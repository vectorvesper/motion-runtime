/**
 * Every hook in this package that hands back a `ref`, called the documented
 * way. Must lint clean.
 *
 * The call-site rule is not specific to the hybrid ref: `useImageTrail`,
 * `useMagneticIntent`, `useNumberTicker` and `useVideoScrubber` return plain
 * `useRef` objects and break in exactly the same way if the ref is reached
 * through a member expression. Covering all of them here means a hook added
 * later with the same shape is checked by the same test.
 */
import { useImageTrail } from "../../effects/useImageTrail";
import { useMagneticIntent } from "../../effects/useMagneticIntent";
import { useNumberTicker } from "../../effects/useNumberTicker";
import { useVideoScrubber } from "../../effects/useVideoScrubber";

export function ImageTrail({ images }: { images: string[] }) {
  const { ref } = useImageTrail<HTMLDivElement>({ images });
  return <div ref={ref} />;
}

export function MagneticButton({ children }: { children: string }) {
  const { ref, active } = useMagneticIntent<HTMLButtonElement>();
  return (
    <button ref={ref} data-active={active ? "yes" : "no"}>
      {children}
    </button>
  );
}

export function Ticker({ value }: { value: number }) {
  const { ref } = useNumberTicker<HTMLSpanElement>(value);
  return <span ref={ref} />;
}

export function Scrubber({ src }: { src: string }) {
  const { ref, videoRef } = useVideoScrubber<HTMLDivElement>();
  return (
    <div ref={ref}>
      <video ref={videoRef} src={src} muted playsInline />
    </div>
  );
}
