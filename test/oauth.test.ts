import { afterAll, describe, expect, it } from "bun:test";
import crypto from "node:crypto";
import type { Server } from "node:http";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createHttpApp } from "../src/http.js";
import { loadConfig } from "../src/config.js";

const REDIRECT = "https://oauth-redirect.googleusercontent.com/r/steam-test";
const PASS = "owner-pass";

const servers: Server[] = [];
afterAll(() => servers.forEach((s) => s.close()));

interface Harness { base: string; advance: (ms: number) => void; env: Record<string, string> }

async function start(env: Record<string, string> = {}, mockFetch?: typeof fetch): Promise<Harness> {
  let skew = 0;
  const full = { MCP_AUTH_TOKEN: PASS, HOST: "127.0.0.1", STEAM_API_KEY: "k", STEAM_ID: "76561198000000001", ...env };
  const cfg = loadConfig(full as any);
  const app = createHttpApp(cfg, { oauth: { now: () => Date.now() + skew }, fetcher: mockFetch });
  const srv = await new Promise<Server>((r) => {
    const s = app.listen(0, "127.0.0.1", () => r(s));
  });
  servers.push(srv);
  return { base: `http://127.0.0.1:${(srv.address() as any).port}`, advance: (ms) => (skew += ms), env: full };
}

const pkce = () => {
  const verifier = crypto.randomBytes(48).toString("base64url");
  return { verifier, challenge: crypto.createHash("sha256").update(verifier).digest("base64url") };
};

const post = (url: string, body: Record<string, string>, headers: Record<string, string> = {}) =>
  fetch(url, {
    method: "POST",
    redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
    body: new URLSearchParams(body),
  });

async function register(h: Harness, extra: Record<string, unknown> = {}) {
  const r = await fetch(`${h.base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: [REDIRECT], client_name: "Gemini", ...extra }),
  });
  return { status: r.status, body: (await r.json()) as any };
}

async function authorize(h: Harness, clientId: string, challenge: string, over: Record<string, string> = {}) {
  return post(`${h.base}/authorize`, {
    client_id: clientId,
    redirect_uri: REDIRECT,
    response_type: "code",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "st4te",
    steam_api_key: "USER-KEY-1",
    steam_id: "76561198000000001",
    ...over,
  });
}

async function getCode(h: Harness, clientId: string, challenge: string) {
  const r = await authorize(h, clientId, challenge);
  expect(r.status).toBe(302);
  const loc = new URL(r.headers.get("location")!);
  expect(loc.origin + loc.pathname).toBe(REDIRECT);
  expect(loc.searchParams.get("state")).toBe("st4te");
  expect(loc.searchParams.get("iss")).toBe(h.base);
  return loc.searchParams.get("code")!;
}

const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const mcp = (h: Harness, token?: string) =>
  fetch(`${h.base}/mcp`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(rpc),
  });

async function fullFlow(h: Harness, reg?: any) {
  const c = reg ?? (await register(h)).body;
  const { verifier, challenge } = pkce();
  const code = await getCode(h, c.client_id, challenge);
  const t = await post(`${h.base}/token`, {
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT,
    code_verifier: verifier,
    client_id: c.client_id,
  });
  return { client: c, verifier, challenge, code, res: t, tok: (await t.clone().json()) as any };
}

describe("discovery", () => {
  it("serves protected-resource and authorization-server metadata", async () => {
    const h = await start();
    const pr: any = await (await fetch(`${h.base}/.well-known/oauth-protected-resource`)).json();
    expect(pr.resource).toBe(`${h.base}/mcp`);
    expect(pr.authorization_servers).toEqual([h.base]);
    const pr2: any = await (await fetch(`${h.base}/.well-known/oauth-protected-resource/mcp`)).json();
    expect(pr2.resource).toBe(`${h.base}/mcp`);
    const as: any = await (await fetch(`${h.base}/.well-known/oauth-authorization-server`)).json();
    expect(as).toMatchObject({
      issuer: h.base,
      authorization_endpoint: `${h.base}/authorize`,
      token_endpoint: `${h.base}/token`,
      registration_endpoint: `${h.base}/register`,
      code_challenge_methods_supported: ["S256"],
    });
    expect(as.grant_types_supported).toContain("refresh_token");
  });
  it("honours PUBLIC_URL as issuer and sends CORS headers", async () => {
    const h = await start({ PUBLIC_URL: "https://steam.example.run.app/" });
    const r = await fetch(`${h.base}/.well-known/oauth-authorization-server`);
    expect(r.headers.get("access-control-allow-origin")).toBe("*");
    expect(((await r.json()) as any).issuer).toBe("https://steam.example.run.app");
  });
  it("401 on /mcp advertises resource_metadata", async () => {
    const h = await start();
    const r = await mcp(h);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${h.base}/.well-known/oauth-protected-resource"`);
  });
  it("is disabled when no owner token is configured (loopback no-auth mode)", async () => {
    const h = await start({ MCP_AUTH_TOKEN: "" });
    expect((await fetch(`${h.base}/.well-known/oauth-authorization-server`)).status).toBe(404);
    expect((await mcp(h)).status).toBe(200);
  });
});

describe("dynamic client registration", () => {
  it("registers a public client", async () => {
    const h = await start();
    const r = await register(h);
    expect(r.status).toBe(201);
    expect(r.body.client_id).toBeTruthy();
    expect(r.body.client_secret).toBeUndefined();
    expect(r.body.token_endpoint_auth_method).toBe("none");
    expect(r.body.redirect_uris).toEqual([REDIRECT]);
  });
  it("registers a confidential client with a secret on request", async () => {
    const h = await start();
    const r = await register(h, { token_endpoint_auth_method: "client_secret_post" });
    expect(r.status).toBe(201);
    expect(r.body.client_secret).toBeTruthy();
  });
  it.each([
    ["foreign host", ["https://evil.example.com/cb"]],
    ["plain http non-loopback", ["http://oauth-redirect.googleusercontent.com/cb"]],
    ["lookalike host", ["https://evilgoogle.com/cb"]],
    ["fragment", [REDIRECT + "#x"]],
    ["userinfo", ["https://user:pw@oauth-redirect.googleusercontent.com/cb"]],
    ["empty list", []],
    ["not a url", ["nope"]],
  ])("rejects %s", async (_n, uris) => {
    const h = await start();
    const r = await fetch(`${h.base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: uris }),
    });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invalid_redirect_uri");
  });
  it("rejects missing redirect_uris and bad auth method", async () => {
    const h = await start();
    const a = await fetch(`${h.base}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(a.status).toBe(400);
    expect((await register(h, { token_endpoint_auth_method: "private_key_jwt" })).status).toBe(400);
  });
  it("accepts loopback redirects", async () => {
    const h = await start();
    const r = await fetch(`${h.base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["http://127.0.0.1:33418/cb", "http://localhost:1/cb"] }),
    });
    expect(r.status).toBe(201);
  });
  it("ALLOWED_REDIRECT_HOSTS extends the allowlist", async () => {
    const h = await start({ ALLOWED_REDIRECT_HOSTS: "example.org" });
    const r = await fetch(`${h.base}/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ redirect_uris: ["https://app.example.org/cb"] }),
    });
    expect(r.status).toBe(201);
  });
});

describe("authorize endpoint", () => {
  it("shows a consent page with the redirect host, Steam API key, and Steam ID fields", async () => {
    const h = await start();
    const c = (await register(h)).body;
    const { challenge } = pkce();
    const q = new URLSearchParams({
      client_id: c.client_id, redirect_uri: REDIRECT, response_type: "code",
      code_challenge: challenge, code_challenge_method: "S256", state: "s",
    });
    const r = await fetch(`${h.base}/authorize?${q}`);
    expect(r.status).toBe(200);
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("cache-control")).toBe("no-store");
    const html = await r.text();
    expect(html).toContain("oauth-redirect.googleusercontent.com");
    expect(html).toContain('name="steam_api_key"');
    expect(html).toContain('name="steam_id"');
    expect(html).toContain("Gemini");
  });
  it("never redirects for unknown client or mismatched redirect_uri", async () => {
    const h = await start();
    const c = (await register(h)).body;
    const { challenge } = pkce();
    const base = { response_type: "code", code_challenge: challenge, code_challenge_method: "S256" };
    const u1 = new URLSearchParams({ ...base, client_id: "bogus", redirect_uri: REDIRECT });
    expect((await fetch(`${h.base}/authorize?${u1}`, { redirect: "manual" })).status).toBe(400);
    const u2 = new URLSearchParams({ ...base, client_id: c.client_id, redirect_uri: "https://oauth-redirect.googleusercontent.com/other" });
    expect((await fetch(`${h.base}/authorize?${u2}`, { redirect: "manual" })).status).toBe(400);
  });
  it("requires PKCE S256 (redirects with invalid_request)", async () => {
    const h = await start();
    const c = (await register(h)).body;
    const q = new URLSearchParams({ client_id: c.client_id, redirect_uri: REDIRECT, response_type: "code", state: "s" });
    const none = await fetch(`${h.base}/authorize?${q}`, { redirect: "manual" });
    expect(none.status).toBe(302);
    expect(new URL(none.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    q.set("code_challenge", "a".repeat(43));
    q.set("code_challenge_method", "plain");
    const plain = await fetch(`${h.base}/authorize?${q}`, { redirect: "manual" });
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
  });
  it("rejects unsupported response_type", async () => {
    const h = await start();
    const c = (await register(h)).body;
    const q = new URLSearchParams({ client_id: c.client_id, redirect_uri: REDIRECT, response_type: "token", code_challenge: pkce().challenge, code_challenge_method: "S256" });
    const r = await fetch(`${h.base}/authorize?${q}`, { redirect: "manual" });
    expect(new URL(r.headers.get("location")!).searchParams.get("error")).toBe("unsupported_response_type");
  });
  it("escapes hostile state/client names in HTML", async () => {
    const h = await start();
    const c = (await register(h, { client_name: '<script>alert(1)</script>' })).body;
    const q = new URLSearchParams({
      client_id: c.client_id, redirect_uri: REDIRECT, response_type: "code",
      code_challenge: pkce().challenge, code_challenge_method: "S256", state: '"><script>alert(2)</script>',
    });
    const html = await (await fetch(`${h.base}/authorize?${q}`)).text();
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
  it("missing steam_api_key gives 400 and no code, preserving steam_id", async () => {
    const h = await start();
    const c = (await register(h)).body;
    const r = await authorize(h, c.client_id, pkce().challenge, { steam_api_key: "  ", steam_id: "76561198000000009" });
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
    const html = await r.text();
    expect(html).toContain("Please enter your Steam Web API key");
    expect(html).toContain("76561198000000009");
  });
});

describe("token endpoint", () => {
  it("completes the full code flow and the token works on /mcp", async () => {
    const h = await start();
    const f = await fullFlow(h);
    expect(f.res.status).toBe(200);
    expect(f.res.headers.get("cache-control")).toBe("no-store");
    expect(f.tok).toMatchObject({ token_type: "Bearer", expires_in: 3600 });
    expect(f.tok.refresh_token).toBeTruthy();
    const ok = await mcp(h, f.tok.access_token);
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).result.tools).toHaveLength(2);
  });
  it("static owner bearer still works", async () => {
    const h = await start();
    expect((await mcp(h, PASS)).status).toBe(200);
    expect((await mcp(h, "wrong")).status).toBe(401);
  });
  it("rejects a wrong PKCE verifier", async () => {
    const h = await start();
    const c = (await register(h)).body;
    const { challenge } = pkce();
    const code = await getCode(h, c.client_id, challenge);
    const r = await post(`${h.base}/token`, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: pkce().verifier, client_id: c.client_id });
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).error).toBe("invalid_grant");
  });
  it("rejects missing/short verifier and redirect mismatch", async () => {
    const h = await start();
    const c = (await register(h)).body;
    const { verifier, challenge } = pkce();
    const code = await getCode(h, c.client_id, challenge);
    const noV = await post(`${h.base}/token`, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: c.client_id });
    expect(noV.status).toBe(400);
    const badRu = await post(`${h.base}/token`, { grant_type: "authorization_code", code, redirect_uri: REDIRECT + "x", code_verifier: verifier, client_id: c.client_id });
    expect(badRu.status).toBe(400);
    const ok = await post(`${h.base}/token`, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: c.client_id });
    expect(ok.status).toBe(200);
  });
  it("codes are single-use", async () => {
    const h = await start();
    const f = await fullFlow(h);
    expect(f.res.status).toBe(200);
    const again = await post(`${h.base}/token`, { grant_type: "authorization_code", code: f.code, redirect_uri: REDIRECT, code_verifier: f.verifier, client_id: f.client.client_id });
    expect(again.status).toBe(400);
  });
  it("codes expire after 2 minutes", async () => {
    const h = await start();
    const c = (await register(h)).body;
    const { verifier, challenge } = pkce();
    const code = await getCode(h, c.client_id, challenge);
    h.advance(121_000);
    const r = await post(`${h.base}/token`, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: c.client_id });
    expect(r.status).toBe(400);
  });
  it("codes are bound to the client that requested them", async () => {
    const h = await start();
    const a = (await register(h)).body;
    const b = (await register(h, { client_name: "other" })).body;
    const { verifier, challenge } = pkce();
    const code = await getCode(h, a.client_id, challenge);
    const r = await post(`${h.base}/token`, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: b.client_id });
    expect(r.status).toBe(400);
  });
  it("access tokens expire after 1 hour; refresh issues a working token", async () => {
    const h = await start();
    const f = await fullFlow(h);
    h.advance(3_601_000);
    expect((await mcp(h, f.tok.access_token)).status).toBe(401);
    const rr = await post(`${h.base}/token`, { grant_type: "refresh_token", refresh_token: f.tok.refresh_token, client_id: f.client.client_id });
    expect(rr.status).toBe(200);
    const t2: any = await rr.json();
    expect((await mcp(h, t2.access_token)).status).toBe(200);
  });
  it("refresh tokens expire after 30 days", async () => {
    const h = await start();
    const f = await fullFlow(h);
    h.advance(31 * 24 * 3600 * 1000);
    const rr = await post(`${h.base}/token`, { grant_type: "refresh_token", refresh_token: f.tok.refresh_token, client_id: f.client.client_id });
    expect(rr.status).toBe(400);
  });
  it("token types are not interchangeable", async () => {
    const h = await start();
    const f = await fullFlow(h);
    expect((await mcp(h, f.tok.refresh_token)).status).toBe(401);
    expect((await mcp(h, f.code)).status).toBe(401);
    expect((await mcp(h, f.client.client_id)).status).toBe(401);
    const rr = await post(`${h.base}/token`, { grant_type: "refresh_token", refresh_token: f.tok.access_token, client_id: f.client.client_id });
    expect(rr.status).toBe(400);
  });
  it("tampered or foreign tokens are rejected, and API keys are encrypted (not plaintext)", async () => {
    const h = await start();
    const other = await start({ MCP_AUTH_TOKEN: "different-owner" });
    const f = await fullFlow(h);
    const t = f.tok.access_token as string;
    expect(Buffer.from(t, "base64url").toString("utf8")).not.toContain("USER-KEY-1");
    const flipped = t.slice(0, -2) + (t.endsWith("AA") ? "BB" : "AA");
    expect((await mcp(h, flipped)).status).toBe(401);
    expect((await mcp(other, t)).status).toBe(401);
    expect((await mcp(h, "a.b.c")).status).toBe(401);
    expect((await mcp(h, "x".repeat(10_000))).status).toBe(401);
  });
  it("OAUTH_SECRET change invalidates previously issued tokens", async () => {
    const a = await start({ OAUTH_SECRET: "one" });
    const b = await start({ OAUTH_SECRET: "two" });
    const f = await fullFlow(a);
    expect((await mcp(a, f.tok.access_token)).status).toBe(200);
    expect((await mcp(b, f.tok.access_token)).status).toBe(401);
  });
  it("rejects unknown clients, bad grant types", async () => {
    const h = await start();
    const f = await fullFlow(h);
    expect((await post(`${h.base}/token`, { grant_type: "authorization_code", client_id: "bogus" })).status).toBe(401);
    const g = await post(`${h.base}/token`, { grant_type: "password", client_id: f.client.client_id });
    expect(g.status).toBe(400);
    expect(((await g.json()) as any).error).toBe("unsupported_grant_type");
  });
  it("confidential DCR client must present its secret (post and basic)", async () => {
    const h = await start();
    const c = (await register(h, { token_endpoint_auth_method: "client_secret_post" })).body;
    const mk = async () => {
      const p = pkce();
      return { ...p, code: await getCode(h, c.client_id, p.challenge) };
    };
    const a = await mk();
    const noSecret = await post(`${h.base}/token`, { grant_type: "authorization_code", code: a.code, redirect_uri: REDIRECT, code_verifier: a.verifier, client_id: c.client_id });
    expect(noSecret.status).toBe(401);
    const bad = await post(`${h.base}/token`, { grant_type: "authorization_code", code: a.code, redirect_uri: REDIRECT, code_verifier: a.verifier, client_id: c.client_id, client_secret: "bad" });
    expect(bad.status).toBe(401);
    const good = await post(`${h.base}/token`, { grant_type: "authorization_code", code: a.code, redirect_uri: REDIRECT, code_verifier: a.verifier, client_id: c.client_id, client_secret: c.client_secret });
    expect(good.status).toBe(200);
    const b = await mk();
    const basic = "Basic " + Buffer.from(`${encodeURIComponent(c.client_id)}:${encodeURIComponent(c.client_secret)}`).toString("base64");
    const viaBasic = await post(`${h.base}/token`, { grant_type: "authorization_code", code: b.code, redirect_uri: REDIRECT, code_verifier: b.verifier }, { authorization: basic });
    expect(viaBasic.status).toBe(200);
  });
});

describe("static client credentials (Gemini 'Advanced features')", () => {
  const env = { OAUTH_CLIENT_ID: "gemini-steam", OAUTH_CLIENT_SECRET: "s3cret-value" };
  it("works end to end with client_secret", async () => {
    const h = await start(env);
    const { verifier, challenge } = pkce();
    const code = await getCode(h, "gemini-steam", challenge);
    const bad = await post(`${h.base}/token`, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: "gemini-steam", client_secret: "nope" });
    expect(bad.status).toBe(401);
    const ok = await post(`${h.base}/token`, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: "gemini-steam", client_secret: "s3cret-value" });
    expect(ok.status).toBe(200);
    const tok: any = await ok.json();
    expect((await mcp(h, tok.access_token)).status).toBe(200);
  });
  it("still restricts redirect hosts", async () => {
    const h = await start(env);
    const r = await authorize(h, "gemini-steam", pkce().challenge, { redirect_uri: "https://evil.example.com/cb" });
    expect(r.status).toBe(400);
    expect(r.headers.get("location")).toBeNull();
  });
});

describe("real MCP client over HTTP with multi-user OAuth tokens", () => {
  it("isolates per-user Steam API key and Steam ID across users and refresh", async () => {
    const seen: { key: string | null; steamid: string | null }[] = [];
    const mock = (async (input: any) => {
      const u = new URL(String(input));
      seen.push({ key: u.searchParams.get("key"), steamid: u.searchParams.get("steamid") });
      return new Response(JSON.stringify({ response: { game_count: 1, games: [{ appid: 730, playtime_forever: 10 }] } }));
    }) as typeof fetch;

    const h = await start({ STEAM_API_KEY: "HOST-KEY", STEAM_ID: "76561198000000000" }, mock);
    const c = (await register(h)).body;

    const authUser = async (steam_api_key: string, steam_id: string) => {
      const { verifier, challenge } = pkce();
      const r = await authorize(h, c.client_id, challenge, { steam_api_key, steam_id });
      const code = new URL(r.headers.get("location")!).searchParams.get("code")!;
      const t = await post(`${h.base}/token`, { grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: verifier, client_id: c.client_id });
      return (await t.json()) as any;
    };

    const u1 = await authUser("ALICE-KEY", "https://steamcommunity.com/profiles/76561198000000011/");
    const u2 = await authUser("BOB-KEY", "76561198000000022");
    const u3 = await authUser("CAROL-KEY", "");

    const rr = await post(`${h.base}/token`, { grant_type: "refresh_token", refresh_token: u1.refresh_token, client_id: c.client_id });
    const u1Refreshed = (await rr.json()) as any;

    const callOwned = async (token: string) => {
      const client = new Client({ name: "e2e", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${h.base}/mcp`), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      const res: any = await client.callTool({ name: "execute_code", arguments: { code: "return (await steam.getOwnedGames({})).game_count;" } });
      await client.close();
      return res;
    };

    expect((await callOwned(u1Refreshed.access_token)).isError).toBeFalsy();
    expect((await callOwned(u2.access_token)).isError).toBeFalsy();
    const carolRes = await callOwned(u3.access_token);
    expect(carolRes.isError).toBe(true);
    expect(carolRes.content[0].text).toContain("No steamId given");

    expect(seen).toEqual([
      { key: "ALICE-KEY", steamid: "76561198000000011" },
      { key: "BOB-KEY", steamid: "76561198000000022" },
    ]);
  });
});
