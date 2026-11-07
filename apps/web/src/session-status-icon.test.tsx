import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SessionStatusIcon } from "./agent-session-feedback.js";

const render = (status: Parameters<typeof SessionStatusIcon>[0]["status"]) => renderToStaticMarkup(<SessionStatusIcon status={status} />);

describe("session status icons", () => {
  it("gives a session waiting for a reply its own icon instead of the idle check (AND-448)", () => {
    expect(render("waiting")).toContain("agent-session-waiting");
    expect(render("waiting")).not.toBe(render("idle"));
  });

  it("keeps the running spinner and the idle check for their own states", () => {
    expect(render("active")).toContain("agent-session-running");
    expect(render("idle")).not.toContain("agent-session-waiting");
  });
});
