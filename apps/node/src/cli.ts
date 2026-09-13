#!/usr/bin/env node
import { hostname } from "node:os";
import { parseArgs } from "node:util";

import { createClaudeCodeAdapter } from "./agents/claude-code.js";
import type { AgentAdapter } from "./agents/types.js";
import { NodeApiClient, pairNode } from "./client.js";
import { configPath, nodeHome, readConfig, writeConfig } from "./config.js";
import { CLAIM_WAIT_MS, HEARTBEAT_INTERVAL_MS, runLoop } from "./run.js";

const USAGE = `missiongo-node — MissionGo 机器端守护进程

用法：
  missiongo-node pair <配对码> --server <服务地址>   用控制台生成的配对码登记本机
  missiongo-node run                                拉取派单并启动会话
  missiongo-node --help

配置文件：${configPath()}（权限 0600）`;

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
    console.error("缺少配对码。用法：missiongo-node pair <配对码> --server <服务地址>");
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
  console.log(`凭证已写入 ${path}（权限 0600）。接下来运行：missiongo-node run`);
  return 0;
}

async function runCommand(): Promise<number> {
  const config = readConfig();
  if (!config) {
    console.error(`本机还没有配对：先运行 missiongo-node pair <配对码> --server <服务地址>（配置位置 ${configPath(nodeHome())}）。`);
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
    console.log(USAGE);
    return command ? 0 : 2;
  }
  switch (command) {
    case "pair":
      return pairCommand(argv.slice(1));
    case "run":
      return runCommand();
    default:
      console.error(`未知命令：${command}\n\n${USAGE}`);
      return 2;
  }
}

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
