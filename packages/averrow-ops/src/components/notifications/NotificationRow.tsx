// One notification row, shared by the bell panel and the /notifications inbox.
// The row, day heading and skeletons are the shared kit's (also used by
// FarmTrack); this wrapper adds the ops pieces: the event-type label from the
// notification registry and the shared snooze durations (lib/snooze) so both
// surfaces offer identical choices.

import { NOTIFICATION_EVENTS } from '@averrow/shared';
import {
  NotificationRow as KitNotificationRow, DayHeading, NotificationRowSkeletons, type RowActions,
} from '@averrow/shared/ui';
import type { Notification } from '@/hooks/useNotifications';
import { SNOOZE_OPTIONS } from '@/lib/snooze';

export { DayHeading, NotificationRowSkeletons, type RowActions };

export function typeLabel(type: string): string {
  const def = NOTIFICATION_EVENTS.find((e) => e.key === type);
  return def?.label ?? type.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

export interface NotificationRowProps {
  notification: Notification;
  onActivate: () => void;
  onSnooze: (hours: number) => void;
  onDone: () => void;
  actions: RowActions;
  /** Show the event-type label under the body (inbox). */
  showType?: boolean;
  /** Show reason + recommended action lines (inbox). */
  showDetail?: boolean;
}

export function NotificationRow({
  notification, onActivate, onSnooze, onDone, actions, showType = false, showDetail = false,
}: NotificationRowProps) {
  return (
    <KitNotificationRow
      notification={notification}
      onActivate={onActivate}
      onSnooze={onSnooze}
      snoozeOptions={SNOOZE_OPTIONS}
      onDone={onDone}
      actions={actions}
      showType={showType}
      typeLabel={typeLabel(notification.type)}
      showDetail={showDetail}
    />
  );
}
