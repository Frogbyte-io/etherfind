export type CaptureLinkType = "ethernet" | "other";

export type CapturedFrame = {
  /** Raw link-layer frame bytes. */
  data: Uint8Array;
  /** Best-effort capture timestamp in epoch milliseconds. */
  timestampMs: number;
  linkType: CaptureLinkType;
};

export type CaptureErrorKind =
  /** Missing CAP_NET_RAW / sudo required (Linux). */
  | "no-permission"
  /** Npcap/wpcap.dll not installed (Windows). */
  | "npcap-missing"
  /** tcpdump/dumpcap binary not found. */
  | "tool-missing"
  /** Capture tool exited unexpectedly mid-session. */
  | "crashed"
  /** Anything else. */
  | "unknown";

export class CaptureError extends Error {
  readonly kind: CaptureErrorKind;
  /** Actionable next steps for the user, safe to display in the TUI. */
  readonly guidance: string;

  constructor(kind: CaptureErrorKind, message: string, guidance: string) {
    super(message);
    this.name = "CaptureError";
    this.kind = kind;
    this.guidance = guidance;
  }
}

/**
 * Source of raw link-layer frames. Implementations: tcpdump/dumpcap subprocess,
 * simulated driver, native libpcap binding. The rest of the core only sees
 * CapturedFrame, never processes or binaries.
 */
export interface PacketSource {
  /** Human-readable backend description for status display. */
  readonly descriptor: string;
  start(handlers: {
    onFrame: (frame: CapturedFrame) => void;
    onError: (error: CaptureError) => void;
  }): Promise<void>;
  stop(): Promise<void>;
}
