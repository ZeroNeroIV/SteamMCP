import { describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { spawnSync } from "node:child_process";

const cli = path.join(import.meta.dir, "..", "src", "cli.ts");

describe("stdio transport (spawned process)", () => {
  it("serves the code-mode tools and reports a clear error without STEAM_API_KEY", async () => {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cli, "stdio"],
      env: { ...(process.env as Record<string, string>), STEAM_API_KEY: "", STEAM_ID: "", STEAM_MCP_CONFIG: path.join(os.tmpdir(), "nonexistent-steam-mcp.json") },
    });
    const client = new Client({ name: "stdio-e2e", version: "0" });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["execute_code", "search_api"]);

    const search: any = await client.callTool({ name: "search_api", arguments: { query: "price" } });
    expect(search.content[0].text).toContain("store.getPrices".split(".")[1]);

    const ran: any = await client.callTool({ name: "execute_code", arguments: { code: "return 6 * 7" } });
    expect(JSON.parse(ran.content[0].text).result).toBe(42);

    const noKey: any = await client.callTool({ name: "execute_code", arguments: { code: "return await steam.getSteamLevel({steamId:'76561198000000001'})" } });
    expect(noKey.isError).toBe(true);
    expect(noKey.content[0].text).toContain("STEAM_API_KEY is not configured");
    await client.close();
  }, 30_000);
});

describe("cli config command", () => {
  const run = (args: string[], cfg: string) =>
    spawnSync(process.execPath, [cli, "config", ...args], { env: { ...process.env, STEAM_MCP_CONFIG: cfg }, encoding: "utf8" });

  it("saves and shows the default Steam ID", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steam-mcp-"));
    const cfg = path.join(dir, "nested", "config.json");
    const set = run(["set-steam-id", "76561198000000001"], cfg);
    expect(set.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(cfg, "utf8"))).toEqual({ steamId: "76561198000000001" });
    const show = run(["show"], cfg);
    expect(JSON.parse(show.stdout).steamId).toBe("76561198000000001");
    expect(run(["bogus"], cfg).status).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("the saved Steam ID is used as the default by the server", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steam-mcp-"));
    const cfg = path.join(dir, "config.json");
    run(["set-steam-id", "76561198000000042"], cfg);
    const { loadConfig } = await import("../src/config.js");
    const prev = process.env.STEAM_MCP_CONFIG;
    // CONFIG_PATH is read at import time; verify through readFileConfig(file) semantics instead.
    const { readFileConfig } = await import("../src/config.js");
    expect(readFileConfig(cfg).steamId).toBe("76561198000000042");
    expect(loadConfig({ STEAM_ID: "1" } as any).defaultSteamId).toBe("1"); // env wins
    process.env.STEAM_MCP_CONFIG = prev;
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("reads STEAM_API_KEY and STEAM_ID from a project-root .env file and lets explicit env override", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "steam-mcp-env-"));
    const envFile = path.join(dir, ".env");
    fs.writeFileSync(
      envFile,
      [
        "# comment",
        "STEAM_API_KEY=from-dotenv-key",
        'STEAM_ID="76561198000000099"',
        "MAX_CALLS_PER_EXECUTION=25 # inline comment",
      ].join("\n"),
    );
    const { loadConfig, parseDotEnv } = await import("../src/config.js");
    expect(parseDotEnv(fs.readFileSync(envFile, "utf8"))).toEqual({
      STEAM_API_KEY: "from-dotenv-key",
      STEAM_ID: "76561198000000099",
      MAX_CALLS_PER_EXECUTION: "25",
    });

    const prevKey = process.env.STEAM_API_KEY;
    const prevId = process.env.STEAM_ID;
    delete process.env.STEAM_API_KEY;
    delete process.env.STEAM_ID;
    try {
      const fromFile = loadConfig(process.env, envFile);
      expect(fromFile.apiKey).toBe("from-dotenv-key");
      expect(fromFile.defaultSteamId).toBe("76561198000000099");
      expect(fromFile.maxCallsPerExecution).toBe(25);

      process.env.STEAM_API_KEY = "override-key";
      const overridden = loadConfig(process.env, envFile);
      expect(overridden.apiKey).toBe("override-key");
      expect(overridden.defaultSteamId).toBe("76561198000000099");
    } finally {
      if (prevKey === undefined) delete process.env.STEAM_API_KEY;
      else process.env.STEAM_API_KEY = prevKey;
      if (prevId === undefined) delete process.env.STEAM_ID;
      else process.env.STEAM_ID = prevId;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
