import { describe, expect, it } from "vitest";

import { dragCarriesFiles, nextDragDepth } from "./file-drop";

describe("file drop", () => {
  it("only treats a drag carrying files as an attachment", () => {
    expect(dragCarriesFiles(["Files"])).toBe(true);
    expect(dragCarriesFiles(["text/plain", "Files"])).toBe(true);
    expect(dragCarriesFiles(["text/plain", "text/html"])).toBe(false);
    expect(dragCarriesFiles(["text/uri-list"])).toBe(false);
    expect(dragCarriesFiles([])).toBe(false);
    expect(dragCarriesFiles(undefined)).toBe(false);
  });

  it("stays dragging while moving between children and clears on leave or drop", () => {
    // Enter the form, then a child: the child's enter precedes the form's leave.
    let depth = nextDragDepth(0, "enter");
    depth = nextDragDepth(depth, "enter");
    depth = nextDragDepth(depth, "leave");
    expect(depth).toBeGreaterThan(0);
    depth = nextDragDepth(depth, "leave");
    expect(depth).toBe(0);

    expect(nextDragDepth(0, "leave")).toBe(0);
    expect(nextDragDepth(3, "drop")).toBe(0);
  });
});
