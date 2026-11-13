import { parentPort, workerData } from "node:worker_threads";
import { runCore, type HostCall } from "./sandbox-core.js";

/** Runs inside a Worker so the main thread can hard-kill runaway code (terminate()). */
const port = parentPort!;
const { code, opts } = workerData as { code: string; opts: { methodNames: string[]; timeoutMs: number; maxCalls: number; memoryLimitBytes?: number } };

let nextId = 0;
const waiting = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

port.on("message", (m: { type: "result"; id: number; ok: boolean; value?: unknown; error?: string }) => {
  const w = waiting.get(m.id);
  if (!w) return;
  waiting.delete(m.id);
  if (m.ok) w.resolve(m.value);
  else w.reject(new Error(m.error ?? "host error"));
});

const host: HostCall = (name, args) =>
  new Promise((resolve, reject) => {
    const id = nextId++;
    waiting.set(id, { resolve, reject });
    port.postMessage({ type: "call", id, name, args });
  });

runCore(code, { ...opts, host, onLog: (line) => port.postMessage({ type: "log", line }) }).then(
  (result) => port.postMessage({ type: "done", result }),
  (e) => port.postMessage({ type: "done", result: { ok: false, error: e instanceof Error ? e.message : String(e), logs: [], calls: 0 } }),
);
