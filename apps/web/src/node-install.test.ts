import { describe, expect, it } from "vitest";

import {
  copyText,
  NODE_LIST_REFETCH_MS,
  NODE_LIST_WAITING_REFETCH_MS,
  nodeCommands,
  nodeListRefetchInterval,
  pairingProgress,
} from "./node-install";
import type { DispatchNode } from "./types";

const origin = "https://missiongo.example.com";

const node = (id: string, overrides: Partial<DispatchNode> = {}): DispatchNode => ({
  id,
  name: `machine ${id}`,
  agents: [],
  repos: [],
  repoCandidates: [],
  online: false,
  createdAt: "2026-09-13T08:00:00.000Z",
  ...overrides,
});

describe("the machine install commands", () => {
  it("downloads the daemon from this deployment into ~/.missiongo-node", () => {
    expect(nodeCommands.download(origin)).toBe(
      "mkdir -p ~/.missiongo-node && curl -fsSL https://missiongo.example.com/downloads/missiongo-node/missiongo-node.mjs -o ~/.missiongo-node/missiongo-node.mjs",
    );
  });

  it("fills the real code and origin into the pairing command", () => {
    expect(nodeCommands.pair(origin, "0a1b2c3d4e-5f6a7b8c9d")).toBe(
      "node ~/.missiongo-node/missiongo-node.mjs pair 0a1b2c3d4e-5f6a7b8c9d --server https://missiongo.example.com",
    );
  });

  it("never doubles the slash after an origin that ends in one", () => {
    expect(nodeCommands.pair(`${origin}/`, "abc-def")).toBe(
      "node ~/.missiongo-node/missiongo-node.mjs pair abc-def --server https://missiongo.example.com",
    );
    expect(nodeCommands.download(`${origin}/`)).toContain("https://missiongo.example.com/downloads/");
  });

  it("runs the service and foreground commands through the downloaded script", () => {
    expect(nodeCommands.installService).toBe("node ~/.missiongo-node/missiongo-node.mjs install-service");
    expect(nodeCommands.run).toBe("node ~/.missiongo-node/missiongo-node.mjs run");
    expect(nodeCommands.checkNode).toBe("node --version");
    expect(nodeCommands.installNode).toBe("brew install node");
    expect(nodeCommands.checkClaude).toBe("claude auth status");
    expect(nodeCommands.loginClaude).toBe("claude auth login");
  });
});

describe("waiting for a newly paired machine", () => {
  const now = Date.parse("2026-09-13T08:05:00.000Z");
  const pairing = { baseline: ["old"], expiresAt: "2026-09-13T08:10:00.000Z" };

  it("waits while the list holds only machines that were there before", () => {
    expect(pairingProgress(pairing, [node("old", { online: true })], now)).toEqual({ state: "waiting" });
  });

  it("reports a new machine that paired but has not come online", () => {
    const fresh = node("fresh");
    expect(pairingProgress(pairing, [node("old", { online: true }), fresh], now)).toEqual({ state: "paired", node: fresh });
  });

  it("reports the new machine once it is online", () => {
    const fresh = node("fresh", { name: "办公室台式机", online: true });
    expect(pairingProgress(pairing, [node("old", { online: true }), fresh], now)).toEqual({ state: "online", node: fresh });
  });

  it("does not take an old machine coming back online for the new one", () => {
    expect(pairingProgress(pairing, [node("old", { online: true, name: "same name" })], now).state).toBe("waiting");
  });

  it("ignores a new machine that was already revoked", () => {
    expect(pairingProgress(pairing, [node("fresh", { revokedAt: "2026-09-13T08:04:00.000Z" })], now).state).toBe("waiting");
  });

  it("gives up once the code expired with nothing redeemed", () => {
    const later = Date.parse("2026-09-13T08:10:00.000Z");
    expect(pairingProgress(pairing, [node("old")], later)).toEqual({ state: "expired" });
  });

  it("keeps waiting on a machine that redeemed the code before it expired", () => {
    const later = Date.parse("2026-09-13T09:00:00.000Z");
    expect(pairingProgress(pairing, [node("fresh")], later).state).toBe("paired");
    expect(pairingProgress(pairing, [node("fresh", { online: true })], later).state).toBe("online");
  });

  it("polls fast only while a machine is expected", () => {
    expect(nodeListRefetchInterval(undefined)).toBe(NODE_LIST_REFETCH_MS);
    expect(nodeListRefetchInterval({ state: "waiting" })).toBe(NODE_LIST_WAITING_REFETCH_MS);
    expect(nodeListRefetchInterval({ state: "paired", node: node("fresh") })).toBe(NODE_LIST_WAITING_REFETCH_MS);
    expect(nodeListRefetchInterval({ state: "online", node: node("fresh", { online: true }) })).toBe(NODE_LIST_REFETCH_MS);
    expect(nodeListRefetchInterval({ state: "expired" })).toBe(NODE_LIST_REFETCH_MS);
    expect(NODE_LIST_WAITING_REFETCH_MS).toBe(5_000);
    expect(NODE_LIST_REFETCH_MS).toBe(30_000);
  });
});

describe("copying a command", () => {
  it("writes the text to the clipboard", async () => {
    const written: string[] = [];
    await expect(copyText("node --version", { writeText: async (text) => { written.push(text); } })).resolves.toBe(true);
    expect(written).toEqual(["node --version"]);
  });

  it("reports failure instead of throwing when the clipboard is missing or refuses", async () => {
    await expect(copyText("x", undefined)).resolves.toBe(false);
    await expect(copyText("x", { writeText: () => Promise.reject(new Error("denied")) })).resolves.toBe(false);
    await expect(copyText("x", { writeText: () => { throw new Error("not allowed"); } })).resolves.toBe(false);
  });
});
