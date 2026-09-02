import type { CapturedFrame } from "../packet-source.js";

const CLASSIC_HEADER_BYTES = 24;
const CLASSIC_RECORD_HEADER_BYTES = 16;

const MAGIC_A = 0xa1b2c3d4; // microsecond resolution
const MAGIC_B = 0xa1b23c4d; // nanosecond resolution

const DLT_EN10MB = 1;

type ByteOrder = "le" | "be";
type TimeUnit = "usec" | "nsec";

/**
 * Incremental parser for classic libpcap capture streams (the format written by
 * `tcpdump -w -`). Feed arbitrary chunks; complete frames are delivered to the
 * callback. No buffering library required.
 */
export class ClassicPcapParser {
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  #byteOrder: ByteOrder | undefined;
  #timeUnit: TimeUnit | undefined;
  #linkType: number | undefined;
  #onFrame: (frame: CapturedFrame) => void;
  #onLinkType?: (linkType: number) => void;

  constructor(handlers: {
    onFrame: (frame: CapturedFrame) => void;
    onLinkType?: (linkType: number) => void;
  }) {
    this.#onFrame = handlers.onFrame;
    this.#onLinkType = handlers.onLinkType;
  }

  push(chunk: Uint8Array): void {
    this.#buffer = concat(this.#buffer, chunk);
    this.#drain();
  }

  #u16(offset: number): number {
    const b = this.#buffer;
    if (this.#byteOrder === "be") return ((b[offset] ?? 0) << 8) | (b[offset + 1] ?? 0);
    return ((b[offset + 1] ?? 0) << 8) | (b[offset] ?? 0);
  }

  #u32(offset: number): number {
    const b = this.#buffer;
    if (this.#byteOrder === "be") {
      return (
        (((b[offset] ?? 0) << 24) |
          ((b[offset + 1] ?? 0) << 16) |
          ((b[offset + 2] ?? 0) << 8) |
          (b[offset + 3] ?? 0)) >>>
        0
      );
    }
    return (
      (((b[offset + 3] ?? 0) << 24) |
        ((b[offset + 2] ?? 0) << 16) |
        ((b[offset + 1] ?? 0) << 8) |
        (b[offset] ?? 0)) >>>
      0
    );
  }

  #drain(): void {
    // Global header
    if (this.#byteOrder === undefined) {
      if (this.#buffer.length < CLASSIC_HEADER_BYTES) return;
      // Interpret the magic in both byte orders; whichever matches determines
      // both endianness and time resolution.
      const leVal =
        ((this.#buffer[0] ?? 0) |
          ((this.#buffer[1] ?? 0) << 8) |
          ((this.#buffer[2] ?? 0) << 16) |
          ((this.#buffer[3] ?? 0) << 24)) >>>
        0;
      const beVal =
        (((this.#buffer[0] ?? 0) << 24) |
          ((this.#buffer[1] ?? 0) << 16) |
          ((this.#buffer[2] ?? 0) << 8) |
          (this.#buffer[3] ?? 0)) >>>
        0;
      if (leVal === MAGIC_A) {
        this.#byteOrder = "le";
        this.#timeUnit = "usec";
      } else if (beVal === MAGIC_A) {
        this.#byteOrder = "be";
        this.#timeUnit = "usec";
      } else if (leVal === MAGIC_B) {
        this.#byteOrder = "le";
        this.#timeUnit = "nsec";
      } else if (beVal === MAGIC_B) {
        this.#byteOrder = "be";
        this.#timeUnit = "nsec";
      } else {
        throw new Error("Not a classic pcap stream (unknown magic)");
      }
      this.#linkType = this.#u32(20);
      this.#onLinkType?.(this.#linkType);
      this.#buffer = this.#buffer.subarray(CLASSIC_HEADER_BYTES);
    }

    // Records
    for (;;) {
      if (this.#buffer.length < CLASSIC_RECORD_HEADER_BYTES) return;
      const inclLen = this.#u32(8);
      const total = CLASSIC_RECORD_HEADER_BYTES + inclLen;
      if (this.#buffer.length < total) return;
      const tsSec = this.#u32(0);
      const tsSub = this.#u32(4);
      const ms =
        tsSec * 1000 +
        (this.#timeUnit === "nsec" ? Math.floor(tsSub / 1e6) : Math.floor(tsSub / 1000));
      const data = this.#buffer.subarray(CLASSIC_RECORD_HEADER_BYTES, total);
      this.#onFrame({
        data: copyOf(data),
        timestampMs: ms,
        linkType: this.#linkType === DLT_EN10MB ? "ethernet" : "other",
      });
      this.#buffer = this.#buffer.subarray(total);
    }
  }
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  if (a.length === 0) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** subarray() shares memory with the growing internal buffer; copy before emitting. */
function copyOf(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  out.set(bytes);
  return out;
}
