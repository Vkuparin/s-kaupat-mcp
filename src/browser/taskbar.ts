import { execFile } from "node:child_process";
import { log } from "../log.js";

// Takes the server's own minimised browser windows off the taskbar and out of Alt+Tab (Windows only).
// The windows stay real, minimised browser windows: only their taskbar button goes, by marking them
// as tool windows. Windows opened later for the user (openForUser) are new windows and keep theirs.
const WINDOW_TYPE = `
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class SKaupatTaskbar {
  delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
  [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hWnd, uint cmd);
  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")] static extern IntPtr GetLong(IntPtr hWnd, int index);
  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW")] static extern IntPtr SetLong(IntPtr hWnd, int index, IntPtr value);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
  const int GWL_EXSTYLE = -20;
  const long WS_EX_TOOLWINDOW = 0x80, WS_EX_APPWINDOW = 0x40000;
  const int SW_HIDE = 0, SW_SHOWMINNOACTIVE = 7;
  public static int Hide(uint[] pids) {
    var wanted = new HashSet<uint>(pids);
    var found = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint pid;
      GetWindowThreadProcessId(h, out pid);
      // Top-level, visible, minimised windows of the server's own browser only.
      if (wanted.Contains(pid) && IsWindowVisible(h) && IsIconic(h) && GetWindow(h, 4) == IntPtr.Zero) found.Add(h);
      return true;
    }, IntPtr.Zero);
    foreach (var h in found) {
      long style = GetLong(h, GWL_EXSTYLE).ToInt64();
      // The taskbar only re-reads the style when a window is shown, so hide, restyle, show minimised.
      ShowWindow(h, SW_HIDE);
      SetLong(h, GWL_EXSTYLE, new IntPtr((style | WS_EX_TOOLWINDOW) & ~WS_EX_APPWINDOW));
      ShowWindow(h, SW_SHOWMINNOACTIVE);
    }
    return found.Count;
  }
}`;

const SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
${WINDOW_TYPE}
'@
$dir = [Console]::In.ReadToEnd().Trim()
$flag = '--user-data-dir=' + $dir
$pids = @(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($flag) } |
  ForEach-Object { [uint32]$_.ProcessId })
if ($pids.Count -eq 0) { '0' } else { [SKaupatTaskbar]::Hide([uint32[]]$pids) }
`;

/**
 * Removes the taskbar button of the minimised browser window that uses this profile.
 * Best effort: on failure the window just keeps its button. Resolves to the number of windows changed.
 */
export function hideFromTaskbar(profileDir: string): Promise<number> {
  if (process.platform !== "win32") return Promise.resolve(0);
  const encoded = Buffer.from(SCRIPT, "utf16le").toString("base64");
  return new Promise((resolve) => {
    const child = execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded],
      { windowsHide: true, timeout: 20_000 },
      (err, stdout, stderr) => {
        if (err) {
          log.debug("Could not hide the S-kaupat window's taskbar button", { message: stderr.trim().split("\n")[0] || err.message });
          resolve(0);
          return;
        }
        const count = Number.parseInt(stdout.trim().split("\n").pop() ?? "0", 10) || 0;
        log.debug("S-kaupat window taken off the taskbar", { windows: count });
        resolve(count);
      },
    );
    // The profile path goes in on stdin, so it needs no quoting inside the script.
    child.stdin?.end(profileDir);
  });
}
