import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { Server } from "node:http";
import { createHttpApp, assertSecureConfig } from "../src/http.js";
import { loadConfig } from "../src/config.js";

const cfg = loadConfig({ MCP_AUTH_TOKEN: "tok", HOST: "127.0.0.1", STEAM_API_KEY: "k" } as any);
let srv: Server;
let base: string;

beforeAll(async () => {
  const app = createHttpApp(cfg);
  await new Promise<void>((r) => (srv = app.listen(0, "127.0.0.1", () => r())));
  base = `http://127.0.0.1:${(srv.address() as any).port}`;
});
afterAll(() => void srv.close());

const rpc = { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} };
const hdr = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  ...extra,
});

describe("HTTP transport", () => {
  it("rejects missing/wrong bearer", async () => {
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: hdr(), body: JSON.stringify(rpc) })).status).toBe(401);
    expect((await fetch(`${base}/mcp`, { method: "POST", headers: hdr({ authorization: "Bearer no" }), body: JSON.stringify(rpc) })).status).toBe(401);
  });
  it("rejects foreign Origin (DNS rebinding)", async () => {
    const r = await fetch(`${base}/mcp`, { method: "POST", headers: hdr({ authorization: "Bearer tok", origin: "https://evil.example" }), body: JSON.stringify(rpc) });
    expect(r.status).toBe(403);
  });
  it("serves tools statelessly with a valid token", async () => {
    for (let i = 0; i < 2; i++) {
      const r = await fetch(`${base}/mcp`, { method: "POST", headers: hdr({ authorization: "Bearer tok" }), body: JSON.stringify(rpc) });
      expect(r.status).toBe(200);
      const body: any = await r.json();
      expect(body.result.tools.map((t: any) => t.name).sort()).toEqual(["execute_code", "search_api"]);
    }
  });
  it("health check is open", async () => {
    expect((await fetch(`${base}/healthz`)).status).toBe(200);
  });
  it("refuses non-loopback bind without token", () => {
    expect(() => assertSecureConfig(loadConfig({ HOST: "0.0.0.0" } as any))).toThrow(/MCP_AUTH_TOKEN/);
    expect(() => assertSecureConfig(loadConfig({ HOST: "0.0.0.0", MCP_AUTH_TOKEN: "x" } as any))).not.toThrow();
  });
});
