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
