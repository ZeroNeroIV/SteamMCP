import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { loadConfig } from "../src/config.js";
import { SteamHttp, ALLOWED_HOSTS } from "../src/steam/http.js";

const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200 });

function mockFetch(log: string[]) {
  return (async (input: any) => {
    const u = new URL(String(input));
    log.push(u.pathname + u.search);
    if (u.pathname.includes("GetOwnedGames"))
      return json({ response: { game_count: 2, games: [{ appid: 10, playtime_forever: 60 }, { appid: 20, playtime_forever: 5 }] } });
    if (u.pathname.includes("ResolveVanityURL")) return json({ response: { success: 1, steamid: "76561198000000001" } });
    if (u.pathname.includes("appdetails")) return json({ "10": { success: true, data: { name: "X", price_overview: { final: 999 } } } });
    return json({});
  }) as typeof fetch;
}

async function connect(log: string[], env: Record<string, string> = {}) {
  const config = loadConfig({ STEAM_API_KEY: "SECRET", STEAM_ID: "76561198000000001", ...env } as any);
  const server = createServer({ config, fetcher: mockFetch(log) });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return client;
}

const text = (r: any) => r.content[0].text as string;

describe("MCP server", () => {
  it("exposes exactly the two code-mode tools", async () => {
    const c = await connect([]);
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(["execute_code", "search_api"]);
  });

  it("tool schemas are Gemini-friendly (flat, no $ref/anyOf/oneOf)", async () => {
    const c = await connect([]);
    for (const t of (await c.listTools()).tools) {
      const s = JSON.stringify(t.inputSchema);
      expect(s).not.toMatch(/\$ref|anyOf|oneOf|allOf|\$defs/);
      expect((t.inputSchema as any).type).toBe("object");
      for (const p of Object.values((t.inputSchema as any).properties)) expect(["string", "number", "boolean"]).toContain((p as any).type);
    }
  });

  it("search_api filters declarations", async () => {
    const c = await connect([]);
    const r = text(await c.callTool({ name: "search_api", arguments: { query: "achievement" } }));
    expect(r).toContain("getPlayerAchievements");
    expect(r).not.toContain("getFriendList");
  });

  it("execute_code aggregates SDK calls using the default Steam ID and hides the key", async () => {
    const log: string[] = [];
    const c = await connect(log);
    const r = await c.callTool({
      name: "execute_code",
      arguments: { code: `const g = await steam.getOwnedGames({}); return g.games.reduce((s,x)=>s+x.playtime_forever,0);` },
    });
    expect(JSON.parse(text(r)).result).toBe(65);
    expect(log[0]).toContain("steamid=76561198000000001");
    expect(text(r)).not.toContain("SECRET");
  });

  it("resolves vanity names", async () => {
    const log: string[] = [];
    const c = await connect(log, { STEAM_ID: "" });
    const r = await c.callTool({ name: "execute_code", arguments: { code: `return await steam.resolveVanityUrl({vanity:"gaben"})` } });
    expect(JSON.parse(text(r)).result).toBe("76561198000000001");
  });

  it("returns isError on failing code", async () => {
    const c = await connect([]);
    const r: any = await c.callTool({ name: "execute_code", arguments: { code: `throw new Error("nope")` } });
    expect(r.isError).toBe(true);
    expect(text(r)).toContain("nope");
  });
});

describe("SteamHttp", () => {
  it("only allows https Steam hosts", async () => {
    const h = new SteamHttp("k", 1000, mockFetch([]));
    expect([...ALLOWED_HOSTS]).toEqual(["api.steampowered.com", "store.steampowered.com"]);
    await expect(h.getJson("https://evil.example.com/x")).rejects.toThrow(/not allowed/);
    await expect(h.getJson("http://api.steampowered.com/x")).rejects.toThrow(/not allowed/);
  });
  it("caches identical requests", async () => {
    const log: string[] = [];
    const h = new SteamHttp("k", 5000, mockFetch(log));
    await h.getJson("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/", { steamid: "1" }, { key: true });
    await h.getJson("https://api.steampowered.com/IPlayerService/GetOwnedGames/v1/", { steamid: "1" }, { key: true });
    expect(log).toHaveLength(1);
  });
  it("fails clearly without a key", async () => {
    const h = new SteamHttp(undefined, 1000, mockFetch([]));
    await expect(h.getJson("https://api.steampowered.com/x", {}, { key: true })).rejects.toThrow(/STEAM_API_KEY/);
  });
});
