// Quiet hours tab. The window is a multi-field form with an explicit Save
// (dirty state + Discard); the on/off switch autosaves (off clears the window).
// Everything is written to the v2 preferences — never the legacy quiet-hours
// fields. The time zone defaults to the user's profile zone.

import { useEffect, useRef, useState, type ReactElement } from 'react';
import {
  Button, Field, FieldError, HelpText, SettingsGroup, SettingsRow, Switch, TimeInput,
  TimezoneSelect, describeQuietWindow, formatTimeZoneLabel,
} from '../../ui';
import { MoonIcon, ShieldAlertIcon } from './icons';
import {
  DEFAULT_QUIET_END, DEFAULT_QUIET_START, hasQuietWindow, resolveQuietTimezone,
} from './helpers';
import { SavedMark } from './useAutosave';
import type { SectionCommon } from './ChannelsSection';
import type { NotificationSettingsProps } from './types';

type Props = SectionCommon & Pick<NotificationSettingsProps, 'prefs' | 'profileTimezone' | 'onUpdatePrefs' | 'onDirtyChange'>;

interface Draft {
  enabled: boolean;
  start: string;
  end: string;
  tz: string;
  critical: boolean;
}

function savedDraft(prefs: Props['prefs'], profileTimezone: string | null): Draft {
  const enabled = hasQuietWindow(prefs);
  return {
    enabled,
    start: enabled ? (prefs.quiet_hours_start as string) : DEFAULT_QUIET_START,
    end: enabled ? (prefs.quiet_hours_end as string) : DEFAULT_QUIET_END,
    tz: resolveQuietTimezone(prefs, profileTimezone),
    critical: prefs.critical_bypasses_quiet !== 0,
  };
}

const same = (a: Draft, b: Draft) =>
  a.enabled === b.enabled && a.start === b.start && a.end === b.end && a.tz === b.tz && a.critical === b.critical;

export function QuietHoursSection({ prefs, profileTimezone, autosave, online, onUpdatePrefs, onDirtyChange }: Props): ReactElement {
  const saved = savedDraft(prefs, profileTimezone);
  const [draft, setDraft] = useState<Draft>(saved);

  // Follow the server when it changes under a clean form (initial load, the
  // switch autosave, another tab). A form with unsaved edits is never clobbered.
  const prevSaved = useRef(saved);
  useEffect(() => {
    if (!same(prevSaved.current, saved)) {
      if (same(draft, prevSaved.current)) setDraft(saved);
      prevSaved.current = saved;
    }
  });

  const dirty = !same(draft, saved);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);
  const summary = draft.enabled ? describeQuietWindow(draft.start, draft.end) : null;
  const invalid = draft.enabled && (!draft.start || !draft.end || !summary);
  const saving = autosave.saving('quiet-save');

  const toggle = (next: boolean) => {
    if (next) {
      // Turning on only prepares the form; nothing is written until Save.
      setDraft({ ...saved, enabled: true });
      return;
    }
    if (!saved.enabled) { setDraft({ ...saved, enabled: false }); return; }
    setDraft((d) => ({ ...d, enabled: false }));
    void autosave.run('quiet-toggle', () => onUpdatePrefs({ quiet_hours_start: null, quiet_hours_end: null }))
      .then((ok) => { if (!ok) setDraft(saved); });
  };

  const save = () => {
    void autosave.run('quiet-save', () => onUpdatePrefs({
      quiet_hours_start: draft.start,
      quiet_hours_end: draft.end,
      quiet_hours_timezone: draft.tz,
      critical_bypasses_quiet: draft.critical ? 1 : 0,
    }, { optimistic: false }));
  };

  return (
    <div className="space-y-6">
      <SettingsGroup title="Quiet hours" footer="The in-app bell keeps updating while push is paused.">
        <SettingsRow
          variant="toggle"
          icon={<MoonIcon />}
          tone="blue"
          title="Quiet hours"
          description="Pause push notifications overnight."
          loading={autosave.saving('quiet-toggle')}
          error={autosave.error('quiet-toggle')}
          trailing={({ labelId, descriptionId, disabled }) => (
            <>
              <SavedMark show={autosave.entry('quiet-toggle')?.status === 'saved'} />
              <Switch
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                checked={draft.enabled}
                disabled={disabled || saving || !online}
                onCheckedChange={toggle}
              />
            </>
          )}
        />

        {draft.enabled && (
          <>
            <div className="grid gap-4 px-4 py-4 min-[640px]:grid-cols-2">
              <Field label="From">
                <TimeInput value={draft.start} onChange={(e) => setDraft((d) => ({ ...d, start: e.target.value }))} />
              </Field>
              <Field label="To">
                <TimeInput value={draft.end} onChange={(e) => setDraft((d) => ({ ...d, end: e.target.value }))} />
              </Field>
              <div className="min-[640px]:col-span-2">
                <Field label="Time zone">
                  <TimezoneSelect value={draft.tz} onChange={(tz) => setDraft((d) => ({ ...d, tz }))} />
                </Field>
              </div>
              <div className="min-[640px]:col-span-2">
                {invalid ? (
                  <FieldError>Choose a start and an end time that are different.</FieldError>
                ) : (
                  <HelpText aria-live="polite">
                    {summary} · {formatTimeZoneLabel(draft.tz)}
                  </HelpText>
                )}
              </div>
            </div>

            <SettingsRow
              variant="toggle"
              icon={<ShieldAlertIcon />}
              tone="red"
              title="Let critical alerts through"
              description="Critical alerts still reach you during quiet hours."
              trailing={({ labelId, descriptionId, disabled }) => (
                <Switch
                  aria-labelledby={labelId}
                  aria-describedby={descriptionId}
                  checked={draft.critical}
                  disabled={disabled || saving}
                  onCheckedChange={(critical) => setDraft((d) => ({ ...d, critical }))}
                />
              )}
            />
          </>
        )}
      </SettingsGroup>

      {draft.enabled && (
        <div className="flex flex-col gap-2 min-[640px]:flex-row min-[640px]:items-center min-[640px]:justify-end">
          {autosave.error('quiet-save') && (
            <FieldError className="min-[640px]:mr-auto">{autosave.error('quiet-save')}</FieldError>
          )}
          <SavedMark show={autosave.entry('quiet-save')?.status === 'saved'} />
          <Button
            variant="ghost"
            className="h-11 min-h-11"
            disabled={!dirty || saving}
            onClick={() => { setDraft(saved); autosave.clear('quiet-save'); }}
          >
            Discard
          </Button>
          <Button
            className="h-11 min-h-11"
            disabled={!dirty || invalid || saving || !online}
            onClick={save}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      )}
    </div>
  );
}
