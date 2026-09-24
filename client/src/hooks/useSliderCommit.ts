import { ChangeEvent, useEffect, useMemo, useRef, useState } from "react";
import { SliderCommitter } from "@/lib/sliderCommit";

/**
 * Range-input props that show the thumb position locally while dragging and send
 * only after a pause or on release. `value` falls back to the confirmed state once
 * the interaction has settled; uncontrolled sliders can use `handlers` alone.
 */
export function useSliderCommit(confirmed: number, send: (value: number) => unknown, delayMs = 300) {
  const [draft, setDraft] = useState<number | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;
  const committer = useMemo(() => new SliderCommitter(value => sendRef.current(value), () => setDraft(null), delayMs), [delayMs]);
  useEffect(() => () => committer.dispose(), [committer]);
  const handlers = {
    onChange: (event: ChangeEvent<HTMLInputElement>) => { const value = Number(event.target.value); setDraft(value); committer.input(value); },
    // Listen on window: the pointer is often released outside the thin track.
    onPointerDown: () => {
      committer.press();
      const listeners = new AbortController();
      const release = () => { listeners.abort(); committer.release(); };
      window.addEventListener("pointerup", release, { signal: listeners.signal });
      window.addEventListener("pointercancel", release, { signal: listeners.signal });
    },
    onKeyUp: () => committer.release(),
  };
  return { value: draft ?? confirmed, adjusting: draft !== null, handlers };
}
