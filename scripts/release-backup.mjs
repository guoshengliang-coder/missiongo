import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, closeSync, copyFileSync, lstatSync, openSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
export function validateManifest(value) {
  assert.equal(value?.formatVersion, 1, "Unsupported backup format");
  assert.ok(/^missiongo-\d{8}T\d{6}Z$/.test(value.directory), "Unsafe backup directory");
  assert.ok(typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt)), "Invalid backup time");
  assert.ok(Date.parse(value.createdAt) <= Date.now(), "Backup time is in the future");
  assert.ok(/^[A-Za-z0-9_-]+\.sqlite$/.test(value.database?.filename), "Unsafe SQLite filename");
  assert.ok(Number.isSafeInteger(value.database.sizeBytes) && value.database.sizeBytes > 0, "Invalid backup size");
  assert.ok(/^[a-f0-9]{64}$/.test(value.database.sha256), "Invalid backup digest");
  return value;
}
// These remote programs only open existing regular files for reading. No env,
// database queries, writes, new backups or attachment bodies are requested.
export const discoverBackupProgram = `import json,os,pathlib,stat,sys
root=pathlib.Path(sys.argv[1])
if root.is_symlink() or not root.is_dir(): raise ValueError('backup root')
found=[]
for directory in root.iterdir():
 if directory.is_symlink() or not directory.is_dir() or not directory.name.startswith('missiongo-'): continue
 manifest=directory/'manifest.json'
 if manifest.is_symlink() or not manifest.is_file(): continue
 try:
  data=json.loads(manifest.read_text())
  data['directory']=directory.name
  name=data.get('database',{}).get('filename','')
  if pathlib.Path(name).name!=name or not name.endswith('.sqlite'): continue
  db=directory/name
  if db.is_symlink() or not db.is_file(): continue
  found.append({k:data[k] for k in ('formatVersion','createdAt','directory','database')})
 except (ValueError,KeyError,OSError): continue
if not found: raise ValueError('no complete backup')
print(json.dumps(max(found,key=lambda x:x['createdAt'])))
`;
const transferProgram = `import os,pathlib,shutil,stat,sys
root=pathlib.Path(sys.argv[1]); directory=root/sys.argv[2]; path=directory/sys.argv[3]
if root.is_symlink() or directory.is_symlink() or path.is_symlink(): raise ValueError('symlink')
if path.resolve().parent.parent != root.resolve(): raise ValueError('path escape')
fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW)
with os.fdopen(fd,'rb') as f:
 if not stat.S_ISREG(os.fstat(f.fileno()).st_mode): raise ValueError('not regular')
 shutil.copyfileobj(f,sys.stdout.buffer)
`;
export function backupCommand(program, args) {
  return ["sudo", "-n", "python3", "-c", quote(program), ...args.map(quote)].join(" ");
}
export function fetchBackup({ host, backupsDir, directory, ssh = "ssh" }) {
  assert.ok(typeof host === "string" && /^[A-Za-z0-9_@.:-]+$/.test(host) && !host.startsWith("-"), "Invalid SSH host");
  assert.ok(typeof backupsDir === "string" && backupsDir.startsWith("/") && !backupsDir.includes("\0"), "Invalid backup root");
  const sshArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host];
  const raw = execFileSync(ssh, [...sshArgs, backupCommand(discoverBackupProgram, [backupsDir])], { encoding: "utf8", maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"] });
  const manifest = validateManifest(JSON.parse(raw));
  const original = join(directory, "snapshot.sqlite"), fd = openSync(original, "wx", 0o600);
  try { execFileSync(ssh, [...sshArgs, backupCommand(transferProgram, [backupsDir, manifest.directory, manifest.database.filename])], { stdio: ["ignore", fd, "ignore"] }); }
  finally { closeSync(fd); }
  assert.equal(lstatSync(original).size, manifest.database.sizeBytes, "Backup size mismatch");
  const digest = createHash("sha256").update(readFileSync(original)).digest("hex");
  assert.equal(digest, manifest.database.sha256, "Backup digest mismatch");
  const database = join(directory, "work.sqlite");
  copyFileSync(original, database); chmodSync(database, 0o600); chmodSync(original, 0o400);
  return { database, backup: { sha256: digest, sizeBytes: manifest.database.sizeBytes, createdAt: manifest.createdAt } };
}
