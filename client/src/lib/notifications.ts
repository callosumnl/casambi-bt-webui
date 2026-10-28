/** Mirrors `GET /admin/notifications`. */
export type AppNotification = { id: number; kind: string; severity: "info" | "warning" | "error"; title: string; message: string; createdAt: string; readAt: string | null };
export type NotificationsInfo = { notifications: AppNotification[]; unread: number; webhook: { configured: boolean; host: string | null } };

/** Unread notifications newer than `lastSeenId`, oldest first, to show as toasts; none on the first load (`lastSeenId` null). */
export function freshNotifications(info: NotificationsInfo, lastSeenId: number | null): AppNotification[] {
  if (lastSeenId === null) return [];
  return info.notifications.filter(notification => notification.id > lastSeenId && !notification.readAt).reverse();
}

export function newestNotificationId(info: NotificationsInfo, previous: number | null): number {
  return Math.max(previous ?? 0, ...info.notifications.map(notification => notification.id));
}
