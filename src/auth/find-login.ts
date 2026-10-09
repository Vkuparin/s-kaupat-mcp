/** A login found in the site's localStorage. */
export interface CapturedLogin {
  refreshToken: string;
  accessToken: string | null;
}

/** Looks through localStorage entries for an object holding a non-empty refreshToken. */
export function findLogin(entries: [string, string][]): CapturedLogin | null {
  for (const [, value] of entries) {
    const found = search(parseJson(value), 0);
    if (found) return found;
  }
  return null;
}

function search(node: unknown, depth: number): CapturedLogin | null {
  if (depth > 8 || node === null || typeof node !== "object") {
    // Some stores keep JSON encoded inside a string value.
    if (typeof node === "string" && depth <= 8 && /^[[{]/.test(node)) return search(parseJson(node), depth + 1);
    return null;
  }
  const record = node as Record<string, unknown>;
  if (typeof record.refreshToken === "string" && record.refreshToken) {
    return {
      refreshToken: record.refreshToken,
      accessToken: typeof record.accessToken === "string" && record.accessToken ? record.accessToken : null,
    };
  }
  for (const child of Object.values(record)) {
    const found = search(child, depth + 1);
    if (found) return found;
  }
  return null;
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}
