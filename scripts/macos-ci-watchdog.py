#!/usr/bin/env python3
"""Bound a CI command, sampling its own processes before terminating on timeout."""
import argparse
import json
import os
from pathlib import Path
import signal
import subprocess
import sys
import time


def process_tree(root):
    result = subprocess.run(['ps', '-axo', 'pid=,ppid=,pgid=,comm='],
                            capture_output=True, text=True, timeout=5, check=True)
    rows = []
    for line in result.stdout.splitlines():
        parts = line.strip().split(None, 3)
        if len(parts) == 4:
            rows.append(dict(pid=int(parts[0]), ppid=int(parts[1]), pgid=int(parts[2]), name=Path(parts[3]).name))
    owned = {root}
    while True:
        expanded = owned | {r['pid'] for r in rows if r['ppid'] in owned or r['pgid'] == root}
        if expanded == owned:
            break
        owned = expanded
    return [r for r in rows if r['pid'] in owned]


def diagnose(root, directory, budget):
    deadline = time.monotonic() + budget
    result = {'processes': [], 'samples': [], 'errors': []}
    try:
        rows = process_tree(root)
        result['processes'] = rows
        # Prefer the test process over the Swift driver when the budget is tight.
        rows.sort(key=lambda r: (0 if 'xctest' in r['name'].lower() else 1, r['pid']))
        for row in rows[:6]:
            remaining = deadline - time.monotonic()
            if remaining < 4:
                result['errors'].append('Sampling budget exhausted')
                break
            sample = directory / ('sample-%s.txt' % row['pid'])
            try:
                with (directory / ('sample-%s.log' % row['pid'])).open('w') as log:
                    p = subprocess.run(['/usr/bin/sample', str(row['pid']), '2', '-mayDie', '-file', str(sample)],
                                       stdout=log, stderr=subprocess.STDOUT, timeout=min(6, remaining))
                result['samples'].append({'pid': row['pid'], 'exitCode': p.returncode, 'captured': sample.exists()})
            except (OSError, subprocess.TimeoutExpired) as error:
                result['errors'].append(type(error).__name__ + ' sampling pid ' + str(row['pid']))
    except (OSError, subprocess.SubprocessError) as error:
        result['errors'].append(type(error).__name__ + ' collecting process tree')
    (directory / 'diagnostics.json').write_text(json.dumps(result, indent=2) + '\n')


def stop_group(process, grace):
    pid = process.pid
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        return
    time.sleep(grace)
    # Reap a terminated leader before signalling again: on macOS an all-zombie
    # process group can return EPERM instead of ESRCH. Live descendants still
    # retain the group and must be killed even when the leader has exited.
    process.poll()
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass


def run(command, directory, timeout, diagnostic_budget, grace):
    directory.mkdir(parents=True, exist_ok=True)
    start = time.monotonic()
    interrupted = []
    def cancel(signum, _frame):
        interrupted.append(signum)
    previous = {s: signal.signal(s, cancel) for s in (signal.SIGINT, signal.SIGTERM)}
    outcome = {'status': 'launch_failed', 'exitCode': 1}
    process = None
    try:
        with (directory / 'command.log').open('wb') as output, (directory / 'command.log').open('rb') as reader:
            process = subprocess.Popen(command, stdout=output, stderr=subprocess.STDOUT, start_new_session=True)
            def forward():
                data = reader.read()
                if data:
                    try:
                        sys.stdout.buffer.write(data)
                        sys.stdout.buffer.flush()
                    except BrokenPipeError:
                        pass
            while True:
                forward()
                code = process.poll()
                if interrupted:
                    outcome = {'status': 'cancelled', 'exitCode': 128 + interrupted[0]}
                    stop_group(process, grace)
                    break
                if code is not None:
                    outcome = {'status': 'passed' if code == 0 else 'failed', 'exitCode': code if code >= 0 else 128 - code}
                    break
                if time.monotonic() - start >= timeout:
                    # Latch failure before sampling: even a concurrent clean exit
                    # must not turn a timed-out command into a green check.
                    outcome = {'status': 'timed_out', 'exitCode': 124}
                    print('\nCI command timed out; collecting bounded process samples.', flush=True)
                    try:
                        diagnose(process.pid, directory, diagnostic_budget)
                    except Exception as error:
                        print('Diagnostic collection failed: ' + type(error).__name__, flush=True)
                    finally:
                        stop_group(process, grace)
                    break
                time.sleep(0.1)
            process.wait(timeout=5)
            forward()
    finally:
        if process is not None and process.poll() is None:
            stop_group(process, grace)
            process.wait(timeout=5)
        for sig, handler in previous.items():
            signal.signal(sig, handler)
        outcome['durationSeconds'] = round(time.monotonic() - start, 3)
        (directory / 'result.json').write_text(json.dumps(outcome, indent=2) + '\n')
    return outcome['exitCode']


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--timeout-seconds', type=float, default=900)
    parser.add_argument('--diagnostic-seconds', type=float, default=45)
    parser.add_argument('--grace-seconds', type=float, default=3)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command or min(args.timeout_seconds, args.diagnostic_seconds, args.grace_seconds) <= 0:
        parser.error('A command and positive time limits are required')
    return run(command, args.output, args.timeout_seconds, args.diagnostic_seconds, args.grace_seconds)


if __name__ == '__main__':
    sys.exit(main())
