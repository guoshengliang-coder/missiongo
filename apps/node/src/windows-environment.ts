import { randomUUID } from "node:crypto";
import { spawnAgent, killProcessTree } from "./launch.js";

/** The script is explicitly selected locally. Paths/data enter over stdin,
 * never PowerShell source text. No user profile is evaluated implicitly.
 */
export async function readPowerShellEnvironment(path: string, base: NodeJS.ProcessEnv, timeoutMs: number, executable = "powershell.exe"): Promise<NodeJS.ProcessEnv> {
  const marker = `__MISSIONGO_ENV_${randomUUID()}__`;
  const source = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $OutputEncoding=[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); `
    + `$request=[Console]::In.ReadLine() | ConvertFrom-Json; . $request.path | Out-Null; `
    + `$values=@{}; Get-ChildItem Env: | ForEach-Object { $values[$_.Name]=$_.Value }; `
    + `[Console]::Out.WriteLine($request.marker); [Console]::Out.WriteLine(($values | ConvertTo-Json -Compress)); [Console]::Out.WriteLine($request.marker);`;
  return new Promise((resolve, reject) => {
    const child = spawnAgent(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(source, "utf16le").toString("base64")], {
      env: base, detached: true, stdio: ["pipe", "pipe", "ignore"],
    });
    const chunks: Buffer[] = []; let size = 0; let settled = false;
    const fail = (message: string) => {
      if (settled) return; settled = true; clearTimeout(timer); killProcessTree(child.pid); reject(new Error(message));
    };
    const timer = setTimeout(() => fail("Agent environment script timed out; check the script and recheck the Agent"), timeoutMs);
    child.stdout!.on("data", (part: Buffer) => {
      size += part.length;
      if (size > 2_000_000) { fail("Agent environment script output exceeded the limit"); return; }
      chunks.push(part);
    });
    child.once("error", () => fail("Agent environment script could not be started"));
    child.stdin!.on("error", () => fail("Agent environment script input closed"));
    child.stdin!.end(JSON.stringify({ path, marker }) + "\n");
    child.once("close", (code) => {
      if (settled) return;
      try {
        const text = Buffer.concat(chunks).toString("utf8");
        const first = text.indexOf(marker); const last = text.lastIndexOf(marker);
        if (code !== 0 || first < 0 || last <= first) throw new Error();
        const env = JSON.parse(text.slice(first + marker.length, last).trim()) as Record<string, unknown>;
        if (!env || typeof env !== "object" || Array.isArray(env) || Object.values(env).some((value) => typeof value !== "string")
          || !Object.keys(env).some((key) => key.toLowerCase() === "path" && env[key])) throw new Error();
        settled = true; clearTimeout(timer); resolve(env as NodeJS.ProcessEnv);
      } catch { fail("Agent environment script failed; check the script and recheck the Agent"); }
    });
  });
}
