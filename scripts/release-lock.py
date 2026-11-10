#!/usr/bin/env python3
"""Hold one OS lock across every MissionGo publishing/deployment command."""
import fcntl
import json
import os
from pathlib import Path
import sys
import time


def main():
    args = sys.argv[1:]
    directory = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "missiongo"
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "release.lock"
    fd = os.open(str(path), os.O_CREAT | os.O_RDWR, 0o600)
    # Nested npm/scripts reuse the inherited, already locked open-file description.
    inherited = os.environ.get("MISSIONGO_RELEASE_LOCK_FD", "")
    if inherited.isdigit():
        try:
            parent_fd = int(inherited)
            if os.fstat(parent_fd) == os.fstat(fd):
                fcntl.flock(parent_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                os.close(fd)
                fd = parent_fd
        except (OSError, ValueError):
            pass
    try:
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        holder = os.read(fd, 16384).decode("utf-8", errors="replace")
        print("MissionGo release is already locked: " + holder, file=sys.stderr)
        return 75
    if args == ["--status"]:
        print("MissionGo release lock is free")
        return 0
    if not args or args[0] != "--" or len(args) < 2:
        print("Usage: release-lock.py -- <command> [args...] | --status", file=sys.stderr)
        return 2
    os.ftruncate(fd, 0)
    os.lseek(fd, 0, os.SEEK_SET)
    os.write(fd, json.dumps({"pid": os.getpid(), "worktree": os.getcwd(), "startedAt": time.time()}, ensure_ascii=False).encode())
    os.set_inheritable(fd, True)
    environment = dict(os.environ, MISSIONGO_RELEASE_LOCK_FD=str(fd))
    os.execvpe(args[1], args[1:], environment)


if __name__ == "__main__":
    sys.exit(main())
