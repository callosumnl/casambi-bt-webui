import { t } from "./i18n";

/** Mirrors the server's `WorkerState`: the supervisor's view of the Python Bluetooth worker. */
export type WorkerState = { running: boolean; pid: number | null; busy: { command: string; forMs: number } | null; lastAnswerAt: string | null; restarts: number; bluetooth?: { commands: number; recent: number; lastMs: number; medianMs: number; p95Ms: number; maxMs: number; fastWrites?: boolean } | null };

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3_600)} h`;
}

/** One readable sentence for the Admin notice, e.g. "Worker running (PID 812), busy with 'configure' for 47 s." */
export function describeWorkerState(state: WorkerState, now = Date.now()): string {
  const restarts = state.restarts === 0 ? "" : ` ${state.restarts === 1 ? t("Restarted {count} time since the service started.", { count: state.restarts }) : t("Restarted {count} times since the service started.", { count: state.restarts })}`;
  if (!state.running) return `${t("Worker not running.")}${restarts}`;
  const process = state.pid === null ? t("Worker running") : t("Worker running (PID {pid})", { pid: state.pid });
  const activity = state.busy ? t("busy with '{command}' for {duration}", { command: state.busy.command, duration: duration(state.busy.forMs) }) : t("idle");
  const lastAnswer = ` ${state.lastAnswerAt ? t("Last answer {duration} ago.", { duration: duration(now - Date.parse(state.lastAnswerAt)) }) : t("No answer yet.")}`;
  const bluetooth = state.bluetooth;
  const times = bluetooth ? { count: bluetooth.recent, median: Math.round(bluetooth.medianMs), p95: Math.round(bluetooth.p95Ms), max: Math.round(bluetooth.maxMs) } : null;
  const timing = !times ? "" : ` ${bluetooth?.fastWrites
    ? t("Bluetooth send time over the last {count} light commands (fast writes): median {median} ms, 95% within {p95} ms, slowest {max} ms.", times)
    : t("Bluetooth send time over the last {count} light commands: median {median} ms, 95% within {p95} ms, slowest {max} ms.", times)}`;
  return `${t("{process}, {activity}.", { process, activity })}${lastAnswer}${timing}${restarts}`;
}
