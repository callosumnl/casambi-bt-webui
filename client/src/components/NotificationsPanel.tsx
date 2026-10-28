import { BellRing, CheckCheck, Send } from "lucide-react";
import { FormEvent, useEffect, useRef, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { t } from "@/lib/i18n";
import { LocalApi } from "@/lib/localApi";
import type { NotificationsInfo } from "@/lib/notifications";

/** Recent notifications, and the webhook that receives them too. */
export function NotificationsPanel({ api, onNotice }: { api: LocalApi; onNotice: (message: string) => void }) {
  const [info, setInfo] = useState<NotificationsInfo | null>(null);
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const load = async () => {
    try { setInfo(await api.request<NotificationsInfo>("/admin/notifications")); }
    catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to load the notifications.")); }
  };
  useEffect(() => { void load().then(() => { if (window.location.hash === "#notifications") frame.current?.scrollIntoView({ behavior: "smooth", block: "start" }); }); }, []);

  const markRead = async () => {
    try { await api.request("/admin/notifications/read", { method: "POST" }); window.dispatchEvent(new Event("notifications-changed")); await load(); }
    catch (error) { onNotice(error instanceof Error ? error.message : t("Marking the notifications read failed.")); }
  };
  const saveWebhook = async (event: FormEvent, next: string) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api.request("/admin/notifications/webhook", { method: "PUT", body: JSON.stringify({ url: next }) });
      setUrl(""); await load();
      onNotice(next ? t("Webhook saved. Use SEND TEST to check that it arrives.") : t("Webhook removed."));
    } catch (error) { onNotice(error instanceof Error ? error.message : t("Saving the webhook failed.")); } finally { setBusy(false); }
  };
  const test = async () => {
    setBusy(true);
    try { onNotice((await api.request<{ message: string }>("/admin/notifications/test", { method: "POST" })).message); }
    catch (error) { onNotice(error instanceof Error ? error.message : t("The test failed.")); } finally { setBusy(false); }
  };

  return <div id="notifications" ref={frame} className="notifications-anchor"><HudFrame className="form-panel notifications-panel"><h3><BellRing /> {t("NOTIFICATIONS")}</h3>
    <p className="muted-copy">{t("The Pi reports problems that need you: the Bluetooth connection down for 5 minutes, timers that fail or cannot run, and failed updates.")}</p>
    {info && (info.notifications.length === 0 ? <p className="muted-copy">{t("No notifications.")}</p> : <>
      <ul className="notification-list">{info.notifications.map(notification => <li key={notification.id} className={`${notification.severity} ${notification.readAt ? "read" : "unread"}`}>
        <strong>{notification.title}</strong><time dateTime={notification.createdAt}>{new Date(notification.createdAt).toLocaleString()}</time><p>{notification.message}</p>
      </li>)}</ul>
      {info.unread > 0 && <button type="button" className="outline-button" onClick={() => void markRead()}><CheckCheck /> {t("MARK ALL READ")}</button>}
    </>)}
    <form className="admin-form" onSubmit={event => void saveWebhook(event, url)}>
      <label>{t("WEBHOOK URL")}<input type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder={info?.webhook.configured ? t("Set ({host}); enter a new URL to replace it", { host: String(info.webhook.host) }) : "https://…"} autoComplete="off" /></label>
      <p className="muted-copy">{t("Optional. Each notification is POSTed there as JSON, for example to a Home Assistant webhook automation, ntfy, Slack, or n8n. The field")} <code>text</code> {t("holds the whole message.")}</p>
      <div className="button-pair">
        <button className="neon-button" disabled={busy || !url}>{t("SAVE WEBHOOK")}</button>
        {info?.webhook.configured && <button type="button" className="outline-button" disabled={busy} onClick={() => void test()}><Send /> {t("SEND TEST")}</button>}
        {info?.webhook.configured && <button type="button" className="outline-button danger" disabled={busy} onClick={event => void saveWebhook(event, "")}>{t("REMOVE")}</button>}
      </div>
    </form>
  </HudFrame></div>;
}
