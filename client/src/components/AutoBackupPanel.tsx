import { CalendarClock, Download, Play, PlugZap } from "lucide-react";
import { FormEvent, useEffect, useState } from "react";
import { HudFrame } from "@/components/HudFrame";
import { describeAutoBackup, formatSize, type AutoBackupInfo, type BackupFrequency } from "@/lib/autoBackup";
import { t } from "@/lib/i18n";
import { LocalApi } from "@/lib/localApi";

const WEEKDAYS = () => [t("Sunday"), t("Monday"), t("Tuesday"), t("Wednesday"), t("Thursday"), t("Friday"), t("Saturday")];

/**
 * Encrypted backups daily, weekly, monthly, or never; to the SD card and/or a WebDAV folder (NAS, Nextcloud), so a
 * broken SD card need not take the backups along.
 */
export function AutoBackupPanel({ api, onNotice }: { api: LocalApi; onNotice: (message: string) => void }) {
  const [info, setInfo] = useState<AutoBackupInfo | null>(null);
  const [form, setForm] = useState({ frequency: "off" as BackupFrequency, time: "03:30", weekday: "0", monthDay: "1", keep: "14", toLocal: true, toWebdav: false, passphrase: "", confirmation: "", webdavUrl: "", webdavUser: "", webdavPassword: "" });
  const [busy, setBusy] = useState<"save" | "run" | "test" | null>(null);
  const show = (next: AutoBackupInfo) => {
    setInfo(next);
    setForm({ frequency: next.frequency, time: next.time, weekday: String(next.weekday), monthDay: String(next.monthDay), keep: String(next.keep), toLocal: next.toLocal, toWebdav: next.toWebdav, passphrase: "", confirmation: "", webdavUrl: next.webdavUrl ?? "", webdavUser: next.webdavUser ?? "", webdavPassword: "" });
  };
  useEffect(() => { void api.request<AutoBackupInfo>("/admin/auto-backup").then(show).catch(error => onNotice(error instanceof Error ? error.message : t("Unable to load the automatic backup settings."))); }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    if (form.passphrase !== form.confirmation) { onNotice(t("The two passphrases differ.")); return; }
    setBusy("save");
    try {
      show(await api.request<AutoBackupInfo>("/admin/auto-backup", { method: "PUT", body: JSON.stringify({
        frequency: form.frequency, time: form.time, weekday: Number(form.weekday), monthDay: Number(form.monthDay), keep: Number(form.keep), toLocal: form.toLocal, toWebdav: form.toWebdav, webdavUrl: form.webdavUrl.trim() || null, webdavUser: form.webdavUser.trim() || null,
        ...(form.passphrase ? { passphrase: form.passphrase } : {}), ...(form.webdavPassword ? { webdavPassword: form.webdavPassword } : {}),
      }) }));
      onNotice(t("Automatic backup settings saved."));
    } catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to save the automatic backup settings.")); } finally { setBusy(null); }
  };
  const test = async () => {
    setBusy("test");
    try {
      const result = await api.request<{ ok: boolean; message: string }>("/admin/auto-backup/test", { method: "POST", body: JSON.stringify({ webdavUrl: form.webdavUrl.trim(), webdavUser: form.webdavUser.trim() || null, ...(form.webdavPassword ? { webdavPassword: form.webdavPassword } : {}) }) });
      onNotice(result.ok ? t("The WebDAV folder works.") : result.message);
    } catch (error) { onNotice(error instanceof Error ? error.message : t("Unable to test the WebDAV folder.")); } finally { setBusy(null); }
  };
  const runNow = async () => {
    setBusy("run");
    try {
      const result = await api.request<{ run: { ok: boolean; message: string }; status: AutoBackupInfo }>("/admin/auto-backup/run", { method: "POST" });
      setInfo(result.status);
      onNotice(result.run.ok ? t("Backup made.") : result.run.message);
    } catch (error) { onNotice(error instanceof Error ? error.message : t("The backup failed.")); } finally { setBusy(null); }
  };
  const download = async (name: string) => {
    try {
      // The backup file is JSON; its header stays in the same order, so it still opens after this round trip.
      const file = await api.request<object>(`/admin/auto-backup/files/${encodeURIComponent(name)}`);
      const link = document.createElement("a");
      link.href = URL.createObjectURL(new Blob([JSON.stringify(file)], { type: "application/json" }));
      link.download = name;
      link.click();
      URL.revokeObjectURL(link.href);
    } catch (error) { onNotice(error instanceof Error ? error.message : t("The download failed.")); }
  };

  return <HudFrame className="form-panel"><h3><CalendarClock /> {t("AUTOMATIC BACKUPS")}</h3>
    {!info && <p className="muted-copy">{t("Loading…")}</p>}
    {info && <>
      <p className="muted-copy">{t("An encrypted backup on a schedule, the same as a downloaded one. Keep it on the SD card, in a WebDAV folder (a NAS or Nextcloud) so a broken SD card does not take the backups along, or both.")}</p>
      <form onSubmit={event => void save(event)} className="admin-form">
        <div className="form-grid">
          <label>{t("HOW OFTEN")}<select value={form.frequency} onChange={event => setForm({ ...form, frequency: event.target.value as BackupFrequency })} disabled={busy !== null}>
            <option value="off">{t("Never (by hand only)")}</option>
            <option value="daily">{t("Every day")}</option>
            <option value="weekly">{t("Every week")}</option>
            <option value="monthly">{t("Every month")}</option>
          </select></label>
          {form.frequency === "weekly" && <label>{t("WEEKDAY")}<select value={form.weekday} onChange={event => setForm({ ...form, weekday: event.target.value })} disabled={busy !== null}>{WEEKDAYS().map((day, index) => <option key={day} value={index}>{day}</option>)}</select></label>}
          {form.frequency === "monthly" && <label>{t("ON DAY")}<input type="number" min={1} max={28} value={form.monthDay} onChange={event => setForm({ ...form, monthDay: event.target.value })} disabled={busy !== null} required /></label>}
          {form.frequency !== "off" && <label>{t("AT")}<input type="time" value={form.time} onChange={event => setForm({ ...form, time: event.target.value })} disabled={busy !== null} required /></label>}
          <label>{t("KEEP")}<input type="number" min={1} max={60} value={form.keep} onChange={event => setForm({ ...form, keep: event.target.value })} disabled={busy !== null} required /></label>
        </div>
        <fieldset className="admin-fieldset"><legend>{t("WHERE TO")}</legend>
          <label className="checkbox-row"><input type="checkbox" checked={form.toLocal} onChange={event => setForm({ ...form, toLocal: event.target.checked })} disabled={busy !== null} /> {t("SD CARD (ON THE PI)")}</label>
          <label className="checkbox-row"><input type="checkbox" checked={form.toWebdav} onChange={event => setForm({ ...form, toWebdav: event.target.checked })} disabled={busy !== null} /> {t("WEBDAV FOLDER (NAS, NEXTCLOUD)")}</label>
        </fieldset>
        <div className="form-grid">
          <label>{t("PASSPHRASE")}<input type="password" value={form.passphrase} minLength={10} onChange={event => setForm({ ...form, passphrase: event.target.value })} autoComplete="new-password" placeholder={info.hasPassphrase ? t("Stored securely") : t("At least 10 characters")} disabled={busy !== null} /></label>
          <label>{t("REPEAT PASSPHRASE")}<input type="password" value={form.confirmation} onChange={event => setForm({ ...form, confirmation: event.target.value })} autoComplete="new-password" disabled={busy !== null} /></label>
        </div>
        <p className="muted-copy">{t("You need this passphrase to restore a backup. Write it down: it cannot be recovered.")}</p>
        {form.toWebdav && <div className="admin-advanced">
          <label>{t("WEBDAV FOLDER")}<input value={form.webdavUrl} required onChange={event => setForm({ ...form, webdavUrl: event.target.value })} placeholder="https://nas.local:5006/backups/casambi" disabled={busy !== null} /></label>
          <div className="form-grid">
            <label>{t("USER NAME")}<input value={form.webdavUser} onChange={event => setForm({ ...form, webdavUser: event.target.value })} autoComplete="off" disabled={busy !== null} /></label>
            <label>{t("PASSWORD")}<input type="password" value={form.webdavPassword} onChange={event => setForm({ ...form, webdavPassword: event.target.value })} autoComplete="new-password" placeholder={info.hasWebdavPassword ? t("Stored securely") : ""} disabled={busy !== null} /></label>
          </div>
          <p className="muted-copy">{t("The folder must exist. Synology and QNAP offer WebDAV as a package; in Nextcloud, use the WebDAV address under Files → Settings, followed by a folder.")}</p>
          <button type="button" className="outline-button" disabled={busy !== null || !form.webdavUrl.trim()} onClick={() => void test()}><PlugZap /> {busy === "test" ? t("TESTING…") : t("TEST CONNECTION")}</button>
        </div>}
        <button className="neon-button" disabled={busy !== null}>{busy === "save" ? t("SAVING…") : t("SAVE")}</button>
      </form>
      <p role="status">{describeAutoBackup(info)}</p>
      <div className="button-pair"><button className="outline-button" disabled={busy !== null || !info.hasPassphrase || (!info.toLocal && !info.toWebdav)} onClick={() => void runNow()}><Play /> {busy === "run" ? t("MAKING A BACKUP…") : t("MAKE A BACKUP NOW")}</button></div>
      {info.files.length > 0 && <div className="matter-fabrics"><p className="muted-copy">{t("BACKUPS ON THE PI")}</p>
        {info.files.map(file => <div key={file.name} className="matter-fabric"><span>{new Date(file.createdAt).toLocaleString()} · {formatSize(file.size)}</span><button className="outline-button" onClick={() => void download(file.name)}><Download /> {t("DOWNLOAD")}</button></div>)}
      </div>}
    </>}
  </HudFrame>;
}
