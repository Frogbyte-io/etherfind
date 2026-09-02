import { Emitter } from "../util/emitter.js";

/** Phases of the guided replug/discovery workflow. Rendered verbatim by the TUI. */
export type DiscoveryPhase =
  | "idle"
  | "waiting-for-disconnect"
  | "waiting-for-link"
  | "listening"
  | "device-found"
  | "configuring"
  | "verifying"
  | "connected"
  | "cleanup"
  | "done"
  | "error";

export type PhaseChangedEvent = {
  type: "phase-changed";
  from: DiscoveryPhase;
  to: DiscoveryPhase;
};

export type StateMachineEvent = PhaseChangedEvent;

export type StartOptions = {
  /** Skip the unplug/replug guidance and start listening immediately. */
  skipReplug?: boolean;
};

/**
 * Pure state machine for the discovery workflow. No I/O, no UI: the engine and
 * TUI only react to phase changes. Invalid transitions throw; callers (engine)
 * are expected to drive it correctly, and tests pin the valid graph.
 */
export class DiscoveryStateMachine {
  #phase: DiscoveryPhase = "idle";
  /** True while a temporary address created by this session is present. */
  #configActive = false;
  readonly #events = new Emitter<StateMachineEvent>();

  get phase(): DiscoveryPhase {
    return this.#phase;
  }

  get configActive(): boolean {
    return this.#configActive;
  }

  onEvent(listener: (event: StateMachineEvent) => void): () => void {
    return this.#events.subscribe(listener);
  }

  start(options: StartOptions = {}): void {
    if (this.#phase !== "idle" && this.#phase !== "error" && this.#phase !== "done") {
      throw invalid("start", this.#phase);
    }
    this.#transition(options.skipReplug ? "listening" : "waiting-for-disconnect");
  }

  /** Physical link went down while waiting for the user to disconnect. */
  linkDown(): void {
    if (this.#phase === "waiting-for-disconnect") {
      this.#transition("waiting-for-link");
      return;
    }
    if (this.#phase === "waiting-for-link") {
      return; // Already waiting for link-up; duplicate notifications are fine.
    }
    throw invalid("linkDown", this.#phase);
  }

  linkUp(): void {
    if (this.#phase === "waiting-for-link") {
      this.#transition("listening");
      return;
    }
    if (
      this.#phase === "listening" ||
      this.#phase === "device-found" ||
      this.#phase === "verifying"
    ) {
      return; // Spurious or repeat notification.
    }
    throw invalid("linkUp", this.#phase);
  }

  /** User confirmed the cable is disconnected (manual skip of auto-detection). */
  confirmDisconnected(): void {
    if (this.#phase === "waiting-for-disconnect") {
      this.#transition("waiting-for-link");
      return;
    }
    throw invalid("confirmDisconnected", this.#phase);
  }

  skipReplug(): void {
    if (this.#phase === "waiting-for-disconnect" || this.#phase === "waiting-for-link") {
      this.#transition("listening");
      return;
    }
    throw invalid("skipReplug", this.#phase);
  }

  deviceFound(): void {
    if (this.#phase === "listening") {
      this.#transition("device-found");
      return;
    }
    throw invalid("deviceFound", this.#phase);
  }

  startConfigure(): void {
    if (this.#phase === "device-found") {
      this.#transition("configuring");
      return;
    }
    throw invalid("startConfigure", this.#phase);
  }

  configApplied(): void {
    if (this.#phase === "configuring") {
      this.#configActive = true;
      this.#transition("verifying");
      return;
    }
    throw invalid("configApplied", this.#phase);
  }

  configureFailed(): void {
    if (this.#phase === "configuring") {
      this.#transition("device-found");
      return;
    }
    throw invalid("configureFailed", this.#phase);
  }

  /** User declined modifying the interface. */
  configureDeclined(): void {
    if (this.#phase === "device-found") {
      this.#transition("connected");
      return;
    }
    throw invalid("configureDeclined", this.#phase);
  }

  startVerify(): void {
    if (this.#phase === "device-found") {
      this.#transition("verifying");
      return;
    }
    throw invalid("startVerify", this.#phase);
  }

  verificationSucceeded(): void {
    if (this.#phase === "verifying") {
      this.#transition("connected");
      return;
    }
    throw invalid("verificationSucceeded", this.#phase);
  }

  verificationFailed(): void {
    if (this.#phase === "verifying") {
      this.#transition("connected");
      return;
    }
    throw invalid("verificationFailed", this.#phase);
  }

  beginCleanup(): void {
    if (
      this.#phase === "connected" ||
      this.#phase === "error" ||
      this.#phase === "listening" ||
      this.#phase === "device-found" ||
      this.#phase === "verifying" ||
      this.#phase === "waiting-for-disconnect" ||
      this.#phase === "waiting-for-link" ||
      this.#phase === "configuring"
    ) {
      this.#transition("cleanup");
      return;
    }
    if (this.#phase === "cleanup" || this.#phase === "done") {
      return;
    }
    throw invalid("beginCleanup", this.#phase);
  }

  cleanupComplete(): void {
    if (this.#phase === "cleanup") {
      this.#transition("done");
      return;
    }
    if (this.#phase === "done") {
      return;
    }
    throw invalid("cleanupComplete", this.#phase);
  }

  restart(): void {
    if (this.#phase === "idle") {
      throw invalid("restart", this.#phase);
    }
    this.#configActive = false;
    this.#transition("waiting-for-disconnect");
  }

  fail(reason: string): void {
    if (this.#phase === "done" || this.#phase === "error") {
      return;
    }
    this.#failReason = reason;
    this.#transition("error");
  }

  #failReason?: string;

  get failReason(): string | undefined {
    return this.#failReason;
  }

  #transition(to: DiscoveryPhase): void {
    const from = this.#phase;
    this.#phase = to;
    this.#events.emit({ type: "phase-changed", from, to });
  }
}

function invalid(action: string, phase: DiscoveryPhase): Error {
  return new Error(`Invalid transition: ${action} in phase "${phase}"`);
}
