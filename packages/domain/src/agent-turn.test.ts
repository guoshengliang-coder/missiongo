import { expect, it } from "vitest";
import { hasStoppableAgentTurn } from "./agent-turn.js";

it.each(["idle", "failed", "suspended", "unavailable"])("hides stop for an ended %s turn", status => {
  expect(hasStoppableAgentTurn({ status, turnState: { turnActive: false } })).toBe(false);
});

it("does not mistake background work for an active foreground turn", () => {
  expect(hasStoppableAgentTurn({ status: "active", turnState: { turnActive: false } })).toBe(false);
});

it("retains active, waiting and legacy turns, including an uncertain active source", () => {
  for (const status of ["active", "idle", "stalled", "unavailable"]) {
    expect(hasStoppableAgentTurn({ status, turnState: { turnActive: true } })).toBe(true);
  }
  expect(hasStoppableAgentTurn({ status: "idle", turnState: { turnActive: false, waitingForInput: true } })).toBe(true);
  expect(hasStoppableAgentTurn({ status: "active" })).toBe(true);
  expect(hasStoppableAgentTurn({ status: "stalled" })).toBe(true);
  expect(hasStoppableAgentTurn({ status: "idle" })).toBe(false);
});

it.each(["queued", "delivering", "delivery_unknown"])("retains a %s input or stop until settled", status => {
  const ended = { status: "idle", turnState: { turnActive: false } };
  expect(hasStoppableAgentTurn({ ...ended, command: { kind: "message", status } })).toBe(true);
  expect(hasStoppableAgentTurn({ ...ended, stopCommand: { kind: "interrupt", status } })).toBe(true);
});

it("retains retry for an unconfirmed stop without reviving confirmed or recovered turns", () => {
  const unknown = { status: "unavailable", turnState: { turnActive: false },
    stopCommand: { kind: "interrupt", status: "failed", stopConfirmed: false } };
  expect(hasStoppableAgentTurn(unknown)).toBe(true);
  expect(hasStoppableAgentTurn({ ...unknown, status: "idle" })).toBe(false);
  expect(hasStoppableAgentTurn({ ...unknown, stopCommand: { ...unknown.stopCommand, stopConfirmed: true } })).toBe(false);
  expect(hasStoppableAgentTurn({ status: "idle", turnState: { turnActive: false },
    command: { kind: "interrupt", status: "delivered", stopConfirmed: true } })).toBe(false);
});
