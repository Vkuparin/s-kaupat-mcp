// Prints the CHANGELOG.md section for one version, for the GitHub release notes.
// Usage: node scripts/release-notes.mjs 1.0.0-rc.1
import { readFileSync } from "node:fs";

const version = process.argv[2]?.replace(/^v/, "");
if (!version) throw new Error("Give the version, like 1.0.0");
const lines = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8").split("\n");
const start = lines.findIndex((l) => l.trim() === `## ${version}`);
if (start < 0) throw new Error(`CHANGELOG.md has no "## ${version}" section`);
const end = lines.findIndex((l, i) => i > start && l.startsWith("## "));
console.log(lines.slice(start + 1, end < 0 ? undefined : end).join("\n").trim());
