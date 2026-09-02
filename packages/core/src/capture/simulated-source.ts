import type { CapturedFrame, PacketSource } from "./packet-source.js";

/**
 * Scriptable in-process packet source. Used by `--simulate` dev mode and by
 * tests so the entire workflow/TUI can run without physical hardware.
 */
export class SimulatedPacketSource implements PacketSource {
  readonly descriptor: string;
  #handlers:
    | { onFrame: (frame: CapturedFrame) => void; onError: (error: Error) => void }
    | undefined;
  #running = false;

  constructor(descriptor = "simulated") {
    this.descriptor = descriptor;
  }

  async start(handlers: {
    onFrame: (frame: CapturedFrame) => void;
    onError: (error: Error) => void;
  }): Promise<void> {
    this.#handlers = handlers;
    this.#running = true;
  }

  async stop(): Promise<void> {
    this.#running = false;
    this.#handlers = undefined;
  }

  get isRunning(): boolean {
    return this.#running;
  }

  /** Injects a frame as if it arrived on the wire. */
  emit(data: Uint8Array, timestampMs = Date.now()): void {
    if (!this.#handlers) return;
    this.#handlers.onFrame({ data, timestampMs, linkType: "ethernet" });
  }

  /** Simulates a backend failure. */
  fail(message: string): void {
    this.#handlers?.onError(new Error(message));
  }
}
