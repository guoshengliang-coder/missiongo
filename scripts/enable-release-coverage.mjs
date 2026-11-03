#!/usr/bin/env node
// Upgrade the shared entry point without replacing its locking, target, CI or signing rules.
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { releaseCandidatesFromPages } from "./release-candidates.mjs";
import { repositoryIdentity } from "./handover-evidence.mjs";

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`Unknown installed release-tool version near: ${before.slice(0, 70)}`);
  return source.replace(before, after);
}

export function withCoverageReceipt(source, command) {
  const before = `  ${command} compare \\\n    --host "$host" --current-link "$current_link" --downloads-dir "$downloads_dir" \\\n    --before-json "$before_snapshot" --origin "$notice_origin" || {\n    echo "Deployment finished, but the release receipt is unavailable; do not advance work items." >&2\n    exit 1\n  }`;
  const after = `  release_receipt="$(${command} compare \\\n    --host "$host" --current-link "$current_link" --downloads-dir "$downloads_dir" \\\n    --before-json "$before_snapshot" --origin "$notice_origin")" || {\n    echo "Deployment finished, but the release receipt is unavailable; do not advance work items." >&2\n    exit 1\n  }\n  printf '%s\\n' "$release_receipt"\n  reconcile_release_coverage "$release_receipt"`;
  return replaceOnce(source, before, after);
}

export function upgradeCoverageTools(files) {
  const result = { ...files };
  if (!result.coordinator.includes('"publish:linux"')) throw new Error("Install existing Linux release-tool support first");
  if (!result.coordinator.includes("from release_coverage_options import coverage_options")) {
    result.coordinator = replaceOnce(result.coordinator, '"publish:linux"}', '"publish:linux", "plan"}');
    result.coordinator = replaceOnce(result.coordinator, '\ndef main():', '\nsys.path.insert(0, str(TOOLS))\nfrom release_coverage_options import coverage_options\n\n\ndef main():');
    const planning = [
      '    args, coverage_args = coverage_options(sys.argv[2:])',
      '    coverage_config = CONFIG / "release-coverage.json"',
      '    if not coverage_config.is_file():',
      '        raise ValueError("Install release coverage with its MissionGo product/repository binding first.")',
      '    coverage_args += ["--coverage-config", str(coverage_config)]',
      '    if action == "plan":',
      '        if any(arg != "--no-publish-apk" for arg in args):',
      '            raise ValueError("Unknown release plan option.")',
      '        plan = ["node", str(TOOLS / "release-preflight.mjs"), "--root", str(root), "--host", settings["host"], "--current-link", settings["currentLink"], "--downloads-dir", settings["downloadsDir"], "--coverage-plan", *coverage_args, *args]',
      '        run(plan, root)',
      '        return',
    ].join("\n") + "\n";
    result.coordinator = replaceOnce(result.coordinator, '    if git(root, "status", "--porcelain"):', planning + '    if git(root, "status", "--porcelain"):');
    result.coordinator = replaceOnce(result.coordinator, '    args = sys.argv[2:]\n', '');
    result.coordinator = replaceOnce(result.coordinator, '    if "--no-publish-apk" in args:', '    preflight.extend(coverage_args)\n    if "--no-publish-apk" in args:');
    const environment = [
      '    os.environ["MISSIONGO_RELEASE_CANDIDATES"] = coverage_args[coverage_args.index("--candidates") + 1]',
      '    os.environ["MISSIONGO_RELEASE_COVERAGE_CONFIG"] = str(coverage_config)',
      '    for flag, key in [("--only-artifacts", "MISSIONGO_RELEASE_ONLY_ARTIFACTS"), ("--scope-reason", "MISSIONGO_RELEASE_SCOPE_REASON")]:',
      '        if flag in coverage_args:',
      '            os.environ[key] = coverage_args[coverage_args.index(flag) + 1]',
      '        else:',
      '            os.environ.pop(key, None)',
    ].join("\n") + "\n";
    result.coordinator = replaceOnce(result.coordinator, '    os.environ["MISSIONGO_RELEASE_ROOT"] = str(root)', environment + '    os.environ["MISSIONGO_RELEASE_ROOT"] = str(root)');
  }
  if (!result.preflight.includes('from "./release-coverage.mjs"')) {
    result.preflight = replaceOnce(result.preflight, 'const SHA =', 'import { coverageForCheckout, assertReleaseCoverage } from "./release-coverage.mjs";\n\nconst SHA =');
    result.preflight = replaceOnce(result.preflight, 'result.push({ artifact: "androidSdk", mode: "local", version: sdk.version });', 'result.push({ artifact: "androidSdk", mode: "local", version: sdk.version, sourceCommit: sdk.commit, pomSha256: digest(pom), aarSha256: digest(aar) });');
    result.preflight = replaceOnce(result.preflight, '  linuxReleaseTools?.checkLinuxArtifacts(root, live?.linuxCli);', '  const linux = linuxReleaseTools?.checkLinuxArtifacts(root, live?.linuxCli);\n  if (linux) result.push({ artifact: "linuxCli", ...linux });');
    const coverage = [
      '  if (!value("--candidates") || !value("--coverage-config")) throw new Error("Complete release candidates and product/repository coverage binding are required");',
      '  const coverage = coverageForCheckout({ root, live,',
      '    config: JSON.parse(readFileSync(value("--coverage-config"), "utf8")),',
      '    candidates: JSON.parse(readFileSync(value("--candidates"), "utf8")),',
      '    artifacts: [{ artifact: "web", version: JSON.parse(readFileSync(join(root, "product.json"), "utf8")).web.version, sourceCommit: git(root, "rev-parse", "HEAD") }, ...report],',
      '    onlyArtifacts: value("--only-artifacts") ?? undefined, scopeReason: value("--scope-reason") ?? undefined });',
      '  console.log(JSON.stringify({ artifacts: report, coverage }, null, 2));',
      '  if (!argv.includes("--coverage-plan")) assertReleaseCoverage(coverage);',
    ].join("\n");
    result.preflight = replaceOnce(result.preflight, '  console.log(JSON.stringify(report, null, 2));', coverage);
  }
  if (!result.deploy.includes("check_release_coverage")) {
    const previous = 'node "$RELEASE_TOOLS/release-preflight.mjs" --root "$PWD" --snapshot "$before_snapshot" --host "$host" --current-link "$current_link" ${artifact_options[@]+"${artifact_options[@]}"}';
    result.deploy = replaceOnce(result.deploy, previous, 'source "$RELEASE_TOOLS/release-coverage-guard.sh"\ncheck_release_coverage');
    result.deploy = withCoverageReceipt(result.deploy, 'node "$RELEASE_TOOLS/release-receipt.mjs"');
  }
  for (const [key, fragments] of Object.entries({
    coordinator: ['args, coverage_args = coverage_options(sys.argv[2:])', 'preflight.extend(coverage_args)', 'os.environ["MISSIONGO_RELEASE_CANDIDATES"]', '"--coverage-plan"'],
    preflight: ['const coverage = coverageForCheckout({ root, live,', 'assertReleaseCoverage(coverage)', 'sourceCommit: sdk.commit', 'result.push({ artifact: "linuxCli", ...linux })'],
    deploy: ['source "$RELEASE_TOOLS/release-coverage-guard.sh"\ncheck_release_coverage', 'reconcile_release_coverage "$release_receipt"'],
  })) if (fragments.some(fragment => !result[key].includes(fragment))) throw new Error("Partial or unknown coverage installation; existing tools were preserved");
  return result;
}

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
export function installCoverage({ home = homedir(), configHome = process.env.XDG_CONFIG_HOME ?? join(home, ".config"), productId, candidates, dryRun = false, repositoryRoot = root }) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(productId ?? "")) throw new Error("Specify --product-id from the authorized MissionGo product");
  const snapshot = releaseCandidatesFromPages(candidates, { coverage: true });
  if (snapshot.productId !== productId) throw new Error("The complete candidate snapshot must belong to the configured product");
  const repository = repositoryIdentity(execFileSync("git", ["-C", repositoryRoot, "config", "--get", "remote.origin.url"], { encoding: "utf8" }));
  const directory = join(configHome, "missiongo"); const tools = join(directory, "release-tools");
  const config = join(directory, "release-coverage.json");
  const manifestPath = join(directory, "release-coverage-installation.json");
  for (const path of [config, manifestPath]) if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) throw new Error("Coverage configuration must be a regular file; existing paths were preserved");
  if (existsSync(config)) {
    const previous = JSON.parse(readFileSync(config, "utf8"));
    if (previous.productId !== productId || previous.repository !== repository) throw new Error("Existing release coverage belongs to another product or repository; it was preserved");
  }
  const paths = { coordinator: join(home, ".local/bin/missiongo-release"), preflight: join(tools, "release-preflight.mjs"), deploy: join(tools, "deploy.sh") };
  const before = Object.fromEntries(Object.entries(paths).map(([key, path]) => {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Release tool must be a regular file; symlinks were preserved");
    return [key, readFileSync(path, "utf8")];
  }));
  const after = upgradeCoverageTools(before);
  execFileSync("python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read())"], { input: after.coordinator, stdio: ["pipe", "pipe", "pipe"] });
  execFileSync(process.execPath, ["--input-type=module", "--check"], { input: after.preflight, stdio: ["pipe", "pipe", "pipe"] });
  execFileSync("bash", ["-n"], { input: after.deploy, stdio: ["pipe", "pipe", "pipe"] });
  const files = Object.entries(paths).map(([key, path]) => ({ path, text: after[key], before: before[key], backup: true }));
  const previousManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  const digest = value => createHash("sha256").update(value).digest("hex");
  const hashes = {};
  for (const [source, target] of [["release-coverage.mjs", "release-coverage.mjs"], ["release-candidates.mjs", "release-candidates.mjs"],
    ["release-coverage-guard.sh", "release-coverage-guard.sh"], ["release-coverage-options.py", "release_coverage_options.py"]]) {
    const text = readFileSync(join(root, "scripts", source), "utf8"); const path = join(tools, target);
    if (existsSync(path)) {
      if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error("Existing coverage helper is not a regular file; preserved");
      const current = readFileSync(path, "utf8");
      if (current !== text && previousManifest[target] !== digest(current)) throw new Error("Coverage helper has unknown local changes; preserved");
    }
    hashes[target] = digest(text); files.push({ path, text });
  }
  files.push({ path: config, text: JSON.stringify({ schemaVersion: 1, productId, repository }, null, 2) + "\n" });
  files.push({ path: manifestPath, text: JSON.stringify(hashes, null, 2) + "\n" });
  if (!dryRun) for (const file of files) {
    if (existsSync(file.path) && readFileSync(file.path, "utf8") === file.text) continue;
    if (file.backup && !existsSync(`${file.path}.before-release-coverage`)) writeFileSync(`${file.path}.before-release-coverage`, file.before, { flag: "wx", mode: 0o600 });
    writeFileSync(file.path, file.text, { mode: 0o600 });
  }
  return { installed: !dryRun, productId, repository, files: files.map(file => file.path) };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2); const value = flag => args[args.indexOf(flag) + 1];
    if (!args.includes("--product-id") || !args.includes("--candidates")) throw new Error("Usage: enable-release-coverage.mjs --product-id <id> --candidates <fresh complete MCP pages> [--dry-run]");
    // Updating shared programs must not race a build or deployment using them.
    const entry = fileURLToPath(import.meta.url);
    if (process.env.MISSIONGO_COVERAGE_INSTALL_ENTRY !== entry) {
      const lock = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "missiongo/release-tools/release-lock.py");
      const result = spawnSync("python3", [lock, "--", process.execPath, entry, ...args], {
        stdio: "inherit", env: { ...process.env, MISSIONGO_COVERAGE_INSTALL_ENTRY: entry },
      });
      if (result.error) throw result.error;
      process.exit(result.status ?? 1);
    }
    console.log(JSON.stringify(installCoverage({ productId: value("--product-id"), candidates: JSON.parse(readFileSync(value("--candidates"), "utf8")), dryRun: args.includes("--dry-run") }), null, 2));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
