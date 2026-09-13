#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { parseArgs } from "node:util";

import { createClaudeCodeAdapter } from "./agents/claude-code.js";
import type { AgentAdapter } from "./agents/types.js";
import { NodeApiClient, pairNode } from "./client.js";
import { configPath, nodeHome, readConfig, writeConfig } from "./config.js";
import { CLAIM_WAIT_MS, HEARTBEAT_INTERVAL_MS, runLoop } from "./run.js";
import { installService, uninstallService } from "./service.js";

function usage(): string {
  const self = selfInvocation();
  return `missiongo-node — MissionGo 机器端守护进程

用法：
  ${self} pair <配对码> --server <服务地址>   用控制台生成的配对码登记本机
  ${self} install-service                    装成开机自启的后台服务（macOS）
  ${self} uninstall-service                  停止并移除后台服务
  ${self} run                                在前台拉取派单并启动会话
  ${self} --help

配置文件：${configPath()}（权限 0600）`;
}

// The list every other part of the daemon reads. Codex and Hermes adapters are
// added here once they exist; nothing else needs to change.
function createAdapters(): AgentAdapter[] {
  return [createClaudeCodeAdapter()];
}

async function pairCommand(argv: readonly string[]): Promise<number> {
  const { positionals, values } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: { server: { type: "string" } },
  });
  const code = positionals[0];
  if (!code) {
    console.error(`缺少配对码。用法：${selfInvocation()} pair <配对码> --server <服务地址>`);
    return 2;
  }
  if (!values.server) {
    console.error("缺少 --server <服务地址>。");
    return 2;
  }
  const paired = await pairNode({ serverUrl: values.server, code, hostname: hostname() });
  const path = writeConfig({
    serverUrl: values.server,
    token: paired.token,
    nodeId: paired.nodeId,
    name: paired.name,
  });
  // The token is written to disk and never printed: a pairing run often happens
  // in a shared terminal, and the value is the machine's whole credential.
  console.log(`已登记为「${paired.name}」（nodeId ${paired.nodeId}）。`);
  console.log(`凭证已写入 ${path}（权限 0600）。`);
  console.log(`接下来运行：${selfInvocation()} install-service（开机自启），或 ${selfInvocation()} run（仅前台）。`);
  return 0;
}

/**
 * How to call this program again, as the operator should type it. Installed from
 * the download it is `node ~/.missiongo-node/missiongo-node.mjs`, not a command on
 * PATH, and printing a bare `missiongo-node` sent people to a command that did
 * not exist on their machine.
 */
function selfInvocation(): string {
  const script = scriptPath();
  const home = homedir();
  const shown = script.startsWith(`${home}/`) ? `~${script.slice(home.length)}` : script;
  return `node ${shown}`;
}

function scriptPath(): string {
  return realpathSync(process.argv[1] ?? "");
}

function installServiceCommand(): number {
  if (!readConfig()) {
    console.error(`本机还没有配对：先运行 ${selfInvocation()} pair <配对码> --server <服务地址>。`);
    return 2;
  }
  const override = process.env.MISSIONGO_NODE_HOME?.trim();
  const { plistPath, logPath } = installService({
    scriptPath: scriptPath(),
    ...(override ? { nodeHome: override } : {}),
  });
  console.log(`已安装并启动后台服务：${plistPath}`);
  console.log(`运行日志：${logPath}`);
  console.log("关掉终端、重启电脑后会自动继续在线。控制台里的机器状态会在 30 秒内变为在线。");
  return 0;
}

function uninstallServiceCommand(): number {
  const { removed } = uninstallService();
  console.log(removed ? "已停止并移除后台服务。已启动的会话不受影响。" : "没有找到已安装的后台服务。");
  return 0;
}

async function runCommand(): Promise<number> {
  const config = readConfig();
  if (!config) {
    console.error(`本机还没有配对：先运行 ${selfInvocation()} pair <配对码> --server <服务地址>（配置位置 ${configPath(nodeHome())}）。`);
    return 2;
  }
  const client = new NodeApiClient({ serverUrl: config.serverUrl, token: config.token });
  const controller = new AbortController();
  // Ctrl-C stops the loop, not the sessions it started: those are detached on
  // purpose and keep running.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      console.log(`收到 ${signal}，停止拉取派单（已启动的会话不受影响）。`);
      controller.abort();
    });
  }
  console.log(
    `机器「${config.name}」已连接 ${config.serverUrl}，`
    + `每 ${HEARTBEAT_INTERVAL_MS / 1000}s 上报状态，派单拉取为长轮询（每次最多挂起 ${CLAIM_WAIT_MS / 1000}s）。`,
  );
  await runLoop({ client, adapters: createAdapters(), signal: controller.signal });
  return 0;
}

async function main(argv: readonly string[]): Promise<number> {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h" || command === "help") {
    console.log(usage());
    return command ? 0 : 2;
  }
  switch (command) {
    case "pair":
      return pairCommand(argv.slice(1));
    case "run":
      return runCommand();
    case "install-service":
      return installServiceCommand();
    case "uninstall-service":
      return uninstallServiceCommand();
    default:
      console.error(`未知命令：${command}\n\n${usage()}`);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
