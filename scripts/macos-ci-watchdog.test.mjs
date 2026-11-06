import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const script = resolve('scripts/macos-ci-watchdog.py');
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'mg-ci-watchdog-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
const args = directory => [script, '--output', directory, '--timeout-seconds', '0.5', '--diagnostic-seconds', '8', '--grace-seconds', '0.1'];
const result = directory => JSON.parse(readFileSync(join(directory, 'result.json')));

test('watchdog preserves successful output and nonzero command failures', t => {
  for (const code of [0, 7]) {
    const directory = fixture(t);
    const child = spawnSync('python3', [...args(directory), '--', 'python3', '-c', `print('fixture output'); raise SystemExit(${code})`], { encoding: 'utf8', timeout: 15000 });
    assert.equal(child.status, code, child.stderr);
    assert.equal(result(directory).status, code === 0 ? 'passed' : 'failed');
    assert.match(readFileSync(join(directory, 'command.log'), 'utf8'), /fixture output/);
    assert.match(child.stdout, /fixture output/);
    assert(!existsSync(join(directory, 'diagnostics.json')));
  }
});

test('timeout captures diagnostics before killing its group, preserves unrelated processes and fails closed', async t => {
  const directory = fixture(t);
  const unrelated = spawn('python3', ['-c', 'import time; time.sleep(30)']);
  t.after(() => unrelated.kill('SIGKILL'));
  const child = spawnSync('python3', [...args(directory), '--', 'python3', '-c',
    'import subprocess,signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); p=subprocess.Popen(["python3","-c","import signal,time; signal.signal(signal.SIGTERM, signal.SIG_IGN); time.sleep(60)"]); print("child",p.pid,flush=True); time.sleep(60)'], { encoding: 'utf8', timeout: 20000 });
  assert.equal(child.status, 124, child.stderr);
  assert.equal(result(directory).status, 'timed_out');
  const diagnostics = JSON.parse(readFileSync(join(directory, 'diagnostics.json')));
  assert(diagnostics.processes.length >= 2);
  if (process.platform === "darwin") assert(diagnostics.samples.some(s => s.exitCode === 0 && s.captured), JSON.stringify(diagnostics));
  assert(!diagnostics.processes.some(p => p.pid === unrelated.pid));
  assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  // A killed descendant can briefly remain a zombie until its parent is reaped.
  await delay(100);
  const pid = Number(readFileSync(join(directory, 'command.log'), 'utf8').match(/child (\d+)/)[1]);
  const state = spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
  assert(!state || state.startsWith('Z'), state);
});

test('diagnostic failure cannot turn a timeout green or prevent process cleanup', t => {
  const directory = fixture(t);
  const program = `import importlib.util, pathlib, sys
spec=importlib.util.spec_from_file_location('watchdog',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
def broken(*args): raise RuntimeError('fixture')
m.diagnose=broken
sys.exit(m.run(['python3','-c','import time; time.sleep(30)'],pathlib.Path(sys.argv[2]),0.2,1,0.1))`;
  const child = spawnSync('python3', ['-c', program, script, directory], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.status, 124, child.stderr);
  assert.equal(result(directory).status, 'timed_out');
});

test('external cancellation terminates the command and stays cancelled', async t => {
  const directory = fixture(t);
  const child = spawn('python3', [script, '--output', directory, '--timeout-seconds', '30', '--grace-seconds', '0.1', '--', 'python3', '-c', 'import time; print("ready",flush=True); time.sleep(60)'], { stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  for (let i = 0; i < 100; i++) {
    if (existsSync(join(directory, 'command.log')) && readFileSync(join(directory, 'command.log'), 'utf8').includes('ready')) break;
    await delay(20);
  }
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  assert.equal((await exited)[0], 143);
  assert.equal(result(directory).status, 'cancelled');
});
