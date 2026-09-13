import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { installService, launchAgentPath, launchAgentPlist, SERVICE_LABEL, uninstallService } from "./service.js";

const homes: string[] = [];

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "missiongo-node-service-"));
  homes.push(home);
  return home;
}

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

describe("launchAgentPlist", () => {
  const plist = launchAgentPlist({
    nodeBinary: "/opt/homebrew/bin/node",
    scriptPath: "/Users/dev/.missiongo-node/missiongo-node.mjs",
    logPath: "/Users/dev/.missiongo-node/logs/daemon.log",
    path: "/Users/dev/.local/bin:/opt/homebrew/bin:/usr/bin:/bin",
  });

  it("runs the downloaded script with the node that installed it", () => {
    expect(plist).toContain("<string>/opt/homebrew/bin/node</string>");
    expect(plist).toContain("<string>/Users/dev/.missiongo-node/missiongo-node.mjs</string>");
    expect(plist).toContain("<string>run</string>");
  });

  it("carries the installing shell's PATH, or launchd cannot find claude", () => {
    // launchd starts agents with a bare /usr/bin:/bin. Without this the daemon
    // comes up, reports no agents, and every dispatch fails out of sight.
    expect(plist).toContain("<key>PATH</key><string>/Users/dev/.local/bin:/opt/homebrew/bin:/usr/bin:/bin</string>");
  });

  it("restarts on exit but not in a tight loop", () => {
    expect(plist).toContain("<key>KeepAlive</key><true/>");
    expect(plist).toContain("<key>ThrottleInterval</key><integer>60</integer>");
  });

  it("escapes paths that would otherwise break the XML", () => {
    const tricky = launchAgentPlist({
      nodeBinary: "/usr/local/bin/node",
      scriptPath: "/Users/a&b/<x>/missiongo-node.mjs",
      logPath: "/tmp/daemon.log",
      path: "/usr/bin",
    });
    expect(tricky).toContain("/Users/a&amp;b/&lt;x&gt;/missiongo-node.mjs");
  });
});

describe("installService / uninstallService", () => {
  it("writes the agent, replaces any loaded copy, then bootstraps it", () => {
    const home = tempHome();
    const calls: string[][] = [];
    const { plistPath } = installService({
      scriptPath: "/Users/dev/.missiongo-node/missiongo-node.mjs",
      nodeBinary: "/usr/local/bin/node",
      path: "/usr/bin:/bin",
      home,
      launchctl: (args) => { calls.push([...args]); },
    });

    expect(plistPath).toBe(launchAgentPath(home));
    expect(readFileSync(plistPath, "utf8")).toContain(SERVICE_LABEL);
    expect(calls.map((call) => call[0])).toEqual(["bootout", "bootstrap"]);
    expect(calls[1]).toContain(plistPath);
  });

  it("still installs when nothing was loaded before", () => {
    const home = tempHome();
    const { plistPath } = installService({
      scriptPath: "/x.mjs",
      nodeBinary: "/usr/local/bin/node",
      path: "/usr/bin",
      home,
      launchctl: (args) => {
        if (args[0] === "bootout") throw new Error("Could not find service");
      },
    });
    expect(readFileSync(plistPath, "utf8")).toContain("/x.mjs");
  });

  it("removes the agent and reports when there was none", () => {
    const home = tempHome();
    const launchctl = () => {};
    installService({ scriptPath: "/x.mjs", nodeBinary: "/n", path: "/usr/bin", home, launchctl });
    expect(uninstallService({ home, launchctl })).toEqual({ removed: true });
    expect(uninstallService({ home, launchctl })).toEqual({ removed: false });
  });
});
