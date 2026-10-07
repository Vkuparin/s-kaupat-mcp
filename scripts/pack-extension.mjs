// Builds the one-click Claude Desktop extension: s-kaupat-<version>.mcpb in the repo root.
// Usage: npm run pack:extension
import { execSync } from "node:child_process";
import { cpSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const stage = join(root, "build", "extension");
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: "inherit" });

const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
if (manifest.version !== pkg.version) {
  throw new Error(`manifest.json version ${manifest.version} does not match package.json ${pkg.version}`);
}

run("npm run build");
rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
for (const file of ["manifest.json", "package.json", "package-lock.json", "README.md", "fixtures"]) {
  cpSync(join(root, file), join(stage, file), { recursive: true });
}
cpSync(join(root, "dist"), join(stage, "dist"), {
  recursive: true,
  filter: (src) => !src.includes(`${join("dist", "test")}`) && !src.endsWith(".map"),
});
// Runtime dependencies only; the extension ships its own node_modules.
run("npm ci --omit=dev --ignore-scripts --no-audit --no-fund", stage);

const output = join(root, `s-kaupat-${pkg.version}.mcpb`);
run(`npx mcpb validate "${join(stage, "manifest.json")}"`);
run(`npx mcpb pack "${stage}" "${output}"`);
console.log(`\nBuilt ${output}. Double-click it (or drag it into Claude Desktop → Settings → Extensions) to install.`);
