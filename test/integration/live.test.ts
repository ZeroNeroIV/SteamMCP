import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

// Live Steam tests.
//   Keyless endpoints (Store API, news, current players, global achievements):  STEAM_LIVE=1 bun run test:integration
//   Keyed endpoints:  set STEAM_API_KEY (and optional STEAM_ID) in .env or env, then:  bun run test:integration
const cfg = loadConfig();
const keyless = process.env.STEAM_LIVE || cfg.apiKey ? describe : describe.skip;
const keyed = cfg.apiKey ? describe : describe.skip;

async function exec(code: string) {
  const server = createServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "it", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r: any = await client.callTool({ name: "execute_code", arguments: { code } });
  return { isError: r.isError, body: JSON.parse(r.content[0].text) };
}

keyless("live Steam (no key needed)", () => {
  it("store.getAppDetails (Counter-Strike 2 / app 730)", async () => {
    const { body, isError } = await exec(`const d = await store.getAppDetails({appId:730}); return d.name;`);
    expect(isError).toBeFalsy();
    expect(body.result).toMatch(/Counter-Strike/);
  }, 30_000);

  it("steam.getCurrentPlayers", async () => {
    const { body } = await exec(`return await steam.getCurrentPlayers({appId:730})`);
    expect(body.result).toBeGreaterThan(0);
  }, 30_000);

  it("steam.getNewsForApp", async () => {
    const { body } = await exec(`return (await steam.getNewsForApp({appId:730,count:2})).length`);
    expect(body.result).toBeGreaterThan(0);
  }, 30_000);

  it("steam.getGlobalAchievementPercentages", async () => {
    const { body, isError } = await exec(`const a = await steam.getGlobalAchievementPercentages({appId:440}); return a.length`);
    expect(isError).toBeFalsy();
    expect(body.result).toBeGreaterThan(0);
  }, 30_000);

  it("store.search + store.getPrices composed in one execution", async () => {
    const { body, isError } = await exec(`
      const hits = await store.search({term:"portal"});
      const prices = await store.getPrices({appIds: hits.slice(0,3).map(h=>h.id)});
      return { hits: hits.length, priced: Object.keys(prices).length };`);
    expect(isError).toBeFalsy();
    expect(body.result.hits).toBeGreaterThan(0);
    expect(body.result.priced).toBeGreaterThan(0);
  }, 30_000);

  it("store.getReviews (new IUserReviewsService endpoint, paging + filters)", async () => {
    const { body, isError } = await exec(`
      const r = await store.getReviews({appId:730, numPerPage:3});
      const neg = await store.getReviews({appId:730, numPerPage:3, reviewType:"negative"});
      const next = await store.getReviews({appId:730, numPerPage:3, cursor:r.cursor});
      return {
        total: r.query_summary.total_reviews, n: r.reviews.length,
        allNeg: neg.reviews.every(x => x.voted_up === false),
        differentPage: next.reviews[0].recommendationid !== r.reviews[0].recommendationid,
      };`);
    expect(isError).toBeFalsy();
    expect(body.result.total).toBeGreaterThan(0);
    expect(body.result.n).toBe(3);
    expect(body.result.allNeg).toBe(true);
    expect(body.result.differentPage).toBe(true);
  }, 30_000);

  it("store.getFeatured", async () => {
    const { body, isError } = await exec(`const f = await store.getFeatured({}); return Object.keys(f).length > 0`);
    expect(isError).toBeFalsy();
    expect(body.result).toBe(true);
  }, 30_000);
});

keyed("live Steam (API key)", () => {
  it("steam.raw.listMethods finds only GET methods", async () => {
    const { body } = await exec(`const m = await steam.raw.listMethods({filter:"GetOwnedGames"}); return m.length`);
    expect(body.result).toBeGreaterThan(0);
  }, 30_000);

  it("resolves a vanity URL (gabelogannewell)", async () => {
    const { body, isError } = await exec(`return await steam.resolveVanityUrl({vanity:"gabelogannewell"})`);
    expect(isError).toBeFalsy();
    expect(body.result).toMatch(/^\d{17}$/);
  }, 30_000);

  it("steam.getPlayerSummaries", async () => {
    const { body, isError } = await exec(`const p = await steam.getPlayerSummaries({steamIds:["gabelogannewell"]}); return p[0].personaname`);
    expect(isError).toBeFalsy();
    expect(typeof body.result).toBe("string");
  }, 30_000);

  (cfg.defaultSteamId ? it : it.skip)("steam.getOwnedGames for the default Steam ID (profile must be public)", async () => {
    const { body, isError } = await exec(`const g = await steam.getOwnedGames({}); return g.game_count;`);
    expect(isError).toBeFalsy();
    expect(typeof body.result).toBe("number");
  }, 30_000);
});
