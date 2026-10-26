/**
 * Reloads the page when the server starts serving a different build of the web app. Every event stream's
 * `connected` event carries the server's build ID; the first one seen is the build this page runs, and a
 * different one after a reconnect means the appliance was updated while the page stayed open.
 */
export function createBuildWatcher(reload: () => void) {
  let loaded: string | null | undefined;
  return (build: string | null | undefined) => {
    if (!build) return;
    if (loaded === undefined) loaded = build;
    else if (build !== loaded) reload();
  };
}

export const watchBuild = createBuildWatcher(() => window.location.reload());

/** Reads the build ID from a `connected` event. */
export function connectedBuild(event: MessageEvent): string | null {
  try { return (JSON.parse(event.data) as { build?: string | null }).build ?? null; } catch { return null; }
}
