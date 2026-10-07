import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/**
 * Where the S-kaupat refresh token is kept between runs. Only the refresh
 * token is stored; access tokens live in memory. Implementations must never
 * log the token.
 */
export interface TokenStore {
  /** Human-readable location for logs and docs, never the token itself. */
  readonly description: string;
  read(): Promise<string | null>;
  write(token: string): Promise<void>;
  clear(): Promise<void>;
}

/** Folder for the server's own state: token file, lock file and login browser profile. */
export function defaultDataDir(): string {
  if (process.env.SKAUPAT_DATA_DIR) return process.env.SKAUPAT_DATA_DIR;
  if (process.platform === "win32") {
    return join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "s-kaupat-mcp");
  }
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "s-kaupat-mcp");
}

/** A plain file readable only by the current user. For hosts without Windows Credential Manager. */
export class FileTokenStore implements TokenStore {
  constructor(private readonly path: string) {}

  get description(): string {
    return `token file ${this.path}`;
  }

  async read(): Promise<string | null> {
    try {
      const token = (await readFile(this.path, "utf8")).trim();
      return token || null;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async write(token: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
    // Write then rename, so a concurrent reader never sees a half-written token.
    const tmp = `${this.path}.${process.pid}.tmp`;
    await writeFile(tmp, token, { encoding: "utf8", mode: 0o600 });
    await chmod(tmp, 0o600);
    await rename(tmp, this.path);
  }

  async clear(): Promise<void> {
    await rm(this.path, { force: true });
  }
}

/**
 * Windows Credential Manager, through PowerShell and the Win32 Cred* API, so
 * no native module is needed. The token is passed on stdin and returned
 * base64-encoded on stdout; it never appears on a command line.
 *
 * The secret is stored as UTF-8, which allows up to 2560 characters (the
 * Credential Manager blob limit).
 */
export class WindowsCredentialStore implements TokenStore {
  constructor(
    private readonly target = "s-kaupat-mcp/refresh-token",
    private readonly runPowerShell: (script: string, stdin: string) => Promise<string> = powershell,
  ) {}

  get description(): string {
    return `Windows Credential Manager entry "${this.target}"`;
  }

  async read(): Promise<string | null> {
    const out = (await this.runPowerShell(script("read", this.target), "")).trim();
    if (!out) return null;
    return Buffer.from(out, "base64").toString("utf8") || null;
  }

  async write(token: string): Promise<void> {
    await this.runPowerShell(script("write", this.target), Buffer.from(token, "utf8").toString("base64"));
  }

  async clear(): Promise<void> {
    await this.runPowerShell(script("delete", this.target), "");
  }
}

const CRED_TYPE = `
using System;
using System.Runtime.InteropServices;
public static class SKaupatCred {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public string TargetName; public string Comment;
    public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
    public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
    public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
  }
  [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredRead(string target, int type, int flags, out IntPtr cred);
  [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredWrite(ref CREDENTIAL cred, int flags);
  [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
  static extern bool CredDelete(string target, int type, int flags);
  [DllImport("advapi32.dll")]
  static extern void CredFree(IntPtr cred);

  public static byte[] Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      var bytes = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, bytes, 0, c.CredentialBlobSize);
      return bytes;
    } finally { CredFree(p); }
  }
  public static void Write(string target, byte[] secret) {
    if (secret.Length > 2560) throw new Exception("Token is too long for Credential Manager; use SKAUPAT_TOKEN_STORE=file.");
    var blob = Marshal.AllocHGlobal(secret.Length);
    try {
      Marshal.Copy(secret, 0, blob, secret.Length);
      var c = new CREDENTIAL { Type = 1, TargetName = target, CredentialBlobSize = secret.Length,
        CredentialBlob = blob, Persist = 2, UserName = "s-kaupat-mcp" };
      if (!CredWrite(ref c, 0)) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    } finally { Marshal.FreeHGlobal(blob); }
  }
  public static void Delete(string target) { CredDelete(target, 1, 0); }
}`;

function script(op: "read" | "write" | "delete", target: string): string {
  const t = `'${target.replace(/'/g, "''")}'`;
  const body = {
    read: `$b = [SKaupatCred]::Read(${t}); if ($b) { [Convert]::ToBase64String($b) }`,
    write: `$in = [Console]::In.ReadToEnd().Trim(); [SKaupatCred]::Write(${t}, [Convert]::FromBase64String($in))`,
    delete: `[SKaupatCred]::Delete(${t})`,
  }[op];
  return `$ErrorActionPreference = 'Stop'\nAdd-Type -TypeDefinition @'\n${CRED_TYPE}\n'@\n${body}\n`;
}

function powershell(script: string, stdin: string): Promise<string> {
  // -EncodedCommand takes UTF-16LE base64; it carries only the script, never the token.
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return new Promise((resolve, reject) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 30_000 },
      (err, stdout, stderr) => {
        if (err) reject(new Error(`Credential Manager call failed: ${stderr.trim().split("\n")[0] || err.message}`));
        else resolve(stdout);
      },
    );
    child.stdin?.end(stdin);
  });
}

/**
 * SKAUPAT_TOKEN_STORE picks the store: "credential-manager" (default on
 * Windows) or "file" (default elsewhere; path from SKAUPAT_TOKEN_FILE).
 * The lock path is where processes sharing that store coordinate renewal.
 */
export function createTokenStore(dataDir = defaultDataDir()): { store: TokenStore; lockPath: string } {
  const kind = process.env.SKAUPAT_TOKEN_STORE ?? (process.platform === "win32" ? "credential-manager" : "file");
  if (kind === "credential-manager") {
    return { store: new WindowsCredentialStore(), lockPath: join(dataDir, "refresh.lock") };
  }
  if (kind === "file") {
    const path = process.env.SKAUPAT_TOKEN_FILE ?? join(dataDir, "refresh-token");
    return { store: new FileTokenStore(path), lockPath: `${path}.lock` };
  }
  throw new Error(`Unknown SKAUPAT_TOKEN_STORE: ${kind} (expected "credential-manager" or "file")`);
}
