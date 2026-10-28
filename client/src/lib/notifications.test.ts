import { describe, expect, it } from "vitest";
import { freshNotifications, newestNotificationId, type AppNotification, type NotificationsInfo } from "./notifications";

const note = (id: number, readAt: string | null = null): AppNotification => ({ id, kind: "timer.failed", severity: "warning", title: `#${id}`, message: "", createdAt: "", readAt });
const info = (notifications: AppNotification[]): NotificationsInfo => ({ notifications, unread: notifications.filter(n => !n.readAt).length, webhook: { configured: false, host: null } });

describe("notification toasts", () => {
  it("shows nothing on the first load, then only new unread ones, oldest first", () => {
    const first = info([note(3), note(2)]);
    expect(freshNotifications(first, null)).toEqual([]);
    const seen = newestNotificationId(first, null);
    expect(seen).toBe(3);
    expect(freshNotifications(info([note(6), note(5, "read"), note(4), note(3)]), seen).map(n => n.id)).toEqual([4, 6]);
    expect(newestNotificationId(info([]), seen)).toBe(3);
  });
});
