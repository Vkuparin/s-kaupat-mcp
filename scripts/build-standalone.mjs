// Builds a single executable of the server for the platform it runs on, with Node.js inside:
// build/standalone/s-kaupat-mcp(.exe). Apps can ship it without Node or anything else installed.
// Usage: npm run build:standalone
//
// Uses Node's single executable applications (https://nodejs.org/api/single-executable-applications.html):
// the server is bundled into one CommonJS file, which is injected into a copy of this Node binary.
import { execFileSync, execSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = join(root, "build", "standalone");
const run = (cmd) => execSync(cmd, { cwd: root, stdio: "inherit" });
const isWindows = process.platform === "win32";
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

run("npm run build");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

const bundle = join(out, "s-kaupat-mcp.cjs");
// Inside a single executable, require() only loads Node's built-in modules and has no resolve().
// playwright-core calls require.resolve() for its own files (to name its folder in stack traces), so
// it gets one that answers a path next to the executable when the file is not there.
const banner =
  'const __seaResolve = (id) => { try { return require("node:module").createRequire(__filename).resolve(id); } ' +
  'catch { return require("node:path").join(require("node:path").dirname(process.execPath), id); } };';
// chromium-bidi is only loaded for Firefox/BiDi browsers, which this server never launches.
await build({
  entryPoints: [join(root, "dist", "index.js")],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  define: { "require.resolve": "__seaResolve" },
  banner: { js: banner },
  external: ["chromium-bidi", "chromium-bidi/*"],
  logLevel: "warning",
  outfile: bundle,
});

const blob = join(out, "sea-prep.blob");
const seaConfig = join(out, "sea-config.json");
writeFileSync(seaConfig, JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true }));
execFileSync(process.execPath, ["--experimental-sea-config", seaConfig], { stdio: "inherit" });

const exe = join(out, isWindows ? "s-kaupat-mcp.exe" : "s-kaupat-mcp");
copyFileSync(process.execPath, exe);
const postject = join(root, "node_modules", "postject", "dist", "cli.js");
execFileSync(
  process.execPath,
  [postject, exe, "NODE_SEA_BLOB", blob, "--sentinel-fuse", "NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"],
  { stdio: "inherit" },
);
rmSync(blob);
rmSync(seaConfig);
console.log(`\nBuilt ${exe} (s-kaupat-mcp ${pkg.version}, Node ${process.version}).`);
