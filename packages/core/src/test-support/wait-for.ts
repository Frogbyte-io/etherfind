/**
 * Test-only synchronization helpers.
 *
 * Fixed sleeps are races. On a loaded CI runner 30 ms was repeatedly not enough
 * for the engine to reach its next phase or for capture to start, which showed
 * up as three different intermittent failures: an injected frame silently
 * dropped (SimulatedPacketSource.emit() is a no-op before start() completes),
 * a phase assertion seeing "idle", and a run promise that never resolved.
 * Wait on the actual condition instead.
 */
export async function waitFor(
  predicate: () => boolean,
  describe: () => string,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${describe()}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Waits until the engine reports the given discovery phase. */
export const whenPhase = (engine: { phase: string }, phase: string): Promise<void> =>
  waitFor(
    () => engine.phase === phase,
    () => `phase ${phase} (now ${engine.phase})`,
  );

/** Waits until the packet source is actually capturing, so emit() is not lost. */
export const whenCapturing = (
  source: { isRunning: boolean },
  engine: { phase: string },
): Promise<void> =>
  waitFor(
    () => source.isRunning,
    () => `capture to start (phase=${engine.phase})`,
  );
