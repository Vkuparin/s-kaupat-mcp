/**
 * Logging goes to stderr only: stdout carries the MCP stdio protocol.
 */
const debugEnabled = process.env.SKAUPAT_DEBUG === "1";

function write(level: string, msg: string, extra?: Record<string, unknown>): void {
  const line = extra ? `${msg} ${JSON.stringify(extra)}` : msg;
  process.stderr.write(`[s-kaupat-mcp] ${level} ${line}\n`);
}

export const log = {
  debug: (msg: string, extra?: Record<string, unknown>) => {
    if (debugEnabled) write("debug", msg, extra);
  },
  info: (msg: string, extra?: Record<string, unknown>) => write("info", msg, extra),
  warn: (msg: string, extra?: Record<string, unknown>) => write("warn", msg, extra),
  error: (msg: string, extra?: Record<string, unknown>) => write("error", msg, extra),
};
