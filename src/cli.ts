#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CONFIG_PATH, loadConfig, readFileConfig, saveFileConfig } from "./config.js";
import { createHttpApp } from "./http.js";
import { createServer } from "./server.js";

const [cmd = "stdio", ...rest] = process.argv.slice(2);

async function main() {
  switch (cmd) {
    case "stdio": {
      const server = createServer();
      await server.connect(new StdioServerTransport());
      console.error("steam-mcp: stdio ready");
      break;
    }
    case "http": {
      const cfg = loadConfig();
      const app = createHttpApp(cfg);
      app.listen(cfg.port, cfg.host, () => console.error(`steam-mcp: http://${cfg.host}:${cfg.port}/mcp`));
      break;
    }
    case "config": {
      const [sub, value] = rest;
      if (sub === "set-steam-id" && value) {
        saveFileConfig({ steamId: value });
        console.log(`Saved default Steam ID to ${CONFIG_PATH}`);
      } else if (sub === "show") {
        console.log(JSON.stringify({ path: CONFIG_PATH, ...readFileConfig() }, null, 2));
      } else {
        console.error("usage: steam-mcp config set-steam-id <id|vanity> | config show");
        process.exit(2);
      }
      break;
    }
    default:
      console.error("usage: steam-mcp [stdio|http|config]");
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
