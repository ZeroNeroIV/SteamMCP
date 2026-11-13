import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT_ENV_PATH = fileURLToPath(new URL("../.env", import.meta.url));

export const CONFIG_PATH =
  process.env.STEAM_MCP_CONFIG ?? path.join(os.homedir(), ".steam-mcp", "config.json");

interface FileConfig {
  steamId?: string;
}

export function readFileConfig(file = CONFIG_PATH): FileConfig {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as FileConfig;
  } catch {
    return {};
  }
}

export function saveFileConfig(update: FileConfig, file = CONFIG_PATH): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ ...readFileConfig(file), ...update }, null, 2));
}

export interface Config {
  apiKey: string | undefined;
  defaultSteamId: string | undefined;
  maxCallsPerExecution: number;
  executionTimeoutMs: number;
  cacheTtlMs: number;
  host: string;
  port: number;
  authToken: string | undefined;
  allowedOrigins: string[];
  /** Public https base URL of this server (OAuth issuer). Derived from the request if unset. */
  publicUrl: string | undefined;
  /** Optional separate HMAC secret for OAuth artefacts (defaults to a key derived from authToken). */
  oauthSecret: string | undefined;
  /** Optional static OAuth client (for Gemini "Advanced features" when DCR is unavailable). */
  oauthClientId: string | undefined;
  oauthClientSecret: string | undefined;
  /** Extra redirect URI hosts allowed besides google.com / googleusercontent.com ("*" = any https). */
  allowedRedirectHosts: string[];
}

export function isLoopback(host: string): boolean {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

const list = (s: string | undefined) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

/** Parse a .env file (KEY=VALUE, optional quotes, # comments). */
export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, "");
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    } else {
      val = val.replace(/\s+#.*$/, "").trim();
    }
    if (key) out[key] = val;
  }
  return out;
}

function readDotEnv(file = ROOT_ENV_PATH): Record<string, string> {
  try {
    return parseDotEnv(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, dotEnvFile = ROOT_ENV_PATH): Config {
  // Always check the project root .env when using process.env (so stdio works regardless of cwd).
  // Explicit env vars (including "" in tests) win over .env.
  const merged: Record<string, string | undefined> =
    env === process.env ? { ...readDotEnv(dotEnvFile), ...env } : env;
  const cfg: Config = {
    apiKey: merged.STEAM_API_KEY || undefined,
    // env / .env wins; otherwise the value saved with `steam-mcp config set-steam-id`
    defaultSteamId: merged.STEAM_ID !== undefined ? (merged.STEAM_ID || undefined) : readFileConfig().steamId,
    maxCallsPerExecution: Number(merged.MAX_CALLS_PER_EXECUTION ?? 50),
    executionTimeoutMs: Number(merged.EXECUTION_TIMEOUT_MS ?? 30_000),
    cacheTtlMs: Number(merged.CACHE_TTL_MS ?? 60_000),
    host: merged.HOST ?? "127.0.0.1",
    port: Number(merged.PORT ?? 8080),
    authToken: merged.MCP_AUTH_TOKEN || undefined,
    allowedOrigins: list(merged.ALLOWED_ORIGINS),
    publicUrl: merged.PUBLIC_URL || undefined,
    oauthSecret: merged.OAUTH_SECRET || undefined,
    oauthClientId: merged.OAUTH_CLIENT_ID || undefined,
    oauthClientSecret: merged.OAUTH_CLIENT_SECRET || undefined,
    allowedRedirectHosts: list(merged.ALLOWED_REDIRECT_HOSTS),
  };
  return cfg;
}
