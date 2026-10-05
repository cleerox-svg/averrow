// Summary tab (the digest, in plain language): how often brand activity is
// rolled up and what the roll-up includes. Realtime is kept as an explicit
// "send instantly" switch so the stored 'realtime' mode stays reachable.

import type { ReactElement } from 'react';
import { SegmentedControl, Select, SettingsGroup, SettingsRow, Switch } from '../../ui';
import { ClockIcon, LayersIcon, SendIcon } from './icons';
import { DIGEST_FLOOR_OPTIONS, DIGEST_SEGMENTS } from './helpers';
import { SavedMark } from './useAutosave';
import type { SectionCommon } from './ChannelsSection';
import type { DigestMode, DigestSeverityFloor, NotificationSettingsProps } from './types';

type Props = SectionCommon & Pick<NotificationSettingsProps, 'prefs' | 'onUpdatePrefs'>;

export function DigestSection({ prefs, autosave, online, onUpdatePrefs }: Props): ReactElement {
  const mode = prefs.digest_mode;
  const instant = mode === 'realtime';
  const off = mode === 'off';
  const save = (key: string, patch: Partial<typeof prefs>) => { void autosave.run(key, () => onUpdatePrefs(patch)); };

  return (
    <div className="space-y-6">
      <SettingsGroup
        title="Brand activity summary"
        footer="A summary of new threats and takedowns for the brands you watch."
      >
        <SettingsRow
          variant="toggle"
          icon={<SendIcon />}
          tone="blue"
          title="Send updates instantly"
          description="Skip the summary and get each update as it happens."
          loading={autosave.saving('digest-instant')}
          error={autosave.error('digest-instant')}
          trailing={({ labelId, descriptionId, disabled }) => (
            <>
              <SavedMark show={autosave.entry('digest-instant')?.status === 'saved'} />
              <Switch
                aria-labelledby={labelId}
                aria-describedby={descriptionId}
                checked={instant}
                disabled={disabled || !online}
                onCheckedChange={(next) => save('digest-instant', { digest_mode: (next ? 'realtime' : 'daily') as DigestMode })}
              />
            </>
          )}
        />
        <SettingsRow
          icon={<ClockIcon />}
          tone="blue"
          title="How often"
          description="Get one summary on this schedule."
          disabled={instant}
          disabledReason="You're getting updates instantly. Turn that off to choose a schedule."
          stackTrailing
          loading={autosave.saving('digest-mode')}
          error={autosave.error('digest-mode')}
          trailing={({ labelId, disabled }) => (
            <>
              <SavedMark show={autosave.entry('digest-mode')?.status === 'saved'} />
              <SegmentedControl
                aria-labelledby={labelId}
                options={DIGEST_SEGMENTS.map((o) => ({ value: o.value, label: o.label }))}
                value={instant ? '' : mode}
                disabled={disabled || !online}
                onValueChange={(next) => save('digest-mode', { digest_mode: next as DigestMode })}
              />
            </>
          )}
        />
        <SettingsRow
          icon={<LayersIcon />}
          tone="blue"
          title="Include"
          description="Only alerts at this level or higher go in the summary."
          disabled={instant || off}
          disabledReason={instant
            ? "You're getting updates instantly, so there is no summary."
            : 'Choose a frequency to schedule summaries.'}
          stackTrailing
          loading={autosave.saving('digest-floor')}
          error={autosave.error('digest-floor')}
          trailing={({ labelId, disabled }) => (
            <>
              <SavedMark show={autosave.entry('digest-floor')?.status === 'saved'} />
              <Select
                variant="inline"
                aria-labelledby={labelId}
                value={prefs.digest_severity_floor}
                disabled={disabled || !online}
                onChange={(e) => save('digest-floor', { digest_severity_floor: e.target.value as DigestSeverityFloor })}
              >
                {DIGEST_FLOOR_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </Select>
            </>
          )}
        />
      </SettingsGroup>
    </div>
  );
}
