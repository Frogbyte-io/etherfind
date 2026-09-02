import type { CapturedFrame } from "../packet-source.js";

const BLOCK_SHB = 0x0a0d0d0a;
const BLOCK_IDB = 0x00000001;
const BLOCK_EPB = 0x00000006;
const BLOCK_SPB = 0x00000003;

const BYTE_ORDER_MAGIC = 0x1a2b3c4d;

const MIN_BLOCK_BYTES = 12;

type ByteOrder = "le" | "be";

/**
 * Incremental parser for pcapng streams (the default output of Wireshark's
 * `dumpcap -w -`). Supports Section Header, Interface Description, Enhanced
 * Packet and Simple Packet blocks across multiple sections/endian changes.
 */
export class PcapngParser {
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array(0);
  #byteOrder: ByteOrder = "le";
  #sectionStarted = false;
  /** interface id -> DLT */
  #interfaces = new Map<number, number>();
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
    if (this.#buffer.length === 0) {
      this.#buffer = chunk;
    } else {
      const merged = new Uint8Array(this.#buffer.length + chunk.length);
      merged.set(this.#buffer, 0);
      merged.set(chunk, this.#buffer.length);
      this.#buffer = merged;
    }
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
    for (;;) {
      if (this.#buffer.length < MIN_BLOCK_BYTES) return;
      const type = this.#u32(0);
      const totalLen = this.#u32(4);
      if (totalLen < MIN_BLOCK_BYTES || totalLen > this.#buffer.length) return; // incomplete
      const bodyStart = 8;
      const bodyEnd = totalLen - 4;

      if (type === BLOCK_SHB) {
        // Byte-order magic lives at body offset 0; determine section endianness.
        const bom = this.#u32(bodyStart);
        if (bom === BYTE_ORDER_MAGIC) {
          // Already matches current interpretation.
        } else {
          this.#byteOrder = this.#byteOrder === "le" ? "be" : "le";
        }
        this.#sectionStarted = true;
        this.#interfaces.clear();
      } else if (type === BLOCK_IDB && this.#sectionStarted) {
        const linkType = this.#u16(bodyStart);
        this.#interfaces.set(this.#interfaces.size, linkType);
        this.#onLinkType?.(linkType);
      } else if (type === BLOCK_EPB && this.#sectionStarted) {
        const interfaceId = this.#u32(bodyStart);
        const tsHigh = this.#u32(bodyStart + 4);
        const tsLow = this.#u32(bodyStart + 8);
        const capturedLen = this.#u32(bodyStart + 12);
        const dataStart = bodyStart + 20;
        if (dataStart + capturedLen > bodyEnd) return; // malformed; stop
        const raw = this.#buffer.subarray(dataStart, dataStart + capturedLen);
        this.#emit(interfaceId, tsHigh, tsLow, raw);
      } else if (type === BLOCK_SPB && this.#sectionStarted) {
        const originalLen = this.#u32(bodyStart);
        const capturedLen = Math.min(originalLen, bodyEnd - bodyStart - 4);
        const raw = this.#buffer.subarray(bodyStart + 4, bodyStart + 4 + capturedLen);
        this.#emit(0, 0, 0, raw);
      }

      this.#buffer = this.#buffer.subarray(totalLen);
    }
  }

  #emit(interfaceId: number, tsHigh: number, tsLow: number, raw: Uint8Array): void {
    const dlt = this.#interfaces.get(interfaceId);
    const ts64 = (tsHigh * 2 ** 32 + tsLow) * 1e-3; // if_tsresol default 1e-6 s -> ms
    const data = new Uint8Array(raw.length);
    data.set(raw);
    this.#onFrame({
      data,
      timestampMs: Math.floor(ts64),
      linkType: dlt === 1 ? "ethernet" : "other",
    });
  }
}
