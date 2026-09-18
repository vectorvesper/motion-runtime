"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createHybridRef } from "../react/hybrid-ref";
import {
  VideoScrubber,
  type VideoScrubberOptions,
} from "../core/video-scrubber/VideoScrubber";

export type UseVideoScrubberOptions = Omit<VideoScrubberOptions, "track">;

export interface UseVideoScrubberReturn<TTrack extends HTMLElement> {
  /**
   * Ref to attach to the `<video>` element.
   */
  videoRef: RefObject<HTMLVideoElement | null>;
  /**
   * Ref to attach to the element whose scroll geometry or pointer boundaries drive the progress.
   * Defaults to the video's parent element if not specified.
   *
   * Named `ref` since 3.0. Every other effect hook hands back its primary
   * element as `ref`, and this was the one shape you could not guess from
   * having used another. The remaining three keep their `Ref` suffix because
   * they genuinely are refs: reading progress through a ref rather than state
   * is the same frame-accurate, no-re-render contract as usePointerIntent's
   * confidenceRef.
   */
  ref: RefObject<TTrack | null>;
  /**
   * Ref containing the smoothed progress (0 to 1). Updated frame-accurately in the background
   * WITHOUT triggering component re-renders. Read from this inside loop callbacks.
   */
  progressRef: RefObject<number>;
  /**
   * The core `VideoScrubber` controller instance (null before mount).
   * Exposes low-level methods like `set(progress)` and `update(options)`.
   */
  scrubberRef: RefObject<VideoScrubber | null>;
}

/**
 * A React hook that maps scroll offset, pointer movements, or manual inputs onto a `<video>` timeline
 * for fluid, high-performance scroll-driven and swipe-driven scrubbing.
 *
 * ### 🎬 Critical Video Encoding Requirement (Avoid Jank):
 * Standard mp4/webm videos only encode change-vectors between keyframes (P-frames/B-frames). 
 * If a video's keyframe interval is large, seeking backwards or forwards forces the browser to decode 
 * dozens of intermediate frames, causing severe scroll stuttering.
 * 
 * **You must encode your scrubbing videos with a keyframe distance of 1 (every frame is a keyframe / I-frame only).**
 * Use this FFmpeg command before uploading your asset:
 * ```bash
 * ffmpeg -i input.mp4 -g 1 -coder 0 -bf 0 -crf 20 -movflags +faststart output.mp4
 * ```
 *
 * ### 📚 Usage Example:
 * ```tsx
 * import { useVideoScrubber } from "@vectorvesper/motion/react";
 * 
 * export function ScrollScrubVideo() {
 *   const { videoRef, ref, progressRef } = useVideoScrubber<HTMLDivElement>({
 *     driver: "scroll",
 *     speed: 10,        // How fast it catches up; 0 is instant
 *     mapping: "pin",   // Pin the video viewport while scrubbing
 *   });
 * 
 *   return (
 *     <div ref={ref} className="scroll-track" style={{ height: "300vh" }}>
 *       <div className="sticky-container" style={{ position: "sticky", top: 0, height: "100vh" }}>
 *         <video ref={videoRef} src="/keyframe-dense-clip.mp4" muted playsInline />
 *         <div className="progress-indicator">
 *           Progress: {Math.round(progressRef.current * 100)}%
 *         </div>
 *       </div>
 *     </div>
 *   );
 * }
 * ```
 *
 * @param {UseVideoScrubberOptions} [options={}] Configuration options specifying drivers, smoothing, and progress callbacks.
 * @returns {UseVideoScrubberReturn<TTrack>} Object containing the element refs and progress status.
 */
export function useVideoScrubber<TTrack extends HTMLElement = HTMLDivElement>(
  options: UseVideoScrubberOptions = {},
): UseVideoScrubberReturn<TTrack> {
  // Hybrid refs, so the scrubber is built when the video arrives rather than
  // only on the first commit. A video behind a hydration guard, a loading
  // branch or `next/dynamic` has no element there yet; up to 4.1.0 the effect
  // bailed, nothing re-ran it, and it never scrubbed. The track is keyed too,
  // so one that arrives after the video is still picked up. See hybrid-ref.ts.
  const videoStore = useRef<HTMLVideoElement | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const trackStore = useRef<TTrack | null>(null);
  const [trackEl, setTrackEl] = useState<TTrack | null>(null);
  // The factory only wires deferred getters/setters onto a function; it never
  // reads the store during render. The compiler cannot see that through an
  // opaque call, so it assumes the worst.
  // eslint-disable-next-line react-hooks/refs
  const videoRef = useMemo(() => createHybridRef<HTMLVideoElement>(videoStore, setVideoEl), []);
  // eslint-disable-next-line react-hooks/refs
  const trackRef = useMemo(() => createHybridRef<TTrack>(trackStore, setTrackEl), []);
  const progressRef = useRef(0);
  const scrubberRef = useRef<VideoScrubber | null>(null);

  // Latest user callback without re-creating the instance.
  const onProgressRef = useRef(options.onProgress);
  useEffect(() => {
    onProgressRef.current = options.onProgress;
  });

  const [initial] = useState(options);

  useEffect(() => {
    // The state values say the nodes have arrived and are what re-run this;
    // the nodes themselves come from the stores.
    const video = videoStore.current;
    if (!videoEl || !video) return;
    const scrubber = new VideoScrubber(video, {
      ...initial,
      track: (trackEl && trackStore.current) || undefined,
      onProgress: (p, t) => {
        progressRef.current = p;
        onProgressRef.current?.(p, t);
      },
    });
    scrubberRef.current = scrubber;
    return () => {
      scrubber.destroy();
      scrubberRef.current = null;
    };
  }, [videoEl, trackEl, initial]);

  const { speed, mapping, pointerAxis } = options;
  useEffect(() => {
    scrubberRef.current?.update({ speed, mapping, pointerAxis });
  }, [speed, mapping, pointerAxis]);

  return { videoRef, ref: trackRef, progressRef, scrubberRef };
}
