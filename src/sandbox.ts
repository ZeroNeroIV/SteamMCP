import { Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { HostCall, RunOptions, RunResult } from "./sandbox-core.js";

export type { HostCall, RunOptions, RunResult } from "./sandbox-core.js";

/** Extra time (ms) the worker gets after the deadline to report a clean timeout before being killed. */
const KILL_GRACE_MS = 1000;

const workerFile = fileURLToPath(new URL("./sandbox-worker.ts", import.meta.url));

/**
 * Execute untrusted code in a QuickJS sandbox living in a worker thread.
 * The worker is terminated hard at deadline + grace, so even native-heavy loops that never
 * hit QuickJS's interrupt checks cannot stall the server.
 */
export function runInSandbox(code: string, o: RunOptions): Promise<RunResult> {
  return new Promise<RunResult>((resolve) => {
    const logs: string[] = [];
    let calls = 0;
    let settled = false;

    const worker = new Worker(workerFile, {
      workerData: {
        code,
        opts: {
          methodNames: o.methodNames,
          timeoutMs: o.timeoutMs,
          maxCalls: o.maxCalls,
          memoryLimitBytes: o.memoryLimitBytes,
        },
      },
    });

    const finish = (r: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(killTimer);
      void worker.terminate();
      resolve(r);
    };

    const killTimer = setTimeout(
      () => finish({ ok: false, error: `Execution timed out after ${o.timeoutMs}ms`, logs, calls }),
      o.timeoutMs + KILL_GRACE_MS,
    );

    worker.on("message", async (m: any) => {
      if (m.type === "log") {
        if (logs.length < 200) logs.push(m.line);
      } else if (m.type === "call") {
        calls++;
        // The worker enforces maxCalls too; this is defence in depth against a modified worker.
        if (calls > o.maxCalls + 1) return;
        try {
          const value = await o.host(m.name, m.args);
          if (!settled) worker.postMessage({ type: "result", id: m.id, ok: true, value: value === undefined ? null : value });
        } catch (e) {
          if (!settled) worker.postMessage({ type: "result", id: m.id, ok: false, error: e instanceof Error ? e.message : String(e) });
        }
      } else if (m.type === "done") {
        finish({ ...(m.result as RunResult), logs: (m.result as RunResult).logs.length ? (m.result as RunResult).logs : logs, calls: Math.max(calls, (m.result as RunResult).calls) });
      }
    });
    worker.on("error", (e: unknown) => finish({ ok: false, error: `Sandbox crashed: ${e instanceof Error ? e.message : String(e)}`, logs, calls }));
    worker.on("exit", (code) => finish({ ok: false, error: `Sandbox exited unexpectedly (code ${code})`, logs, calls }));
  });
}
