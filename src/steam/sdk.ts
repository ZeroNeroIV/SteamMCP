import type { Config } from "../config.js";
import { SteamHttp } from "./http.js";

const WEB = "https://api.steampowered.com";
const STORE = "https://store.steampowered.com";

export interface Ctx {
  http: SteamHttp;
  cfg: Pick<Config, "defaultSteamId">;
}

export interface MethodSpec {
  /** Namespace.method as seen in the sandbox, e.g. "steam.getOwnedGames" */
  name: string;
  doc: string;
  /** TypeScript type of the single args object */
  params: string;
  impl: (ctx: Ctx, a: any) => Promise<unknown>;
}

const isId = (s: string) => /^\d{17}$/.test(s);

export async function resolveSteamId(ctx: Ctx, input?: string): Promise<string> {
  const v = input ?? ctx.cfg.defaultSteamId;
  if (!v) throw new Error("No steamId given and no default Steam ID configured");
  if (isId(v)) return v;
  const vanity = v.replace(/^https?:\/\/steamcommunity\.com\/id\//, "").replace(/\/$/, "");
  const r: any = await ctx.http.getJson(`${WEB}/ISteamUser/ResolveVanityURL/v1/`, { vanityurl: vanity }, { key: true });
  if (r?.response?.success !== 1) throw new Error(`Could not resolve vanity URL "${v}"`);
  return r.response.steamid as string;
}

const web = (ctx: Ctx, path: string, params: Record<string, unknown> = {}, key = true) =>
  ctx.http.getJson(`${WEB}${path}`, params, { key });
const store = (ctx: Ctx, path: string, params: Record<string, unknown> = {}) =>
  ctx.http.getJson(`${STORE}${path}`, params);

const SID = "steamId?: string /* 17-digit id, vanity name, or profile URL; defaults to configured Steam ID */";

export const METHODS: MethodSpec[] = [
  {
    name: "steam.resolveVanityUrl",
    doc: "Resolve a vanity name to a 17-digit SteamID.",
    params: "{ vanity: string }",
    impl: async (c, a) => resolveSteamId(c, a.vanity),
  },
  {
    name: "steam.getPlayerSummaries",
    doc: "Public profile info (name, avatar, status, country) for up to 100 players.",
    params: "{ steamIds: string[] }",
    impl: async (c, a) => {
      const ids = await Promise.all((a.steamIds as string[]).map((s) => resolveSteamId(c, s)));
      const r: any = await web(c, "/ISteamUser/GetPlayerSummaries/v2/", { steamids: ids.join(",") });
      return r.response.players;
    },
  },
  {
    name: "steam.getFriendList",
    doc: "Friends of a player (profile and friends list must be public).",
    params: `{ ${SID} }`,
    impl: async (c, a) =>
      ((await web(c, "/ISteamUser/GetFriendList/v1/", { steamid: await resolveSteamId(c, a.steamId), relationship: "friend" })) as any)
        .friendslist.friends,
  },
  {
    name: "steam.getOwnedGames",
    doc: "Games owned by a player with playtime in minutes (game details must be public).",
    params: `{ ${SID}; includeFreeGames?: boolean }`,
    impl: async (c, a) =>
      ((await web(c, "/IPlayerService/GetOwnedGames/v1/", {
        steamid: await resolveSteamId(c, a.steamId),
        include_appinfo: 1,
        include_played_free_games: a.includeFreeGames ? 1 : 0,
      })) as any).response,
  },
  {
    name: "steam.getRecentlyPlayedGames",
    doc: "Games played in the last two weeks.",
    params: `{ ${SID}; count?: number }`,
    impl: async (c, a) =>
      ((await web(c, "/IPlayerService/GetRecentlyPlayedGames/v1/", {
        steamid: await resolveSteamId(c, a.steamId),
        count: a.count,
      })) as any).response,
  },
  {
    name: "steam.getSteamLevel",
    doc: "Steam level of a player.",
    params: `{ ${SID} }`,
    impl: async (c, a) =>
      ((await web(c, "/IPlayerService/GetSteamLevel/v1/", { steamid: await resolveSteamId(c, a.steamId) })) as any).response.player_level,
  },
  {
    name: "steam.getBadges",
    doc: "Badges, XP and level progress of a player.",
    params: `{ ${SID} }`,
    impl: async (c, a) =>
      ((await web(c, "/IPlayerService/GetBadges/v1/", { steamid: await resolveSteamId(c, a.steamId) })) as any).response,
  },
  {
    name: "steam.getPlayerBans",
    doc: "VAC / community / game ban status for players.",
    params: "{ steamIds: string[] }",
    impl: async (c, a) => {
      const ids = await Promise.all((a.steamIds as string[]).map((s) => resolveSteamId(c, s)));
      return ((await web(c, "/ISteamUser/GetPlayerBans/v1/", { steamids: ids.join(",") })) as any).players;
    },
  },
  {
    name: "steam.getPlayerAchievements",
    doc: "A player's achievements for one game.",
    params: `{ appId: number; ${SID}; language?: string }`,
    impl: async (c, a) =>
      ((await web(c, "/ISteamUserStats/GetPlayerAchievements/v1/", {
        appid: a.appId,
        steamid: await resolveSteamId(c, a.steamId),
        l: a.language ?? "english",
      })) as any).playerstats,
  },
  {
    name: "steam.getUserStatsForGame",
    doc: "A player's stat counters and achievements for one game.",
    params: `{ appId: number; ${SID} }`,
    impl: async (c, a) =>
      ((await web(c, "/ISteamUserStats/GetUserStatsForGame/v2/", {
        appid: a.appId,
        steamid: await resolveSteamId(c, a.steamId),
      })) as any).playerstats,
  },
  {
    name: "steam.getGlobalAchievementPercentages",
    doc: "Global unlock percentage of every achievement in a game.",
    params: "{ appId: number }",
    impl: async (c, a) =>
      ((await web(c, "/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/", { gameid: a.appId }, false)) as any).achievementpercentages
        .achievements,
  },
  {
    name: "steam.getSchemaForGame",
    doc: "Achievement and stat definitions for a game.",
    params: "{ appId: number; language?: string }",
    impl: async (c, a) =>
      ((await web(c, "/ISteamUserStats/GetSchemaForGame/v2/", { appid: a.appId, l: a.language ?? "english" })) as any).game,
  },
  {
    name: "steam.getCurrentPlayers",
    doc: "Number of players currently in a game.",
    params: "{ appId: number }",
    impl: async (c, a) =>
      ((await web(c, "/ISteamUserStats/GetNumberOfCurrentPlayers/v1/", { appid: a.appId }, false)) as any).response.player_count,
  },
  {
    name: "steam.getNewsForApp",
    doc: "Latest news items for a game.",
    params: "{ appId: number; count?: number; maxLength?: number }",
    impl: async (c, a) =>
      ((await web(c, "/ISteamNews/GetNewsForApp/v2/", { appid: a.appId, count: a.count ?? 5, maxlength: a.maxLength ?? 500 }, false)) as any)
        .appnews.newsitems,
  },
  {
    name: "steam.getAppList",
    doc: "Paged list of store apps (id and name). Use lastAppId from the previous page to continue.",
    params: "{ maxResults?: number; lastAppId?: number; includeGames?: boolean; includeDlc?: boolean }",
    impl: async (c, a) =>
      ((await web(c, "/IStoreService/GetAppList/v1/", {
        max_results: a.maxResults ?? 1000,
        last_appid: a.lastAppId,
        include_games: a.includeGames === false ? 0 : 1,
        include_dlc: a.includeDlc ? 1 : 0,
      })) as any).response,
  },
  {
    name: "store.getAppDetails",
    doc: "Store page data for one app: description, price, genres, requirements, etc.",
    params: "{ appId: number; country?: string; language?: string }",
    impl: async (c, a) => {
      const r: any = await store(c, "/api/appdetails", { appids: a.appId, cc: a.country ?? "us", l: a.language ?? "english" });
      const e = r?.[String(a.appId)];
      if (!e?.success) throw new Error(`No store data for app ${a.appId}`);
      return e.data;
    },
  },
  {
    name: "store.getPrices",
    doc: "Price overview for several apps (max ~100) in one call. Returns a map appId -> price_overview.",
    params: "{ appIds: number[]; country?: string }",
    impl: async (c, a) => {
      const r: any = await store(c, "/api/appdetails", { appids: (a.appIds as number[]).join(","), cc: a.country ?? "us", filters: "price_overview" });
      return Object.fromEntries(Object.entries(r).map(([k, v]: [string, any]) => [k, v?.success ? v.data?.price_overview ?? null : null]));
    },
  },
  {
    name: "store.search",
    doc: "Search the store by term.",
    params: "{ term: string; country?: string; language?: string }",
    impl: async (c, a) =>
      ((await store(c, "/api/storesearch/", { term: a.term, cc: a.country ?? "us", l: a.language ?? "english" })) as any).items,
  },
  {
    name: "store.getReviews",
    doc: "Review summary and a page of reviews for an app (IUserReviewsService; the old /appreviews endpoint was retired). Pass the returned cursor to get the next page.",
    params: "{ appId: number; filter?: 'recent'|'updated'|'all'; language?: string; numPerPage?: number; reviewType?: 'all'|'positive'|'negative'; cursor?: string }",
    impl: async (c, a) => {
      const filterMap: Record<string, number> = { all: 0, recent: 1, updated: 2 };
      const reviewTypeMap: Record<string, number> = { all: 0, positive: 1, negative: 2 };
      return ((await web(
        c,
        "/IUserReviewsService/GetAppReviews/v1/",
        {
          appid: Number(a.appId),
          filter: filterMap[a.filter ?? "recent"] ?? 1,
          language: a.language ?? "english",
          num_per_page: a.numPerPage ?? 20,
          review_type: reviewTypeMap[a.reviewType ?? "all"] ?? 0,
          purchase_type: 0,
          cursor: a.cursor,
        },
        false,
      )) as any).response;
    },
  },
  {
    name: "store.getFeatured",
    doc: "Featured categories (specials, top sellers, new releases, coming soon).",
    params: "{ country?: string; language?: string }",
    impl: async (c, a) => store(c, "/api/featuredcategories", { cc: a.country ?? "us", l: a.language ?? "english" }),
  },
  // ---- raw, schema-driven escape hatch (GET methods only) ----
  {
    name: "steam.raw.listMethods",
    doc: "List every GET method exposed by the Steam Web API (from GetSupportedAPIList). Optionally filter by substring.",
    params: "{ filter?: string }",
    impl: async (c, a) => {
      const all = await rawIndex(c);
      const f = String(a.filter ?? "").toLowerCase();
      return all.filter((m) => !f || `${m.interface}/${m.method}`.toLowerCase().includes(f));
    },
  },
  {
    name: "steam.raw.call",
    doc: "Call any read-only (GET) Steam Web API method discovered via steam.raw.listMethods. Returns the parsed JSON.",
    params: "{ interface: string; method: string; version?: number; params?: Record<string, string|number|boolean> }",
    impl: async (c, a) => {
      const all = await rawIndex(c);
      const m = all.find(
        (x) => x.interface === a.interface && x.method === a.method && (a.version === undefined || x.version === a.version),
      );
      if (!m) throw new Error(`Unknown or non-GET method ${a.interface}/${a.method}`);
      return web(c, `/${m.interface}/${m.method}/v${m.version}/`, a.params ?? {});
    },
  },
];

interface RawMethod { interface: string; method: string; version: number; params: string[] }

async function rawIndex(c: Ctx): Promise<RawMethod[]> {
  const r: any = await web(c, "/ISteamWebAPIUtil/GetSupportedAPIList/v1/");
  const out: RawMethod[] = [];
  for (const i of r.apilist.interfaces as any[]) {
    for (const m of i.methods as any[]) {
      if (m.httpmethod !== "GET") continue; // read-only guarantee
      out.push({ interface: i.name, method: m.name, version: m.version, params: (m.parameters ?? []).map((p: any) => p.name) });
    }
  }
  return out;
}

/** TypeScript declarations shown to the LLM through the search_api tool. */
export function renderDeclarations(): string {
  const groups: Record<string, string[]> = {};
  for (const m of METHODS) {
    const parts = m.name.split(".");
    const method = parts.pop()!;
    const ns = parts.join(".");
    (groups[ns] ??= []).push(`  /** ${m.doc} */\n  ${method}(args: ${m.params}): Promise<any>;`);
  }
  return Object.entries(groups)
    .map(([ns, lines]) => `// ${ns}\n${lines.join("\n")}`)
    .join("\n\n");
}
