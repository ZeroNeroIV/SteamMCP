import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isLoopback, type Config } from "./config.js";
import { OAuth, type OAuthOptions } from "./oauth.js";
import { createServer, type ServerDeps } from "./server.js";
import { safeEqual } from "./oauth.js";

export function assertSecureConfig(cfg: Config): void {
  if (!isLoopback(cfg.host) && !cfg.authToken) {
    throw new Error(`Refusing to bind to ${cfg.host} without MCP_AUTH_TOKEN (bearer auth is mandatory off-loopback)`);
  }
}

export function createHttpApp(cfg: Config, deps: ServerDeps & { oauth?: OAuthOptions } = {}): Express {
  assertSecureConfig(cfg);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", 1);

  app.use((req, res, next) => {
    const start = Date.now();
    res.on("finish", () => {
      if (req.path !== "/healthz") {
        console.error(`[http] ${req.method} ${req.path} -> ${res.statusCode} (${Date.now() - start}ms)`);
      }
    });
    next();
  });

  app.get("/healthz", (_req, res) => void res.json({ ok: true }));

  // OAuth 2.1 server (Gemini app custom connectors). Only when an owner token exists.
  const oauth = cfg.authToken ? new OAuth(cfg, deps.oauth) : undefined;
  oauth?.mount(app);

  app.use(express.json({ limit: "1mb" }));

  const guard = (req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (origin) {
      let ok = cfg.allowedOrigins.includes(origin);
      if (!ok && isLoopback(cfg.host)) {
        try {
          ok = isLoopback(new URL(origin).hostname.replace(/^\[|\]$/g, ""));
        } catch {
          ok = false;
        }
      }
      if (!ok) return void res.status(403).json({ error: "Origin not allowed" });
    }
    if (cfg.authToken) {
      const m = /^Bearer (.+)$/i.exec(req.headers.authorization ?? "");
      const token = m?.[1];
      if (token && safeEqual(token, cfg.authToken)) {
        res.locals.oauthCreds = undefined; // owner static bearer uses server config
      } else {
        const creds = token ? oauth?.verifyAccessToken(token) : null;
        if (!creds) {
          res.setHeader(
            "WWW-Authenticate",
            oauth ? `Bearer resource_metadata="${oauth.resourceMetadataUrl(req)}"` : "Bearer",
          );
          return void res.status(401).json({ error: "Unauthorized" });
        }
        res.locals.oauthCreds = creds;
      }
    }
    next();
  };

  // Stateless Streamable HTTP: a fresh server+transport per request (scales on Cloud Run).
  app.post("/mcp", guard, async (req, res) => {
    const creds = res.locals.oauthCreds as { apiKey?: string; steamId?: string } | undefined;
    const reqCfg: Config = creds ? { ...cfg, apiKey: creds.apiKey, defaultSteamId: creds.steamId } : cfg;
    const server = createServer({ config: reqCfg, fetcher: deps.fetcher });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      console.error(e);
      if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
    }
  });

  const notAllowed = (_req: Request, res: Response) =>
    void res.status(405).set("Allow", "POST").json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed (stateless server)" }, id: null });
  app.get("/mcp", guard, notAllowed);
  app.delete("/mcp", guard, notAllowed);
  return app;
}
