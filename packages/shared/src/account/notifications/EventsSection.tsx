// Events tab: toggle rows grouped by category with "Turn all on/off", plus the
// per-brand override list — shown to customers only (staff already see every
// brand, so an override list would be hundreds of "Normal" rows).

import { useMemo, useState, type ReactElement } from 'react';
import {
  Button, ConfirmDialog, Select, SettingsGroup, SettingsRow, Switch, type IconTileTone,
} from '../../ui';
import {
  AlertTriangleIcon, BellIcon, BuildingIcon, FileCheckIcon, FlagIcon, MailIcon, NewspaperIcon,
  PauseCircleIcon, RssIcon, ShieldAlertIcon, TrashIcon, TrendUpIcon,
} from './icons';
import { buildEventGroups, isEventOn, SUBSCRIPTION_LEVELS } from './helpers';
import { SavedMark, type Autosave } from './useAutosave';
import type { SectionCommon } from './ChannelsSection';
import type { NotificationSettingsProps, SubscriptionLevel } from './types';

type Props = SectionCommon & Pick<
  NotificationSettingsProps,
  'events' | 'subscriptions' | 'onUpdateEvents' | 'onSetBrandLevel' | 'onRemoveBrand'
> & { isStaff: boolean };

/** A glyph + tint per event, so a list of switches scans by shape and colour. */
const EVENT_VISUAL: Record<string, { icon: ReactElement; tone: IconTileTone }> = {
  brand_threat: { icon: <ShieldAlertIcon />, tone: 'red' },
  campaign_escalation: { icon: <TrendUpIcon />, tone: 'amber' },
  email_security_change: { icon: <MailIcon />, tone: 'blue' },
  takedown_awaiting_approval: { icon: <FileCheckIcon />, tone: 'amber' },
  intelligence_digest: { icon: <NewspaperIcon />, tone: 'violet' },
  feed_health: { icon: <RssIcon />, tone: 'green' },
  platform_feed_at_risk: { icon: <AlertTriangleIcon />, tone: 'amber' },
  platform_agent_stalled: { icon: <PauseCircleIcon />, tone: 'red' },
  agent_milestone: { icon: <FlagIcon />, tone: 'green' },
};
const FALLBACK_VISUAL = { icon: <BellIcon />, tone: 'blue' as IconTileTone };

export function EventsSection({
  events, subscriptions, isStaff, autosave, online, onUpdateEvents, onSetBrandLevel, onRemoveBrand,
}: Props): ReactElement {
  const groups = useMemo(() => buildEventGroups(isStaff), [isStaff]);

  return (
    <div className="space-y-6">
      {groups.map((group) => {
        const allOn = group.events.every((e) => isEventOn(events, e));
        const groupKey = `group:${group.id}`;
        return (
          <SettingsGroup
            key={group.id}
            title={group.title}
            headerAction={
              <Button
                variant="ghost"
                size="sm"
                className="ds-hbtn font-semibold text-[var(--amber-text,var(--amber))]"
                disabled={autosave.saving(groupKey) || !online}
                onClick={() => {
                  const next = !allOn;
                  const patch = Object.fromEntries(group.events.map((e) => [e.key, next]));
                  void autosave.run(groupKey, () => onUpdateEvents(patch));
                }}
              >
                {allOn ? 'Turn all off' : 'Turn all on'}
              </Button>
            }
          >
            {group.events.map((event) => {
              const key = `event:${event.key}`;
              const visual = EVENT_VISUAL[event.key] ?? FALLBACK_VISUAL;
              return (
                <SettingsRow
                  key={event.key}
                  variant="toggle"
                  icon={visual.icon}
                  tone={visual.tone}
                  title={event.title}
                  description={event.description}
                  fullDescription
                  loading={autosave.saving(key)}
                  error={autosave.error(key) ?? autosave.error(groupKey)}
                  trailing={({ labelId, descriptionId, disabled }) => (
                    <>
                      <SavedMark show={autosave.entry(key)?.status === 'saved'} />
                      <Switch
                        aria-labelledby={labelId}
                        aria-describedby={descriptionId}
                        checked={isEventOn(events, event)}
                        disabled={disabled || !online}
                        onCheckedChange={(next) => { void autosave.run(key, () => onUpdateEvents({ [event.key]: next })); }}
                      />
                    </>
                  )}
                />
              );
            })}
          </SettingsGroup>
        );
      })}

      {!isStaff && (
        <BrandOverrides
          subscriptions={subscriptions}
          autosave={autosave}
          online={online}
          onSetBrandLevel={onSetBrandLevel}
          onRemoveBrand={onRemoveBrand}
        />
      )}
    </div>
  );
}

function BrandOverrides({
  subscriptions, autosave, online, onSetBrandLevel, onRemoveBrand,
}: { autosave: Autosave; online: boolean } & Pick<NotificationSettingsProps, 'subscriptions' | 'onSetBrandLevel' | 'onRemoveBrand'>): ReactElement {
  const [removing, setRemoving] = useState<{ id: string; name: string } | null>(null);

  return (
    <>
      <SettingsGroup
        title="Brand overrides"
        footer="Follow a brand closely to get every alert for it, or mute it. Brands you add to monitoring appear here."
      >
        {subscriptions.length === 0 ? (
          <SettingsRow
            icon={<BuildingIcon />}
            tone="neutral"
            title="No brands yet"
            description="Brands you add to monitoring will show up here."
          />
        ) : subscriptions.map((s) => {
          const name = s.brand_name ?? 'Unnamed brand';
          const key = `brand:${s.brand_id}`;
          const level = SUBSCRIPTION_LEVELS.find((l) => l.value === s.level);
          return (
            <SettingsRow
              key={s.brand_id}
              icon={<BuildingIcon />}
              tone="blue"
              title={name}
              description={level?.description}
              stackTrailing
              loading={autosave.saving(key)}
              error={autosave.error(key)}
              trailing={({ labelId, disabled }) => (
                <>
                  <SavedMark show={autosave.entry(key)?.status === 'saved'} />
                  <Select
                    variant="inline"
                    aria-labelledby={labelId}
                    value={s.level}
                    disabled={disabled || !online}
                    onChange={(e) => {
                      const next = e.target.value as SubscriptionLevel;
                      void autosave.run(key, () => onSetBrandLevel(s.brand_id, next));
                    }}
                  >
                    {SUBSCRIPTION_LEVELS.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
                  </Select>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="ml-1 min-h-11 min-w-11"
                    aria-label={`Stop following ${name}`}
                    title="Stop following this brand"
                    disabled={disabled || !online}
                    onClick={() => setRemoving({ id: s.brand_id, name })}
                  >
                    <TrashIcon width={18} height={18} />
                  </Button>
                </>
              )}
            />
          );
        })}
      </SettingsGroup>

      <ConfirmDialog
        open={removing !== null}
        onOpenChange={(open) => { if (!open) setRemoving(null); }}
        title="Stop following this brand?"
        description={removing ? `You'll go back to your default alert level for ${removing.name}.` : undefined}
        consequence="Its alerts will follow the levels you set on the Channels tab."
        confirmLabel="Stop following this brand"
        tone="primary"
        errorMessage="Couldn't update this brand. Check your connection and try again."
        onConfirm={async () => { if (removing) await onRemoveBrand(removing.id); }}
      />
    </>
  );
}
