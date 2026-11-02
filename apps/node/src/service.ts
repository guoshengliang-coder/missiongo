import { existsSync, lstatSync, mkdirSync, openSync, closeSync, writeFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
declare const PRODUCT_NAME: string;

function quoted(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new Error("Invalid service path");
  return `"${value.replaceAll("%", "%%").replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
export function serviceUnit(node: string, entry: string, root: string, path: string): string {
  return `[Unit]\nDescription=${typeof PRODUCT_NAME === "string" ? PRODUCT_NAME : "Headless"} headless node\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart=${quoted(node)} ${quoted(entry)} run\nEnvironment=${quoted(`MISSIONGO_NODE_HOME=${root}`)}\nEnvironment=${quoted(`PATH=${path}`)}\nUMask=0077\nRestart=on-failure\nRestartSec=10\nKillMode=process\nTimeoutStopSec=50\n\n[Install]\nWantedBy=default.target\n`;
}
export function servicePath(): string { return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "systemd/user/missiongo-node.service"); }
export function installService(node: string, entry: string, root: string): string {
  const target = servicePath(); const directory = join(target, "..");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (existsSync(target)) throw new Error("Service file already exists; uninstall it explicitly first");
  const fd = openSync(target, "wx", 0o600);
  try { writeFileSync(fd, serviceUnit(node, entry, root, process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin")); }
  finally { closeSync(fd); }
  return target;
}
export function uninstallService(): void {
  const path = servicePath(); const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== process.getuid?.()) throw new Error("Service file is not owned by this user");
  unlinkSync(path);
}
