/** Rate limiter + TTL cache + allowlisted fetch. All Steam traffic goes through here. */

export const ALLOWED_HOSTS = new Set(["api.steampowered.com", "store.steampowered.com"]);

export class TokenBucket {
  private tokens: number;
  private last = Date.now();
  constructor(private capacity: number, private refillPerSec: number) {
    this.tokens = capacity;
  }
  async take(): Promise<void> {
    for (;;) {
      const now = Date.now();
      this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refillPerSec);
      this.last = now;
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      await new Promise((r) => setTimeout(r, Math.ceil(((1 - this.tokens) / this.refillPerSec) * 1000)));
    }
  }
}

export class TtlCache {
  private m = new Map<string, { exp: number; v: unknown }>();
  constructor(private ttlMs: number, private max = 500) {}
  get(k: string): unknown {
    const e = this.m.get(k);
    if (!e) return undefined;
    if (e.exp < Date.now()) {
      this.m.delete(k);
      return undefined;
    }
    return e.v;
  }
  set(k: string, v: unknown): void {
    if (this.m.size >= this.max) this.m.delete(this.m.keys().next().value as string);
    this.m.set(k, { exp: Date.now() + this.ttlMs, v });
  }
}

export type Fetcher = typeof fetch;

export class SteamHttp {
  // Web API: generous. Store API: ~200 req / 5 min => 0.6/s with small burst.
  private web = new TokenBucket(20, 10);
  private store = new TokenBucket(10, 0.6);
  private cache: TtlCache;
  constructor(
    private apiKey: string | undefined,
    cacheTtlMs: number,
    private fetcher: Fetcher = fetch,
  ) {
    this.cache = new TtlCache(cacheTtlMs);
  }

  hasKey(): boolean {
    return !!this.apiKey;
  }

  async getJson(url: string, params: Record<string, unknown> = {}, opts: { key?: boolean } = {}): Promise<unknown> {
    const u = new URL(url);
    if (u.protocol !== "https:" || !ALLOWED_HOSTS.has(u.hostname)) {
      throw new Error(`Host not allowed: ${u.hostname}`);
    }
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) u.searchParams.set(k, String(v));
    }
    const cacheKey = u.toString(); // computed before the key is added
    const hit = this.cache.get(cacheKey);
    if (hit !== undefined) return hit;
    if (opts.key) {
      if (!this.apiKey) throw new Error("STEAM_API_KEY is not configured");
      u.searchParams.set("key", this.apiKey);
    }
    await (u.hostname === "store.steampowered.com" ? this.store : this.web).take();
    const res = await this.fetcher(u, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`Steam responded ${res.status} for ${u.pathname}`);
    const body = (await res.json()) as unknown;
    this.cache.set(cacheKey, body);
    return body;
  }
}
