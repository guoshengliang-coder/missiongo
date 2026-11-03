import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { createReadStream } from "node:fs";
import type { AccountSnapshot } from "./accounts-store.js";
import type { MissionGoStore } from "./store.js";
import type { AttachmentStorage } from "./attachment-storage.js";
import {
  Collaborations,
  collaborationDraftSchema,
  collaborationGrantSchema,
} from "./collaboration.js";
import { invalidInput } from "./errors.js";
const note = z.string().trim().min(1).max(2000),
  key = z.string().trim().min(1).max(200),
  revision = z.number().int().positive();
const command = z.object({ idempotencyKey: key, note });
function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const r = schema.safeParse(body);
  if (!r.success)
    throw invalidInput(
      "协作请求内容无效，请核对必填字段。",
      "collaboration_input_invalid",
    );
  return r.data;
}
export function registerCollaborationRoutes(
  app: FastifyInstance,
  {
    store,
    requireAccount,
    storage,
  }: {
    store: MissionGoStore;
    requireAccount: (r: FastifyRequest) => AccountSnapshot;
    storage: AttachmentStorage;
  },
) {
  const service = new Collaborations(store),
    who = (r: FastifyRequest) => requireAccount(r).id;
  const params = (r: FastifyRequest) =>
    r.params as {
      productId: string;
      itemKey: string;
      id: string;
      attachmentId: string;
    };
  app.get("/api/v1/products/:productId/collaboration", async (r) => ({
    grants: service.grants(who(r), params(r).productId),
  }));
  app.get("/api/v1/products/:productId/collaboration/directory", async (r) => ({
    projects: service.directory(who(r), params(r).productId),
  }));
  app.put("/api/v1/products/:productId/collaboration", async (r) =>
    service.configure(
      who(r),
      params(r).productId,
      parse(collaborationGrantSchema, r.body),
    ),
  );
  app.get("/api/v1/items/:itemKey/collaboration", async (r) =>
    service.context(who(r), params(r).itemKey),
  );
  app.get("/api/v1/items/:itemKey/collaboration/targets", async (r) => ({
    targets: service.targets(who(r), params(r).itemKey),
  }));
  app.post("/api/v1/items/:itemKey/collaboration/drafts", async (r) => {
    const b = parse(
      collaborationDraftSchema.extend({
        draftId: key.optional(),
        expectedVersion: revision.optional(),
        idempotencyKey: key,
      }),
      r.body,
    );
    return service.prepareCommand(
      who(r),
      params(r).itemKey,
      collaborationDraftSchema.parse(b),
      b.idempotencyKey,
      "human",
      undefined,
      b.draftId,
      b.expectedVersion,
    );
  });
  app.post("/api/v1/collaboration/drafts/:id/submit", async (r) => {
    const b = parse(
      z.object({
        version: revision,
        idempotencyKey: key,
        approved: z.literal(true),
      }),
      r.body,
    );
    return service.submit(who(r), params(r).id, b.version, b.idempotencyKey);
  });
  app.post("/api/v1/items/:itemKey/collaboration/associate", async (r) => {
    const b = parse(command.extend({ targetKey: key, grantId: key }), r.body);
    return service.associate(
      who(r),
      params(r).itemKey,
      b.targetKey,
      b.grantId,
      b.note,
      b.idempotencyKey,
    );
  });
  app.get("/api/v1/collaboration/:id/candidates", async (r) => ({
    people: service.candidates(who(r), params(r).id),
  }));
  app.get("/api/v1/collaboration/:id", async (r) =>
    service.detail(who(r), params(r).id),
  );
  app.post("/api/v1/collaboration/:id/withdraw", async (r) => {
    const b = parse(command.extend({ revision }), r.body);
    return service.withdraw(
      who(r),
      params(r).id,
      b.revision,
      b.note,
      b.idempotencyKey,
    );
  });
  app.post("/api/v1/collaboration/:id/verify", async (r) => {
    const b = parse(
      command.extend({
        revision,
        targetRevision: revision,
        passed: z.boolean(),
      }),
      r.body,
    );
    return service.verify(
      who(r),
      params(r).id,
      b.revision,
      b.targetRevision,
      b.passed,
      b.note,
      b.idempotencyKey,
    );
  });
  app.post("/api/v1/collaboration/:id/discussion", async (r) => {
    const b = parse(
      command.extend({ delivery: z.boolean().default(false) }),
      r.body,
    );
    return service.discuss(
      who(r),
      params(r).id,
      b.note,
      b.idempotencyKey,
      "human",
      b.delivery,
    );
  });
  app.post("/api/v1/collaboration/:id/verifier", async (r) => {
    const b = parse(command.extend({ successorId: key }), r.body);
    return service.transferVerifier(
      who(r),
      params(r).id,
      b.successorId,
      b.note,
      b.idempotencyKey,
    );
  });
  app.post("/api/v1/collaboration/:id/rebind", async (r) => {
    const b = parse(command.extend({ revision, targetKey: key }), r.body);
    return service.rebind(
      who(r),
      params(r).id,
      b.revision,
      b.targetKey,
      b.note,
      b.idempotencyKey,
    );
  });
  app.post("/api/v1/collaboration/:id/restore-access", async (r) => {
    const b = parse(command, r.body);
    return service.restoreAccess(
      who(r),
      params(r).id,
      b.note,
      b.idempotencyKey,
    );
  });
  app.post("/api/v1/collaboration/:id/revoke", async (r) => {
    const b = parse(command, r.body);
    return service.revoke(who(r), params(r).id, b.note, b.idempotencyKey);
  });
  app.get(
    "/api/v1/collaboration/:id/attachments/:attachmentId",
    async (r, reply) => {
      const f = service.sharedAttachment(
        who(r),
        params(r).id,
        params(r).attachmentId,
      );
      return reply
        .header(
          "Content-Disposition",
          `attachment; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
        )
        .header("X-Content-Type-Options", "nosniff")
        .type("application/octet-stream")
        .send(createReadStream(storage.resolveStoredFile(f.storageFilename)));
    },
  );
}
