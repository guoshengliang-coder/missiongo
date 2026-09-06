import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { MissionGoDatabase } from "./storage/database.js";
import { MissionGoStore } from "./store.js";
import type { FreeCommentBody, StructuredCommentBody } from "./types.js";

const stores: MissionGoStore[] = [];
const directories: string[] = [];

afterEach(async () => {
  stores.splice(0).forEach((store) => store.close());
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function seed() {
  const directory = await mkdtemp(join(tmpdir(), "missiongo-comments-"));
  directories.push(directory);
  const databasePath = join(directory, "missiongo.sqlite");
  const store = new MissionGoStore(databasePath);
  stores.push(store);
  const product = store.createProduct({ name: "Hermes Go", keyPrefix: "HG" });
  const item = store.createWorkItem({
    productId: product.id,
    type: "bug",
    priority: "high",
    title: "Crash",
    description: "Fails on launch",
    environment: { platform: "other" },
  });
  return { databasePath, store, item };
}

describe("work-item comments", () => {
  it("keeps both body shapes and reads them back in order", async () => {
    const { store, item } = await seed();
    store.createComment({
      itemKey: item.key,
      actorKind: "agent",
      bodyKind: "structured",
      body: {
        understanding: "冷启动崩溃，要定位并修好",
        finding: "onResume 读到未初始化的 session",
        evidence: ["launch.log 第 142 行"],
        openQuestions: ["未在 API 34 上验证"],
      },
      idempotencyKey: "analysis-1",
    });
    store.createComment({
      itemKey: item.key,
      actorKind: "human",
      bodyKind: "free",
      body: { text: "Reproduced on my Pixel too." },
    });

    const comments = store.listComments(item.key);
    expect(comments.map((comment) => comment.actorKind)).toEqual(["agent", "human"]);
    expect((comments[0]!.body as StructuredCommentBody).evidence).toEqual(["launch.log 第 142 行"]);
    expect((comments[0]!.body as StructuredCommentBody).finding).toBe("onResume 读到未初始化的 session");
    expect((comments[1]!.body as FreeCommentBody).text).toBe("Reproduced on my Pixel too.");
  });

  it("returns the same comment for a repeated idempotency key", async () => {
    const { store, item } = await seed();
    const first = store.createComment({
      itemKey: item.key,
      actorKind: "agent",
      bodyKind: "free",
      body: { text: "Looking at this now." },
      idempotencyKey: "note-1",
    });
    const second = store.createComment({
      itemKey: item.key,
      actorKind: "agent",
      bodyKind: "free",
      body: { text: "Looking at this now." },
      idempotencyKey: "note-1",
    });

    expect(second.id).toBe(first.id);
    expect(store.listComments(item.key)).toHaveLength(1);
  });

  it("hides a withdrawn comment from a reader but keeps it for the record", async () => {
    const { store, item } = await seed();
    const comment = store.createComment({
      itemKey: item.key,
      actorKind: "agent",
      bodyKind: "structured",
      body: {
        understanding: "列表白屏",
        finding: "Wrong on every count.",
        evidence: ["app.log 第 88 行"],
        openQuestions: [],
      },
      idempotencyKey: "analysis-1",
    });
    store.withdrawComment({ itemKey: item.key, commentId: comment.id, accountId: "account-1" });

    expect(store.listComments(item.key)).toHaveLength(0);
    const kept = store.listComments(item.key, { includeWithdrawn: true });
    expect(kept).toHaveLength(1);
    expect(kept[0]!.withdrawnBy).toBe("account-1");

    // The retraction is itself a fact worth keeping.
    const timeline = store.getTimeline(item.key);
    expect(timeline.some((entry) => entry.eventType === "comment_withdrawn")).toBe(true);
    expect(timeline.some((entry) => entry.eventType === "comment_added")).toBe(false);
    expect(store.getTimeline(item.key, { includeWithdrawn: true })
      .some((entry) => entry.eventType === "comment_added")).toBe(true);
  });

  it("refuses to withdraw the same comment twice", async () => {
    const { store, item } = await seed();
    const comment = store.createComment({
      itemKey: item.key,
      actorKind: "human",
      bodyKind: "free",
      body: { text: "Never mind." },
    });
    store.withdrawComment({ itemKey: item.key, commentId: comment.id });
    expect(() => store.withdrawComment({ itemKey: item.key, commentId: comment.id }))
      .toThrowError(/already withdrawn/);
  });

  it("merges comments into the timeline in the order things happened", async () => {
    const { store, item } = await seed();
    store.createComment({ itemKey: item.key, actorKind: "human", bodyKind: "free", body: { text: "First." } });
    store.transitionWorkItem({ itemKey: item.key, to: "ready", actor: "human", reason: "triaged" });

    const types = store.getTimeline(item.key).map((entry) => entry.eventType);
    expect(types).toEqual(["item_created", "comment_added", "status_changed"]);
  });

  it("moves historical analyses onto comments without losing their content", async () => {
    const { databasePath, store, item } = await seed();
    const itemId = (store.getTimeline(item.key)[0]!).itemKey;
    expect(itemId).toBe(item.key);
    store.close();
    stores.splice(stores.indexOf(store), 1);

    // Recreate the pre-migration shape: an analysis stored as an event, and the
    // migration marker removed so reopening replays the backfill.
    const seeded = new MissionGoDatabase(databasePath);
    const row = seeded.connection.prepare("SELECT id FROM work_items WHERE item_key = ?").get(item.key) as unknown as { id: string };
    const payload = JSON.stringify({ conclusion: "Legacy analysis.", evidence: ["old log"], risks: [] });
    seeded.connection
      .prepare(
        `INSERT INTO work_item_events (id, item_id, event_type, actor_kind, payload_json, account_id, created_at)
         VALUES ('legacy-1', ?, 'analysis_appended', 'agent', ?, 'account-1', '2026-01-01T00:00:00.000Z')`,
      )
      .run(row.id, payload);
    // Both markers: 14 moves the analysis onto a comment, 17 reshapes it. A real
    // upgrade runs them in that order, so the test has to as well.
    seeded.connection.exec("DELETE FROM schema_migrations WHERE version IN (14, 17);");
    seeded.close();

    const reopened = new MissionGoStore(databasePath);
    stores.push(reopened);
    const comments = reopened.listComments(item.key);
    expect(comments).toHaveLength(1);
    expect(comments[0]!.bodyKind).toBe("structured");
    expect(comments[0]!.accountId).toBe("account-1");
    expect((comments[0]!.body as StructuredCommentBody).finding).toBe("Legacy analysis.");
    expect((comments[0]!.body as StructuredCommentBody).understanding).toContain("迁移自旧格式");
    expect((comments[0]!.body as StructuredCommentBody).evidence).toEqual(["old log"]);
    expect(reopened.getTimeline(item.key).some((entry) => entry.eventType === "analysis_appended")).toBe(false);
  });

  it("reshapes an analysis that was written in the old bug-shaped fields", async () => {
    const { databasePath, store, item } = await seed();
    const comment = store.createComment({
      itemKey: item.key,
      actorKind: "agent",
      bodyKind: "structured",
      body: { understanding: "占位", finding: "占位", evidence: ["占位"], openQuestions: [] },
      idempotencyKey: "placeholder",
    });
    store.close();
    stores.splice(stores.indexOf(store), 1);

    const seeded = new MissionGoDatabase(databasePath);
    seeded.connection
      .prepare("UPDATE work_item_comments SET body_json = ? WHERE id = ?")
      .run(JSON.stringify({ conclusion: "旧结论", evidence: ["日志第 3 行"], risks: ["未覆盖低端机"] }), comment.id);
    seeded.connection.exec("DELETE FROM schema_migrations WHERE version = 17;");
    seeded.close();

    const reopened = new MissionGoStore(databasePath);
    stores.push(reopened);
    const body = reopened.listComments(item.key)[0]!.body as StructuredCommentBody;
    expect(body.finding).toBe("旧结论");
    expect(body.evidence).toEqual(["日志第 3 行"]);
    expect(body.openQuestions).toEqual(["未覆盖低端机"]);
    // The field did not exist then, so it says so rather than inventing one.
    expect(body.understanding).toContain("迁移自旧格式");
    expect((body as unknown as Record<string, unknown>).conclusion).toBeUndefined();
  });

  it("refuses a structured analysis with no evidence", async () => {
    const { store, item } = await seed();
    expect(() => store.createComment({
      itemKey: item.key,
      actorKind: "agent",
      bodyKind: "structured",
      body: { understanding: "读到的", finding: "我的判断", evidence: [], openQuestions: [] },
      idempotencyKey: "no-evidence",
    })).toThrowError(/at least one piece of evidence/);
  });
});
