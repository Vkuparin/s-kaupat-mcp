import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { ConfigError, loadConfig } from "../config.js";

const tmp = () => mkdtempSync(join(tmpdir(), "skaupat-config-"));

test("defaults keep earlier versions' locations, so an update finds the saved store and login", () => {
  const { config } = loadConfig({ env: { LOCALAPPDATA: "C:\\L", APPDATA: "C:\\R" }, platform: "win32" });
  assert.equal(config.mode, "live");
  assert.equal(config.transport, "browser");
  assert.equal(config.tokenStore, "credential-manager");
  assert.equal(config.dataDir, resolve(join("C:\\L", "s-kaupat-mcp")));
  assert.equal(config.settingsFile, resolve(join("C:\\R", "s-kaupat-mcp", "settings.json")));
  assert.equal(loadConfig({ env: {}, platform: "linux" }).config.tokenStore, "file");
});

test("an app's own data folder holds everything", () => {
  const dir = tmp();
  const { config } = loadConfig({ env: { SKAUPAT_DATA_DIR: dir }, platform: "win32" });
  assert.equal(config.settingsFile, join(dir, "settings.json"));
  assert.equal(config.tokenFile, join(dir, "refresh-token"));
});

test("flags beat environment variables, which beat the config file", () => {
  const dir = tmp();
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ mode: "demo", transport: "direct", debug: true, browserPath: "C:\\edge.exe" }));
  const fromFile = loadConfig({ env: { SKAUPAT_CONFIG: file } }).config;
  assert.deepEqual([fromFile.mode, fromFile.transport, fromFile.debug, fromFile.browserPath], ["demo", "direct", true, "C:\\edge.exe"]);

  const fromEnv = loadConfig({ env: { SKAUPAT_CONFIG: file, SKAUPAT_TRANSPORT: "browser" } }).config;
  assert.equal(fromEnv.transport, "browser");

  const fromFlag = loadConfig({ env: { SKAUPAT_TRANSPORT: "browser" }, argv: ["--config", file, "--transport=direct"] }).config;
  assert.equal(fromFlag.transport, "direct");
});

test("the extension's Demo mode switch and the old fixtures name still mean demo", () => {
  assert.equal(loadConfig({ env: { SKAUPAT_DEMO: "true" } }).config.mode, "demo");
  assert.equal(loadConfig({ env: { SKAUPAT_DEMO: "false" } }).config.mode, "live");
  assert.equal(loadConfig({ env: { SKAUPAT_MODE: "fixtures" } }).config.mode, "demo");
  assert.equal(loadConfig({ argv: ["--demo"], env: {} }).config.mode, "demo");
});

test("mistakes are reported clearly, not ignored", () => {
  const dir = tmp();
  const file = join(dir, "config.json");
  writeFileSync(file, JSON.stringify({ trasport: "direct" }));
  assert.throws(() => loadConfig({ env: { SKAUPAT_CONFIG: file } }), (e: Error) => e instanceof ConfigError && /trasport/.test(e.message));
  assert.throws(() => loadConfig({ env: { SKAUPAT_MODE: "prod" } }), ConfigError);
  assert.throws(() => loadConfig({ env: {}, argv: ["--nope"] }), ConfigError);
  assert.throws(() => loadConfig({ env: {}, argv: ["--data-dir"] }), ConfigError);
  assert.throws(() => loadConfig({ env: { SKAUPAT_CONFIG: join(dir, "missing.json") } }), ConfigError);
});

test("--help and --version are reported to the caller", () => {
  assert.equal(loadConfig({ env: {}, argv: ["--help"] }).cli.help, true);
  assert.equal(loadConfig({ env: {}, argv: ["--version"] }).cli.version, true);
});

test("demo mode keeps its own store and time apart from the real ones", () => {
  const dir = tmp();
  assert.equal(loadConfig({ argv: ["--demo"], env: { SKAUPAT_DATA_DIR: dir }, platform: "win32" }).config.settingsFile, join(dir, "demo-settings.json"));
  assert.equal(loadConfig({ env: { SKAUPAT_DATA_DIR: dir }, platform: "win32" }).config.settingsFile, join(dir, "settings.json"));
});
