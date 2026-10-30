import { t } from "@/lib/i18n";

/** Mirrors `GET /admin/auto-backup`. */
export type BackupFrequency = "off" | "daily" | "weekly" | "monthly";
export type AutoBackupInfo = {
  frequency: BackupFrequency;
  time: string;
  weekday: number;
  monthDay: number;
  keep: number;
  toLocal: boolean;
  toWebdav: boolean;
  webdavUrl: string | null;
  webdavUser: string | null;
  hasPassphrase: boolean;
  hasWebdavPassword: boolean;
  lastRun: { at: string; ok: boolean; file: string | null; local: boolean; uploaded: boolean; message: string } | null;
  nextRun: string | null;
  files: Array<{ name: string; size: number; createdAt: string }>;
};

/** The panel's status line: the last run and the next one. */
export function describeAutoBackup(info: AutoBackupInfo, locale?: string): string {
  const when = (iso: string) => new Date(iso).toLocaleString(locale);
  const last = info.lastRun
    ? info.lastRun.ok
      ? info.lastRun.local
        ? info.lastRun.uploaded ? t("Last backup {time}: on the Pi and in the WebDAV folder.", { time: when(info.lastRun.at) }) : t("Last backup {time}: on the Pi.", { time: when(info.lastRun.at) })
        : t("Last backup {time}: in the WebDAV folder.", { time: when(info.lastRun.at) })
      : t("Last backup {time} failed: {message}", { time: when(info.lastRun.at), message: info.lastRun.message })
    : t("No automatic backup made yet.");
  if (info.frequency === "off") return `${last} ${t("Automatic backups are off.")}`;
  return info.nextRun ? `${last} ${t("Next one {time}.", { time: when(info.nextRun) })}` : last;
}

/** 1.2 MB, 340 kB. */
export function formatSize(bytes: number): string {
  return bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1000))} kB`;
}
