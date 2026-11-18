import { execFileSync } from "node:child_process";

// A PowerShell 7 parent can pass its module path to Windows PowerShell 5.
// Load only modules belonging to the selected executable before inspecting bytes.
const program = "$ErrorActionPreference='Stop'; foreach ($module in @('Microsoft.PowerShell.Utility','Microsoft.PowerShell.Management','Microsoft.PowerShell.Security')) { Import-Module ($PSHOME + '/Modules/' + $module + '/' + $module + '.psd1') -ErrorAction Stop }; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $r=[Console]::In.ReadLine() | ConvertFrom-Json; $s=Get-AuthenticodeSignature -LiteralPath $r.path; if ($r.unsigned) { if ($s.Status -ne 'NotSigned') { exit 1 }; exit 0 }; if ($s.Status -ne 'Valid' -or $s.SignerCertificate.GetNameInfo('SimpleName',$false) -ne $r.publisher) { exit 1 }; $h=[Security.Cryptography.SHA256]::Create(); [Console]::Out.WriteLine(([BitConverter]::ToString($h.ComputeHash($s.SignerCertificate.RawData))).Replace('-','').ToLowerInvariant())";

export function verifyWindowsAuthenticode(request, { env = process.env } = {}) {
  return execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(program, "utf16le").toString("base64")], {
    input: JSON.stringify(request) + "\n", encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], env, timeout: 30_000,
  }).trim();
}
