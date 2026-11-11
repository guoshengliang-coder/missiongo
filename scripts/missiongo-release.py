#!/usr/bin/env python3
"""Machine-wide release entry point; private target values stay outside Git."""
import json
import os
from pathlib import Path
import subprocess
import sys

CONFIG = Path(os.environ.get("XDG_CONFIG_HOME", str(Path.home() / ".config"))) / "missiongo"
TOOLS = CONFIG / "release-tools"


def run(command, root):
    subprocess.run(command, cwd=str(root), check=True)


def git(root, *args):
    return subprocess.check_output(["git", *args], cwd=str(root), text=True).strip()


sys.path.insert(0, str(TOOLS))
from release_coverage_options import coverage_options


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    allowed = {"status", "check", "deploy", "publish:macos", "publish:android-internal", "publish:android-sdk", "publish:linux", "plan"}
    if action not in allowed:
        raise ValueError("Usage: missiongo-release " + "|".join(sorted(allowed)))
    root = Path(git(Path.cwd(), "rev-parse", "--show-toplevel"))
    if not (root / "product.json").is_file() or not (root / "scripts/deploy.sh").is_file():
        raise ValueError("Run this from a MissionGo worktree.")
    if action == "status":
        print(json.dumps({"worktree": str(root), "head": git(root, "rev-parse", "HEAD"), "originMain": git(root, "rev-parse", "origin/main"), "dirty": bool(git(root, "status", "--porcelain"))}, ensure_ascii=False, indent=2), flush=True)
        run([sys.executable, str(TOOLS / "release-lock.py"), "--status"], root)
        return
    # Every invocation, including legacy checkouts, passes the same installed guards.
    entry = str(Path(__file__).resolve())
    if os.environ.get("MISSIONGO_COORDINATOR_ENTRY") != entry:
        os.environ["MISSIONGO_COORDINATOR_ENTRY"] = entry
        os.execv(sys.executable, [sys.executable, str(TOOLS / "release-lock.py"), "--", sys.executable, entry, *sys.argv[1:]])
    if action.startswith("publish:"):
        artifact = {"publish:macos": "macosApp", "publish:android-internal": "androidApp", "publish:android-sdk": "androidSdk", "publish:linux": "linuxCli"}[action]
        run(["node", str(TOOLS / "release-preflight.mjs"), "--root", str(root), "--build", artifact], root)
        if artifact not in {"androidSdk", "linuxCli"}:
            run(["node", str(root / "scripts/release-notes.mjs"), "--artifact", artifact, "--to", git(root, "rev-parse", "HEAD")], root)
        script = root / "scripts" / (action.replace("publish:", "publish-") + ".sh")
        os.execv(str(script), [str(script), *sys.argv[2:]])
    settings = json.loads((CONFIG / "release-local.json").read_text())
    common = (root / git(root, "rev-parse", "--git-common-dir")).resolve()
    if root.resolve() == common.parent:
        raise ValueError("Deploy/check must use an isolated release worktree.")
    args, coverage_args = coverage_options(sys.argv[2:], planning=action == "plan")
    coverage_config = CONFIG / "release-coverage.json"
    if not coverage_config.is_file():
        raise ValueError("Install release coverage with its MissionGo product/repository binding first.")
    coverage_args += ["--coverage-config", str(coverage_config)]
    if action == "plan":
        if any(arg != "--no-publish-apk" for arg in args):
            raise ValueError("Unknown release plan option.")
        plan = ["node", str(TOOLS / "release-preflight.mjs"), "--root", str(root), "--host", settings["host"], "--current-link", settings["currentLink"], "--downloads-dir", settings["downloadsDir"], "--coverage-plan", *coverage_args, *args]
        run(plan, root)
        return
    if git(root, "status", "--porcelain"):
        raise ValueError("Worktree has existing changes; preserve and commit them before deployment.")
    git(root, "fetch", "--quiet", "origin", "main")
    commit = git(root, "rev-parse", "HEAD")
    if commit != git(root, "rev-parse", "origin/main"):
        raise ValueError("HEAD must equal the latest origin/main.")
    run(["node", str(TOOLS / "release-ci.mjs"), commit], root)
    run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", settings["host"], "true"], root)
    if any(arg.startswith(("--host", "--env-file", "--current-link", "--downloads-dir", "--releases-dir", "--allow-dirty", "--skip-ci-check", "--skip-backup", "--notice-origin")) for arg in args):
        raise ValueError("Use the documented target and normal guards; overrides are not accepted by the shared entry point.")
    preflight = ["node", str(TOOLS / "release-preflight.mjs"), "--root", str(root), "--host", settings["host"], "--current-link", settings["currentLink"], "--downloads-dir", settings["downloadsDir"]]
    preflight.extend(coverage_args)
    if "--no-publish-apk" in args:
        preflight.append("--no-publish-apk")
    run(preflight, root)
    # BEGIN RELEASE PERFORMANCE V1
    performance_settings = json.loads((CONFIG / "release-coverage.json").read_text())
    if not settings.get("backupsDir"):
        raise ValueError("Install the release performance backup-directory setting first.")
    smoke = root / "scripts/release-performance.mjs"
    if not smoke.is_file():
        raise ValueError("Candidate checkout lacks mandatory release performance support.")
    run(["node", str(smoke), "--root", str(root), "--host", settings["host"], "--backups-dir", settings["backupsDir"], "--product-id", performance_settings["productId"]], root)
    # END RELEASE PERFORMANCE V1
    if action == "check":
        return
    # Keep the lock while the repository's standard deployment runs.
    os.environ["MISSIONGO_RELEASE_CANDIDATES"] = coverage_args[coverage_args.index("--candidates") + 1]
    os.environ["MISSIONGO_RELEASE_COVERAGE_CONFIG"] = str(coverage_config)
    for flag, key in [("--only-artifacts", "MISSIONGO_RELEASE_ONLY_ARTIFACTS"), ("--scope-reason", "MISSIONGO_RELEASE_SCOPE_REASON"), ("--selection", "MISSIONGO_RELEASE_SELECTION"), ("--selection-digest", "MISSIONGO_RELEASE_SELECTION_DIGEST")]:
        if flag in coverage_args:
            os.environ[key] = coverage_args[coverage_args.index(flag) + 1]
        else:
            os.environ.pop(key, None)
    os.environ["MISSIONGO_RELEASE_ROOT"] = str(root)
    os.environ["MISSIONGO_RELEASE_TOOLS"] = str(TOOLS)
    script = TOOLS / "deploy.sh"
    os.execv(str(script), [str(script), "--host", settings["host"], "--env-file", settings["envFile"], "--notice-origin", settings["origin"], *args])


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        print("MissionGo release refused: " + str(error), file=sys.stderr)
        sys.exit(1)
