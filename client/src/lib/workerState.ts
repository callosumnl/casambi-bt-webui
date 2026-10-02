/** Mirrors the server's `WorkerState`: the supervisor's view of the Python Bluetooth worker. */
export type WorkerState = { running: boolean; pid: number | null; busy: { command: string; forMs: number } | null; lastAnswerAt: string | null; restarts: number };

function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1_000));
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3_600) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3_600)} h`;
}

/** One readable sentence for the Admin notice, e.g. "Worker running (PID 812), busy with 'configure' for 47 s." */
export function describeWorkerState(state: WorkerState, now = Date.now()): string {
  const restarts = state.restarts === 0 ? "" : ` Restarted ${state.restarts} time${state.restarts === 1 ? "" : "s"} since the service started.`;
  if (!state.running) return `Worker not running.${restarts}`;
  const process = `Worker running${state.pid === null ? "" : ` (PID ${state.pid})`}`;
  const activity = state.busy ? `busy with '${state.busy.command}' for ${duration(state.busy.forMs)}` : "idle";
  const lastAnswer = state.lastAnswerAt ? ` Last answer ${duration(now - Date.parse(state.lastAnswerAt))} ago.` : " No answer yet.";
  return `${process}, ${activity}.${lastAnswer}${restarts}`;
}
