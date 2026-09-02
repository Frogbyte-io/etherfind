import type { CapturedFrame } from "../packet-source.js";
import { ClassicPcapParser } from "./classic-parser.js";
import { PcapngParser } from "./pcapng-parser.js";

export { ClassicPcapParser } from "./classic-parser.js";
export { PcapngParser } from "./pcapng-parser.js";

/**
 * Auto-detecting capture-stream parser: accepts a stream that is either classic
 * pcap (tcpdump) or pcapng (dumpcap) and normalizes it into CapturedFrame.
 */
export class CaptureStreamParser {
  #classic: ClassicPcapParser | undefined;
  #pcapng: PcapngParser | undefined;
  #onFrame: (frame: CapturedFrame) => void;

  constructor(onFrame: (frame: CapturedFrame) => void) {
    this.#onFrame = onFrame;
  }

  push(chunk: Uint8Array): void {
    if (this.#classic === undefined && this.#pcapng === undefined) {
      if (chunk.length === 0) return;
      const first = chunk[0];
      if (first === 0x0a) {
        this.#pcapng = new PcapngParser({ onFrame: this.#onFrame });
      } else {
        this.#classic = new ClassicPcapParser({ onFrame: this.#onFrame });
      }
    }
    if (this.#classic) this.#classic.push(chunk);
    else this.#pcapng?.push(chunk);
  }
}
