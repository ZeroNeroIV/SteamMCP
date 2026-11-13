# SteamMCP

A **Code Mode** [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server for Steam, running on **Bun**.

Instead of exposing dozens of separate tools, `SteamMCP` exposes two:

| Tool | Purpose |
|---|---|
| `search_api` | Returns TypeScript declarations for matching Steam & Store SDK methods. |
| `execute_code` | Runs JavaScript in an isolated QuickJS (WASM + worker thread) sandbox with `steam` and `store` globals. |

The model writes a single script that chains, filters, and aggregates many calls in one turn:

```js
const { games } = await steam.getOwnedGames({});
const top = games.sort((a, b) => b.playtime_forever - a.playtime_forever).slice(0, 5);
const prices = await store.getPrices({ appIds: top.map((g) => g.appid) });
return top.map((g) => ({
  name: g.name,
  hours: Math.round((g.playtime_forever / 60) * 10) / 10,
  price: prices[g.appid]?.final_formatted ?? "Free / N/A",
}));
```

## Features

- **Curated SDK + Raw Escape Hatch**: 20+ typed wrappers (`steam.*` and `store.*`) plus `steam.raw.listMethods` and `steam.raw.call` backed by Steam's `GetSupportedAPIList` (restricted to `GET` methods).
- **Isolated Sandbox**: QuickJS (WASM) inside a `worker_threads` worker with no network, filesystem, or process access; 64 MB memory cap; 50 SDK calls/execution; and hard worker termination on timeout.
- **Rate Limiting & Caching**: Separate token-bucket limiters for the Steam Web API and Store API, plus a 60 s in-memory TTL cache per request.
- **Dual Transports**: `stdio` for local clients and stateless Streamable HTTP (`/mcp`) for remote hosting.
- **Multi-User OAuth 2.1 for Gemini Apps**: Built-in RFC 8414 / RFC 9728 discovery, Dynamic Client Registration (RFC 7591), PKCE (`S256`), and refresh tokens. Each user enters their own Steam Web API key and Steam ID on `/authorize`, which are AES-256-GCM encrypted inside their token—zero database, zero cross-user leakage.
- **Gemini-Compatible Schemas**: Flat `object`/`string` tool schemas (no `$ref`, `anyOf`, or `oneOf`).

## Quick Start

```powershell
git clone https://github.com/ZeroNeroIV/SteamMCP.git
cd SteamMCP
bun install
```

Copy [`.env.example`](.env.example) to `.env` and add your Steam Web API key ([get one here](https://steamcommunity.com/dev/apikey)) and Steam ID:

```dotenv
STEAM_API_KEY=your-steam-web-api-key
STEAM_ID=76561198000000001
```

`.env` is gitignored, dockerignored, and loaded automatically regardless of the current working directory. Alternatively, save a default Steam ID to `~/.steam-mcp/config.json`:

```powershell
bun src/cli.ts config set-steam-id <id-or-vanity>
```

> Steam profiles, game details, and friends lists must be **Public** in Steam Privacy Settings for owned-games, achievements, and friend queries.

## Connect to Clients

### Gemini Apps (Web & Mobile Custom Connected App)
1. Expose the HTTP server over HTTPS:
   - **Free on your PC (Cloudflare Quick Tunnel, $0):**
     ```powershell
     .\deploy\tunnel.ps1
     ```
   - **Cloud Run:**
     ```powershell
     .\deploy\cloudrun.ps1 -Project <gcp-project-id> -Region us-central1
     ```
2. In **Gemini (`gemini.google.com/apps`) → Settings → Connected Apps → Add a custom app**, enter `https://<your-host>/mcp`.
3. On the **Connect to Steam MCP** page, enter your Steam Web API key and (optionally) your Steam ID or vanity name. Each user who connects gets their own isolated session encrypted in their OAuth token.

### Gemini CLI / Antigravity
Local (`stdio`):
```json
{
  "mcpServers": {
    "steam": {
      "command": "bun",
      "args": ["D:/Projects/SteamMCP/src/cli.ts", "stdio"]
    }
  }
}
```
*(Reads `STEAM_API_KEY` and `STEAM_ID` from `.env`, or you can pass them in `"env"`.)*

Remote (Streamable HTTP with owner bearer token `MCP_AUTH_TOKEN`):
```json
{
  "mcpServers": {
    "steam": {
      "httpUrl": "https://YOUR-HOST/mcp",
      "headers": {
        "Authorization": "Bearer <MCP_AUTH_TOKEN>"
      }
    }
  }
}
```
*(Antigravity uses `"serverUrl"` instead of `"httpUrl"`.)*

### Gemini API
Point your remote MCP configuration at `https://YOUR-HOST/mcp` with `Authorization: Bearer <MCP_AUTH_TOKEN>`.

## Configuration

| Variable | Description |
|---|---|
| `STEAM_API_KEY` | Steam Web API key for `stdio` and static owner bearer requests. |
| `STEAM_ID` | Default Steam ID (17-digit or vanity) for `stdio` and static bearer requests. |
| `MCP_AUTH_TOKEN` | Owner bearer token & default OAuth encryption/signing secret. **Required when `HOST` is not loopback.** |
| `OAUTH_SECRET` | Optional separate secret for OAuth AES-256-GCM tokens/codes. |
| `OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` | Optional static OAuth client credentials (for Gemini "Advanced features"). |
| `HOST` / `PORT` | HTTP bind address and port (default `127.0.0.1:8080`). |
| `PUBLIC_URL` | Public HTTPS base URL (OAuth issuer). Derived from `X-Forwarded-Proto` + `Host` if unset. |
| `ALLOWED_ORIGINS` | Comma-separated browser origins permitted on HTTP. |
| `ALLOWED_REDIRECT_HOSTS` | Extra OAuth redirect hosts besides `google.com`, `googleusercontent.com`, and loopback. |
| `MAX_CALLS_PER_EXECUTION` | Max SDK calls per `execute_code` run (default `50`). |
| `EXECUTION_TIMEOUT_MS` | Sandbox execution timeout in ms (default `30000`). |
| `CACHE_TTL_MS` | In-memory response cache TTL in ms (default `60000`). |

## Tests

```powershell
bun run typecheck                                  # TypeScript check
bun run test                                       # Unit, sandbox-escape, OAuth, HTTP, and stdio tests
$env:STEAM_LIVE="1"; bun run test:integration      # Live keyless Steam endpoints
bun run test:integration                           # All live Steam endpoints (uses .env STEAM_API_KEY/STEAM_ID)
```

## License

[MIT](LICENSE)
