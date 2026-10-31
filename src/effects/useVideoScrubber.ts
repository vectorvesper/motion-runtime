"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { createHybridRef } from "../react/hybrid-ref";
import {
  VideoScrubber,
  type VideoScrubberOptions,
} from "../core/video-scrubber/VideoScrubber";

export type UseVideoScrubberOptions = Omit<VideoScrubberOptions, "track">;

export interface UseVideoScrubberReturn<TTrack extends HTMLElement> {
  /** Ref to attach to the `<video>` element. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /**
   * Ref to attach to the element whose scroll geometry or pointer boundaries
   * drive the progress. Defaults to the video's parent element.
   */
  ref: RefObject<TTrack | null>;
  /**
   * Ref holding the smoothed progress, 0 to 1. Updated every frame without
   * re-rendering. Read it inside loop callbacks.
   */
  progressRef: RefObject<number>;
  /**
   * The `VideoScrubber` instance, null before mount. Exposes `set(progress)` and
   * `update(options)`.
   */
  scrubberRef: RefObject<VideoScrubber | null>;
}

/**
 * Maps scroll offset, pointer movement or manual input onto a `<video>`
 * timeline.
 *
 * Encode scrubbing videos with every frame as a keyframe. With a large keyframe
 * interval each seek makes the browser decode dozens of intermediate frames,
 * which stutters on scroll:
 *
 * ```bash
 * ffmpeg -i input.mp4 -g 1 -coder 0 -bf 0 -crf 20 -movflags +faststart output.mp4
 * ```
 *
 * ```tsx
 * import { useVideoScrubber } from "@vectorvesper/motion/react";
 *
 * export function ScrollScrubVideo() {
 *   const { videoRef, ref } = useVideoScrubber<HTMLDivElement>({
 *     driver: "scroll",
 *     speed: 10,        // How fast it catches up; 0 is instant
 *     mapping: "pin",   // Pin the video viewport while scrubbing
 *   });
 *
 *   return (
 *     <div ref={ref} className="scroll-track" style={{ height: "300vh" }}>
 *       <div className="sticky-container" style={{ position: "sticky", top: 0, height: "100vh" }}>
 *         <video ref={videoRef} src="/keyframe-dense-clip.mp4" muted playsInline />
 *       </div>
 *     </div>
 *   );
 * }
 * ```
 *
 * @param {UseVideoScrubberOptions} [options={}] Driver, smoothing and callbacks.
 * @returns {UseVideoScrubberReturn<TTrack>} The element refs and progress ref.
 */
export function useVideoScrubber<TTrack extends HTMLElement = HTMLDivElement>(
  options: UseVideoScrubberOptions = {},
): UseVideoScrubberReturn<TTrack> {
  // Hybrid refs, so the scrubber is built when the video arrives. A video
  // behind a hydration guard, a loading branch or `next/dynamic` has no element
  // on the first commit. The track is keyed too, so one arriving after the video
  // is still picked up. See hybrid-ref.ts.
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
