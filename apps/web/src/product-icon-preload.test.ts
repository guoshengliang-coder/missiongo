import { afterEach, describe, expect, it, vi } from "vitest";
import { productIconPreloadUrls, ProductIconPreloader } from "./product-icon-preload";

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function controlled() {
  const calls: { url: string; signal: AbortSignal; finish: (success: boolean) => void }[] = [];
  const load = vi.fn((url: string, signal: AbortSignal) => new Promise<boolean>(finish => {
    calls.push({ url, signal, finish });
    signal.addEventListener("abort", () => finish(false), { once: true });
  }));
  return { calls, load, queue: new ProductIconPreloader(load) };
}

describe("project icon warming", () => {
  it("prioritizes the current visible icon, filters missing/archived icons and caps at eight", () => {
    const products = Array.from({ length: 20 }, (_, i) => ({ id: String(i), updatedAt: "v1", hasIcon: true }));
    const urls = productIconPreloadUrls([
      { id: "missing", updatedAt: "v1", hasIcon: false },
      { id: "archived", updatedAt: "v1", hasIcon: true, archivedAt: "then" }, ...products, products[0]!,
    ], "19");
    expect(urls).toHaveLength(8);
    expect(urls[0]).toBe("/api/v1/products/19/icon?v=v1");
    expect(urls.join(" ")).not.toMatch(/missing|archived/);
  });

  it("defers work, caps concurrency at two and deduplicates repeated updates", async () => {
    vi.useFakeTimers();
    const f = controlled();
    const urls = Array.from({ length: 12 }, (_, i) => `icon-${i}`);
    f.queue.update(urls); f.queue.update(urls);
    expect(f.load).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.calls.map(call => call.url)).toEqual(["icon-0", "icon-1"]);
    f.queue.update(urls);
    f.calls[0]!.finish(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.calls.map(call => call.url)).toEqual(["icon-0", "icon-1", "icon-2"]);
    for (let i = 1; i < 8; i++) { f.calls[i]!.finish(true); await vi.advanceTimersByTimeAsync(0); }
    expect(f.load).toHaveBeenCalledTimes(8);
    f.queue.update(urls);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.load).toHaveBeenCalledTimes(8);
    f.queue.dispose();
  });

  it("cancels removed versions and never starts removed pending work", async () => {
    vi.useFakeTimers();
    const f = controlled();
    f.queue.update(["old-a", "old-b", "old-pending"]);
    await vi.advanceTimersByTimeAsync(200);
    f.queue.update(["new-a"]);
    expect(f.calls.every(call => call.signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.calls.map(call => call.url)).toEqual(["old-a", "old-b", "new-a"]);
    // An aborted old result must not mark the new version as complete.
    f.calls[0]!.finish(true);
    expect(f.calls[2]!.signal.aborted).toBe(false);
    f.queue.dispose();
  });

  it("does not retry failed URLs in a loop, but permits a later snapshot to retry", async () => {
    vi.useFakeTimers();
    const f = controlled();
    f.queue.update(["bad"]);
    await vi.advanceTimersByTimeAsync(200);
    f.calls[0]!.finish(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(f.load).toHaveBeenCalledTimes(1);
    f.queue.update(["bad"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(f.load).toHaveBeenCalledTimes(2);
    f.queue.dispose();
  });

  it("disposes delayed StrictMode work before it starts and isolates account lifetimes", async () => {
    vi.useFakeTimers();
    const f = controlled();
    f.queue.update(["old-account"]);
    f.queue.dispose();
    await vi.advanceTimersByTimeAsync(200);
    expect(f.load).not.toHaveBeenCalled();
    const next = controlled();
    next.queue.update(["new-account", "pending", "never"]);
    await vi.advanceTimersByTimeAsync(200);
    next.queue.dispose();
    expect(next.calls.every(call => call.signal.aborted)).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(next.load).toHaveBeenCalledTimes(2);
  });

  it("handles loader rejection without blocking later icons", async () => {
    vi.useFakeTimers();
    const load = vi.fn().mockRejectedValue(new Error("offline"));
    const queue = new ProductIconPreloader(load);
    queue.update(["a", "b", "c"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(load).toHaveBeenCalledTimes(3);
    queue.dispose();
  });

  it("times out a stalled browser image and clears the request on cancellation", async () => {
    vi.useFakeTimers();
    const images: { src: string; removeAttribute: ReturnType<typeof vi.fn> }[] = [];
    class StalledImage {
      src = "";
      complete = false;
      naturalWidth = 0;
      onload = null;
      onerror = null;
      removeAttribute = vi.fn();
      constructor() { images.push(this); }
    }
    vi.stubGlobal("Image", StalledImage);
    const queue = new ProductIconPreloader();
    queue.update(["a", "b", "c"]);
    await vi.advanceTimersByTimeAsync(200);
    expect(images).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(8_000);
    expect(images).toHaveLength(3);
    expect(images[0]!.removeAttribute).toHaveBeenCalledWith("src");
    queue.dispose();
    expect(images[2]!.removeAttribute).toHaveBeenCalledWith("src");
  });
});
