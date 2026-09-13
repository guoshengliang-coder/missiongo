import { chmodSync, mkdtempSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { configPath, logPathFor, normalizeServerUrl, parseConfig, readConfig, writeConfig } from "./config.js";

function fakeHome(): string {
  return mkdtempSync(join(tmpdir(), "missiongo-node-config-"));
}

describe("writeConfig", () => {
  it("writes the token readable only by its owner", () => {
    // The file is the machine's whole credential; a group- or world-readable
    // config would hand it to every other account on the machine.
    const home = fakeHome();
    const path = writeConfig({ serverUrl: "https://missiongo.example.com", token: "mgn_abc", nodeId: "n1", name: "mbp" }, home);
    expect(path).toBe(configPath(home));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("tightens the permissions of a file that already existed", () => {
    // writeFileSync's mode only applies when it creates the file, so pairing a
    // second time would otherwise keep a loose mode from the first run.
    const home = fakeHome();
    const path = writeConfig({ serverUrl: "https://a.example.com", token: "mgn_1", nodeId: "n1", name: "mbp" }, home);
    chmodSync(path, 0o644);
    writeConfig({ serverUrl: "https://a.example.com", token: "mgn_2", nodeId: "n1", name: "mbp" }, home);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("round-trips through readConfig and reports an unpaired machine as undefined", () => {
    const home = fakeHome();
    expect(readConfig(home)).toBeUndefined();
    writeConfig({ serverUrl: "https://missiongo.example.com/", token: "mgn_abc", nodeId: "n1", name: "mbp" }, home);
    expect(readConfig(home)).toEqual({
      serverUrl: "https://missiongo.example.com",
      token: "mgn_abc",
      nodeId: "n1",
      name: "mbp",
    });
  });
});

describe("normalizeServerUrl", () => {
  it("drops trailing slashes so request paths do not double up", () => {
    expect(normalizeServerUrl(" https://missiongo.example.com// ")).toBe("https://missiongo.example.com");
  });
});

describe("parseConfig", () => {
  it("refuses a config that is missing a field instead of running half-configured", () => {
    expect(() => parseConfig('{"serverUrl":"https://a.example.com","nodeId":"n1","name":"mbp"}')).toThrowError(/token/);
    expect(() => parseConfig("not json")).toThrowError(/合法的 JSON/);
  });
});

describe("logPathFor", () => {
  it("keeps a dispatch id from escaping the log directory", () => {
    // The id arrives over the wire and lands in a file name.
    expect(logPathFor("../../etc/passwd", "/home/dev")).toBe("/home/dev/.missiongo-node/logs/______etc_passwd.log");
    expect(logPathFor("1f2e3d4c-aaaa", "/home/dev")).toBe("/home/dev/.missiongo-node/logs/1f2e3d4c-aaaa.log");
  });
});
