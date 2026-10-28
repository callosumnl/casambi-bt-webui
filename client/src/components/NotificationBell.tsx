import { Bell } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Link } from "wouter";
import { LocalApi } from "@/lib/localApi";
import { freshNotifications, newestNotificationId, type NotificationsInfo } from "@/lib/notifications";

const POLL_MS = 60_000;

/**
 * The unread count for administrators, on every page; new notifications also appear as a toast. It polls once a
 * minute (the Pi checks for problems once a minute too) instead of holding another event stream open.
 */
export function NotificationBell() {
  const api = useMemo(() => new LocalApi(), []);
  const [unread, setUnread] = useState(0);
  const lastSeen = useRef<number | null>(null);
  useEffect(() => {
    let stopped = false;
    const load = async () => {
      try {
        const info = await api.request<NotificationsInfo>("/admin/notifications");
        if (stopped) return;
        for (const notification of freshNotifications(info, lastSeen.current)) {
          (notification.severity === "info" ? toast : notification.severity === "warning" ? toast.warning : toast.error)(notification.title, { description: notification.message, id: `notification-${notification.id}` });
        }
        lastSeen.current = newestNotificationId(info, lastSeen.current);
        setUnread(info.unread);
      } catch { /* Shown again on the next poll. */ }
    };
    void load();
    const timer = window.setInterval(() => void load(), POLL_MS);
    // The Admin panel marks notifications read; it tells the bell so the count drops at once.
    const reload = () => void load();
    window.addEventListener("notifications-changed", reload);
    return () => { stopped = true; window.clearInterval(timer); window.removeEventListener("notifications-changed", reload); };
  }, [api]);
  const label = unread ? `${unread} unread notification${unread === 1 ? "" : "s"}` : "Notifications";
  return <Link href="/admin#notifications" className={`notification-bell ${unread ? "has-unread" : ""}`} aria-label={label} title={label}><Bell />{unread > 0 && <span>{unread > 99 ? "99+" : unread}</span>}</Link>;
}
