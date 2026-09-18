import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MissionGoStore } from "./store.js";

const stores: MissionGoStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function seed() {
  const directory = await mkdtemp(join(tmpdir(), "missiongo-verification-return-"));
  directories.push(directory);
  const store = new MissionGoStore(join(directory, "missiongo.sqlite"));
  stores.push(store);
  const product = store.createProduct({ name: "Mission Go", keyPrefix: "AND" });
  const item = store.createWorkItem({
    productId: product.id, status: "ready", type: "requirement", priority: "normal",
    title: "Review this", description: "Verify and return if needed", environment: { platform: "web" },
  });
  const move = (to: "ready" | "in_progress" | "pending_verification" | "inbox", reason: "claim" | "resolution_submitted" | "verification_failed" | "manual_override" | "reopened" | "triaged", note?: string) =>
    store.transitionWorkItem({ itemKey: item.key, to, reason, actor: "human", ...(note ? { note } : {}) });
  return { store, product, item, move };
}

describe("verification return summary", () => {
  it("shows the current return and its note in item and list responses, then clears it when work starts", async () => {
    const { store, product, item, move } = await seed();
    expect(item.verificationReturn).toBeUndefined();
    move("in_progress", "claim");
    move("pending_verification", "resolution_submitted");
    expect(store.getWorkItem(item.key).verificationReturn).toBeUndefined();
    const returned = move("ready", "verification_failed", "The export is still blank.");
    expect(returned.verificationReturn).toMatchObject({ note: "The export is still blank." });
    expect(returned.verificationReturn?.at).toBeTruthy();
    expect(store.listWorkItems({ productId: product.id, status: "ready" })[0]?.verificationReturn)
      .toEqual(returned.verificationReturn);
    move("in_progress", "claim");
    expect(store.getWorkItem(item.key).verificationReturn).toBeUndefined();
  });

  it("uses the latest entry into Ready, including a direct move, without carrying an old badge forward", async () => {
    const { store, item, move } = await seed();
    move("in_progress", "claim");
    move("pending_verification", "resolution_submitted");
    expect(move("ready", "manual_override", "First return").verificationReturn?.note).toBe("First return");
    move("inbox", "reopened");
    expect(move("ready", "triaged").verificationReturn).toBeUndefined();
    move("in_progress", "claim");
    move("pending_verification", "resolution_submitted");
    expect(move("ready", "verification_failed", "Second return").verificationReturn?.note).toBe("Second return");
    expect(store.getWorkItem(item.key).verificationReturn?.note).toBe("Second return");
  });
});
