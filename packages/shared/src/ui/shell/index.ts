// Shell modules shared by every product's top bar (account menu, search
// trigger, notification bell). Props-driven: no router, no icon library, no
// data layer. See AVERROW_UI_STANDARD.md "Shared kit".

export {
  AccountMenu,
  type AccountMenuProps, type AccountMenuLink, type AccountMenuAction, type AccountMenuRole, type AccountMenuTheme,
} from './AccountMenu';
export { SearchTrigger, type SearchTriggerProps } from './SearchTrigger';
export {
  NotificationBell,
  type NotificationBellProps, type NotificationBellFooterLink, type NotificationBellPanelContext,
  type ShellLinkRenderProps, type ShellRenderLink,
} from './NotificationBell';
export {
  NotificationRow, DayHeading, NotificationRowSkeletons,
  type NotificationRowProps, type ShellNotification, type SnoozeOption, type RowActions,
} from './NotificationRow';
export { groupByDay, dayLabel, type DayGroup } from './groupByDay';
export { parseUtc, relativeMagnitude, relativeTime, relativeTimeSigned, isFuture } from './time';
