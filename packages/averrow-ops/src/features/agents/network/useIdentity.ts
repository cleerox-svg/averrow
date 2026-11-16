// Identity colours as a hook: resolves the page tokens that anchor the colour
// maths (card background, text colour, primary, feed-group colours) and
// rebuilds when the appearance changes.

import { useMemo } from 'react';
import { useTokenColors, type Rgba } from '@averrow/shared/theme';
import type { Agent } from '@/hooks/useAgents';
import { buildIdentity, FEED_GROUP_TOKEN, type Identity, type RGB } from './colors';

const TOKENS = ['--bg-card', '--text-primary', '--primary', '--blue', '--green', '--violet'] as const;

// Used only where no stylesheet is loaded (tests); real pages resolve the tokens.
const FALLBACK: Record<string, RGB> = {
  '--bg-card': [21, 22, 25], '--text-primary': [246, 247, 247], '--primary': [76, 92, 248],
  '--blue': [10, 138, 181], '--green': [60, 184, 120], '--violet': [167, 139, 250],
};

const rgbOf = (colors: Record<string, Rgba | null>, name: string): RGB => {
  const c = colors[name];
  return c ? [c[0], c[1], c[2]] : FALLBACK[name]!;
};

export function useIdentity(byName: ReadonlyMap<string, Pick<Agent, 'color'>>): Identity {
  const { colors } = useTokenColors(TOKENS);
  return useMemo(() => {
    const feeds: Record<string, RGB> = {};
    for (const [gid, token] of Object.entries(FEED_GROUP_TOKEN)) feeds[gid] = rgbOf(colors, token);
    return buildIdentity({
      bg: rgbOf(colors, '--bg-card'),
      anchor: rgbOf(colors, '--text-primary'),
      primary: rgbOf(colors, '--primary'),
      feeds,
      agents: byName,
    });
  }, [colors, byName]);
}
