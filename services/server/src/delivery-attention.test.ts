import { expect, it } from "vitest";
import { withDeliveryAttention } from "./delivery-attention.js";
import type { AgentSessionListItem } from "./agent-session-store.js";

const base = { status: "idle", attention: { state: "needed", kind: "instruction", reason: "等待发起合并", revision: "message-1", deliveryOnly: true },
  needsAttention: true, waitingForReply: true } as const;
it("projects only explicitly classified delivery instructions and preserves the raw reason", () => {
  expect(withDeliveryAttention(base, true)).toMatchObject({ needsAttention: false, waitingForReply: false,
    attention: { ...base.attention, handledByDelivery: true } });
  expect(withDeliveryAttention(base, false)).toBe(base);
  expect(base.needsAttention).toBe(true);
});
it("fails visible for independent, unknown, legacy and superseded requests", () => {
  for (const attention of [ { ...base.attention, deliveryOnly: false }, { ...base.attention, deliveryOnly: undefined },
    { ...base.attention, revision: undefined }, ...["answer", "approval", "action", "uncertain"].map(kind => ({ ...base.attention, kind })) ]) {
    const session = { ...base, attention } as AgentSessionListItem;
    expect(withDeliveryAttention(session, true)).toBe(session);
  }
  for (const extra of [{ status: "failed" }, { status: "stalled" }, { status: "unavailable" },
    { waitingForPermission: true }, { planApprovalPending: true }]) {
    const session = { ...base, ...extra } as AgentSessionListItem;
    expect(withDeliveryAttention(session, true)).toBe(session);
  }
});
