import { expect, it } from "vitest";
import { windowsEnvironmentValue } from "./launch.js";

it("resolves Win32 environment names in case-sensitive worker copies without changing values", () => {
  const env = { PROGRAMFILES: "C:\\Program Files", systemroot: "C:\\Windows", ProviderToken: "fixture-only" };
  expect(windowsEnvironmentValue(env, "ProgramFiles")).toBe(env.PROGRAMFILES);
  expect(windowsEnvironmentValue(env, "SystemRoot")).toBe(env.systemroot);
  expect(windowsEnvironmentValue(env, "absent")).toBeUndefined();
  expect(env.ProviderToken).toBe("fixture-only");
});
