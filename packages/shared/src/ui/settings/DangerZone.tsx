// @averrow/shared/ui/settings — DangerZone (ACCOUNT_DESIGN_SPEC §4.9)
//
// A `SettingsGroup variant="danger"` (Card critical) of action rows. Row
// buttons are OUTLINE (red text/border for destructive, standard outline for the
// recommended safe action) — the solid red `Button variant="danger"` belongs
// only inside the confirm dialog the action opens, so no row triggers
// anything irreversible on its own. `onAction` should open a ConfirmDialog.

import type { ReactNode } from 'react';
import { Button } from '../Button';
import { cn } from '../cn';
import { SettingsGroup } from './SettingsGroup';
import { SettingsRow } from './SettingsRow';

export interface DangerZoneAction {
  id: string;
  title: ReactNode;
  description?: ReactNode;
  /** Button label. Repeat the verb: "Sign out everywhere", never "OK". */
  actionLabel: string;
  onAction: () => void;
  /** `danger` (default): red outline. `safe`: standard outline (the recommended, reversible action). */
  tone?: 'danger' | 'safe';
  loading?: boolean;
  disabled?: boolean;
  disabledReason?: ReactNode;
  error?: ReactNode;
}

export interface DangerZoneProps {
  /** Default "Danger zone"; Security uses a calmer "Sign out & reset". */
  title?: ReactNode;
  actions: DangerZoneAction[];
  footer?: ReactNode;
  className?: string;
}

const DANGER_BTN =
  'min-h-[44px] !border-[var(--sev-critical-border)] !text-[var(--sev-critical-text)] hover:!bg-[var(--sev-critical-bg)]';

export function DangerZone({ title = 'Danger zone', actions, footer, className }: DangerZoneProps) {
  return (
    <SettingsGroup variant="danger" title={title} footer={footer} className={className}>
      {actions.map((a) => (
        <SettingsRow
          key={a.id}
          title={a.title}
          description={a.description}
          loading={a.loading}
          disabled={a.disabled}
          disabledReason={a.disabledReason}
          error={a.error}
          stackTrailing
          trailing={
            <Button
              type="button"
              variant="outline"
              size="md"
              disabled={a.disabled || a.loading}
              onClick={a.onAction}
              className={cn('ds-fill min-h-[44px]', (a.tone ?? 'danger') === 'danger' && DANGER_BTN)}
              data-tone={a.tone ?? 'danger'}
            >
              {a.actionLabel}
            </Button>
          }
        />
      ))}
    </SettingsGroup>
  );
}
