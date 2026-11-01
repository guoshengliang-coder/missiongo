import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { TransitionAttachmentAttempt } from "./transition-attachments";
import type { WorkItem, WorkItemAttachment } from "./types";

const action = { to: "ready", reason: "verification_failed", label: "Needs more work" } as const;
const item = (attachments: WorkItemAttachment[] = []): WorkItem => ({
  id: "item", key: "TR-1", productId: "product", affectedComponentIds: [], type: "requirement", priority: "normal",
  status: "pending_verification", title: "Reason", description: "", diagnosticSummary: { logCount: 0, contextEntryCount: 0 },
  attachments, createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z",
});
afterEach(() => vi.restoreAllMocks());

describe("reason attachment retries", () => {
  it("keeps upload receipts after a partial failure and only writes once all files upload", async () => {
    const attempt = new TransitionAttachmentAttempt();
    const first = new File(["first"], "first.txt"), second = new File(["second"], "second.txt");
    const upload = vi.spyOn(api, "uploadAttachment").mockResolvedValueOnce({ id: "a" } as WorkItemAttachment)
      .mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce({ id: "b" } as WorkItemAttachment);
    const write = vi.spyOn(api, "transitionItem").mockResolvedValue(item());
    await expect(attempt.submit("TR-1", "pending_verification", action, "Reason", [first, second])).rejects.toThrow("offline");
    expect(write).not.toHaveBeenCalled();
    await attempt.submit("TR-1", "pending_verification", action, "Reason", [first, second]);
    expect(upload.mock.calls.map(call => call[1].name)).toEqual(["first.txt", "second.txt", "second.txt"]);
    expect(upload.mock.calls[1]?.[2]).toBe(upload.mock.calls[2]?.[2]);
    expect(write).toHaveBeenCalledWith("TR-1", action, "Reason", expect.objectContaining({ attachmentIds: ["a", "b"] }));
  });

  it("keeps the key and precondition after a lost response even if a background read observes the new state", async () => {
    const attempt = new TransitionAttachmentAttempt();
    const write = vi.spyOn(api, "transitionItem").mockRejectedValueOnce(new Error("lost response")).mockResolvedValue(item());
    await expect(attempt.submit("TR-1", "pending_verification", action, "Reason", [])).rejects.toThrow();
    await attempt.submit("TR-1", "ready", action, "Reason", []);
    expect(write.mock.calls[0]?.[3]).toEqual(write.mock.calls[1]?.[3]);
    await attempt.submit("TR-1", "ready", action, "Reason", []);
    expect(write).toHaveBeenCalledTimes(2); // A confirmed batch item is skipped.
  });

  it("accounts for successful partial uploads before and after a refreshed snapshot and after removing a file", async () => {
    const attempt = new TransitionAttachmentAttempt(), selected = new File(["x"], "evidence.txt");
    vi.spyOn(api, "uploadAttachment").mockResolvedValue({ id: "new" } as WorkItemAttachment);
    vi.spyOn(api, "transitionItem").mockRejectedValue(new Error("offline"));
    const originals = Array.from({ length: 9 }, (_, index) => ({ id: `old-${index}` } as WorkItemAttachment));
    await expect(attempt.submit("TR-1", "pending_verification", action, "Reason", [selected])).rejects.toThrow();
    expect(attempt.capacity([item(originals)], [selected])).toBe(1);
    expect(attempt.capacity([item([...originals, { id: "new" } as WorkItemAttachment])], [selected])).toBe(1);
    expect(attempt.capacity([item(originals)], [])).toBe(0);
  });
});
