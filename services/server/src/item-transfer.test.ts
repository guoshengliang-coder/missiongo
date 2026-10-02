import { scryptSync } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { WorkItemStatus } from "@missiongo/domain";
import { afterEach, describe, expect, it } from "vitest";

import { AccountStore } from "./accounts-store.js";
import { buildApp } from "./app.js";
import { AttachmentStorage } from "./attachment-storage.js";
import { transferWorkItem } from "./item-transfer.js";
import { MissionGoStore } from "./store.js";
import { ManagedRunStore } from "./managed-run-store.js";

const cleanup: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function seed() {
  const directory = await mkdtemp(join(tmpdir(), "missiongo-transfer-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, "test.sqlite");
  const store = new MissionGoStore(path);
  cleanup.push(async () => store.close());
  const source = store.createProduct({ name: "Source", keyPrefix: "SRC" });
  const target = store.createProduct({ name: "Target", keyPrefix: "DST" });
  const storage = new AttachmentStorage(join(directory, "attachments"));
  const component = store.createComponent({ productId: source.id, name: "UI", kind: "web" });
  const item = store.createWorkItem({ productId: source.id, type: "bug", priority: "high", title: "Transfer me",
    description: "A report", report: { overview: "A report", reproductionSteps: "Open the menu" },
    environment: { platform: "web", metadata: { example: "diagnostic" } }, sourceComponentId: component.id,
    affectedComponentIds: [component.id], attribution: { accountId: "original-author" } });
  const transfer = (idempotencyKey = "request-one", targetProductId = target.id) => transferWorkItem(store, storage,
    { itemKey: item.key, targetProductId, accountId: "mover", idempotencyKey });
  return { store, source, target, storage, item, component, transfer, path };
}

describe("project transfer", () => {
  it("copies evidence independently, preserves bylines, timestamps, withdrawal and history order, and freezes the original", async () => {
    const { store, storage, item, component, transfer } = await seed();
    const attachment = await storage.save(store, item.key, "evidence.log", "text/plain", Buffer.from("original evidence"));
    const comment = store.createComment({ itemKey: item.key, actorKind: "human", bodyKind: "free",
      body: { text: "Keep this" }, attribution: { accountId: "comment-author" } });
    const withdrawn = store.createComment({ itemKey: item.key, actorKind: "agent", bodyKind: "free", body: { text: "Retracted" } });
    store.withdrawComment({ itemKey: item.key, commentId: withdrawn.id });
    store.transitionWorkItem({ itemKey: item.key, to: "ready", actor: "human", reason: "triaged" });
    const before = store.getTimeline(item.key, { includeWithdrawn: true });
    const moved = transfer();
    expect(moved).toMatchObject({ key: "DST-1", status: "ready", title: item.title, description: item.description,
      report: item.report, environment: item.environment, affectedComponentIds: [], createdBy: { kind: "human", accountId: "original-author" } });
    expect(moved.sourceComponentId).toBeUndefined();
    expect(store.getWorkItem(item.key)).toMatchObject({ status: "cancelled", transferred: true });
    expect(store.transferReferences(item.key, () => true)).toMatchObject({ transferredTo: { key: moved.key } });
    expect(store.transferReferences(item.key, () => false)).toEqual({});
    const copied = store.getTimeline(moved.key, { includeWithdrawn: true }).filter((e) => e.historySourceKey);
    expect(copied.map((e) => [e.eventType, e.actorKind, e.accountId, e.createdAt])).toEqual(before.map((e) => [e.eventType, e.actorKind, e.accountId, e.createdAt]));
    expect(store.listComments(moved.key)).toMatchObject([{ body: comment.body, accountId: "comment-author", createdAt: comment.createdAt }]);
    expect(store.listComments(moved.key, { includeWithdrawn: true })[1]?.withdrawnAt).toBeTruthy();
    const newAttachment = store.listAttachments(moved.key)[0]!;
    expect(newAttachment.displayNumber).toBe(attachment.displayNumber);
    expect(newAttachment.id).not.toBe(attachment.id);
    expect(newAttachment.storageFilename).not.toBe(attachment.storageFilename);
    await storage.replace(store, moved.key, newAttachment.id, "evidence.log", "text/plain", Buffer.from("new evidence"));
    expect((await readFile(storage.resolveStoredFile(attachment.storageFilename))).toString()).toBe("original evidence");
    for (const action of [
      () => store.updateWorkItem(item.key, { title: "Changed" }),
      () => store.transitionWorkItem({ itemKey: item.key, to: "ready", actor: "human", reason: "reopened" }),
      () => store.createComment({ itemKey: item.key, actorKind: "human", bodyKind: "free", body: { text: "Later" } }),
      () => store.withdrawComment({ itemKey: item.key, commentId: comment.id }),
      () => store.deleteAttachmentMetadata(item.key, attachment.id),
      () => store.appendSystemEvent(item.id, "dispatched", {}),
    ]) expect(action).toThrow(/read-only/);
    await expect(storage.remove(store, item.key, attachment.id)).rejects.toThrow(/read-only/);
    expect((await readFile(storage.resolveStoredFile(attachment.storageFilename))).toString()).toBe("original evidence");
    expect(store.getTimeline(moved.key).at(-1)?.eventType).toBe("attachment_replaced");
    expect(store.getTimeline(moved.key).find((e) => e.eventType === "item_transferred_in")?.payload.clearedComponents).toMatchObject([{ id: component.id }]);
  });

  it.each(["inbox", "ready", "in_progress", "development_complete", "on_hold", "pending_verification", "done", "cancelled"] as WorkItemStatus[])("retains status %s without importing execution or derivation relationships", async (status) => {
    const { store, item, transfer } = await seed();
    store.database.connection.prepare("UPDATE work_items SET status = ? WHERE id = ?").run(status, item.id);
    store.appendSystemEvent(item.id, "dispatched", { dispatchId: "past" });
    store.appendSystemEvent(item.id, "derived_item_created", { itemKey: "SRC-99" });
    const moved = transfer();
    expect(moved.status).toBe(status);
    expect(moved.derivedFrom).toBeUndefined();
    expect(store.getTimeline(moved.key).some((e) => ["dispatched", "derived_item_created"].includes(e.eventType))).toBe(false);
  });

  it("replays the same transfer and rejects a changed target or a second transfer of the frozen original", async () => {
    const { store, item, transfer } = await seed();
    const moved = transfer();
    expect(transfer().key).toBe(moved.key);
    expect(() => transfer("different-request")).toThrow(/read-only/);
    const third = store.createProduct({ name: "Third", keyPrefix: "TH" });
    expect(() => transfer("request-one", third.id)).toThrow(/another operation/);
    expect(store.database.connection.prepare("SELECT COUNT(*) AS n FROM item_transfers WHERE source_item_id = ?").get(item.id)).toMatchObject({ n: 1 });
  });

  it("rolls back item allocation, copies and source changes when history insertion fails", async () => {
    const { store, storage, item, target, transfer } = await seed();
    await storage.save(store, item.key, "failure.log", "text/plain", Buffer.from("data"));
    const files = await readdir(storage.rootPath);
    store.database.connection.exec(`CREATE TRIGGER fail_transfer BEFORE INSERT ON work_item_events
      WHEN NEW.history_source_key IS NOT NULL BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    expect(transfer).toThrow(/injected failure/);
    expect(store.getWorkItem(item.key).transferred).toBeUndefined();
    expect(store.listWorkItems({ productId: target.id })).toEqual([]);
    expect(await readdir(storage.rootPath)).toEqual(files);
    store.database.connection.exec("DROP TRIGGER fail_transfer");
    expect(transfer().key).toBe("DST-1");
  });

  it("refuses same-project and archived targets, and pending legacy AI execution", async () => {
    const { store, item, source, target, transfer } = await seed();
    expect(() => transfer("same", source.id)).toThrow(/different target/);
    store.updateProduct(target.id, { archived: true });
    expect(() => transfer()).toThrow(/Restore the target/);
    store.updateProduct(target.id, { archived: false });
    store.database.connection.prepare(`INSERT INTO ai_executions
      (id, item_id, agent_id, mode, trigger_source, status, created_at, updated_at)
      VALUES ('active', ?, 'test', 'process', 'agent_pull', 'waiting_for_human', 'now', 'now')`).run(item.id);
    expect(transfer).toThrow(/End queued or running/);
    store.database.connection.prepare("UPDATE ai_executions SET status = 'succeeded' WHERE id = 'active'").run();
    expect(transfer().key).toBe("DST-1");
  });

  it.each(["queued", "delivered", "launched"])("blocks %s dispatches that can still execute", async (status) => {
    const { store, item, transfer } = await seed();
    const db = store.database.connection;
    db.exec(`INSERT INTO nodes (id, account_id, name, token_hash, created_at, updated_at) VALUES ('n', 'mover', 'Test', 'example', 'now', 'now');`);
    db.prepare(`INSERT INTO dispatches (id, account_id, node_id, agent_kind, mode, status, repo_path, created_at)
      VALUES ('d', 'mover', 'n', 'codex', 'plan', ?, 'example-checkout', '2000-01-01')`).run(status);
    db.prepare("INSERT INTO dispatch_items VALUES ('d', ?, 0)").run(item.id);
    expect(transfer).toThrow(/End queued or running/);
    if (status === "launched") {
      db.exec(`INSERT INTO agent_sessions (id, dispatch_id, node_id, agent_kind, agent_session_ref, status, created_at, updated_at)
        VALUES ('s', 'd', 'n', 'codex', 'example-session', 'active', 'now', 'now');`);
      expect(transfer).toThrow(/End queued or running/);
      db.exec("UPDATE agent_sessions SET status = 'idle' WHERE id = 's'");
    } else db.exec("UPDATE dispatches SET status = 'cancelled' WHERE id = 'd'");
    expect(transfer().key).toBe("DST-1");
  });

  it("keeps copied release handovers historical", async () => {
    const { store, item, transfer } = await seed();
    store.database.connection.prepare("UPDATE work_items SET status = 'in_progress' WHERE id = ?").run(item.id);
    store.submitDevelopmentComplete({ itemKey: item.key, pullRequestUrl: "https://example.test/pr/1", requiredArtifacts: ["web"], idempotencyKey: "merge" });
    const moved = transfer();
    expect(moved.status).toBe("development_complete");
    expect(() => store.submitForVerification({ itemKey: moved.key, pullRequestUrl: "https://example.test/pr/1",
      releases: [{ artifact: "web", version: "test", sourceCommit: "a".repeat(40) }], deployedCommit: "a".repeat(40),
      receiptDigest: "a".repeat(64), idempotencyKey: "release" })).toThrow(/recorded merged PR/);
  });

  it("blocks managed stages and prevents a frozen scope from starting work later", async () => {
    const { store, source, item, transfer } = await seed();
    const runs = new ManagedRunStore(store.database);
    const actor = { accountId: "mover", productIds: [source.id] };
    const scope = { productId: source.id, repositoryRef: "example-repository", itemKeys: [item.key], contractRevision: 1 };
    const run = runs.createRun(actor, { scope, idempotencyKey: "run" });
    const command = { runId: run.id, expectedVersion: 1, scopeDigest: run.scopeDigest, contractRevision: 1,
      idempotencyKey: "stage", stageKey: "implement", role: "implement" as const, inputCommit: "a".repeat(40) };
    const stage = runs.createStage(actor, command);
    expect(transfer).toThrow(/End queued or running/);
    store.database.connection.prepare("UPDATE managed_stages SET status = 'succeeded' WHERE id = ?").run(stage.id);
    transfer();
    expect(() => runs.createRun(actor, { scope, idempotencyKey: "another-run" })).toThrow(/read-only/);
    expect(() => runs.createStage(actor, { ...command, stageKey: "verify", expectedVersion: 2, idempotencyKey: "another-stage" })).toThrow(/read-only/);
  });

  it("positions a transferred item as a new entry and retains its origin across a second transfer", async () => {
    const { store, target, item, storage, transfer } = await seed();
    const old = store.createWorkItem({ productId: target.id, type: "note", priority: "normal", title: "Older", description: "" });
    const moved = transfer();
    expect(store.listWorkItems({ productId: target.id, limit: 1 }).map((i) => i.key)).toEqual([moved.key]);
    expect(store.listWorkItems({ productId: target.id, beforeSequence: 2 }).map((i) => i.key)).toEqual([old.key]);
    const third = store.createProduct({ name: "Third", keyPrefix: "TH" });
    const again = transferWorkItem(store, storage, { itemKey: moved.key, targetProductId: third.id, accountId: "mover", idempotencyKey: "move-again" });
    expect(store.getWorkItem(moved.key).transferred).toBe(true);
    expect(store.getTimeline(again.key).find((e) => e.eventType === "item_created")?.historySourceKey).toBe(item.key);
    expect(store.transferReferences(again.key, () => true).transferredFrom?.key).toBe(moved.key);
  });

  it("checks both project operation permissions and hides inaccessible destination links", async () => {
    const { store, item, source, target, path, storage } = await seed();
    const salt = Buffer.from("example-transfer-test");
    const app = buildApp({ databasePath: path, attachmentsPath: storage.rootPath, adminAccount: {
      id: "test-admin", username: "owner@example.test", passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync("example-password", salt, 64).toString("base64url")}`,
      sessionSecret: "example-transfer-session-secret-for-tests-only", cookieSecure: false,
    } });
    cleanup.push(() => app.close());
    const accounts = new AccountStore(store.database);
    const member = accounts.createAccount({ email: "member@example.test", password: "example-password", role: "member" });
    const permission = (canOperate: boolean) => ({ canView: true, canOperate, canUseAi: true });
    accounts.replaceProductAccess(source.id, [{ accountId: member.id, permission: permission(false) }]);
    accounts.replaceProductAccess(target.id, [{ accountId: member.id, permission: permission(true) }]);
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/login", payload: { username: "member@example.test", password: "example-password" } });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    const request = () => app.inject({ method: "POST", url: `/api/v1/items/${item.key}/transfer`, headers: { cookie }, payload: { targetProductId: target.id, idempotencyKey: "route-transfer" } });
    expect((await request()).statusCode).toBe(404);
    accounts.replaceProductAccess(source.id, [{ accountId: member.id, permission: permission(true) }]);
    accounts.replaceProductAccess(target.id, [{ accountId: member.id, permission: permission(false) }]);
    expect((await request()).statusCode).toBe(404);
    accounts.replaceProductAccess(target.id, [{ accountId: member.id, permission: permission(true) }]);
    const moved = await request();
    expect(moved.statusCode).toBe(200);
    expect(moved.json()).toMatchObject({ key: "DST-1", transferredFrom: { key: item.key } });
    accounts.replaceProductAccess(target.id, [{ accountId: member.id, permission: { canView: false, canOperate: false, canUseAi: false } }]);
    const old = await app.inject({ url: `/api/v1/items/${item.key}`, headers: { cookie } });
    expect(old.json()).toMatchObject({ transferred: true });
    expect(old.json().transferredTo).toBeUndefined();
    const timeline = await app.inject({ url: `/api/v1/items/${item.key}/timeline`, headers: { cookie } });
    expect(timeline.body).not.toContain("DST-1");
    const edit = await app.inject({ method: "PATCH", url: `/api/v1/items/${item.key}`, headers: { cookie }, payload: { title: "Changed" } });
    expect(edit.statusCode).toBe(409);
  });
});
