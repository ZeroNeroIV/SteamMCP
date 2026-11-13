import crypto from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import type { Config } from "./config.js";

/**
 * Minimal, stateless, multi-user OAuth 2.1 authorization server for Gemini custom apps.
 *
 * - Discovery (RFC 8414 + RFC 9728), Dynamic Client Registration (RFC 7591), PKCE S256 only.
 * - Static client credentials fallback (OAUTH_CLIENT_ID / OAUTH_CLIENT_SECRET).
 * - Each user enters their own Steam Web API key and Steam ID on the /authorize page.
 * - Every artefact (client_id, auth code, access/refresh token) is AES-256-GCM encrypted
 *   with a server secret (OAUTH_SECRET / MCP_AUTH_TOKEN), so there is no database,
 *   credentials stay confidential, and rotating the secret revokes everything.
 */

const ACCESS_TTL_S = 3600;
const REFRESH_TTL_S = 30 * 24 * 3600;
const CODE_TTL_S = 120;
export const SCOPE = "steam.read";

const DEFAULT_REDIRECT_HOSTS = ["googleusercontent.com", "google.com"];

type TokenType = "client" | "code" | "access" | "refresh";

export interface SteamCredentials {
  apiKey?: string;
  steamId?: string;
}

interface ClientPayload { t: "client"; n?: string; ru: string[]; m: "none" | "client_secret_post" | "client_secret_basic"; iat: number }
interface CodePayload { t: "code"; cid: string; ru: string; cc: string; sc: string; ak: string; sid?: string; exp: number; jti: string }
interface AccessPayload { t: "access"; cid: string; sc: string; ak: string; sid?: string; exp: number }
interface RefreshPayload { t: "refresh"; cid: string; sc: string; ak: string; sid?: string; exp: number }

export interface OAuthOptions {
  now?: () => number; // ms
}

const b64u = (b: Buffer | string) => Buffer.from(b).toString("base64url");

function normalizeSteamId(raw: string): string | undefined {
  const s = raw.trim();
  if (!s) return undefined;
  const prof = /^https?:\/\/steamcommunity\.com\/profiles\/(\d{17})\/?$/i.exec(s);
  if (prof) return prof[1];
  const vanity = /^https?:\/\/steamcommunity\.com\/id\/([^/?#]+)\/?$/i.exec(s);
  if (vanity) return vanity[1];
  return s;
}

export class OAuth {
  private key: Buffer;
  private now: () => number;
  private usedCodes = new Map<string, number>(); // jti -> exp (best-effort single use per instance)

  constructor(private cfg: Config, opts: OAuthOptions = {}) {
    if (!cfg.authToken && !cfg.oauthSecret) throw new Error("OAuth requires MCP_AUTH_TOKEN or OAUTH_SECRET");
    this.now = opts.now ?? Date.now;
    this.key = crypto
      .createHmac("sha256", cfg.oauthSecret ?? cfg.authToken!)
      .update("steam-mcp/oauth/v2")
      .digest();
  }

  // ---------- authenticated encryption (AES-256-GCM) ----------
  private sign(payload: object): string {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const ct = Buffer.concat([cipher.update(JSON.stringify(payload), "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return b64u(Buffer.concat([iv, tag, ct]));
  }

  private verify<T extends { t: TokenType; exp?: number }>(token: unknown, type: T["t"]): T | null {
    if (typeof token !== "string" || token.length > 8192) return null;
    let buf: Buffer;
    try {
      buf = Buffer.from(token, "base64url");
    } catch {
      return null;
    }
    if (buf.length < 29 || b64u(buf) !== token) return null;
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const ct = buf.subarray(28);
    let p: T;
    try {
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, iv);
      decipher.setAuthTag(tag);
      const plain = Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
      p = JSON.parse(plain) as T;
    } catch {
      return null;
    }
    if (p.t !== type) return null;
    if (p.exp !== undefined && p.exp * 1000 < this.now()) return null;
    return p;
  }

  private clientSecretFor(clientId: string): string {
    return crypto.createHmac("sha256", this.key).update("client-secret:" + clientId).digest("base64url");
  }

  // ---------- public helpers ----------
  baseUrl(req: Request): string {
    if (this.cfg.publicUrl) return this.cfg.publicUrl.replace(/\/+$/, "");
    const proto = (req.headers["x-forwarded-proto"] as string | undefined)?.split(",")[0].trim() || req.protocol;
    return `${proto}://${req.get("host")}`;
  }

  resourceMetadataUrl(req: Request): string {
    return `${this.baseUrl(req)}/.well-known/oauth-protected-resource`;
  }

  /** Returns the user's Steam credentials if the bearer token is a valid OAuth access token. */
  verifyAccessToken(token: string): SteamCredentials | null {
    const p = this.verify<AccessPayload>(token, "access");
    return p ? { apiKey: p.ak, steamId: p.sid } : null;
  }

  private redirectAllowed(uri: string): boolean {
    let u: URL;
    try {
      u = new URL(uri);
    } catch {
      return false;
    }
    if (u.hash) return false;
    if (u.username || u.password) return false;
    const host = u.hostname.replace(/^\[|\]$/g, "");
    if (["127.0.0.1", "localhost", "::1"].includes(host)) return u.protocol === "http:" || u.protocol === "https:";
    if (u.protocol !== "https:") return false;
    const allowed = [...DEFAULT_REDIRECT_HOSTS, ...this.cfg.allowedRedirectHosts];
    if (allowed.includes("*")) return true;
    return allowed.some((a) => host === a || host.endsWith("." + a));
  }

  /** Resolve a client (static or DCR). */
  private resolveClient(clientId: string):
    | { kind: "static"; secret: string; redirectUris: string[] | null }
    | { kind: "dcr"; payload: ClientPayload }
    | null {
    if (this.cfg.oauthClientId && clientId === this.cfg.oauthClientId) {
      return { kind: "static", secret: this.cfg.oauthClientSecret ?? "", redirectUris: null };
    }
    const p = this.verify<ClientPayload>(clientId, "client");
    return p ? { kind: "dcr", payload: p } : null;
  }

  private checkRedirect(client: NonNullable<ReturnType<OAuth["resolveClient"]>>, uri: string): boolean {
    if (!this.redirectAllowed(uri)) return false;
    if (client.kind === "dcr") return client.payload.ru.includes(uri);
    return true;
  }

  // ---------- express wiring ----------
  mount(app: Express): void {
    const cors = (_req: Request, res: Response, next: () => void) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "authorization, content-type, mcp-protocol-version");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
      next();
    };
    const preflight = (_req: Request, res: Response) => void res.status(204).end();
    const form = express.urlencoded({ extended: false, limit: "16kb" });

    for (const p of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
      app.options(p, cors, preflight);
      app.get(p, cors, (req, res) => {
        const base = this.baseUrl(req);
        res.json({
          resource: `${base}/mcp`,
          authorization_servers: [base],
          bearer_methods_supported: ["header"],
          scopes_supported: [SCOPE],
          resource_name: "Steam MCP",
        });
      });
    }

    for (const p of ["/.well-known/oauth-authorization-server", "/.well-known/oauth-authorization-server/mcp", "/.well-known/openid-configuration"]) {
      app.options(p, cors, preflight);
      app.get(p, cors, (req, res) => {
        const base = this.baseUrl(req);
        res.json({
          issuer: base,
          authorization_endpoint: `${base}/authorize`,
          token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`,
          response_types_supported: ["code"],
          grant_types_supported: ["authorization_code", "refresh_token"],
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
          scopes_supported: [SCOPE],
          authorization_response_iss_parameter_supported: true,
        });
      });
    }

    // --- Dynamic Client Registration ---
    app.options("/register", cors, preflight);
    app.post("/register", cors, express.json({ limit: "16kb" }), (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      const b = req.body ?? {};
      const uris: unknown = b.redirect_uris;
      if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every((u) => typeof u === "string")) {
        return void res.status(400).json({ error: "invalid_redirect_uri", error_description: "redirect_uris must be a non-empty array of strings" });
      }
      const bad = (uris as string[]).find((u) => !this.redirectAllowed(u));
      if (bad) {
        console.error(`[oauth] /register rejected redirect_uri: ${bad}`);
        return void res.status(400).json({
          error: "invalid_redirect_uri",
          error_description: `redirect URI not allowed: ${bad.slice(0, 200)}. Add its host to ALLOWED_REDIRECT_HOSTS.`,
        });
      }
      const requested = b.token_endpoint_auth_method ?? "none";
      if (!["none", "client_secret_post", "client_secret_basic"].includes(requested)) {
        console.error(`[oauth] /register rejected auth_method: ${requested}`);
        return void res.status(400).json({ error: "invalid_client_metadata", error_description: "unsupported token_endpoint_auth_method" });
      }
      const grants: unknown = b.grant_types;
      if (grants !== undefined && (!Array.isArray(grants) || !grants.every((g) => ["authorization_code", "refresh_token"].includes(g)))) {
        console.error(`[oauth] /register rejected grant_types: ${JSON.stringify(grants)}`);
        return void res.status(400).json({ error: "invalid_client_metadata", error_description: "unsupported grant_types" });
      }
      const name = typeof b.client_name === "string" ? b.client_name.slice(0, 100) : undefined;
      const iat = Math.floor(this.now() / 1000);
      const payload: ClientPayload = { t: "client", n: name, ru: uris as string[], m: requested, iat };
      const clientId = this.sign(payload);
      const out: Record<string, unknown> = {
        client_id: clientId,
        client_id_issued_at: iat,
        redirect_uris: uris,
        client_name: name,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: requested,
        scope: SCOPE,
      };
      if (requested !== "none") {
        out.client_secret = this.clientSecretFor(clientId);
        out.client_secret_expires_at = 0;
      }
      res.status(201).json(out);
    });

    // --- Authorization endpoint ---
    const authParams = (src: Record<string, unknown>) => {
      const s = (k: string) => (typeof src[k] === "string" ? (src[k] as string) : "");
      return {
        client_id: s("client_id"),
        redirect_uri: s("redirect_uri"),
        response_type: s("response_type"),
        code_challenge: s("code_challenge"),
        code_challenge_method: s("code_challenge_method"),
        state: s("state"),
        scope: s("scope"),
      };
    };

    type ClientInfo = NonNullable<ReturnType<OAuth["resolveClient"]>>;
    type AuthCheck =
      | { kind: "fatal"; msg: string }
      | { kind: "redirect"; redirectError: string; desc?: string }
      | { kind: "ok"; client: ClientInfo };

    /** Validates request params. "fatal" errors must NOT redirect back to the client. */
    const validateAuth = (p: ReturnType<typeof authParams>): AuthCheck => {
      const client = p.client_id ? this.resolveClient(p.client_id) : null;
      if (!client) return { kind: "fatal", msg: "Unknown client_id" };
      if (!p.redirect_uri || !this.checkRedirect(client, p.redirect_uri)) return { kind: "fatal", msg: "redirect_uri is not registered or not allowed" };
      if (p.response_type !== "code") return { kind: "redirect", redirectError: "unsupported_response_type" };
      if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(p.code_challenge) || p.code_challenge_method !== "S256") {
        return { kind: "redirect", redirectError: "invalid_request", desc: "PKCE with S256 is required" };
      }
      return { kind: "ok", client };
    };

    const errParams = (v: { redirectError: string; desc?: string }): Record<string, string> => {
      const o: Record<string, string> = { error: v.redirectError };
      if (v.desc) o.error_description = v.desc;
      return o;
    };

    const redirectBack = (res: Response, p: ReturnType<typeof authParams>, params: Record<string, string>, base: string) => {
      const u = new URL(p.redirect_uri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (p.state) u.searchParams.set("state", p.state);
      u.searchParams.set("iss", base);
      res.redirect(302, u.toString());
    };

    const page = (res: Response, status: number, body: string) => {
      res.status(status);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https: http:; frame-ancestors 'none'; base-uri 'none'");
      res.send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Steam MCP</title>
<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:4rem auto;padding:0 1rem;color:#1b2838}input,button{font:inherit;padding:.6rem;width:100%;box-sizing:border-box;margin-top:.5rem}button{background:#1b2838;color:#fff;border:0;cursor:pointer}.err{color:#b00020}code{background:#eee;padding:0 .25rem}</style></head><body>${body}</body></html>`);
    };
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

    const consent = (res: Response, p: ReturnType<typeof authParams>, client: NonNullable<ReturnType<OAuth["resolveClient"]>>, error?: string, status = 200, prevSid = "") => {
      const name = client.kind === "dcr" ? client.payload.n ?? "An application" : "Your configured application";
      const host = new URL(p.redirect_uri).host;
      const hidden = Object.entries(p).map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v)}">`).join("");
      page(
        res,
        status,
        `<h1>Connect to Steam MCP</h1>
<p><strong>${esc(name)}</strong> wants read-only access to your Steam data. Redirects back to <code>${esc(host)}</code>.</p>
${error ? `<p class="err">${esc(error)}</p>` : ""}
<form method="post" action="/authorize">${hidden}
<label>Steam Web API Key (<a href="https://steamcommunity.com/dev/apikey" target="_blank" rel="noopener">get yours</a>)<input type="password" name="steam_api_key" autocomplete="off" required autofocus></label>
<label style="display:block;margin-top:.8rem">Steam ID or vanity name (optional)<input type="text" name="steam_id" value="${esc(prevSid)}" placeholder="7656119... or profile URL / vanity"></label>
<p style="font-size:.85rem;color:#555">Your key is encrypted inside your access token and never stored on the server.</p>
<button type="submit">Connect Steam</button></form>`,
      );
    };

    app.get("/authorize", (req, res) => {
      const p = authParams(req.query as Record<string, unknown>);
      const v = validateAuth(p);
      if (v.kind === "fatal") return page(res, 400, `<h1>Cannot continue</h1><p class="err">${esc(v.msg)}</p>`);
      if (v.kind === "redirect") return redirectBack(res, p, errParams(v), this.baseUrl(req));
      consent(res, p, v.client);
    });

    app.post("/authorize", form, (req, res) => {
      const p = authParams(req.body ?? {});
      const v = validateAuth(p);
      if (v.kind === "fatal") return page(res, 400, `<h1>Cannot continue</h1><p class="err">${esc(v.msg)}</p>`);
      if (v.kind === "redirect") return redirectBack(res, p, errParams(v), this.baseUrl(req));

      const rawKey = typeof req.body?.steam_api_key === "string" ? req.body.steam_api_key.trim() : "";
      const rawSid = typeof req.body?.steam_id === "string" ? req.body.steam_id.trim() : "";
      if (!rawKey) {
        return consent(res, p, v.client, "Please enter your Steam Web API key.", 400, rawSid);
      }

      const payload: CodePayload = {
        t: "code",
        cid: p.client_id,
        ru: p.redirect_uri,
        cc: p.code_challenge,
        sc: SCOPE,
        ak: rawKey,
        ...(normalizeSteamId(rawSid) ? { sid: normalizeSteamId(rawSid) } : {}),
        exp: Math.floor(this.now() / 1000) + CODE_TTL_S,
        jti: crypto.randomBytes(12).toString("base64url"),
      };
      redirectBack(res, p, { code: this.sign(payload) }, this.baseUrl(req));
    });

    // --- Token endpoint ---
    app.options("/token", cors, preflight);
    app.post("/token", cors, form, (req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      const err = (status: number, error: string, desc?: string) => {
        console.error(`[oauth] /token ${status} ${error}${desc ? `: ${desc}` : ""}`);
        if (status === 401) res.setHeader("WWW-Authenticate", 'Basic realm="steam-mcp"');
        return void res.status(status).json({ error, ...(desc ? { error_description: desc } : {}) });
      };
      const b = (req.body ?? {}) as Record<string, string>;

      // client authentication
      let clientId = typeof b.client_id === "string" ? b.client_id : "";
      let secret = typeof b.client_secret === "string" ? b.client_secret : undefined;
      const basic = /^Basic (.+)$/i.exec(req.headers.authorization ?? "");
      if (basic) {
        try {
          const [id = "", ...rest] = Buffer.from(basic[1]!, "base64").toString("utf8").split(":");
          clientId = decodeURIComponent(id);
          secret = decodeURIComponent(rest.join(":"));
        } catch {
          return err(401, "invalid_client", "Malformed Basic credentials");
        }
      }
      const client = clientId ? this.resolveClient(clientId) : null;
      if (!client) return err(401, "invalid_client", "Unknown client");
      if (client.kind === "static") {
        if (client.secret && !(secret !== undefined && safeEqual(secret, client.secret))) return err(401, "invalid_client", "Bad client secret");
      } else if (client.payload.m !== "none") {
        if (!(secret !== undefined && safeEqual(secret, this.clientSecretFor(clientId)))) return err(401, "invalid_client", "Bad client secret");
      }

      const issue = (ak: string, sid?: string) => {
        const nowS = Math.floor(this.now() / 1000);
        const access: AccessPayload = { t: "access", cid: clientId, sc: SCOPE, ak, ...(sid ? { sid } : {}), exp: nowS + ACCESS_TTL_S };
        const refresh: RefreshPayload = { t: "refresh", cid: clientId, sc: SCOPE, ak, ...(sid ? { sid } : {}), exp: nowS + REFRESH_TTL_S };
        return {
          access_token: this.sign(access),
          token_type: "Bearer",
          expires_in: ACCESS_TTL_S,
          refresh_token: this.sign(refresh),
          scope: SCOPE,
        };
      };

      if (b.grant_type === "authorization_code") {
        const code = this.verify<CodePayload>(b.code, "code");
        if (!code || code.cid !== clientId) return err(400, "invalid_grant", "Invalid or expired code");
        if (code.ru !== b.redirect_uri) return err(400, "invalid_grant", "redirect_uri mismatch");
        const verifier = typeof b.code_verifier === "string" ? b.code_verifier : "";
        if (!/^[A-Za-z0-9\-._~]{43,128}$/.test(verifier)) return err(400, "invalid_grant", "Invalid code_verifier");
        const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
        if (!safeEqual(challenge, code.cc)) return err(400, "invalid_grant", "PKCE verification failed");
        // best-effort replay protection (per instance)
        const nowMs = this.now();
        for (const [k, exp] of this.usedCodes) if (exp * 1000 < nowMs) this.usedCodes.delete(k);
        if (this.usedCodes.has(code.jti)) return err(400, "invalid_grant", "Code already used");
        this.usedCodes.set(code.jti, code.exp);
        return void res.json(issue(code.ak, code.sid));
      }

      if (b.grant_type === "refresh_token") {
        const rt = this.verify<RefreshPayload>(b.refresh_token, "refresh");
        if (!rt || rt.cid !== clientId) return err(400, "invalid_grant", "Invalid or expired refresh token");
        return void res.json(issue(rt.ak, rt.sid));
      }

      return err(400, "unsupported_grant_type");
    });
  }
}

export function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
