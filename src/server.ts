import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { loadConfig, type Config } from "./config.js";
import { runInSandbox } from "./sandbox.js";
import { METHODS, renderDeclarations, type Ctx } from "./steam/sdk.js";
import { SteamHttp, type Fetcher } from "./steam/http.js";

const MAX_OUTPUT_CHARS = 100_000;

export interface ServerDeps {
  config?: Config;
  fetcher?: Fetcher;
}

export function createServer(deps: ServerDeps = {}): McpServer {
  const config = deps.config ?? loadConfig();
  const http = new SteamHttp(config.apiKey, config.cacheTtlMs, deps.fetcher);
  const ctx: Ctx = { http, cfg: config };
  const byName = new Map(METHODS.map((m) => [m.name, m]));
  const declarations = renderDeclarations();

  const server = new McpServer({ name: "steam-mcp", version: "0.1.0" });

  server.registerTool(
    "search_api",
    {
      title: "Search Steam SDK",
      description:
        "Search the typed Steam SDK available inside execute_code. Returns TypeScript declarations of matching methods. " +
        "Call with an empty query to list everything. Use this before writing code.",
      inputSchema: { query: z.string().describe("Keywords, e.g. 'achievements' or 'price'. Empty for all.") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    async ({ query }) => {
      const q = query.trim().toLowerCase();
      const blocks = declarations.split("\n\n");
      const out: string[] = [];
      for (const b of blocks) {
        const lines = b.split("\n");
        const header = lines[0];
        const matched: string[] = [];
        for (let i = 1; i < lines.length; i += 2) {
          const pair = `${lines[i]}\n${lines[i + 1]}`;
          if (!q || `${header} ${pair}`.toLowerCase().includes(q)) matched.push(pair);
        }
        if (matched.length) out.push(`${header}\n${matched.join("\n")}`);
      }
      const text = out.length
        ? `Globals available in execute_code (every method takes ONE args object and returns a Promise):\n\n${out.join("\n\n")}`
        : "No matching methods. Try an empty query to list all.";
      return { content: [{ type: "text", text }] };
    },
  );

  server.registerTool(
    "execute_code",
    {
      title: "Execute JavaScript against the Steam SDK",
      description:
        "Run JavaScript (async function body; use await and return a JSON-serialisable value) in a sandbox with `steam` and `store` globals. " +
        "Chain and aggregate many calls in one execution instead of calling tools repeatedly. " +
        "No network, filesystem or process access. Read-only. Limits: " +
        `${config.maxCallsPerExecution} SDK calls and ${config.executionTimeoutMs / 1000}s per execution. ` +
        "Use search_api first to see method signatures.",
      inputSchema: { code: z.string().describe("Async function body. Example: const g = await steam.getOwnedGames({}); return g.games.length;") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ code }) => {
      const r = await runInSandbox(code, {
        methodNames: METHODS.map((m) => m.name),
        timeoutMs: config.executionTimeoutMs,
        maxCalls: config.maxCallsPerExecution,
        host: async (name, args) => {
          const m = byName.get(name);
          if (!m) throw new Error(`Unknown SDK method ${name}`);
          return m.impl(ctx, args);
        },
      });
      let text = JSON.stringify(
        r.ok ? { result: r.result, logs: r.logs, sdkCalls: r.calls } : { error: r.error, logs: r.logs, sdkCalls: r.calls },
        null,
        2,
      );
      if (text.length > MAX_OUTPUT_CHARS) text = text.slice(0, MAX_OUTPUT_CHARS) + "\n…[truncated; return less data]";
      return { content: [{ type: "text", text }], isError: !r.ok };
    },
  );

  return server;
}
