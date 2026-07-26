"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
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
   */
  trackRef: RefObject<TTrack | null>;
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
 * import { useVideoScrubber } from "@vv-motion/react";
 * 
 * export function ScrollScrubVideo() {
 *   const { videoRef, trackRef, progressRef } = useVideoScrubber<HTMLDivElement>({
 *     driver: "scroll",
 *     smooth: 10,       // Damping factor (higher = smoother, 0 = instant)
 *     mapping: "pin",   // Pin the video viewport while scrubbing
 *   });
 * 
 *   return (
 *     <div ref={trackRef} className="scroll-track" style={{ height: "300vh" }}>
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const trackRef = useRef<TTrack>(null);
  const progressRef = useRef(0);
  const scrubberRef = useRef<VideoScrubber | null>(null);

  // Latest user callback without re-creating the instance.
  const onProgressRef = useRef(options.onProgress);
  useEffect(() => {
    onProgressRef.current = options.onProgress;
  });

  const [initial] = useState(options);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const scrubber = new VideoScrubber(video, {
      ...initial,
      track: trackRef.current ?? undefined,
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
  }, [initial]);

  const { smooth, mapping, pointerAxis } = options;
  useEffect(() => {
    scrubberRef.current?.update({ smooth, mapping, pointerAxis });
  }, [smooth, mapping, pointerAxis]);

  return { videoRef, trackRef, progressRef, scrubberRef };
}
