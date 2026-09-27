import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ManagedDecisionContent } from "@missiongo/domain";
import type { AccountSnapshot, AccountStore } from "./accounts-store.js";
import { invalidInput, MissionGoError, notFound } from "./errors.js";
import { ManagedDecisionStore, type DecisionChange, type DecisionOperation } from "./managed-decision-store.js";
import type { MissionGoDatabase } from "./storage/database.js";

const GUARD_FIELDS = ["version", "stateVersion", "contentDigest", "scopeDigest", "contractRevision", "idempotencyKey"];
function exactBody(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidInput("Expected decision object.");
  const body = value as Record<string, unknown>;
  if (Object.keys(body).length !== fields.length || !fields.every((k) => Object.hasOwn(body, k))) throw invalidInput("Unexpected or missing decision fields.");
  return body;
}

/** Separate human-only control surface. Never use the legacy bearer-bypass helpers here. */
export function registerManagedDecisionRoutes(app: FastifyInstance, options: {
  db: MissionGoDatabase; accounts: AccountStore; requireAccount: (request: FastifyRequest) => AccountSnapshot; publicOrigin?: string;
}): void {
  const decisions = new ManagedDecisionStore(options.db);
  const expectedOrigin = options.publicOrigin ? new URL(options.publicOrigin).origin : undefined;
  const human = (request: FastifyRequest, write = false): AccountSnapshot => {
    if (request.headers.authorization !== undefined) throw new MissionGoError("human_session_required", "Use a human account session without a machine bearer.", 403);
    const account = options.requireAccount(request);
    if (write && (!expectedOrigin || request.headers.origin !== expectedOrigin || request.headers["sec-fetch-site"] === "cross-site")) {
      throw new MissionGoError("decision_origin_required", "A same-origin decision confirmation is required.", 403);
    }
    return account;
  };
  const access = (request: FastifyRequest, capability: "view" | "write" | "revoke") => (productId: string): string => {
    // Invoked again under BEGIN IMMEDIATE on each mutation, including idempotent replay.
    const account = human(request, capability !== "view");
    if (!options.accounts.allows(account, productId, "view")) throw notFound("Decision");
    if (capability !== "view" && (!options.accounts.allows(account, productId, "operate")
      || (capability === "write" && !options.accounts.allows(account, productId, "ai")))) {
      throw new MissionGoError("decision_not_permitted", "This account cannot authorize this decision.", 403);
    }
    return account.id;
  };

  app.post("/api/v1/managed-runs/:runId/decisions", async (request, reply) => {
    reply.header("cache-control", "no-store"); human(request, true);
    const { runId } = request.params as { runId: string };
    const b = exactBody(request.body, ["decisionKey", "scopeDigest", "contractRevision", "content", "idempotencyKey"]);
    const result = decisions.create(access(request, "write"), { runId, decisionKey: b.decisionKey as string,
      scopeDigest: b.scopeDigest as string, contractRevision: b.contractRevision as number,
      content: b.content as ManagedDecisionContent, idempotencyKey: b.idempotencyKey as string });
    return reply.status(201).send(result);
  });
  app.get("/api/v1/managed-decisions/:id", async (request, reply) => {
    reply.header("cache-control", "no-store"); human(request);
    const { id } = request.params as { id: string };
    const decision = decisions.get(access(request, "view"), id);
    const account = human(request);
    const operate = options.accounts.allows(account, decision.scope.productId, "operate");
    const ai = options.accounts.allows(account, decision.scope.productId, "ai");
    const product = options.db.connection.prepare("SELECT name FROM products WHERE id=?").get(decision.scope.productId) as { name: string };
    return { decision, productName: product.name, access: {
      canApprove: operate && ai && decision.status === "pending", canRevoke: operate && decision.status !== "revoked",
    } };
  });
  app.get("/api/v1/managed-decisions/:id/events", async (request, reply) => {
    reply.header("cache-control", "no-store"); human(request);
    const { id } = request.params as { id: string };
    const query = request.query as Record<string, string | undefined>;
    const after = query.after === undefined ? 0 : Number(query.after);
    const events = decisions.listEvents(access(request, "view"), id, after, 100);
    return { events, nextAfter: events.length === 100 ? events.at(-1)!.sequence : null };
  });
  const operations: readonly DecisionOperation[] = ["approve", "revoke", "revise", "explain"];
  for (const operation of operations) {
    app.post(`/api/v1/managed-decisions/:id/${operation}`, async (request, reply) => {
      reply.header("cache-control", "no-store"); human(request, true);
      const { id } = request.params as { id: string };
      const extra = operation === "revise" ? ["content"] : operation === "explain" ? ["explanation"] : [];
      const input = exactBody(request.body, [...GUARD_FIELDS, ...extra]) as unknown as DecisionChange;
      return decisions.change(access(request, operation === "revoke" ? "revoke" : "write"), id, operation, input);
    });
  }
}
