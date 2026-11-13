import { describe, expect, it } from "bun:test";
import { runInSandbox } from "../src/sandbox.js";

const base = {
  methodNames: ["steam.echo", "steam.raw.echo"],
  timeoutMs: 3000,
  maxCalls: 5,
  host: (async (name: string, args: any): Promise<unknown> => ({ name, args })) as (name: string, args: any) => Promise<unknown>,
};
const run = (code: string, o: Partial<typeof base> = {}) => runInSandbox(code, { ...base, ...o });

describe("sandbox", () => {
  it("runs code and calls the SDK bridge", async () => {
    const r = await run(`const a = await steam.echo({x:1}); const b = await steam.raw.echo({}); return [a.args.x, b.name];`);
    expect(r).toMatchObject({ ok: true, result: [1, "steam.raw.echo"], calls: 2 });
  });
  it("captures console.log", async () => {
    const r = await run(`console.log("hi", {a:1}); return 1`);
    expect(r.logs).toEqual(['hi {"a":1}']);
  });
  it("propagates host errors as catchable exceptions", async () => {
    const r = await run(`try { await steam.echo({}); } catch(e) { return e.message }`, {
      host: async () => {
        throw new Error("boom");
      },
    });
    expect(r.result).toBe("boom");
  });
  it("enforces the per-execution call cap", async () => {
    const r = await run(`for (let i=0;i<10;i++) await steam.echo({}); return 1`, { maxCalls: 3 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/Call limit exceeded/);
  });
  it("kills infinite loops", async () => {
    const r = await run(`while(true){}`, { timeoutMs: 300 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/timed out/i);
  });
  it("reports syntax errors", async () => {
    const r = await run(`return (`);
    expect(r.ok).toBe(false);
  });
});

describe("sandbox escape attempts", () => {
  const probes = [
    "typeof process", "typeof require", "typeof fetch", "typeof XMLHttpRequest", "typeof WebSocket",
    "typeof Buffer", "typeof module", "typeof globalThis.global", "typeof setTimeout", "typeof importScripts",
  ];
  it.each(probes)("%s is undefined", async (p) => {
    const r = await run(`return ${p}`);
    expect(r.result).toBe("undefined");
  });
  it("cannot import modules", async () => {
    const r = await run(`const m = await import("node:fs"); return Object.keys(m)`);
    expect(r.ok).toBe(false);
  });
  it("cannot reach host via constructor chain", async () => {
    const r = await run(`return (function(){}).constructor("return typeof process")()`);
    expect(r.result).toBe("undefined");
  });
  it("cannot reach host bridge internals to call arbitrary host names", async () => {
    // __call exists but host rejects unknown names; the real server host does this.
    const r = await run(`return await __call("fs.readFile", "{}")`, {
      host: async (n) => {
        if (n !== "steam.echo") throw new Error("Unknown SDK method " + n);
        return 1;
      },
    }).catch((e) => ({ ok: false, error: String(e) }));
    expect(r.ok).toBe(false);
  });
  it("memory bombs / native-heavy loops are hard-killed on time without stalling the host", async () => {
    const t = Date.now();
    // Meanwhile the host event loop must stay responsive.
    let ticks = 0;
    const iv = setInterval(() => ticks++, 50);
    const r = await run(`const a=[]; while(true) a.push("x".repeat(1e6));`, { timeoutMs: 1500 });
    clearInterval(iv);
    expect(r.ok).toBe(false);
    expect(Date.now() - t).toBeLessThan(1500 + 1000 + 1500);
    expect(ticks).toBeGreaterThan(10);
  }, 20_000);
  it("memory limit stops fast allocators", async () => {
    const r = await run(`const a=[]; while(true) a.push({x:1,y:[1,2,3],z:"abc"});`, { timeoutMs: 8000 });
    expect(r.ok).toBe(false);
  }, 20_000);
  it("sandbox runs are isolated from each other", async () => {
    await run(`globalThis.leak = 42; return 1`);
    const r = await run(`return typeof globalThis.leak`);
    expect(r.result).toBe("undefined");
  });
  it("host calls can run concurrently via Promise.all", async () => {
    const r = await run(`const xs = await Promise.all([1,2,3].map(i => steam.echo({i}))); return xs.map(x => x.args.i)`);
    expect(r.result).toEqual([1, 2, 3]);
  });
  it("large results survive the worker boundary", async () => {
    const r = await run(`return (await steam.echo({big: "y".repeat(500000)})).args.big.length`);
    expect(r.result).toBe(500000);
  });
});
