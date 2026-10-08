// Writes build/tools.json: every tool's name, title, description, input schema and hints, with the
// server and schema versions, so a caller app can check what it builds against without starting the
// server. Run after `npm run build`.
import { mkdirSync, writeFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createRuntime, loadConfig, SCHEMA_VERSION, SERVER_INSTRUCTIONS, SERVER_NAME, SERVER_VERSION } from "../dist/lib.js";

const { config } = loadConfig({ argv: ["--demo"], env: {} });
const runtime = createRuntime(config);
const server = runtime.createMcpServer();
const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "export-tools", version: "0" });
await Promise.all([server.connect(b), client.connect(a)]);
const { tools } = await client.listTools();
await runtime.close();

const out = {
  server: SERVER_NAME,
  version: SERVER_VERSION,
  schemaVersion: SCHEMA_VERSION,
  instructions: SERVER_INSTRUCTIONS,
  tools: tools
    .map((t) => ({ name: t.name, title: t.title, description: t.description, inputSchema: t.inputSchema, annotations: t.annotations }))
    .sort((x, y) => x.name.localeCompare(y.name)),
};
mkdirSync("build", { recursive: true });
writeFileSync("build/tools.json", `${JSON.stringify(out, null, 2)}\n`);
console.log(`build/tools.json: ${out.tools.length} tools, version ${out.version}`);
