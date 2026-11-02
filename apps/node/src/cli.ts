#!/usr/bin/env node
import { hostname } from "node:os";
import { realpathSync } from "node:fs";
import { join, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { API, serverOrigin } from "./api.js";
import { hostCall, runHost } from "./host.js";
import { detectAgents, runNode, verifyRepo, version } from "./runner.js";
import { loadConfig, readPrivate, safeError, saveConfig, stateRoot } from "./storage.js";
import { installService, uninstallService } from "./service.js";
import type { Kind, RepoMapping } from "./types.js";

const help = `missiongo-node — Linux headless execution node
Node.js >=22.13; Ubuntu 22.04/24.04 x86_64; no graphical session required.

login --server <https-origin> [--name <name>]  Authorize in any browser
logout                                     Remove this local node credential
products                                   List permitted products
repo list | repo set <product-id> <path> | repo remove <product-id>
agent enable <claude_code|codex|opencode> [--executable <absolute-path>]
agent disable <kind> | agent check          Only enabled agents are probed
status | doctor                            Show node state / recheck enabled agents
run                                        Foreground node (flock singleton)
service install | service uninstall         Optional systemd user service; print systemctl commands
--version | --help

Agents keep their existing accounts, models, gateways and MCP authorization.
Enable only the integrations you want this node to use. Run without sudo.
`;

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const { values, positionals } = parseArgs({ args: argv, allowPositionals: true, options: {
    server: { type: "string" }, name: { type: "string" }, executable: { type: "string" },
    version: { type: "boolean" }, help: { type: "boolean", short: "h" },
  } });
  if (values.version) { console.log(version); return; }
  if (values.help || !positionals.length) { console.log(help); return; }
  const root = stateRoot(); const entry = fileURLToPath(import.meta.url);
  const config = loadConfig(root);
  const [command, action, arg, path] = positionals;
  const api = () => {
    if (!config.server || !config.token) throw new Error("Run login first");
    return new API(config.server, config.token);
  };
  switch (command) {
    case "login": {
      if (process.platform === "linux" && spawnSync("flock", ["--nonblock", join(root, "node.lock"), "true"]).status !== 0) throw new Error("Stop the running node before changing its login");
      if (!values.server) throw new Error("Specify --server <https-origin>");
      const next = await new API(serverOrigin(values.server)).login(config, values.name ?? hostname(), (url, code) => {
        console.log(`Open this URL on any device to authorize:\n${url}\nDevice code: ${code}`);
      });
      saveConfig(root, next); console.log("Node registered. Enable an Agent, map a repository, then run."); return;
    }
    case "logout": {
      if (process.platform === "linux" && spawnSync("flock", ["--nonblock", join(root, "node.lock"), "true"]).status !== 0) throw new Error("Stop the running node before signing out");
      delete config.token; delete config.nodeId; saveConfig(root, config);
      console.log("Local credential removed. Stop the node service; revoke the device in Web to invalidate any running copy."); return;
    }
    case "products": {
      const profile = await api().call("GET", "/api/v1/node/me"); console.log(JSON.stringify(profile.products, null, 2)); return;
    }
    case "repo": {
      const client = api(); const profile = await client.call("GET", "/api/v1/node/me");
      const repos: RepoMapping[] = profile.repos ?? [];
      if (action === "list") { console.log(JSON.stringify(repos, null, 2)); return; }
      if (!arg || !profile.products?.some((product: { id: string }) => product.id === arg)) throw new Error("Choose a product ID from products");
      const next = repos.filter((repo) => repo.productId !== arg);
      if (action === "set" && path) next.push({ productId: arg, repoPath: await verifyRepo(path) });
      else if (action !== "remove") throw new Error("Use repo set <product-id> <path> or repo remove <product-id>");
      await client.call("PUT", "/api/v1/node/repos", { repos: next.map(({ productId, repoPath }) => ({ productId, repoPath })) });
      console.log("Repository mappings saved."); return;
    }
    case "agent": {
      if (action === "check") { console.log(JSON.stringify(await detectAgents(config), null, 2)); return; }
      if (!["claude_code", "codex", "opencode"].includes(arg ?? "")) throw new Error("Choose claude_code, codex, or opencode");
      const kind = arg as Kind;
      if (action === "enable") {
        api();
        if (values.executable && !isAbsolute(values.executable)) throw new Error("Executable override must be an absolute path");
        config.agents[kind] = values.executable ? { executable: values.executable } : {};
        saveConfig(root, config);
        console.log(JSON.stringify(await detectAgents({ ...config, agents: { [kind]: config.agents[kind] } }), null, 2));
      } else if (action === "disable") { delete config.agents[kind]; saveConfig(root, config); console.log("Integration disabled for new dispatches."); }
      else throw new Error("Use agent enable, disable or check");
      return;
    }
    case "status": {
      const status = readPrivate(join(root, "status.json"));
      console.log(JSON.stringify({ version, registered: !!config.token, enabledAgents: Object.keys(config.agents), runtime: status ?? { state: "not_started" } }, null, 2)); return;
    }
    case "doctor": {
      await api().call("GET", "/api/v1/node/me");
      console.log(JSON.stringify({ version, nodeAuthorization: "valid", agents: await detectAgents(config) }, null, 2)); return;
    }
    case "service": {
      if (action === "install") {
        console.log(`Created ${installService(process.execPath, entry, root)}\nRun:\nsystemctl --user daemon-reload\nsystemctl --user enable --now missiongo-node`);
      } else if (action === "uninstall") {
        uninstallService(); console.log("Unit removed. Run systemctl --user disable --now missiongo-node and systemctl --user daemon-reload. Existing Agent hosts remain running.");
      } else throw new Error("Use service install or uninstall"); return;
    }
    case "run": {
      api(); saveConfig(root, config);
      // Kernel-owned lock survives crashes without stale PID files or unsafe lock deletion.
      const child = spawn("flock", ["--nonblock", "--no-fork", join(root, "node.lock"), process.execPath, entry, "_run"], { stdio: "inherit", env: process.env });
      const stop = () => child.kill("SIGTERM"); process.once("SIGTERM", stop); process.once("SIGINT", stop);
      await new Promise<void>((resolve, reject) => { child.once("error", () => reject(new Error("flock (util-linux) is required"))); child.once("exit", (code) => {
        process.removeListener("SIGTERM", stop); process.removeListener("SIGINT", stop); if (code) reject(new Error("Node exited or another node holds the lock")); else resolve();
      }); }); return;
    }
    case "_run": {
      const controller = new AbortController(); const stop = () => controller.abort();
      process.once("SIGTERM", stop); process.once("SIGINT", stop);
      await runNode(root, entry, controller.signal); return;
    }
    case "_host": { if (!action) throw new Error("Missing dispatch ID"); await runHost(root, action); return; }
    case "inspect": { if (!action) throw new Error("Missing dispatch ID"); console.log(JSON.stringify(await hostCall(root, action), null, 2)); return; }
    default: throw new Error("Unknown command; use --help");
  }
}
if (process.argv[1] && fileURLToPath(import.meta.url) === realpathSync(process.argv[1])) {
  main().catch((error) => { console.error(safeError(error)); process.exitCode = 1; });
}
