import { afterEach, describe, expect, it, vi } from "vitest";

import { api } from "./api";

afterEach(() => vi.unstubAllGlobals());

describe("administrator account API", () => {
  it("uses a same-origin session cookie for login and authenticated requests", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: { id: "account-1", username: "owner", role: "admin" },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify([]), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    await api.login({ username: "owner", password: "secret" });
    await api.listProducts();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/auth/login", expect.objectContaining({
      method: "POST",
      credentials: "same-origin",
      body: JSON.stringify({ username: "owner", password: "secret" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/products", expect.objectContaining({
      credentials: "same-origin",
    }));
    expect(fetchMock.mock.calls[1]?.[1]?.headers).not.toHaveProperty("authorization");
  });

  it("checks and clears the current account session", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        user: { id: "account-1", username: "owner", role: "admin" },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }));
    vi.stubGlobal("fetch", fetchMock);

    expect((await api.getSession()).user.id).toBe("account-1");
    await api.logout();

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/auth/session", expect.objectContaining({ credentials: "same-origin" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/auth/logout", expect.objectContaining({ method: "POST", credentials: "same-origin" }));
  });
});

describe("dispatch API", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": status === 200 ? "application/json" : "application/problem+json" },
  });
  const input = { nodeId: "node-1", agentKind: "claude_code", mode: "plan", itemKeys: ["AND-37"] } as const;

  it("lists the unclaimed dispatches with the session cookie", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ active: [], latest: [] }));
    vi.stubGlobal("fetch", fetchMock);

    expect(await api.listActiveDispatches()).toEqual({ active: [], latest: [] });
    expect(fetchMock).toHaveBeenCalledWith("/api/v1/dispatches/active", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("leaves force out of an ordinary dispatch, so the server still refuses a duplicate", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetchMock);

    await api.createDispatch(input);

    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).not.toHaveProperty("force");
  });

  it("sends force when the person confirmed the earlier session is gone", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({}));
    vi.stubGlobal("fetch", fetchMock);

    await api.createDispatch({ ...input, force: true });

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/dispatches", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string)).toEqual({ ...input, force: true });
  });

  it("carries the duplicate refusal's code, which the dialog turns into its own wording", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(json({
      code: "item_already_dispatched",
      title: "Already dispatched and not yet claimed: AND-37 → Mac mini（launched）.",
    }, 409)));

    await expect(api.createDispatch(input)).rejects.toMatchObject({ status: 409, code: "item_already_dispatched" });
  });

  it("reads a mirrored Codex session and queues a reply", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "session-1", status: "idle", messages: [] }))
      .mockResolvedValueOnce(json({ sessions: [] }))
      .mockResolvedValueOnce(json({ id: "command-1", status: "queued", text: "continue" }, 201))
      .mockResolvedValueOnce(json({ id: "command-1", status: "cancelled", text: "continue" }));
    vi.stubGlobal("fetch", fetchMock);

    await api.getAgentSession("session 1");
    await api.listAgentSessions("product 1");
    await api.sendAgentSessionCommand("session 1", "continue");
    await api.cancelAgentSessionCommand("session 1", "command 1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/agent-sessions/session%201", expect.objectContaining({
      credentials: "same-origin",
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/agent-sessions?productId=product%201", expect.objectContaining({
      credentials: "same-origin",
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(3, "/api/v1/agent-sessions/session%201/commands", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ text: "continue" }),
    }));
    expect(fetchMock).toHaveBeenNthCalledWith(4, "/api/v1/agent-sessions/session%201/commands/command%201/cancel", expect.objectContaining({
      method: "POST",
    }));
  });

  it("retries and stops a dispatch through explicit control endpoints", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json({ id: "dispatch-1", status: "queued" }, 201))
      .mockResolvedValueOnce(json({ dispatch: { id: "dispatch-1", status: "cancelled" } }));
    vi.stubGlobal("fetch", fetchMock);

    await api.retryDispatch("dispatch 1");
    await api.stopDispatch("dispatch 1");

    expect(fetchMock).toHaveBeenNthCalledWith(1, "/api/v1/dispatches/dispatch%201/retry", expect.objectContaining({ method: "POST" }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, "/api/v1/dispatches/dispatch%201/stop", expect.objectContaining({ method: "POST" }));
  });

  it("archives a dispatch-only conversation through its dispatch id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({
      id: "dispatch-1", status: "launched", archivedAt: "2026-09-21T09:26:00.000Z",
    }));
    vi.stubGlobal("fetch", fetchMock);

    await api.setDispatchArchived("dispatch 1", true);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/dispatches/dispatch%201/archive", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ archived: true }),
    }));
  });
});

describe("machine nickname API", () => {
  const nodeResponse = () => new Response(JSON.stringify({ id: "node 1", name: "Mac mini", deviceName: "Mac mini" }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  it("sets a nickname through the nickname field, not the old name field", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(nodeResponse());
    vi.stubGlobal("fetch", fetchMock);

    await api.setNodeNickname("node 1", "Studio");

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/nodes/node%201", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ nickname: "Studio" }),
    }));
  });

  it("clears it by sending null", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(nodeResponse());
    vi.stubGlobal("fetch", fetchMock);

    await api.setNodeNickname("node 1", null);

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({ nickname: null }));
  });

  it("surfaces the server's refusal as its title", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      code: "invalid_input",
      title: "Nickname must be 40 characters or fewer.",
    }), { status: 400, headers: { "content-type": "application/problem+json" } })));

    await expect(api.setNodeNickname("node 1", "x")).rejects.toMatchObject({
      status: 400,
      message: "Nickname must be 40 characters or fewer.",
    });
  });
});

describe("setProductAccounts", () => {
  const accessResponse = () => new Response(JSON.stringify({ accounts: [] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  it("sends entries named by id", async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(accessResponse());
    vi.stubGlobal("fetch", fetchMock);

    await api.setProductAccounts("product 1", [
      { accountId: "account-1", canView: true, canOperate: false, canUseAi: false },
    ]);

    expect(fetchMock).toHaveBeenCalledWith("/api/v1/products/product%201/accounts", expect.objectContaining({
      method: "PUT",
      body: JSON.stringify({
        accounts: [{ accountId: "account-1", canView: true, canOperate: false, canUseAi: false }],
      }),
    }));
  });

  it("sends an entry named by email, which is how a creator adds someone", async () => {
    // A product's creator cannot list who has an account here, so the address it
    // typed has to reach the server as an address for the server to resolve.
    const fetchMock = vi.fn().mockResolvedValueOnce(accessResponse());
    vi.stubGlobal("fetch", fetchMock);

    await api.setProductAccounts("product-1", [
      { email: "member@example.com", canView: true, canOperate: false, canUseAi: false },
    ]);

    expect(fetchMock.mock.calls[0]?.[1]?.body).toBe(JSON.stringify({
      accounts: [{ email: "member@example.com", canView: true, canOperate: false, canUseAi: false }],
    }));
  });

  it("surfaces a refused grant with the server's message", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      code: "own_access_unchangeable",
      title: "You cannot change your own access to a product you created. Ask an administrator.",
    }), { status: 403, headers: { "content-type": "application/problem+json" } })));

    await expect(api.setProductAccounts("product-1", [
      { accountId: "account-1", canView: false, canOperate: false, canUseAi: false },
    ])).rejects.toMatchObject({ status: 403, code: "own_access_unchangeable" });
  });
});
