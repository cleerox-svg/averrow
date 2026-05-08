import { useState, useEffect } from 'react';

export function useCountUp(target: number, duration = 1100): number {
  const [val, setVal] = useState(0);
  useEffect(() => {
    if (!Number.isFinite(target) || target === 0) {
      setVal(target);
      return;
    }
    let start: number | null = null;
    const step = (ts: number) => {
      if (start === null) start = ts;
      const p = Math.min((ts - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3);
      setVal(Math.round(ease * target));
      if (p < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }, [target, duration]);
  return val;
}
