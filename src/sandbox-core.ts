import { getQuickJS } from "quickjs-emscripten";

export type HostCall = (name: string, args: unknown) => Promise<unknown>;

export interface RunOptions {
  methodNames: string[];
  host: HostCall;
  timeoutMs: number;
  maxCalls: number;
  memoryLimitBytes?: number;
  onLog?: (line: string) => void;
}

export interface RunResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  logs: string[];
  calls: number;
}

/** Build the JS prelude that exposes `steam.*` / `store.*` backed by the single host bridge. */
function prelude(names: string[]): string {
  const tree: Record<string, any> = {};
  for (const n of names) {
    const parts = n.split(".");
    let cur = tree;
    parts.slice(0, -1).forEach((p) => (cur = cur[p] ??= {}));
    cur[parts[parts.length - 1]] = n;
  }
  const emit = (node: any): string =>
    "{" +
    Object.entries(node)
      .map(([k, v]) => `${JSON.stringify(k)}: ${typeof v === "string" ? `(a) => __invoke(${JSON.stringify(v)}, a)` : emit(v)}`)
      .join(",") +
    "}";
  return `
const __invoke = (n, a) => __call(n, JSON.stringify(a === undefined ? {} : a)).then((s) => JSON.parse(s));
${Object.entries(tree).map(([k, v]) => `globalThis.${k} = ${emit(v)};`).join("\n")}
globalThis.console = { log: (...a) => __log(a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")) };
globalThis.console.info = globalThis.console.warn = globalThis.console.error = globalThis.console.log;
`;
}

export async function runCore(code: string, o: RunOptions): Promise<RunResult> {
  const QuickJS = await getQuickJS();
  const rt = QuickJS.newRuntime();
  rt.setMemoryLimit(o.memoryLimitBytes ?? 64 * 1024 * 1024);
  rt.setMaxStackSize(512 * 1024);
  const deadline = Date.now() + o.timeoutMs;
  rt.setInterruptHandler(() => Date.now() > deadline);
  const vm = rt.newContext();
  const logs: string[] = [];
  let calls = 0;
  const pending = new Set<Promise<void>>();
  let disposed = false;

  const pump = () => {
    if (!disposed) rt.executePendingJobs();
  };

  const logFn = vm.newFunction("__log", (h) => {
    if (logs.length < 200) {
      const line = vm.getString(h).slice(0, 4000);
      logs.push(line);
      o.onLog?.(line);
    }
  });
  vm.setProp(vm.global, "__log", logFn);
  logFn.dispose();

  const callFn = vm.newFunction("__call", (nameH, argsH) => {
    const name = vm.getString(nameH);
    const args = vm.getString(argsH);
    const deferred = vm.newPromise();
    const settle = (fn: () => void) => {
      if (disposed) return;
      fn();
      pump();
    };
    const task: Promise<void> = (async () => {
      try {
        if (++calls > o.maxCalls) throw new Error(`Call limit exceeded (${o.maxCalls} per execution)`);
        const res = await o.host(name, JSON.parse(args));
        const s = JSON.stringify(res === undefined ? null : res);
        settle(() => {
          const h = vm.newString(s);
          deferred.resolve(h);
          h.dispose();
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        settle(() => {
          const h = vm.newError(msg);
          deferred.reject(h);
          h.dispose();
        });
      }
    })().finally(() => pending.delete(task));
    pending.add(task);
    return deferred.handle;
  });
  vm.setProp(vm.global, "__call", callFn);
  callFn.dispose();

  const finish = (r: Omit<RunResult, "logs" | "calls">): RunResult => {
    disposed = true;
    try {
      vm.dispose();
      rt.dispose();
    } catch {
      /* ignore */
    }
    return { ...r, logs, calls };
  };

  try {
    const pre = vm.evalCode(prelude(o.methodNames));
    if (pre.error) {
      const e = vm.dump(pre.error);
      pre.error.dispose();
      return finish({ ok: false, error: `prelude: ${JSON.stringify(e)}` });
    }
    pre.value.dispose();

    const wrapped = `globalThis.__out = undefined;
(async () => {\n${code}\n})().then(
  (v) => { globalThis.__out = JSON.stringify({ ok: true, v: v === undefined ? null : v }); },
  (e) => { globalThis.__out = JSON.stringify({ ok: false, e: (e && e.message !== undefined) ? (e.name + ": " + e.message) : String(e) }); }
);`;
    const run = vm.evalCode(wrapped, "user-code.js");
    if (run.error) {
      const e = vm.dump(run.error);
      run.error.dispose();
      return finish({ ok: false, error: typeof e === "object" ? `${e.name}: ${e.message}` : String(e) });
    }
    run.value.dispose();

    for (;;) {
      pump();
      const out = vm.getProp(vm.global, "__out");
      const s = vm.typeof(out) === "string" ? vm.getString(out) : undefined;
      out.dispose();
      if (s) {
        const p = JSON.parse(s);
        if (!p.ok && (/interrupted/i.test(p.e) || Date.now() > deadline)) {
          return finish({ ok: false, error: `Execution timed out after ${o.timeoutMs}ms` });
        }
        return finish(p.ok ? { ok: true, result: p.v } : { ok: false, error: p.e });
      }
      if (Date.now() > deadline) return finish({ ok: false, error: `Execution timed out after ${o.timeoutMs}ms` });
      if (pending.size === 0) {
        return finish({ ok: false, error: "Execution stalled: code returned an unresolved promise" });
      }
      await Promise.race([
        Promise.race(pending),
        new Promise((r) => setTimeout(r, Math.max(1, deadline - Date.now()))),
      ]);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return finish({ ok: false, error: /interrupted/i.test(msg) ? `Execution timed out after ${o.timeoutMs}ms` : msg });
  }
}
