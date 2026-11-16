import { spawnSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import { installFileSecurity, type NativeFileSecurity } from "../../node/src/storage.js";
import { windowsSystemExecutable, windowsPowerShellBootstrap } from "../../node/src/launch.js";
import { windowsFailure } from "../../node/src/windows-failure.js";

// Fixed program text. Paths and credential bytes are supplied only through
// stdin. Neither command arguments nor error messages contain secret values.
const program = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$r=[Console]::In.ReadLine() | ConvertFrom-Json
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User
function AssertPrivate($path) {
  $item=Get-Item -LiteralPath $path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse point' }
  $acl=Get-Acl -LiteralPath $path
  if ($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Owner' }
  foreach ($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
    if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid.Value,'S-1-5-18','S-1-5-32-544')) { throw 'Public ACL' }
  }
}
switch ($r.action) {
  'directory' {
    if (!(Test-Path -LiteralPath $r.path)) {
      $acl=New-Object Security.AccessControl.DirectorySecurity
      $acl.SetOwner($sid); $acl.SetAccessRuleProtection($true,$false)
      $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
      $acl.AddAccessRule($rule)
      [IO.Directory]::CreateDirectory($r.path,$acl) | Out-Null
    }
    AssertPrivate $r.path
    if (!(Get-Item -LiteralPath $r.path -Force).PSIsContainer) { throw 'Not directory' }
    [Console]::Out.WriteLine('true')
  }
  'file' { AssertPrivate $r.path; if ((Get-Item -LiteralPath $r.path -Force).PSIsContainer) { throw 'Not file' }; [Console]::Out.WriteLine('true') }
  'protect' {
    Add-Type -AssemblyName System.Security
    $bytes=[Text.Encoding]::UTF8.GetBytes($r.value)
    [Console]::Out.WriteLine(([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($bytes,$null,'CurrentUser')) | ConvertTo-Json -Compress))
  }
  'unprotect' {
    Add-Type -AssemblyName System.Security
    $bytes=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($r.value),$null,'CurrentUser')
    [Console]::Out.WriteLine(([Text.Encoding]::UTF8.GetString($bytes) | ConvertTo-Json -Compress))
  }
  default { throw 'Unsupported operation' }
}`;

function nativeCall(action: string, payload: { path?: string; value?: string }): unknown {
  const result = spawnSync(windowsSystemExecutable("powershell.exe"), ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(windowsPowerShellBootstrap + program, "utf16le").toString("base64")], {
    windowsHide: true, input: JSON.stringify({ action, ...payload }) + "\n", encoding: "utf8", timeout: 10_000, maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error(`Windows credential or file protection failed (${windowsFailure(result.stderr ?? "", (result.error as NodeJS.ErrnoException | undefined)?.code, result.status)}); use a private local NTFS directory owned by this user`);
  try { return JSON.parse(result.stdout.trim()); } catch { throw new Error("Windows protection returned an invalid response"); }
}

/** Check ancestors too: a private leaf below a junction is not a private root. */
export function rejectReparsePoints(path: string): void {
  if (!isAbsolute(path)) throw new Error("Local state path must be absolute");
  let current = path;
  for (;;) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error("Local state path must not contain a reparse point");
    const parent = dirname(current); if (parent === current) break; current = parent;
  }
}

export function windowsFileSecurity(): NativeFileSecurity {
  const directories = new Map<string, number>();
  const files = new Map<string, string>();
  const decrypted = new Map<string, string>();
  return {
    directory(path) {
      rejectReparsePoints(path);
      const stamp = existsSync(path) ? lstatSync(path).birthtimeMs : undefined;
      if (stamp !== undefined && directories.get(path) === stamp) return;
      nativeCall("directory", { path }); directories.set(path, lstatSync(path).birthtimeMs);
    },
    file(path) {
      rejectReparsePoints(path);
      const stat = lstatSync(path);
      if (!stat.isFile()) throw new Error("Local state must be a regular file");
      const stamp = `${stat.birthtimeMs}:${stat.ctimeMs}`;
      if (files.get(path) !== stamp) { nativeCall("file", { path }); files.set(path, stamp); }
    },
    protect(value) { return String(nativeCall("protect", { value })); },
    unprotect(value) {
      if (!decrypted.has(value)) decrypted.set(value, String(nativeCall("unprotect", { value })));
      return decrypted.get(value)!;
    },
  };
}

export function initializeNativeSecurity(): void { if (process.platform === "win32") installFileSecurity(windowsFileSecurity()); }
