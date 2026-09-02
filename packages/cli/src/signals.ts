/** Minimal shape needed for shutdown; keeps this testable without an engine. */
type Shutdownable = { shutdown(): Promise<void> };

const SHUTDOWN_SIGNALS: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"];

/**
 * Restores network configuration when the process is terminated.
 *
 * Etherfind registered no signal handlers at all, so Ctrl+C in `--json` mode
 * (where there is no Ink instance to intercept it), a closed terminal window,
 * or a SIGTERM killed the process outright and left the temporary address on
 * the interface — precisely the outcome the cleanup journal exists to prevent,
 * and which the README promises does not happen. Observed in practice: a stray
 * 192.168.68.254/24 survived a run and had to be removed with `--cleanup`.
 *
 * Returns a function that unregisters the handlers again.
 */
export function installShutdownSignals(
  engine: Shutdownable,
  exit: (code: number) => void = (code) => process.exit(code),
): () => void {
  let shuttingDown = false;
  const onSignal = (signal: NodeJS.Signals) => {
    // A second Ctrl+C must not start a competing restore.
    if (shuttingDown) return;
    shuttingDown = true;
    void engine
      .shutdown()
      .catch(() => {
        // Nothing better to do while dying; the journal still records the change
        // so `etherfind --cleanup` can finish the job.
      })
      .finally(() => exit(signal === "SIGINT" ? 130 : 143));
  };

  // Bind the signal per handler rather than reading the listener argument:
  // process.emit(signal) passes none, and the exit code should not depend on it.
  const installed: Array<[NodeJS.Signals, () => void]> = [];
  for (const signal of SHUTDOWN_SIGNALS) {
    const handler = () => onSignal(signal);
    try {
      process.on(signal, handler);
      installed.push([signal, handler]);
    } catch {
      // Not every signal exists on every platform (SIGBREAK is Windows-only).
    }
  }
  return () => {
    for (const [signal, handler] of installed) process.off(signal, handler);
  };
}
