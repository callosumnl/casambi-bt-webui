/** Mirrors `GET /admin/server-settings`. */
export type ServerSettingsInfo = {
  supported: boolean;
  port: number;
  trustProxy: boolean;
  pending: boolean;
  status: { state?: string; message?: string; at?: string };
  readOnly: { nodeEnv: string | null; mockMode: boolean; databasePath: string | null; cachePath: string | null; pythonCommand: string | null; envFile: string };
};

/** Where the app answers after moving to `port`, on the host this page was opened with. */
export function addressOnPort(location: { protocol: string; hostname: string }, port: number): string {
  const host = location.hostname.includes(":") ? `[${location.hostname}]` : location.hostname;
  return `${location.protocol}//${host}:${port}/`;
}

/** The panel's line about the last change, or null when there is nothing to report. */
export function describeSettingsStatus(info: ServerSettingsInfo): string | null {
  if (!info.supported) return "Changing these from the app is set up by running deploy/install.sh once more on the Pi (cd /opt/casambi-bt-webui && git pull && ./deploy/install.sh).";
  if (info.pending) return "Applying the new settings…";
  return info.status.message ?? null;
}
