import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Everything an app can set when it runs the server. Each setting can come
 * from (highest wins) a command-line flag, an environment variable, a JSON
 * config file, or the default. See docs/embedding.md.
 */
export interface SKaupatConfig {
  /** live: real S-kaupat. demo: built-in sample stores and products, no network, no account. */
  mode: "live" | "demo";
  /** browser: calls go from the server's own Edge/Chrome window (S-kaupat answers only its site). direct: plain HTTP. */
  transport: "browser" | "direct";
  /** Where the server keeps its browser profile, lock files and (if file-based) the login. */
  dataDir: string;
  /** The user's chosen store. */
  settingsFile: string;
  /** Where the login is kept: Windows Credential Manager, or a file only the user can read. */
  tokenStore: "credential-manager" | "file";
  /** Login file when tokenStore is file. */
  tokenFile: string;
  /** A Chromium-based browser to use instead of the installed Edge or Chrome. */
  browserPath: string | null;
  /** Page the login window opens. */
  loginUrl: string | null;
  /** A JSON catalogue for demo mode instead of the built-in one. */
  demoCatalogueFile: string | null;
  /** Log every API request to stderr (never tokens). */
  debug: boolean;
  /** Serve MCP over HTTP on this port instead of stdio (null: stdio). 0 picks a free port. */
  httpPort: number | null;
  /** Address the HTTP server listens on. Loopback only unless the app really needs otherwise. */
  httpHost: string;
  /** Key every HTTP request must send as "Authorization: Bearer <key>". Required with httpPort. */
  accessKey: string | null;
  /** Whether place_order may place orders. An app that only wants lists and prices can turn it off. */
  ordering: boolean;
}

/** Names of the environment variables, for the docs and error messages. */
export const ENV = {
  config: "SKAUPAT_CONFIG",
  mode: "SKAUPAT_MODE",
  demo: "SKAUPAT_DEMO",
  transport: "SKAUPAT_TRANSPORT",
  dataDir: "SKAUPAT_DATA_DIR",
  settingsFile: "SKAUPAT_SETTINGS_FILE",
  tokenStore: "SKAUPAT_TOKEN_STORE",
  tokenFile: "SKAUPAT_TOKEN_FILE",
  browserPath: "SKAUPAT_BROWSER_PATH",
  loginUrl: "SKAUPAT_LOGIN_URL",
  demoCatalogueFile: "SKAUPAT_FIXTURES",
  debug: "SKAUPAT_DEBUG",
  httpPort: "SKAUPAT_HTTP_PORT",
  httpHost: "SKAUPAT_HTTP_HOST",
  accessKey: "SKAUPAT_ACCESS_KEY",
  ordering: "SKAUPAT_ORDERING",
} as const;

/** Shortest access key accepted for the HTTP server. */
export const MIN_ACCESS_KEY_LENGTH = 24;

export class ConfigError extends Error {
  override name = "ConfigError";
}

type Env = Record<string, string | undefined>;
type Partial_ = { -readonly [K in keyof SKaupatConfig]?: SKaupatConfig[K] };

export interface LoadConfigOptions {
  env?: Env;
  /** Command-line arguments after the program name. */
  argv?: string[];
  platform?: NodeJS.Platform;
}

export interface CliOptions {
  help: boolean;
  version: boolean;
}

/** Reads the settings from flags, environment and config file, in that order of precedence. */
export function loadConfig(options: LoadConfigOptions = {}): { config: SKaupatConfig; cli: CliOptions } {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const { values: flags, cli, configFile: flagConfigFile } = parseArgs(options.argv ?? []);
  const configFile = flagConfigFile ?? env[ENV.config] ?? null;
  const file = configFile ? readConfigFile(configFile) : {};
  const fromEnv = envValues(env);
  const merged: Partial_ = { ...file, ...fromEnv, ...flags };

  const explicitDataDir = merged.dataDir;
  const dataDir = resolve(explicitDataDir ?? defaultDataDir(env, platform));
  const tokenStore = merged.tokenStore ?? (platform === "win32" ? "credential-manager" : "file");
  const config: SKaupatConfig = {
    mode: merged.mode ?? "live",
    transport: merged.transport ?? "browser",
    dataDir,
    // With a data folder of its own, an app keeps everything in it; otherwise the store choice stays
    // where earlier versions saved it.
    settingsFile: resolve(merged.settingsFile ?? (explicitDataDir ? join(dataDir, "settings.json") : defaultSettingsPath(env, platform))),
    tokenStore,
    tokenFile: resolve(merged.tokenFile ?? join(dataDir, "refresh-token")),
    browserPath: merged.browserPath ?? null,
    loginUrl: merged.loginUrl ?? null,
    demoCatalogueFile: merged.demoCatalogueFile ?? null,
    debug: merged.debug ?? false,
    httpPort: merged.httpPort ?? null,
    httpHost: merged.httpHost ?? "127.0.0.1",
    accessKey: merged.accessKey ?? null,
    ordering: merged.ordering ?? true,
  };
  if (config.httpPort !== null) {
    if (!config.accessKey) {
      throw new ConfigError(
        `The HTTP server needs an access key: set ${ENV.accessKey} or "accessKey" in the config file ` +
          `(at least ${MIN_ACCESS_KEY_LENGTH} random characters). It is not a command-line flag, so it stays out of process lists.`,
      );
    }
    if (config.accessKey.length < MIN_ACCESS_KEY_LENGTH) {
      throw new ConfigError(`The access key must be at least ${MIN_ACCESS_KEY_LENGTH} characters.`);
    }
  }
  return { config, cli };
}

function envValues(env: Env): Partial_ {
  const out: Partial_ = {};
  const mode = env[ENV.demo] === "true" ? "demo" : env[ENV.mode];
  if (mode) out.mode = parseMode(mode, ENV.mode);
  if (env[ENV.transport]) out.transport = parseTransport(env[ENV.transport]!, ENV.transport);
  if (env[ENV.dataDir]) out.dataDir = env[ENV.dataDir];
  if (env[ENV.settingsFile]) out.settingsFile = env[ENV.settingsFile];
  if (env[ENV.tokenStore]) out.tokenStore = parseTokenStore(env[ENV.tokenStore]!, ENV.tokenStore);
  if (env[ENV.tokenFile]) out.tokenFile = env[ENV.tokenFile];
  if (env[ENV.browserPath]) out.browserPath = env[ENV.browserPath]!;
  if (env[ENV.loginUrl]) out.loginUrl = env[ENV.loginUrl]!;
  if (env[ENV.demoCatalogueFile]) out.demoCatalogueFile = env[ENV.demoCatalogueFile]!;
  if (env[ENV.debug]) out.debug = env[ENV.debug] === "1" || env[ENV.debug] === "true";
  if (env[ENV.httpPort]) out.httpPort = parsePort(env[ENV.httpPort]!, ENV.httpPort);
  if (env[ENV.httpHost]) out.httpHost = env[ENV.httpHost]!;
  if (env[ENV.accessKey]) out.accessKey = env[ENV.accessKey]!;
  if (env[ENV.ordering]) out.ordering = !["0", "false", "off"].includes(env[ENV.ordering]!.toLowerCase());
  return out;
}

function readConfigFile(path: string): Partial_ {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new ConfigError(`Could not read the config file ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfigError(`${path} must contain a JSON object.`);
  const out: Partial_ = {};
  const where = (key: string) => `"${key}" in ${path}`;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    switch (key) {
      case "mode":
        out.mode = parseMode(String(value), where(key));
        break;
      case "transport":
        out.transport = parseTransport(String(value), where(key));
        break;
      case "tokenStore":
        out.tokenStore = parseTokenStore(String(value), where(key));
        break;
      case "debug":
        if (typeof value !== "boolean") throw new ConfigError(`${where(key)} must be true or false.`);
        out.debug = value;
        break;
      case "ordering":
        if (typeof value !== "boolean") throw new ConfigError(`${where(key)} must be true or false.`);
        out.ordering = value;
        break;
      case "httpPort":
        out.httpPort = parsePort(String(value), where(key));
        break;
      case "dataDir":
      case "httpHost":
      case "accessKey":
      case "settingsFile":
      case "tokenFile":
      case "browserPath":
      case "loginUrl":
      case "demoCatalogueFile":
        if (typeof value !== "string" || value === "") throw new ConfigError(`${where(key)} must be a non-empty string.`);
        out[key] = value;
        break;
      default:
        throw new ConfigError(`Unknown setting ${where(key)}. See docs/embedding.md for the settings.`);
    }
  }
  return out;
}

const USAGE = `Usage: s-kaupat-mcp [options]

Runs the S-kaupat MCP server on stdio, or on local HTTP with --http-port.

Options:
  --config <file>     JSON config file (or ${ENV.config})
  --demo              Built-in sample data, no network or account (or ${ENV.mode}=demo)
  --data-dir <dir>    Folder for the browser profile and login (or ${ENV.dataDir})
  --transport <name>  browser (default) or direct (or ${ENV.transport})
  --http-port <port>  Serve MCP over HTTP at http://127.0.0.1:<port>/mcp instead of stdio
                      (needs ${ENV.accessKey}; or ${ENV.httpPort})
  --http-host <addr>  Address to listen on (default 127.0.0.1)
  --debug             Log each API request to stderr
  --version           Print the version
  --help              Print this help

Every setting is described in docs/embedding.md.`;

export function usage(): string {
  return USAGE;
}

function parseArgs(argv: string[]): { values: Partial_; cli: CliOptions; configFile: string | null } {
  const values: Partial_ = {};
  const cli: CliOptions = { help: false, version: false };
  let configFile: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    const [name, inline] = arg.startsWith("--") && arg.includes("=") ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)] : [arg, undefined];
    const next = (): string => {
      const value = inline ?? argv[++i];
      if (value === undefined || value === "") throw new ConfigError(`${name} needs a value.`);
      return value;
    };
    switch (name) {
      case "--config":
        configFile = next();
        break;
      case "--demo":
        values.mode = "demo";
        break;
      case "--data-dir":
        values.dataDir = next();
        break;
      case "--transport":
        values.transport = parseTransport(next(), name);
        break;
      case "--debug":
        values.debug = true;
        break;
      case "--http-port":
        values.httpPort = parsePort(next(), name);
        break;
      case "--http-host":
        values.httpHost = next();
        break;
      case "--version":
      case "-v":
        cli.version = true;
        break;
      case "--help":
      case "-h":
        cli.help = true;
        break;
      default:
        throw new ConfigError(`Unknown option ${arg}.\n\n${USAGE}`);
    }
  }
  return { values, cli, configFile };
}

function parsePort(value: string, where: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new ConfigError(`${where} must be a port number, not "${value}".`);
  return port;
}

function parseMode(value: string, where: string): SKaupatConfig["mode"] {
  // "fixtures" is the older name for demo mode.
  if (value === "demo" || value === "fixtures") return "demo";
  if (value === "live") return "live";
  throw new ConfigError(`${where} must be "live" or "demo", not "${value}".`);
}

function parseTransport(value: string, where: string): SKaupatConfig["transport"] {
  if (value === "browser" || value === "direct") return value;
  throw new ConfigError(`${where} must be "browser" or "direct", not "${value}".`);
}

function parseTokenStore(value: string, where: string): SKaupatConfig["tokenStore"] {
  if (value === "credential-manager" || value === "file") return value;
  throw new ConfigError(`${where} must be "credential-manager" or "file", not "${value}".`);
}

/** %LOCALAPPDATA%\s-kaupat-mcp on Windows, ~/.config/s-kaupat-mcp elsewhere. */
export function defaultDataDir(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  if (platform === "win32") return join(env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "s-kaupat-mcp");
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "s-kaupat-mcp");
}

/** %APPDATA%\s-kaupat-mcp\settings.json on Windows, ~/.config/s-kaupat-mcp/settings.json elsewhere. */
export function defaultSettingsPath(env: Env = process.env, platform: NodeJS.Platform = process.platform): string {
  const base =
    platform === "win32" ? (env.APPDATA ?? join(homedir(), "AppData", "Roaming")) : (env.XDG_CONFIG_HOME ?? join(homedir(), ".config"));
  return join(base, "s-kaupat-mcp", "settings.json");
}
