import { generateKeyPairSync } from "node:crypto";

import { describe, expect, it } from "vitest";

import { AccountStore } from "./accounts-store.js";
import { MissionGoDatabase } from "./storage/database.js";
import { WidgetDeviceStore } from "./widget-devices.js";
import {
  parseWidgetPushServiceAccount,
  WidgetPushService,
  widgetSummaryFingerprint,
  type WidgetPushServiceAccount,
} from "./widget-push.js";
import { widgetSummary, type WidgetSummary } from "./widget-summary.js";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });

const SERVICE_ACCOUNT: WidgetPushServiceAccount = {
  projectId: "missiongo-test",
  clientEmail: "push@test.example",
  privateKey,
};

const ACCOUNT_ID = "00000000-0000-4000-8000-000000000001";

function summaryOf(attention: number, now: string): WidgetSummary {
  return widgetSummary(
    Array.from({ length: attention }, (_, index) => ({
      id: `s${index}`,
      status: "idle",
      needsAttention: true,
      items: [{ productId: "p1", key: `AND-${index}` }],
      attention: { kind: "answer", revision: `r${index}` },
      latestMessageText: "x",
    })),
    new Map(),
    new Date(now),
  );
}

interface Harness {
  readonly devices: WidgetDeviceStore;
  readonly service: WidgetPushService;
  readonly tokenRequests: string[];
  readonly fcmRequests: Array<{ token: string; body: unknown; authorization: string }>;
  setSummary(summary: WidgetSummary | undefined): void;
}

/**
 * A real database, real account row, and a locally generated RSA key; only the
 * two Google endpoints are replaced, so the JWT signing path runs for real.
 */
async function harness(fcmStatuses: number[] = [200]): Promise<Harness> {
  const database = new MissionGoDatabase(":memory:");
  const accounts = new AccountStore(database);
  accounts.seedBootstrapAdmin({ id: ACCOUNT_ID, email: "admin@example.com", passwordScrypt: "digest" });
  const devices = new WidgetDeviceStore(database);
  const tokenRequests: string[] = [];
  const fcmRequests: Array<{ token: string; body: unknown; authorization: string }> = [];
  let fcmCall = 0;
  let summary: WidgetSummary | undefined = summaryOf(1, "2026-09-23T04:00:00.000Z");
  const service = new WidgetPushService({
    devices,
    summaryFor: () => summary,
    serviceAccount: SERVICE_ACCOUNT,
    debounceMs: 0,
    fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
      const target = String(url);
      if (target === "https://oauth2.googleapis.com/token") {
        tokenRequests.push(String(init?.body));
        return new Response(JSON.stringify({ access_token: `t${tokenRequests.length}`, expires_in: 3600 }), { status: 200 });
      }
      const body = JSON.parse(String(init?.body)) as { message: { token: string } };
      fcmRequests.push({ token: body.message.token, body, authorization: String(init?.headers?.authorization) });
      const status = fcmStatuses[Math.min(fcmCall, fcmStatuses.length - 1)] ?? 200;
      fcmCall += 1;
      return new Response("{}", { status });
    }) as typeof fetch,
  });
  return {
    devices,
    service,
    tokenRequests,
    fcmRequests,
    setSummary: (next) => {
      summary = next;
    },
  };
}

/** Let a zero-delay debounce timer fire, then wait for whatever it started. */
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("parseWidgetPushServiceAccount", () => {
  it("reads the three fields Google's JSON carries", () => {
    expect(parseWidgetPushServiceAccount(
      JSON.stringify({ project_id: "p", client_email: "e@x", private_key: "k" }),
    )).toEqual({ projectId: "p", clientEmail: "e@x", privateKey: "k" });
  });

  it("treats absent, blank, and whitespace as push-off", () => {
    expect(parseWidgetPushServiceAccount(undefined)).toBeUndefined();
    expect(parseWidgetPushServiceAccount("")).toBeUndefined();
    expect(parseWidgetPushServiceAccount("  ")).toBeUndefined();
  });

  it("refuses JSON that is not a service account", () => {
    expect(() => parseWidgetPushServiceAccount("not json")).toThrow();
    expect(() => parseWidgetPushServiceAccount("{}")).toThrow();
    expect(() => parseWidgetPushServiceAccount(JSON.stringify({ project_id: "p" }))).toThrow();
  });
});

describe("widgetSummaryFingerprint", () => {
  it("ignores the timestamp that changes on every read", () => {
    const a = summaryOf(2, "2026-09-23T04:00:00.000Z");
    const b = summaryOf(2, "2026-09-23T05:00:00.000Z");
    expect(widgetSummaryFingerprint(a)).toBe(widgetSummaryFingerprint(b));
    expect(widgetSummaryFingerprint(summaryOf(3, "2026-09-23T04:00:00.000Z")))
      .not.toBe(widgetSummaryFingerprint(a));
  });
});

describe("WidgetPushService (AND-150)", () => {
  it("sends one data-only signal per real change and none for repeats", async () => {
    const h = await harness();
    h.devices.register(ACCOUNT_ID, "device-token");

    h.service.noteChanged();
    h.service.noteChanged();
    h.service.noteChanged();
    await settle();
    expect(h.fcmRequests).toHaveLength(1);
    expect(h.fcmRequests[0]).toEqual({
      token: "device-token",
      authorization: "Bearer t1",
      body: { message: { token: "device-token", data: { widget: "refresh" }, android: { priority: "NORMAL" } } },
    });

    // Same summary again: the fingerprint says the devices already know.
    h.service.noteChanged();
    await settle();
    expect(h.fcmRequests).toHaveLength(1);

    // The attention count moved: push.
    h.setSummary(summaryOf(2, "2026-09-23T06:00:00.000Z"));
    h.service.noteChanged();
    await settle();
    expect(h.fcmRequests).toHaveLength(2);
    await h.service.close();
  });

  it("exchanges one access token and reuses it", async () => {
    const h = await harness();
    h.devices.register(ACCOUNT_ID, "device-token");
    h.service.noteChanged();
    await settle();
    h.setSummary(summaryOf(3, "2026-09-23T07:00:00.000Z"));
    h.service.noteChanged();
    await settle();
    expect(h.tokenRequests).toHaveLength(1);
    expect(h.fcmRequests.map((request) => request.authorization)).toEqual(["Bearer t1", "Bearer t1"]);
    await h.service.close();
  });

  it("re-authenticates once when FCM rejects the access token", async () => {
    const h = await harness([401, 200]);
    h.devices.register(ACCOUNT_ID, "device-token");
    h.service.noteChanged();
    await settle();
    expect(h.tokenRequests).toHaveLength(2);
    expect(h.fcmRequests).toHaveLength(2);
    await h.service.close();
  });

  it("drops a token Google reports unregistered", async () => {
    const h = await harness([404]);
    h.devices.register(ACCOUNT_ID, "device-token");
    h.service.noteChanged();
    await settle();
    expect(h.fcmRequests).toHaveLength(1);
    expect(h.devices.listForAccount(ACCOUNT_ID)).toEqual([]);
    await h.service.close();
  });

  it("keeps the fingerprint unrecorded on failure so the next change retries", async () => {
    const h = await harness([500]);
    h.devices.register(ACCOUNT_ID, "device-token");
    h.service.noteChanged();
    await settle();
    expect(h.fcmRequests).toHaveLength(1);
    // Still 500, but the retry happens because the failure never counted as delivered.
    h.service.noteChanged();
    await settle();
    expect(h.fcmRequests).toHaveLength(2);
    await h.service.close();
  });

  it("stays silent when the account no longer resolves", async () => {
    const h = await harness();
    h.devices.register(ACCOUNT_ID, "device-token");
    h.setSummary(undefined);
    h.service.noteChanged();
    await settle();
    expect(h.fcmRequests).toHaveLength(0);
    expect(h.tokenRequests).toHaveLength(0);
    await h.service.close();
  });

  it("does nothing without credentials", async () => {
    const database = new MissionGoDatabase(":memory:");
    new AccountStore(database).seedBootstrapAdmin({ id: ACCOUNT_ID, email: "admin@example.com", passwordScrypt: "digest" });
    const devices = new WidgetDeviceStore(database);
    const service = new WidgetPushService({ devices, summaryFor: () => summaryOf(1, "now") });
    devices.register(ACCOUNT_ID, "device-token");
    service.noteChanged();
    await settle();
    await service.close();
    expect(devices.listForAccount(ACCOUNT_ID)).toEqual(["device-token"]);
  });
});
