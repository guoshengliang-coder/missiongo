import { describe, expect, it } from "vitest";

import { groupAiConnections } from "./ai-connections";
import type { AiAuthorization } from "./api";

const connection = (id: string, extra: Partial<AiAuthorization> = {}): AiAuthorization => ({
  id,
  clientId: `client-${id}`,
  clientName: "Desktop client",
  issuedAt: "2026-10-20T00:00:00.000Z",
  expiresAt: "2027-10-20T00:00:00.000Z",
  scopes: ["missiongo:read", "missiongo:node"],
  ...extra,
});

describe("AI connection groups", () => {
  it("collapses matching names across registrations and retains every revocable credential", () => {
    const original = [
      connection("old", { lastUsedAt: "2026-10-21T00:00:00.000Z" }),
      connection("recent", { clientName: " desktop CLIENT ", lastUsedAt: "2026-10-28T00:00:00.000Z", scopes: ["missiongo:node", "missiongo:read"] }),
      connection("unused"),
    ];
    const groups = groupAiConnections(original);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.authorizations.map((entry) => entry.id)).toEqual(["recent", "old", "unused"]);
    expect(groups[0]?.lastUsedAt).toBe("2026-10-28T00:00:00.000Z");
    expect(groups[0]?.scopes).toEqual(["missiongo:node", "missiongo:read"]);
    expect(original.map((entry) => entry.id)).toEqual(["old", "recent", "unused"]);
  });

  it("does not describe mixed permissions as shared by every connection", () => {
    const groups = groupAiConnections([
      connection("read", { scopes: ["missiongo:read"] }),
      connection("write", { scopes: ["missiongo:read", "missiongo:write"] }),
    ]);
    expect(groups[0]?.scopes).toBeUndefined();
    expect(groups[0]?.authorizations).toHaveLength(2);
  });

  it("keeps personal tokens and client authorizations with the same name separate", () => {
    expect(groupAiConnections([
      connection("oauth", { clientName: "codex" }),
      connection("pat", { kind: "pat", name: "codex" }),
    ]).map((group) => group.kind)).toEqual(["oauth", "pat"]);
  });

  it("does not merge unnamed registrations or a name matching a registration id", () => {
    const groups = groupAiConnections([
      connection("a", { clientName: "" }),
      connection("b", { clientName: " " }),
      connection("named", { clientName: "client-a" }),
    ]);
    expect(groups).toHaveLength(3);
    expect(groups[0]?.lastUsedAt).toBeUndefined();
    expect(groupAiConnections([])).toEqual([]);
  });
});
