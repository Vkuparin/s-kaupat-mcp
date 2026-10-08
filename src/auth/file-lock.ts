import { open, stat, unlink } from "node:fs/promises";

export interface FileLockOptions {
  /** A lock file older than this is assumed to belong to a crashed process. */
  staleMs?: number;
  /** Give up waiting for the lock after this long. */
  timeoutMs?: number;
  pollMs?: number;
}

/**
 * Runs `fn` while holding an exclusive lock file, so that several server
 * processes (one per caller app) never refresh the same token at once.
 */
export async function withFileLock<T>(path: string, fn: () => Promise<T>, options: FileLockOptions = {}): Promise<T> {
  const staleMs = options.staleMs ?? 30_000;
  const deadline = Date.now() + (options.timeoutMs ?? 20_000);
  const pollMs = options.pollMs ?? 100;

  for (;;) {
    try {
      const handle = await open(path, "wx");
      try {
        await handle.writeFile(String(process.pid));
      } finally {
        await handle.close();
      }
      break;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // On Windows, opening a lock file that its holder is deleting at that moment fails with EPERM
      // (or EACCES/EBUSY) instead of EEXIST; it means the same thing: someone holds the lock.
      const contended = code === "EEXIST" || (process.platform === "win32" && ["EPERM", "EACCES", "EBUSY"].includes(code ?? ""));
      if (!contended) throw err;
      const age = await stat(path).then((s) => Date.now() - s.mtimeMs, () => 0);
      if (age > staleMs) {
        await unlink(path).catch(() => {});
        continue;
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for lock ${path} (last error ${code})`);
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  try {
    return await fn();
  } finally {
    await unlink(path).catch(() => {});
  }
}
