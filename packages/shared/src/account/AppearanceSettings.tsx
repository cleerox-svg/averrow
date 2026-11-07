// Appearance page (facelift P3-5, `/settings/appearance`, tenant
// `/account/appearance`): accent colour and dark-mode background.
//
// Light / dark / system stays where it is, in Profile (ProfileSettings), next
// to the time zone. This page only owns the two facelift axes.
//
// Host-agnostic: no router, no api module. The host passes an api client (only
// `patch`). Mount it inside a <ToastProvider> (failures report via useToast).
// Hidden until APPEARANCE_PICKER_ENABLED (theme/appearanceDefaults.ts): the
// section list leaves it out and hosts redirect its route to Profile.
//
// Persistence contract (account-synced, like theme_preference):
//   PATCH /api/profile { accent_preference } — 'indigo'|'violet'|'mono'|'lime'; null = default
//   PATCH /api/profile { base_preference }   — 'graphite'|'navy'; null = default
//
// Save semantics: a choice applies instantly (useAppearance writes the <html>
// attribute + localStorage, the no-flash cache), then saves to the account
// through pickAccent / pickBase, which serialize the PATCHes per field (one in
// flight; afterwards only the latest pick is sent). A failed save that no newer
// pick supersedes reverts to the last SERVER-CONFIRMED value and toasts. A
// successful save does not refetch the session user: the account hydrates once
// per session (theme/accountSync), on the next load.

import type { AccountApiClient } from './api-types';
import { SegmentedControl, type SegmentedOption } from '../ui/forms';
import { useToast } from '../ui/overlays';
import { SettingsGroup, SettingsRow, useMediaQuery } from '../ui/settings';
import {
  useAppearance, isAccent, isBase, pickAccent, pickBase, type Accent, type Base,
} from '../theme/useAppearance';
import { useAppearanceVersion } from '../theme/tokenReader';
import { ACCENTS, BASES, DEFAULT_ACCENT, DEFAULT_BASE } from '../theme/appearanceDefaults';
import { LayersIcon, PaletteIcon } from './section-icons';

export interface AppearanceSettingsProps {
  apiClient: Pick<AccountApiClient, 'patch'>;
}

/** Swatch colours: each accent's dark-mode `--primary`, and each base's dark
 *  `--bg-page`, from the generated appearance.css (a test pins them). They are
 *  previews of OTHER palettes, so they cannot be read from the live tokens. */
export const ACCENT_SWATCHES: Record<Accent, string> = {
  indigo: '#4c5cf8',
  violet: '#8f43f8',
  mono:   '#f4f5f7',
  lime:   '#a0f814',
};
export const BASE_SWATCHES: Record<Base, string> = {
  graphite: '#0a0b0e',
  navy:     '#040915',
};
/** Each base's dark `--bg-card` (indigo palette; a test pins them): the inner
 *  chip of the background swatch, so the two bases read apart on a dark card. */
export const BASE_CARD_SWATCHES: Record<Base, string> = {
  graphite: '#151619',
  navy:     '#0c1423',
};
/** Swatch outline: mid grey, >= 3:1 against both a dark card (#151619, ~4.5:1)
 *  and a light one (#ffffff, ~4:1), so near-black swatches keep a visible edge. */
export const SWATCH_OUTLINE = '#7c8089';

const ACCENT_LABELS: Record<Accent, string> = { indigo: 'Indigo', violet: 'Violet', mono: 'Mono', lime: 'Lime' };
const BASE_LABELS: Record<Base, string> = { graphite: 'Graphite', navy: 'Navy' };

function Swatch({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="inline-block h-4 w-4 rounded-full border border-[var(--border-strong)]"
      style={{ background: color }}
    />
  );
}

/** Background preview: the page colour with a card-colour chip inside it. */
function BaseSwatch({ base }: { base: Base }) {
  return (
    <span
      aria-hidden="true"
      data-swatch={base}
      className="relative inline-block h-4 w-5 rounded-[4px] border"
      style={{ background: BASE_SWATCHES[base], borderColor: SWATCH_OUTLINE }}
    >
      <span
        data-swatch-card
        className="absolute rounded-[2px]"
        style={{ inset: '3px 3px 3px 6px', background: BASE_CARD_SWATCHES[base] }}
      />
    </span>
  );
}

const ACCENT_OPTIONS: SegmentedOption[] = ACCENTS.map((a) => ({
  value: a, label: ACCENT_LABELS[a], icon: <Swatch color={ACCENT_SWATCHES[a]} />,
}));
const BASE_OPTIONS: SegmentedOption[] = BASES.map((b) => ({
  value: b, label: BASE_LABELS[b], icon: <BaseSwatch base={b} />,
}));

const SAVE_FAILED = "Couldn't save your appearance. Check your connection and try again.";

export function AppearanceSettings({ apiClient }: AppearanceSettingsProps) {
  const toast = useToast();
  const { accent, base, setAccent, setBase } = useAppearance();
  // Re-render on data-theme changes (the background only applies in dark mode).
  useAppearanceVersion();
  const isLight = typeof document !== 'undefined'
    && document.documentElement.getAttribute('data-theme') === 'light';
  const narrow = useMediaQuery('(max-width: 479px)', false);

  // What the controls show: the stored choice, else the default it falls back to.
  // Before the P3-6 flip both defaults are null; the indigo / graphite segment
  // then reads as selected, which is what the CSS renders once an accent is set.
  const shownAccent: Accent = accent ?? DEFAULT_ACCENT ?? 'indigo';
  const shownBase: Base = base ?? DEFAULT_BASE ?? 'graphite';

  const saveField = (field: 'accent_preference' | 'base_preference') => async (value: string | null) => {
    try {
      const res = await apiClient.patch('/api/profile', { [field]: value });
      return !!res.success;
    } catch {
      return false;
    }
  };
  const onFailed = () => { toast.error(SAVE_FAILED); };

  const changeAccent = (value: string) => {
    if (!isAccent(value) || value === accent) return;
    void pickAccent(value, saveField('accent_preference'), onFailed);
  };

  const changeBase = (value: string) => {
    if (!isBase(value) || value === base) return;
    void pickBase(value, saveField('base_preference'), onFailed);
  };

  return (
    <div>
      <SettingsGroup
        title="Appearance"
        footer="Saved to your account, so it follows you to every device. Light or dark mode is in Profile."
      >
        <SettingsRow
          icon={<PaletteIcon />}
          tone="cyan"
          title="Accent"
          description="The color of buttons, links and highlights."
          stackTrailing
          trailing={(
            <SegmentedControl
              aria-label="Accent"
              options={ACCENT_OPTIONS}
              value={shownAccent}
              fullWidth={narrow}
              onValueChange={changeAccent}
            />
          )}
        />
        <SettingsRow
          icon={<LayersIcon />}
          tone="cyan"
          title="Background"
          description="The base the dark theme is built on."
          disabled={isLight}
          disabledReason="Backgrounds apply in dark mode. Switch to dark in Profile to change it."
          stackTrailing
          trailing={(
            <SegmentedControl
              aria-label="Background"
              options={BASE_OPTIONS}
              value={shownBase}
              disabled={isLight}
              fullWidth={narrow}
              onValueChange={changeBase}
            />
          )}
        />
      </SettingsGroup>
    </div>
  );
}
