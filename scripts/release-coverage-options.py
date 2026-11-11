"""Coverage options consumed by the shared coordinator, never forwarded to deploy.sh."""
from pathlib import Path
import re


def coverage_options(arguments, *, planning=False):
    values = {}
    remaining = []
    flags = {"--candidates", "--only-artifacts", "--scope-reason", "--selection", "--selection-digest"}
    index = 0
    while index < len(arguments):
        flag = arguments[index]
        if flag in flags:
            if flag in values or index + 1 == len(arguments) or arguments[index + 1].startswith("--"):
                raise ValueError("Coverage options need one value and must not repeat")
            values[flag] = arguments[index + 1]
            index += 2
        else:
            if any(flag.startswith(name + "=") for name in flags):
                raise ValueError("Use separate coverage option and value arguments")
            remaining.append(flag)
            index += 1
    if not values.get("--candidates"):
        raise ValueError("Use --candidates <complete includeUnscoped MCP pages>; plan the full product release first")
    candidates = Path(values["--candidates"]).resolve()
    if not candidates.is_file():
        raise ValueError("Release candidate file is missing")
    values["--candidates"] = str(candidates)
    if "--selection" in values:
        selection = Path(values["--selection"]).resolve()
        if not selection.is_file():
            raise ValueError("Release selection file is missing")
        values["--selection"] = str(selection)
    if "--selection-digest" in values:
        if "--selection" not in values or not re.fullmatch(r"[a-f0-9]{64}", values["--selection-digest"]):
            raise ValueError("Selection digest needs its selection and a SHA-256 from planning")
    if "--selection" in values and not planning and "--selection-digest" not in values:
        raise ValueError("Executable selection requires --selection-digest from the reviewed plan")
    if ("--only-artifacts" in values) != ("--scope-reason" in values) or "--scope-reason" in values and not values["--scope-reason"].strip():
        raise ValueError("Partial release needs --only-artifacts and --scope-reason from explicit user scope")
    coverage = [part for flag in ("--candidates", "--only-artifacts", "--scope-reason", "--selection", "--selection-digest") if flag in values for part in (flag, values[flag])]
    return remaining, coverage
