// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * The scroll driver against a page whose layout moves. jsdom has no layout, so
 * the track's place in the page is supplied by hand.
 */

let raf: FrameRequestCallback | null = null;
let now = 0;

function crank(frames: number): void {
  for (let i = 0; i < frames; i++) {
    now += 16;
    const cb = raf;
    raf = null;
    cb?.(now);
  }
}

beforeEach(() => {
  raf = null;
  now = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    raf = cb;
    return 1;
  });
  vi.stubGlobal("cancelAnimationFrame", () => {});
  vi.spyOn(performance, "now").mockImplementation(() => now);
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: false, media: query, onchange: null,
    addEventListener: () => {}, removeEventListener: () => {},
    addListener: () => {}, removeListener: () => {}, dispatchEvent: () => false,
  }));
  vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(() => Promise.resolve());
  vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("VideoScrubber, scroll driver", () => {
  it("follows the track when content above it changes height", async () => {
    vi.resetModules();
    const { VideoScrubber } = await import("./VideoScrubber");

    const track = document.createElement("div");
    const video = document.createElement("video");
    track.appendChild(video);
    document.body.appendChild(track);

    // A 2400px pinned track that starts 1000px down the page.
    let trackTop = 1000;
    Object.defineProperty(track, "offsetTop", { get: () => trackTop, configurable: true });
    Object.defineProperty(track, "offsetHeight", { get: () => 2400, configurable: true });
    Object.defineProperty(track, "offsetParent", { get: () => null, configurable: true });

    let scrollY = 1000;
    Object.defineProperty(window, "scrollY", { get: () => scrollY, configurable: true });

    const scrubber = new VideoScrubber(video, { track, speed: 0, mapping: "pin" });
    crank(3);
    expect(scrubber.targetProgress).toBe(0);

    // An image above the track loads and pushes it 400px further down. Nothing
    // resized. The reader scrolls to the track's new top.
    trackTop = 1400;
    scrollY = 1400;
    crank(70); // past the one-second heartbeat
    expect(scrubber.targetProgress).toBe(0);

    scrubber.destroy();
    track.remove();
  });
});
