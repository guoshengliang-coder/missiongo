#!/usr/bin/env node
//
// Fill a MissionGo instance with the same console, every time.
//
// The UI checks in tests/ui measure what is actually on screen -- text size,
// contrast, touch targets, and the screenshots themselves -- so an empty
// instance passes every one of them while saying nothing. This writes a fixture
// that puts each type, each status, attachments, a comment and a long URL in
// front of them, through the same REST API the console uses.
//
// Deterministic on purpose: same titles, same order, same generated PNGs, so a
// screenshot that differs means the interface changed.
//
// Used by the Playwright global setup, and by hand against a throwaway local
// server: `node scripts/seed-ui-fixture.mjs --base http://127.0.0.1:8799 --cookie <session>`

import { readFileSync } from "node:fs";
import { deflateSync } from "node:zlib";

/** A solid-colour PNG, built here so the fixture needs no binary files in git. */
export function solidPng(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body) >>> 0);
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // truecolour
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x += 1) {
      const at = row + 1 + x * 3;
      // A band across the top, so the image is not one flat colour and a
      // thumbnail crop is visible in a screenshot.
      const top = y < height * 0.12;
      raw[at] = top ? 23 : r;
      raw[at + 1] = top ? 32 : g;
      raw[at + 2] = top ? 51 : b;
    }
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

let crcTable;
function crc32(buffer) {
  if (!crcTable) {
    crcTable = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c;
    }
  }
  let crc = -1;
  for (const byte of buffer) crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return crc ^ -1;
}

const LONG_URL = "https://example.com/very/long/path/that/has/to/wrap/instead/of/widening/the/row?trace=1&attempt=2";

export async function seedFixture({ baseUrl, cookie, fetchImpl = fetch }) {
  const call = async (path, init = {}) => {
    const response = await fetchImpl(new URL(path, baseUrl), {
      ...init,
      headers: {
        accept: "application/json",
        cookie,
        ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} -> ${response.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  };

  const products = await call("/api/v1/products");
  const product = products[0] ?? (await call("/api/v1/products", {
    method: "POST",
    body: JSON.stringify({ name: "Fixture", keyPrefix: "FX" }),
  }));

  const createItem = (body) => call("/api/v1/items", { method: "POST", body: JSON.stringify({ productId: product.id, ...body }) });
  const move = (key, to, reason, note) => call(`/api/v1/items/${key}/transitions`, {
    method: "POST",
    body: JSON.stringify({ to, reason, ...(note ? { note } : {}) }),
  });
  const attach = (key, name, type, body) => fetchImpl(new URL(`/api/v1/items/${key}/attachments`, baseUrl), {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/octet-stream",
      "x-missiongo-content-type": type,
      "x-missiongo-filename": encodeURIComponent(name),
    },
    body,
  }).then((response) => {
    if (!response.ok) throw new Error(`attachment ${name} -> ${response.status}`);
  });

  const keys = [];

  const bug = await createItem({
    status: "ready",
    type: "bug",
    priority: "urgent",
    title: "界面走查：弱网下首页列表空白，下拉刷新才出现",
    description: `在弱网环境打开 App，**列表为空**，下拉刷新后恢复。\n\n- 复现概率约 1/5\n- 日志见附件\n\n参考：${LONG_URL}`,
    report: {
      overview: "首页列表空白",
      reproductionSteps: "1. 打开 App\n2. 切到弱网\n3. 回到首页",
      expectedOutcome: "列表正常显示",
      impact: "所有 Android 用户",
      occurrenceFrequency: "intermittent",
    },
    environment: {
      platform: "android",
      appVersion: "0.1.13",
      buildNumber: "113",
      osVersion: "Android 15",
      deviceModel: "Pixel 8",
      metadata: { locale: "zh-CN", network: "wifi" },
    },
  });
  keys.push(bug.key);
  await attach(bug.key, "screen-a.png", "image/png", solidPng(360, 780, [214, 226, 240]));
  await attach(bug.key, "screen-b.png", "image/png", solidPng(360, 780, [240, 224, 214]));
  // An iPhone screenshot as the phone saves it. Only Safari can draw HEIC, so
  // this is what proves the server's decoded copy reaches the page (C6).
  await attach(bug.key, "iphone.heic", "image/heic", readFileSync(new URL("../services/server/src/test-fixtures/iphone-screenshot.heic", import.meta.url)));
  // Bytes no browser can decode as video, standing in for the HEVC .mov an
  // iPhone records and Windows browsers cannot play.
  await attach(bug.key, "screen-recording.mov", "video/quicktime", Buffer.from("not a playable video stream"));
  await attach(bug.key, "app.log", "text/plain", Buffer.from(
    "2026-09-22 10:00:01 INFO boot\n2026-09-22 10:00:02 WARN slow network 3200ms\n2026-09-22 10:00:03 ERROR list request timed out\n",
  ));
  await call(`/api/v1/items/${bug.key}/comments`, {
    method: "POST",
    body: JSON.stringify({ text: "已在 Pixel 8 上复现，和网络超时有关。" }),
  });
  await move(bug.key, "in_progress", "claim");

  const requirement = await createItem({
    status: "ready",
    type: "requirement",
    priority: "high",
    title: "界面走查：支持按模块筛选列表",
    description: "希望在列表顶部按模块筛选。",
    environment: { platform: "web" },
  });
  keys.push(requirement.key);
  await move(requirement.key, "on_hold", "request_human_input", "需要确认筛选是否多选");

  const idea = await createItem({
    status: "inbox",
    type: "idea",
    priority: "normal",
    title: "界面走查：详情里显示预计完成时间",
    description: "灵感：详情页可以显示预计完成时间。",
  });
  keys.push(idea.key);

  const task = await createItem({
    status: "ready",
    type: "task",
    priority: "normal",
    title: "界面走查：升级依赖并跑一遍回归",
    description: "升级 React 与 Vite。",
    environment: { platform: "shared" },
  });
  keys.push(task.key);
  await move(task.key, "in_progress", "claim");
  await move(task.key, "development_complete", "resolution_submitted", "已合并，待发布");
  await move(task.key, "pending_verification", "release_verified", "已发布，待验证");

  const note = await createItem({
    status: "ready",
    type: "note",
    priority: "low",
    title: "界面走查：发布前更新 CHANGELOG",
    description: "备注。",
    environment: { platform: "other" },
  });
  keys.push(note.key);
  await move(note.key, "in_progress", "claim");
  await move(note.key, "development_complete", "resolution_submitted");
  await move(note.key, "pending_verification", "release_verified");
  await move(note.key, "done", "verification_passed");

  const cancelled = await createItem({
    status: "inbox",
    type: "bug",
    priority: "low",
    title: "界面走查：误录的一条",
    description: "误录。",
  });
  keys.push(cancelled.key);
  await move(cancelled.key, "cancelled", "cancelled", "误录");

  return { productId: product.id, keys, detailKey: bug.key };
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop())) {
  const argument = (name, fallback) => {
    const at = process.argv.indexOf(`--${name}`);
    return at === -1 ? fallback : process.argv[at + 1];
  };
  const baseUrl = argument("base", "http://127.0.0.1:8787");
  const cookie = argument("cookie", "");
  if (!cookie) {
    console.error("Pass --cookie <session cookie>. This writes items, so it wants the session you already have.");
    process.exit(2);
  }
  const result = await seedFixture({ baseUrl, cookie });
  console.log(`Seeded ${result.keys.length} items into ${baseUrl}: ${result.keys.join(", ")}`);
}
