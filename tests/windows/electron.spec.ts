import { _electron, expect, test } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("native shell starts its real worker with a sandboxed local bridge and no node credentials in the renderer", async () => {
  test.skip(process.platform !== "win32", "Requires Windows Electron and native DPAPI/ACL APIs");
  const root = await mkdtemp(join(tmpdir(), "mg-electron-"));
  const app = await _electron.launch({ args: [resolve("apps/windows/dist/app")], env: { ...process.env, MISSIONGO_DESKTOP_TEST_HOME: root } });
  try {
    const window = await app.firstWindow();
    await expect(window.getByRole("heading", { name: "连接服务器" })).toBeVisible({ timeout: 30_000 });
    const snapshot = await window.evaluate(async () => {
      const port = (window as unknown as { desktop: { request: (value: unknown) => Promise<unknown> } }).desktop;
      return { state: await port.request({ method: "snapshot" }), node: typeof (globalThis as Record<string, unknown>).require };
    });
    expect(snapshot.node).toBe("undefined"); expect(snapshot.state).toMatchObject({ registered: false, managedEnabled: false, preferences: { runtime: "native" } });
    expect(snapshot.state).not.toHaveProperty("token"); expect(snapshot.state).not.toHaveProperty("protectedToken");
    await expect(window.evaluate(async () => {
      const port = (window as unknown as { desktop: { request: (value: unknown) => Promise<unknown> } }).desktop;
      return port.request({ method: "readFile", path: "unavailable" });
    })).rejects.toThrow("不支持");
  } finally { await app.close(); await rm(root, { recursive: true, force: true }); }
});
