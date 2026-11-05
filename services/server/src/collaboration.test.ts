import { randomUUID, scryptSync } from "node:crypto";
import { afterEach, beforeEach, describe, it, expect } from "vitest";
import { buildApp } from "./app.js";
import { createAiAccessToken } from "./admin-auth.js";
import { Collaborations } from "./collaboration.js";
import { collaborationBlockers } from "./collaboration-policy.js";
import { transitionPolicy } from "./item-policy.js";
import { PersonalNotifications } from "./personal-notifications.js";
const salt = Buffer.from("collaboration-tests");
const admin = {
  id: "collab-admin",
  username: "admin@example.test",
  passwordScrypt: `scrypt:${salt.toString("base64url")}:${scryptSync("password-123", salt, 64).toString("base64url")}`,
  sessionSecret: "test-session-secret-long-enough",
  cookieSecure: false,
};
let app: ReturnType<typeof buildApp>,
  c: Collaborations,
  source: ReturnType<
    ReturnType<typeof buildApp>["missionGoStore"]["getWorkItem"]
  >;
let a: string,
  b: string,
  pa: string,
  pb: string,
  grantId: string,
  cookies: Record<string, string>;
beforeEach(async () => {
  app = buildApp({
    databasePath: ":memory:",
    adminAccount: admin,
    statusCheckTime: false,
    writeTools: "comments",
    publicOrigin: "https://missiongo.test",
  });
  const s = app.missionGoStore,
    accounts = app.missionGoAccounts;
  c = new Collaborations(s);
  pa = s.createProduct({ name: "Application", keyPrefix: "APP" }).id;
  pb = s.createProduct({ name: "Engine", keyPrefix: "ENG" }).id;
  a = accounts.createAccount({
    email: "source@example.test",
    password: "password-123",
    role: "member",
  }).id;
  b = accounts.createAccount({
    email: "target@example.test",
    password: "password-123",
    role: "member",
  }).id;
  accounts.replacePermissions(a, [
    { productId: pa, canView: true, canOperate: true, canUseAi: true },
  ]);
  accounts.replacePermissions(b, [
    { productId: pb, canView: true, canOperate: true, canUseAi: true },
  ]);
  source = s.createWorkItem({
    productId: pa,
    title: "Source issue",
    description: "Private source context",
    type: "bug",
    priority: "normal",
    status: "ready",
    builderAccountId: a,
    environment: { platform: "web" },
    attribution: { accountId: a },
  });
  grantId = c.configure(admin.id, pb, {
    sourceProductId: pa,
    moduleId: "",
    builderAccountId: b,
    enabled: true,
    expectedRevision: 0,
  }).id;
  cookies = {};
  for (const id of [a, b, admin.id]) {
    const login = await app.inject({
      method: "POST",
      url: "/api/v1/auth/login",
      payload: {
        username: accounts.getAccount(id).email,
        password: "password-123",
      },
    });
    cookies[id] = String(login.headers["set-cookie"]).split(";")[0]!;
  }
});
afterEach(async () => {
  await app.close();
});
const draft = () =>
  c.prepare(
    a,
    source.key,
    {
      grantId,
      title: "Shared request",
      description: "Only approved evidence",
      acceptance: "Retry succeeds",
      attachmentIds: [],
      type: "bug",
      priority: "normal",
    },
    "agent",
    "Codex",
  );
function send() {
  const d = draft(),
    r = c.submit(a, d.id, d.version, randomUUID());
  return c.detail(a, r.id);
}
function preset(
  key: string,
  status: "pending_verification" | "done" | "cancelled",
) {
  app.missionGoStore.database.connection
    .prepare("UPDATE work_items SET status=? WHERE item_key=?")
    .run(status, key);
}
function post(url: string, id: string, payload: unknown) {
  return app.inject({
    method: "POST",
    url,
    headers: { cookie: cookies[id]! },
    payload: payload as Record<string, unknown>,
  });
}
describe("cross-project collaboration", () => {
  it.each(["in_progress", "development_complete"] as const)(
    "keeps the receiving item's %s list and detail readable after an Agent claim",
    async (status) => {
      const relation = send();
      const store = app.missionGoStore;
      const claimed = store.claimWorkItem({
        itemKey: relation.targetKey,
        agentId: "Codex",
        idempotencyKey: randomUUID(),
        attribution: { accountId: b },
      });
      expect(claimed.status).toBe("in_progress");
      if (status === "development_complete") {
        store.transitionWorkItem({
          itemKey: relation.targetKey,
          to: status,
          actor: "human",
          reason: "manual_override",
          note: "Development complete; delivery evidence still required",
          attribution: { accountId: admin.id },
        });
      }
      const list = await app.inject({
        method: "GET",
        url: `/api/v1/items?productId=${pb}&status=${status}&limit=30`,
        headers: { cookie: cookies[b]! },
      });
      expect(list.statusCode, list.body).toBe(200);
      expect(list.json().items).toEqual([
        expect.objectContaining({ key: relation.targetKey, status }),
      ]);
      const detail = await app.inject({
        method: "GET",
        url: `/api/v1/items/${relation.targetKey}`,
        headers: { cookie: cookies[b]! },
      });
      expect(detail.statusCode, detail.body).toBe(200);
      expect(detail.json()).toMatchObject({
        key: relation.targetKey,
        status,
        transitionDecisions: expect.arrayContaining([
          expect.objectContaining({
            to: "pending_verification",
            allowed: false,
            code: "collaboration_delivery_required",
          }),
        ]),
      });
    },
  );
  it("creates no item or blocker before human approval; submission is atomic and idempotent", () => {
    const d = draft();
    expect(c.context(a, source.key).blocked).toBe(false);
    expect(app.missionGoStore.listWorkItems({ productId: pb })).toHaveLength(0);
    const key = randomUUID(),
      first = c.submit(a, d.id, d.version, key);
    expect(c.submit(a, d.id, d.version, key)).toEqual(first);
    expect(c.submit(a, d.id, d.version, randomUUID())).toEqual(first);
    expect(app.missionGoStore.listWorkItems({ productId: pb })).toHaveLength(1);
    const detail = c.detail(a, first.id);
    expect(detail.status).toBe("ready");
    expect(detail.verifierAccountId).toBe(a);
    expect(detail.blocking).toBe(true);
    expect(
      app.missionGoStore.getWorkItem(detail.targetKey).builderAccountId,
    ).toBe(b);
  });
  it("requires exact approval version and checks grant revocation at commit", () => {
    const d = draft();
    c.prepare(
      a,
      source.key,
      { ...d, title: "Changed scope" },
      "agent",
      "Codex",
      d.id,
      d.version,
    );
    expect(() => c.submit(a, d.id, 1, randomUUID())).toThrow();
    c.configure(admin.id, pb, {
      sourceProductId: pa,
      moduleId: "",
      builderAccountId: b,
      enabled: false,
      expectedRevision: 1,
    });
    expect(() => c.submit(a, d.id, 2, randomUUID())).toThrow();
    expect(app.missionGoStore.listWorkItems({ productId: pb })).toHaveLength(0);
  });
  it("opens only the linked source item to the receiving side, read-only and scoped", async () => {
    const d = send();
    app.missionGoStore.createComment({
      itemKey: d.targetKey,
      actorKind: "human",
      bodyKind: "free",
      body: { text: "Private target investigation" },
      attribution: { accountId: b },
    });
    const other = app.missionGoStore.createWorkItem({
      productId: pa,
      title: "Other source item",
      description: "Not part of the request",
      type: "task",
      priority: "normal",
      status: "ready",
      environment: { platform: "web" },
      attribution: { accountId: a },
    });
    const shared = await app.inject({
      url: `/api/v1/collaboration/${d.id}`,
      headers: { cookie: cookies[a]! },
    });
    expect(shared.statusCode).toBe(200);
    // The collaboration payload still carries only the approved request; the
    // source item is read through its own, item-scoped route.
    expect(shared.body).not.toContain("Private target investigation");
    expect(shared.body).not.toContain("Private source context");
    // The source side still cannot read the target project's internals.
    for (const suffix of ["", "/timeline", "/attachments"]) {
      expect(
        (
          await app.inject({
            url: `/api/v1/items/${d.targetKey}${suffix}`,
            headers: { cookie: cookies[a]! },
          })
        ).statusCode,
      ).toBe(404);
    }
    // The receiving side reads the linked source item, without the project.
    const detail = await app.inject({
      url: `/api/v1/items/${source.key}`,
      headers: { cookie: cookies[b]! },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      key: source.key,
      description: "Private source context",
      access: { canOperate: false, readOnlySource: { productName: "Application" } },
    });
    for (const suffix of ["/timeline", "/attachments"]) {
      expect(
        (
          await app.inject({
            url: `/api/v1/items/${source.key}${suffix}`,
            headers: { cookie: cookies[b]! },
          })
        ).statusCode,
      ).toBe(200);
    }
    // Execution history is part of the content; the source roster and
    // management stay closed.
    const delivery = await app.inject({
      url: `/api/v1/items/${source.key}/delivery`,
      headers: { cookie: cookies[b]! },
    });
    expect(delivery.statusCode).toBe(200);
    expect(delivery.json()).toMatchObject({
      canManage: false,
      canManageBuilder: false,
      candidates: [],
      performers: [],
      readOnlySource: true,
    });
    expect(
      (
        await app.inject({
          url: `/api/v1/items/${d.targetKey}/delivery`,
          headers: { cookie: cookies[a]! },
        })
      ).statusCode,
    ).toBe(404);
    // Only the linked item: the project list, its other items and every write
    // remain closed.
    expect(
      (
        await app.inject({
          url: `/api/v1/items?productId=${pa}`,
          headers: { cookie: cookies[b]! },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/api/v1/items/${other.key}`,
          headers: { cookie: cookies[b]! },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await post(`/api/v1/items/${source.key}/comments`, b, {
          bodyKind: "free",
          text: "should not be written",
        })
      ).statusCode,
    ).toBe(404);
  });
  it("carries the sender's report and environment and accepts the request's own files", async () => {
    const d = c.prepare(
      a,
      source.key,
      {
        grantId,
        title: "With evidence",
        description: "Reproduced on device",
        acceptance: "No crash",
        attachmentIds: [],
        type: "bug",
        priority: "high",
        report: {
          overview: "Reproduced on device",
          reproductionSteps: "1. Open the screen",
          expectedOutcome: "No crash",
          occurrenceFrequency: "always",
        },
        environment: {
          platform: "android",
          appVersion: "1.2.3",
          deviceModel: "Pixel",
        },
      },
      "human",
    );
    const result = c.submit(a, d.id, d.version, randomUUID());
    const target = app.missionGoStore.getWorkItem(result.targetKey);
    expect(target.report).toMatchObject({
      reproductionSteps: "1. Open the screen",
      occurrenceFrequency: "always",
    });
    expect(target.environment).toMatchObject({
      platform: "android",
      appVersion: "1.2.3",
      deviceModel: "Pixel",
    });
    const upload = (uploadId: string) =>
      app.inject({
        method: "POST",
        url: `/api/v1/items/${result.targetKey}/attachments`,
        headers: {
          cookie: cookies[a]!,
          "content-type": "application/octet-stream",
          "x-missiongo-filename": "evidence.txt",
          "x-missiongo-content-type": "text/plain",
          "x-missiongo-upload-id": uploadId,
        },
        payload: Buffer.from("request evidence"),
      });
    // The requester may add the request's own material without target operate.
    expect((await upload("request-file")).statusCode).toBe(201);
    expect((await upload("request-file")).statusCode).toBe(201);
    expect(app.missionGoStore.listAttachments(result.targetKey)).toHaveLength(1);
    // The narrow upload never becomes target-project read.
    expect(
      (
        await app.inject({
          url: `/api/v1/items/${result.targetKey}`,
          headers: { cookie: cookies[a]! },
        })
      ).statusCode,
    ).toBe(404);
    c.withdraw(
      a,
      result.id,
      c.detail(a, result.id).revision,
      "withdrawn after delivery",
      "withdraw-upload",
    );
    expect((await upload("after-withdraw")).statusCode).toBe(404);
  });
  it("ends the linked read when access is revoked, restored or the request withdrawn", async () => {
    const d = send();
    const read = () =>
      app.inject({
        url: `/api/v1/items/${source.key}`,
        headers: { cookie: cookies[b]! },
      });
    expect((await read()).statusCode).toBe(200);
    c.revoke(admin.id, d.id, "revoked for test", "revoke-read");
    expect((await read()).statusCode).toBe(404);
    c.restoreAccess(admin.id, d.id, "restored for test", "restore-read");
    expect((await read()).statusCode).toBe(200);
    c.withdraw(a, d.id, c.detail(a, d.id).revision, "withdrawn for test", "withdraw-read");
    expect((await read()).statusCode).toBe(404);
  });
  it("notifies at pending verification but only the source human accepts and releases", async () => {
    const d = send();
    preset(d.targetKey, "pending_verification");
    const t = app.missionGoStore.getWorkItem(d.targetKey);
    expect(c.context(a, source.key).blocked).toBe(true);
    for (const id of [b, admin.id]) {
      expect(
        transitionPolicy(
          app.missionGoStore.database,
          t,
          id,
          "done",
          "manual_override",
        ).allowed,
      ).toBe(false);
      expect(
        (
          await post(`/api/v1/collaboration/${d.id}/verify`, id, {
            revision: d.revision,
            targetRevision: t.revision,
            passed: true,
            note: "Checked",
            idempotencyKey: randomUUID(),
          })
        ).statusCode,
      ).toBe(403);
    }
    const accepted = await post(`/api/v1/collaboration/${d.id}/verify`, a, {
      revision: d.revision,
      targetRevision: t.revision,
      passed: true,
      note: "Retry verified",
      idempotencyKey: randomUUID(),
    });
    expect(accepted.statusCode, accepted.body).toBe(200);
    expect(c.context(a, source.key).blocked).toBe(false);
    expect(app.missionGoStore.getWorkItem(source.key).status).toBe("ready");
  });
  it("blocks human overrides and system/agent delivery while independent work remains allowed", () => {
    send();
    const db = app.missionGoStore.database;
    for (const actor of ["human", "agent", "system"] as const)
      for (const to of [
        "development_complete",
        "pending_verification",
        "done",
      ] as const) {
        expect(
          transitionPolicy(db, source, admin.id, to, "manual_override", actor)
            .code,
        ).toBe("collaboration_blocked");
        expect(() =>
          app.missionGoStore.transitionWorkItem({
            itemKey: source.key,
            to,
            actor,
            reason: "manual_override",
            note: "Cannot bypass",
          }),
        ).toThrow();
      }
    expect(
      transitionPolicy(db, source, a, "in_progress", "claim").allowed,
    ).toBe(true);
  });
  it("failed verification retains dependency; receiver cancellation releases with a reason", () => {
    const d = send();
    preset(d.targetKey, "pending_verification");
    let t = app.missionGoStore.getWorkItem(d.targetKey);
    c.verify(
      a,
      d.id,
      d.revision,
      t.revision!,
      false,
      "Retry still fails",
      randomUUID(),
    );
    expect(c.context(a, source.key).blocked).toBe(true);
    t = app.missionGoStore.getWorkItem(d.targetKey);
    expect(t.status).toBe("ready");
    expect(() =>
      app.missionGoStore.transitionWorkItem({
        itemKey: t.key,
        to: "cancelled",
        actor: "human",
        reason: "cancelled",
        attribution: { accountId: b },
      }),
    ).toThrow();
    app.missionGoStore.transitionWorkItem({
      itemKey: t.key,
      to: "cancelled",
      actor: "human",
      reason: "cancelled",
      note: "Unsupported API usage",
      attribution: { accountId: b },
    });
    expect(c.context(a, source.key).blocked).toBe(false);
    expect(
      c
        .detail(a, d.id)
        .events.some((e) => e.payload.note === "Unsupported API usage"),
    ).toBe(true);
  });
  it("requires source cancellation disposition and never cancels the receiving item", () => {
    const d = send();
    const input = {
      itemKey: source.key,
      to: "cancelled" as const,
      actor: "human" as const,
      reason: "cancelled" as const,
      note: "No longer needed",
      attribution: { accountId: a },
    };
    expect(() => app.missionGoStore.transitionWorkItem(input)).toThrow();
    app.missionGoStore.transitionWorkItem({
      ...input,
      collaborationDisposition: { mode: "withdraw" },
    });
    expect(app.missionGoStore.getWorkItem(d.targetKey).status).toBe("ready");
    expect(c.context(a, source.key).blocked).toBe(false);
  });
  it("can retain requests under an explicit successor and invalidate unapproved drafts", () => {
    const d = send();
    draft();
    app.missionGoStore.transitionWorkItem({
      itemKey: source.key,
      to: "cancelled",
      actor: "human",
      reason: "cancelled",
      note: "Transfer responsibility",
      attribution: { accountId: a },
      collaborationDisposition: { mode: "keep", successorAccountId: admin.id },
    });
    expect(c.context(a, source.key).drafts).toHaveLength(0);
    expect(c.context(a, source.key).blocked).toBe(true);
    expect(c.detail(admin.id, d.id).canWithdraw).toBe(true);
  });
  it("does not change ongoing requests when inbound grants are disabled", () => {
    const d = send();
    c.configure(admin.id, pb, {
      sourceProductId: pa,
      moduleId: "",
      builderAccountId: b,
      enabled: false,
      expectedRevision: 1,
    });
    expect(c.detail(a, d.id).blocking).toBe(true);
  });
  it("requires compatible existing collaboration targets and prevents cycles", () => {
    const d = send();
    const reverse = c.configure(admin.id, pa, {
      sourceProductId: pb,
      moduleId: "",
      builderAccountId: a,
      enabled: true,
      expectedRevision: 0,
    });
    app.missionGoAccounts.replacePermissions(a, [
      { productId: pa, canView: true, canOperate: true, canUseAi: true },
      { productId: pb, canView: true, canOperate: true, canUseAi: true },
    ]);
    // Existing non-collaboration source cannot be hijacked as a receiving task.
    expect(() =>
      c.associate(
        admin.id,
        d.targetKey,
        source.key,
        reverse.id,
        "Cycle",
        randomUUID(),
      ),
    ).toThrow();
    const db = app.missionGoStore.database.connection;
    expect(
      db.prepare("SELECT count(*) AS n FROM collaboration_requests").get(),
    ).toEqual({ n: 1 });
  });
  it("reopened receiving work restores the blocker without moving original status", () => {
    const d = send();
    preset(d.targetKey, "done");
    expect(c.context(a, source.key).blocked).toBe(false);
    app.missionGoStore.transitionWorkItem({
      itemKey: d.targetKey,
      to: "ready",
      actor: "human",
      reason: "reopened",
      note: "Regression",
      attribution: { accountId: admin.id },
    });
    expect(c.context(a, source.key).blocked).toBe(true);
    expect(app.missionGoStore.getWorkItem(source.key).status).toBe("ready");
  });
  it("records durable, deduplicated notifications on the source project", () => {
    const d = send();
    const notices = new PersonalNotifications(
      app.missionGoStore,
      app.missionGoAccounts,
    );
    expect(
      notices
        .list(app.missionGoAccounts.getAccount(a), {})
        .notifications.some((n) => n.summary.includes(d.targetKey)),
    ).toBe(true);
    expect(collaborationBlockers(app.missionGoStore.database, source.id)).toBe(
      1,
    );
  });
  it("rejects agent/bearer approval and non-receiver grant configuration", async () => {
    const d = draft();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/collaboration/drafts/${d.id}/submit`,
          payload: { version: 1, approved: true, idempotencyKey: randomUUID() },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: `/api/v1/products/${pb}/collaboration`,
          headers: { cookie: cookies[a]! },
          payload: { sourceProductId: pa, expectedRevision: 1 },
        })
      ).statusCode,
    ).toBe(404);
  });
});

describe("collaboration boundaries and recovery", () => {
  it("serializes duplicate approvals and rolls the entire submission back if audit persistence fails", async () => {
    const d = draft(),
      db = app.missionGoStore.database.connection;
    db.exec(
      "CREATE TRIGGER reject_collab_audit BEFORE INSERT ON collaboration_events WHEN NEW.kind='approved_and_submitted' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END",
    );
    expect(() => c.submit(a, d.id, d.version, "retryable-approval")).toThrow();
    expect(app.missionGoStore.listWorkItems({ productId: pb })).toHaveLength(0);
    expect(c.context(a, source.key).blocked).toBe(false);
    db.exec("DROP TRIGGER reject_collab_audit");
    const payload = {
      version: d.version,
      approved: true,
      idempotencyKey: "retryable-approval",
    };
    const results = await Promise.all([
      post(`/api/v1/collaboration/drafts/${d.id}/submit`, a, payload),
      post(`/api/v1/collaboration/drafts/${d.id}/submit`, a, payload),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
    expect(results[0]!.json()).toEqual(results[1]!.json());
    expect(app.missionGoStore.listWorkItems({ productId: pb })).toHaveLength(1);
  });
  it("permits nested reciprocal project relationships but refuses an actual item cycle", () => {
    const reverse = c.configure(admin.id, pa, {
      sourceProductId: pb,
      moduleId: "",
      builderAccountId: a,
      enabled: true,
      expectedRevision: 0,
    });
    const next = (key: string, grant: string) => {
      const d = c.prepare(admin.id, key, {
        grantId: grant,
        title: "Nested",
        description: "Shared",
        acceptance: "Criteria",
        attachmentIds: [],
        type: "requirement",
        priority: "normal",
      });
      return c.detail(
        admin.id,
        c.submit(admin.id, d.id, d.version, randomUUID()).id,
      );
    };
    const r1 = next(source.key, grantId),
      r2 = next(r1.targetKey, reverse.id),
      r3 = next(r2.targetKey, grantId);
    expect(() =>
      c.associate(
        admin.id,
        r3.targetKey,
        r2.targetKey,
        reverse.id,
        "Would cycle",
        randomUUID(),
      ),
    ).toThrow(/循环/);
    expect(c.context(admin.id, r1.targetKey).blocked).toBe(true);
    expect(() =>
      app.missionGoStore.transitionWorkItem({
        itemKey: r1.targetKey,
        to: "pending_verification",
        actor: "human",
        reason: "manual_override",
        note: "Bypass",
        attribution: { accountId: admin.id },
      }),
    ).toThrow();
  });
  it("keeps multiple dependencies blocked until every target has a conclusion", () => {
    const first = send(),
      second = send();
    preset(first.targetKey, "done");
    expect(collaborationBlockers(app.missionGoStore.database, source.id)).toBe(
      1,
    );
    expect(
      app.missionGoStore
        .listWorkItems({ productId: pa, collaborations: ["waiting"] })
        .map((i) => i.key),
    ).toEqual([source.key]);
    preset(second.targetKey, "cancelled");
    expect(c.context(a, source.key).blocked).toBe(false);
    expect(
      app.missionGoStore.listWorkItems({
        productId: pa,
        collaborations: ["waiting"],
      }),
    ).toHaveLength(0);
  });
  it("preserves old receiving acceptance and history when rebinding a duplicate", () => {
    const first = send(),
      s = app.missionGoStore,
      secondSource = s.createWorkItem({
        productId: pa,
        title: "Other source",
        description: "Private",
        type: "bug",
        priority: "normal",
        status: "ready",
        environment: { platform: "web" },
        builderAccountId: a,
      });
    const d = c.prepare(a, secondSource.key, { ...draft(), grantId }),
      second = c.detail(a, c.submit(a, d.id, d.version, randomUUID()).id);
    const replacement = c.rebind(
      a,
      first.id,
      first.revision,
      second.targetKey,
      "Duplicate; use same contract",
      randomUUID(),
    );
    expect(c.detail(a, first.id).withdrawn).toBe(true);
    expect(c.detail(a, replacement.id).targetKey).toBe(second.targetKey);
    expect(s.getWorkItem(first.targetKey).status).toBe("ready");
    preset(first.targetKey, "pending_verification");
    expect(
      transitionPolicy(
        s.database,
        s.getWorkItem(first.targetKey),
        b,
        "done",
        "manual_override",
      ).allowed,
    ).toBe(false);
    expect(c.context(a, source.key).requests).toHaveLength(2);
  });
  it("cannot approve changed attachment content or fetch unshared or replaced evidence", () => {
    const s = app.missionGoStore;
    const file = (name: string) =>
      s.createAttachmentMetadata({
        itemKey: source.key,
        kind: "document",
        filename: name,
        storageFilename: randomUUID() + ".txt",
        contentType: "text/plain",
        sizeBytes: 1,
      });
    const shared = file("shared.txt"),
      hidden = file("private.txt"),
      d = c.prepare(a, source.key, { ...draft(), attachmentIds: [shared.id] });
    const relation = c.submit(a, d.id, d.version, randomUUID());
    expect(c.sharedAttachment(b, relation.id, shared.id).id).toBe(shared.id);
    expect(() => c.sharedAttachment(b, relation.id, hidden.id)).toThrow();
    const pending = c.prepare(a, source.key, {
      ...draft(),
      attachmentIds: [shared.id],
    });
    s.database.connection
      .prepare("UPDATE work_item_attachments SET storage_filename=? WHERE id=?")
      .run(randomUUID() + ".txt", shared.id);
    expect(() => c.sharedAttachment(b, relation.id, shared.id)).toThrow();
    expect(() =>
      c.submit(a, pending.id, pending.version, randomUUID()),
    ).toThrow(/附件/);
  });
  it("requires current delivery evidence; stale acceptance cannot silently accept new discussion", () => {
    const d = send(),
      s = app.missionGoStore,
      t = s.getWorkItem(d.targetKey);
    const pending = {
      itemKey: t.key,
      to: "pending_verification" as const,
      actor: "human" as const,
      reason: "manual_override" as const,
      note: "Delivered",
      attribution: { accountId: admin.id },
    };
    expect(() => s.transitionWorkItem(pending)).toThrow();
    c.discuss(b, d.id, "v2; retry tested", randomUUID(), "agent", true);
    s.transitionWorkItem(pending);
    const view = c.detail(a, d.id);
    expect(view.canVerify).toBe(true);
    const notifications = new PersonalNotifications(
      s,
      app.missionGoAccounts,
    ).list(app.missionGoAccounts.getAccount(a), {});
    expect(
      notifications.notifications.some(
        (n) => n.kind === "verification" && n.itemKey === source.key,
      ),
    ).toBe(true);
    c.discuss(b, d.id, "Correction: v2.1", randomUUID(), "human", true);
    expect(() =>
      c.verify(
        a,
        d.id,
        view.revision,
        view.targetRevision!,
        true,
        "Checked older evidence",
        randomUUID(),
      ),
    ).toThrow();
    const current = c.detail(a, d.id);
    c.verify(
      a,
      d.id,
      current.revision,
      current.targetRevision!,
      false,
      "Return for retest",
      randomUUID(),
    );
    expect(() => s.transitionWorkItem(pending)).toThrowError(
      expect.objectContaining({ code: "collaboration_delivery_required" }),
    );
    c.discuss(b, d.id, "v3; retest completed", randomUUID(), "agent", true);
    expect(s.transitionWorkItem(pending).status).toBe("pending_verification");
  });
  it("revocation keeps blockers and supports controlled recovery and withdrawal", () => {
    const d = send();
    c.revoke(admin.id, d.id, "Review shared evidence", randomUUID());
    expect(() => c.detail(a, d.id)).toThrow();
    const redacted = c.context(a, source.key);
    expect(redacted.blocked).toBe(true);
    expect(JSON.stringify(redacted.requests)).not.toContain("Shared request");
    expect(() =>
      c.restoreAccess(a, d.id, "Cannot self-grant", randomUUID()),
    ).toThrow();
    c.restoreAccess(admin.id, d.id, "Review complete", randomUUID());
    expect(c.detail(a, d.id).blocking).toBe(true);
    c.revoke(admin.id, d.id, "Restricted again", randomUUID());
    c.withdraw(
      a,
      d.id,
      c.context(a, source.key).requests[0]!.revision!,
      "Resolved locally",
      randomUUID(),
    );
    expect(c.context(a, source.key).blocked).toBe(false);
  });
  it("rejects changed authority at approval and disallows live collaboration archive", () => {
    const d = draft();
    app.missionGoAccounts.replacePermissions(a, [
      { productId: pa, canView: true, canOperate: false, canUseAi: true },
    ]);
    expect(() => c.submit(a, d.id, d.version, randomUUID())).toThrow();
    app.missionGoAccounts.replacePermissions(a, [
      { productId: pa, canView: true, canOperate: true, canUseAi: true },
    ]);
    send();
    expect(() =>
      app.missionGoStore.updateProduct(pb, { archived: true }),
    ).toThrow();
  });
});

it("invalidates a cancellation snapshot when a new dependency arrives", () => {
  const old = app.missionGoStore.getWorkItem(source.key);
  send();
  expect(() =>
    app.missionGoStore.transitionWorkItem({
      itemKey: source.key,
      to: "cancelled",
      actor: "human",
      reason: "cancelled",
      note: "Old decision",
      expectedRevision: old.revision!,
      expectedStatus: "ready",
      attribution: { accountId: a },
      collaborationDisposition: { mode: "withdraw" },
    }),
  ).toThrow();
  expect(c.context(a, source.key).blocked).toBe(true);
});

it("MCP only prepares drafts and reads narrow shared context under the current AI scope", async () => {
  const token = (id: string) => {
    const account = app.missionGoAccounts.getAccount(id);
    return createAiAccessToken(
      admin,
      { id, username: account.email, role: account.role },
      app.missionGoAccounts.credentialsStamp(account),
      "collaboration-test",
      ["missiongo:read", "missiongo:write"],
    ).token;
  };
  const call = async (id: string, name: string, args: unknown) => {
    const r = await app.inject({
      method: "POST",
      url: "/mcp",
      headers: {
        authorization: `Bearer ${token(id)}`,
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
      },
      payload: {
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
      },
    });
    const raw = r.headers["content-type"]?.includes("text/event-stream")
      ? r.body
          .split("\n")
          .find((l) => l.startsWith("data: "))!
          .slice(6)
      : r.body;
    return JSON.parse(raw);
  };
  const args = {
    itemKey: source.key,
    grantId,
    title: "Agent draft",
    description: "Approved evidence",
    acceptance: "Success",
    agentName: "Codex",
    idempotencyKey: "draft-key",
  };
  const prepared = await call(a, "prepare_collaboration_request", args);
  expect(prepared.result?.structuredContent?.requiresHumanApproval).toBe(true);
  const d = prepared.result.structuredContent.draft;
  expect(
    (await call(a, "prepare_collaboration_request", args)).result
      .structuredContent.draft.id,
  ).toBe(d.id);
  expect(app.missionGoStore.listWorkItems({ productId: pb })).toHaveLength(0);
  expect(
    (await call(a, "approve_collaboration_request", { draftId: d.id })).error,
  ).toBeDefined();
  const approval = await app.inject({
    method: "POST",
    url: `/api/v1/collaboration/drafts/${d.id}/submit`,
    headers: { authorization: `Bearer ${token(a)}` },
    payload: { version: 1, approved: true, idempotencyKey: "forged-human" },
  });
  expect(approval.statusCode).toBe(401);
  const relation = c.submit(a, d.id, d.version, randomUUID());
  expect(
    (await call(b, "get_collaboration", { requestId: relation.id })).result
      .structuredContent.request.description,
  ).toBe("Approved evidence");
  const linked = await call(b, "get_item_context", { itemKey: source.key });
  expect(linked.result?.isError).toBeUndefined();
  expect(linked.result?.structuredContent?.item?.description).toBe(
    "Private source context",
  );
  expect(linked.result?.structuredContent?.scopeNotice).toBeTruthy();
  // The linked read is item-scoped: the source project's module list is not
  // handed over with it.
  expect(linked.result?.structuredContent?.components ?? []).toEqual([]);
  app.missionGoAccounts.replacePermissions(b, [
    { productId: pb, canView: true, canOperate: true, canUseAi: false },
  ]);
  const denied = await call(b, "get_collaboration", { requestId: relation.id });
  expect(denied.error || denied.result?.isError).toBeTruthy();
});

it("a source proposer cannot cancel receiving work merely because they can view that project", () => {
  const d = send();
  app.missionGoAccounts.replacePermissions(a, [
    { productId: pa, canView: true, canOperate: true, canUseAi: true },
    { productId: pb, canView: true, canOperate: true, canUseAi: true },
  ]);
  expect(
    transitionPolicy(
      app.missionGoStore.database,
      app.missionGoStore.getWorkItem(d.targetKey),
      a,
      "cancelled",
      "cancelled",
    ).allowed,
  ).toBe(false);
  expect(
    transitionPolicy(
      app.missionGoStore.database,
      app.missionGoStore.getWorkItem(d.targetKey),
      b,
      "cancelled",
      "cancelled",
    ).allowed,
  ).toBe(true);
});

it("read-only project observers cannot write shared comments or impersonate delivery", async () => {
  const d = send(),
    viewer = app.missionGoAccounts.createAccount({
      email: "observer@example.test",
      password: "password-123",
      role: "member",
    });
  app.missionGoAccounts.replacePermissions(viewer.id, [
    { productId: pa, canView: true, canOperate: false, canUseAi: true },
  ]);
  expect(c.detail(viewer.id, d.id).canDiscuss).toBe(false);
  expect(() =>
    c.discuss(viewer.id, d.id, "Unauthorized", randomUUID()),
  ).toThrow();
  expect(() =>
    c.discuss(
      a,
      d.id,
      "Cannot impersonate receiver",
      randomUUID(),
      "agent",
      true,
    ),
  ).toThrow();
  const response = await post(`/api/v1/items/${source.key}/transitions`, a, {
    to: "cancelled",
    reason: "cancelled",
    note: "Malformed choice",
    expectedRevision: app.missionGoStore.getWorkItem(source.key).revision,
    expectedStatus: "ready",
    idempotencyKey: randomUUID(),
    collaborationDisposition: { mode: "anything" },
  });
  expect(response.statusCode).toBe(400);
  expect(c.context(a, source.key).blocked).toBe(true);
});
