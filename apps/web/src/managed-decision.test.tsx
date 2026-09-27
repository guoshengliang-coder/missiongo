import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import type { ManagedDecision } from "@missiongo/domain";
import { I18nProvider } from "./i18n";
import * as page from "./managed-decision-page";
import { api } from "./api";

const decision: ManagedDecision = { id: "decision-1", runId: "run-1", decisionKey: "implementation", scope: { productId: "p", repositoryRef: "repo", itemKeys: ["AND-1", "AND-2"], contractRevision: 3 },
  scopeDigest: "scope", version: 2, stateVersion: 4, contentDigest: "content", status: "pending", approval: null, explanation: "Clarification",
  content: { title: "Frozen task", recommendation: "Recommended plan", alternatives: ["Defer and accept delay"], costs: "No production change",
    acceptanceCriteria: ["Security tests pass", "No worker launched"], allowedActions: ["implement", "review"] }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" };
afterEach(() => vi.unstubAllGlobals());
it("shows the entire approval contract and links discussions back to the console, not approval", () => {
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => undefined });
  const html = renderToStaticMarkup(<I18nProvider><page.DecisionDetails view={{ decision, productName: "Test product", access: { canApprove: true, canRevoke: true } }} /></I18nProvider>);
  for (const value of ["Frozen task", "Test product", "repo", "AND-1", "AND-2", "Recommended plan", "Defer and accept delay", "No production change", "Security tests pass", "No worker launched", "Clarification"]) expect(html).toContain(value);
  expect(html).toContain('/?product=p&amp;item=AND-1');
  expect(html).toContain("查看和讨论不构成批准");
  expect(html).toContain("批准不会自动启动任务");
});
it("ties confirmation to every authorization binding field rather than a boolean", () => {
  const base = { decision, productName: "Test product", access: { canApprove: true, canRevoke: true } };
  const original = page.decisionConfirmation(base);
  const variants: typeof base[] = [
    { ...base, decision: { ...decision, id: "different" } },
    { ...base, decision: { ...decision, runId: "different" } },
    { ...base, decision: { ...decision, version: decision.version + 1 } },
    { ...base, decision: { ...decision, stateVersion: decision.stateVersion + 1 } },
    { ...base, decision: { ...decision, contentDigest: "different" } },
    { ...base, decision: { ...decision, scopeDigest: "different" } },
    { ...base, decision: { ...decision, scope: { ...decision.scope, contractRevision: decision.scope.contractRevision + 1 } } },
    { ...base, decision: { ...decision, status: "revoked" } },
    { ...base, access: { ...base.access, canApprove: false } },
    { ...base, access: { ...base.access, canRevoke: false } },
  ];
  for (const value of variants) expect(page.decisionConfirmation(value)).not.toBe(original);
});
it("uses explicit version-bound JSON writes and same-origin cookie, never comment or dispatch APIs", async () => {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(decision), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  const guard = page.decisionGuard(decision, "stable-key");
  await api.approveManagedDecision("decision/1", guard);
  await api.revokeManagedDecision("decision/1", guard);
  expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/managed-decisions/decision%2F1/approve", expect.objectContaining({ method: "POST", credentials: "same-origin", body: JSON.stringify(guard) }));
  expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/managed-decisions/decision%2F1/revoke", expect.objectContaining({ method: "POST", credentials: "same-origin", body: JSON.stringify(guard) }));
  expect(guard).toEqual({ version: 2, stateVersion: 4, contentDigest: "content", scopeDigest: "scope", contractRevision: 3, idempotencyKey: "stable-key" });
});
