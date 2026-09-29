import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { DraftChatFile } from "./agent-chat-draft-file";
import { I18nProvider } from "./i18n";

Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: () => null,
    setItem: () => undefined,
  },
});

function render(node: ReactNode): string {
  return renderToStaticMarkup(<I18nProvider>{node}</I18nProvider>);
}

const CAMERA_NAME = "Screenshot_20260927_153343_com_tencent_mm_ChattingUI.png";

describe("a draft attachment chip", () => {
  it("draws a picture as a thumbnail with no file name (AND-243)", () => {
    const file = new File([new Uint8Array([1, 2, 3])], CAMERA_NAME, { type: "image/png" });
    const html = render(<DraftChatFile file={file} disabled={false} onRemove={() => undefined} />);
    expect(html).toContain("agent-chat-draft-file-media");
    expect(html).toContain("agent-chat-draft-file-preview");
    expect(html).not.toContain("agent-chat-draft-file-name");
    expect(html).not.toContain(">PNG<");
  });

  it("keeps the full name reachable on the tooltip and the remove label", () => {
    const file = new File([new Uint8Array([1])], CAMERA_NAME, { type: "image/png" });
    const html = render(<DraftChatFile file={file} disabled={false} onRemove={() => undefined} />);
    expect(html).toContain(`title="${CAMERA_NAME}"`);
    expect(html).toContain(`aria-label="移除 ${CAMERA_NAME}"`);
  });

  it("keeps the icon, the name and the extension for a document", () => {
    const file = new File(["log"], "missiongo-2026-09-28-node.log", { type: "text/plain" });
    const html = render(<DraftChatFile file={file} disabled={false} onRemove={() => undefined} />);
    expect(html).not.toContain("agent-chat-draft-file-media");
    expect(html).toContain("missiongo-2026-09-28-node.log");
    expect(html).toContain(">LOG<");
  });

  it("drops the remove button while the reply is being sent", () => {
    const file = new File(["log"], "node.log", { type: "text/plain" });
    const html = render(<DraftChatFile file={file} disabled />);
    expect(html).not.toContain("<button");
  });
});
