import type { LinkState } from "../models/interface.js";
import type { LinkMonitor, Unsubscribe } from "../models/interface.js";
import { Emitter } from "../util/emitter.js";

export type PollingLinkMonitorOptions = {
  interfaceName: string;
  /** Reads the current state; injected for tests. */
  readState: () => Promise<LinkState>;
  intervalMs?: number;
  /** Injectable timer factory (defaults to setInterval). */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

/** Link monitor that polls a state reader at a fixed interval. */
export class PollingLinkMonitor implements LinkMonitor {
  readonly interfaceName: string;
  readonly #readState: () => Promise<LinkState>;
  readonly #intervalMs: number;
  readonly #setTimer: (fn: () => void, ms: number) => unknown;
  readonly #clearTimer: (handle: unknown) => void;
  readonly #events = new Emitter<LinkState>();
  #state: LinkState = "unknown";
  #timer: unknown;
  #polling = false;

  constructor(options: PollingLinkMonitorOptions) {
    this.interfaceName = options.interfaceName;
    this.#readState = options.readState;
    this.#intervalMs = options.intervalMs ?? 250;
    this.#setTimer = options.setTimer ?? ((fn, ms) => setInterval(fn, ms));
    this.#clearTimer =
      options.clearTimer ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  }

  current(): LinkState {
    return this.#state;
  }

  subscribe(listener: (state: LinkState) => void): Unsubscribe {
    return this.#events.subscribe(listener);
  }

  /** Starts polling. Idempotent. */
  async start(): Promise<void> {
    if (this.#polling) return;
    this.#polling = true;
    await this.#poll();
    const handle = this.#setTimer(() => {
      void this.#poll();
    }, this.#intervalMs);
    this.#timer = handle;
  }

  async #poll(): Promise<void> {
    try {
      const state = await this.#readState();
      if (state !== this.#state) {
        this.#state = state;
        this.#events.emit(state);
      }
    } catch {
      // Transient read failures keep the previous state.
    }
  }

  dispose(): void {
    if (this.#timer !== undefined) this.#clearTimer(this.#timer);
    this.#timer = undefined;
    this.#polling = false;
    this.#events.clear();
  }
}
