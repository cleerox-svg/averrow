import { useEffect, useState } from 'react';

/** Live window height (px); follows rotation and the mobile URL-bar collapse. */
export function useViewportHeight(): number {
  const [h, setH] = useState(() => (typeof window !== 'undefined' ? window.innerHeight : 0));
  useEffect(() => {
    const on = () => setH(window.innerHeight);
    window.addEventListener('resize', on);
    return () => window.removeEventListener('resize', on);
  }, []);
  return h;
}
