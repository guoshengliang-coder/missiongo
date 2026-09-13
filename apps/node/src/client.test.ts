import { describe, expect, it } from "vitest";

import { NodeApiClient, NodeAuthError, pairNode } from "./client.js";

type Call = { url: string; init: RequestInit };

function stubFetch(responses: Array<{ status: number; body?: string }>) {
  const calls: Call[] = [];
  let index = 0;
  const fetchImpl = async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const response = responses[Math.min(index, responses.length - 1)]!;
    index += 1;
    // 204 forbids a body in the Response constructor, so pass null rather than "".
    return new Response(response.body ?? null, { status: response.status });
  };
  return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
}

describe("Node API client status handling", () => {
  // Every one of these was a real mismatch found by running the daemon against
  // the server: the endpoints answer 201 and 204, and a 200-only check turned a
  // success into a reported failure — for pairing, one that could never be
  // retried, because the code is single use.
  it("accepts the 201 that pairing answers", async () => {
    const { fetchImpl } = stubFetch([{
      status: 201,
      body: JSON.stringify({ nodeId: "n1", name: "Mac mini", token: "mgn_x" }),
    }]);
    await expect(pairNode({ serverUrl: "http://127.0.0.1:8799", code: "a-b", hostname: "mini", fetchImpl }))
      .resolves.toMatchObject({ nodeId: "n1", token: "mgn_x" });
  });

  it("accepts the 204 that reporting a result answers", async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 204 }]);
    const client = new NodeApiClient({ serverUrl: "http://127.0.0.1:8799", token: "mgn_x", fetchImpl });
    await expect(client.reportResult("d1", { status: "launched", sessionName: "MissionGo AND-1" }))
      .resolves.toBeUndefined();
    expect(calls[0]!.url).toContain("/api/v1/node/dispatches/d1/result");
  });

  it("reads 204 from claim-next as an empty queue rather than an error", async () => {
    const { fetchImpl } = stubFetch([{ status: 204 }]);
    const client = new NodeApiClient({ serverUrl: "http://127.0.0.1:8799", token: "mgn_x", fetchImpl });
    await expect(client.claimNext()).resolves.toBeUndefined();
  });

  it("treats a revoked credential as fatal instead of retrying forever", async () => {
    const { fetchImpl } = stubFetch([{ status: 401, body: "{}" }]);
    const client = new NodeApiClient({ serverUrl: "http://127.0.0.1:8799", token: "mgn_x", fetchImpl });
    await expect(client.heartbeat([])).rejects.toBeInstanceOf(NodeAuthError);
  });
});
