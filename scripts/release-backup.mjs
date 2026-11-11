import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmodSync, copyFileSync, constants, createReadStream, createWriteStream, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

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
export const transferProgram = `# MISSIONGO_BACKUP_TRANSFER_V2
import gzip,os,pathlib,stat,sys
root=pathlib.Path(sys.argv[1]); directory=root/sys.argv[2]; path=directory/sys.argv[3]
expected=int(sys.argv[4])
if expected<=0: raise ValueError('invalid expected size')
if root.is_symlink() or directory.is_symlink() or path.is_symlink(): raise ValueError('symlink')
if path.resolve().parent.parent != root.resolve(): raise ValueError('path escape')
fd=os.open(path,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK)
with os.fdopen(fd,'rb') as f:
 info=os.fstat(f.fileno())
 if not stat.S_ISREG(info.st_mode): raise ValueError('not regular')
 if info.st_size!=expected: raise ValueError('backup size changed')
 remaining=expected
 with gzip.GzipFile(fileobj=sys.stdout.buffer,mode='wb',compresslevel=1,mtime=0) as output:
  while remaining:
   data=f.read(min(1024*1024,remaining))
   if not data: raise ValueError('backup truncated')
   output.write(data)
   remaining-=len(data)
  if f.read(1): raise ValueError('backup grew')
`;
export function backupCommand(program, args) {
  return ["sudo", "-n", "python3", "-c", quote(program), ...args.map(quote)].join(" ");
}
export async function fetchBackup({ host, backupsDir, directory, ssh = "ssh", maxBackupBytes = 512 * 1024 * 1024, stage = () => {} }) {
  assert.ok(typeof host === "string" && /^[A-Za-z0-9_@.:-]+$/.test(host) && !host.startsWith("-"), "Invalid SSH host");
  assert.ok(typeof backupsDir === "string" && backupsDir.startsWith("/") && !backupsDir.includes("\0"), "Invalid backup root");
  const sshArgs = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host];
  stage("discovery");
  const raw = execFileSync(ssh, [...sshArgs, backupCommand(discoverBackupProgram, [backupsDir])], { encoding: "utf8", maxBuffer: 65536, stdio: ["ignore", "pipe", "ignore"] });
  const manifest = validateManifest(JSON.parse(raw));
  assert.ok(manifest.database.sizeBytes <= maxBackupBytes, "Backup resource limit exceeded");
  const original = join(directory, "snapshot.sqlite");
  const digest = createHash("sha256");
  let transferredBytes = 0, decodedBytes = 0;
  stage("transfer");
  const child = spawn(ssh, [...sshArgs, backupCommand(transferProgram, [backupsDir, manifest.directory, manifest.database.filename, String(manifest.database.sizeBytes)])], { stdio: ["ignore", "pipe", "ignore"] });
  const exited = new Promise(resolve => {
    child.once("error", () => resolve(false));
    child.once("close", code => resolve(code === 0));
  });
  const compressed = new Transform({ transform(bytes, _, done) {
    transferredBytes += bytes.length;
    done(transferredBytes > maxBackupBytes + 1024 * 1024 ? new Error("Compressed backup resource limit exceeded") : null, bytes);
  } });
  const decoded = new Transform({ transform(bytes, _, done) {
    decodedBytes += bytes.length;
    if (decodedBytes > manifest.database.sizeBytes || decodedBytes > maxBackupBytes) return done(new Error("Backup size mismatch"));
    digest.update(bytes); done(null, bytes);
  } });
  try {
    await pipeline(child.stdout, compressed, createGunzip(), decoded, createWriteStream(original, { flags: "wx", mode: 0o600 }));
    assert.ok(await exited, "Backup transfer failed");
  } catch (error) {
    child.kill("SIGKILL"); await exited; throw error;
  }
  stage("validation");
  assert.equal(decodedBytes, manifest.database.sizeBytes, "Backup size mismatch");
  assert.equal(lstatSync(original).size, manifest.database.sizeBytes, "Backup size mismatch");
  const sha256 = digest.digest("hex");
  assert.equal(sha256, manifest.database.sha256, "Backup digest mismatch");
  const diskDigest = createHash("sha256");
  for await (const chunk of createReadStream(original)) diskDigest.update(chunk);
  assert.equal(diskDigest.digest("hex"), manifest.database.sha256, "Backup digest mismatch");
  const database = join(directory, "work.sqlite");
  copyFileSync(original, database, constants.COPYFILE_EXCL); chmodSync(database, 0o600); chmodSync(original, 0o400);
  return { database, backup: { directory: manifest.directory, filename: manifest.database.filename,
    sha256, sizeBytes: decodedBytes, createdAt: manifest.createdAt, compression: "gzip", transferredBytes } };
}
