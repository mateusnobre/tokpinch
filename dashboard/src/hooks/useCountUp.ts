import { useEffect, useRef, useState } from "react";

export function useCountUp(target: number, duration = 800): number {
  const [value, setValue] = useState(0);
  const prevRef = useRef(0);
  const rafRef  = useRef<number | null>(null);

  useEffect(() => {
    const start = prevRef.current;
    const diff  = target - start;
    if (Math.abs(diff) < 0.0001) return;

    const startTime = performance.now();

    const tick = (now: number) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      // Ease out cubic
      const eased = 1 - Math.pow(1 - progress, 3);
      const current = start + diff * eased;
      setValue(current);
      if (progress < 1) {
        rafRef.current = requestAnimationFrame(tick);
      } else {
        prevRef.current = target;
      }
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [target, duration]);

  return value;
}
