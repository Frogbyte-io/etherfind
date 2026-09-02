import { describe, expect, it } from "vitest";
import type { CapturedFrame } from "../packet-source.js";
import { CaptureStreamParser } from "./capture-stream-parser.js";
import { ClassicPcapParser } from "./classic-parser.js";
import { PcapngParser } from "./pcapng-parser.js";

function classicHeader(linkType: number, endian: "le" | "be"): Uint8Array {
  const h = new Uint8Array(24);
  const view = new DataView(h.buffer);
  view.setUint32(0, 0xa1b2c3d4, endian === "le");
  view.setUint16(4, 2, endian === "le");
  view.setUint16(6, 4, endian === "le");
  view.setUint32(20, linkType, endian === "le");
  return h;
}

function classicRecord(payload: Uint8Array, tsSec: number, endian: "le" | "be"): Uint8Array {
  const r = new Uint8Array(16 + payload.length);
  const view = new DataView(r.buffer);
  view.setUint32(0, tsSec, endian === "le");
  view.setUint32(4, 500, endian === "le");
  view.setUint32(8, payload.length, endian === "le");
  view.setUint32(12, payload.length, endian === "le");
  r.set(payload, 16);
  return r;
}

function pcapngBlock(type: number, body: Uint8Array, endian: "le" | "be"): Uint8Array {
  const total = 12 + body.length;
  const b = new Uint8Array(total);
  const view = new DataView(b.buffer);
  view.setUint32(0, type, endian === "le");
  view.setUint32(4, total, endian === "le");
  b.set(body, 8);
  view.setUint32(total - 4, total, endian === "le");
  return b;
}

describe("ClassicPcapParser", () => {
  it.each(["le", "be"] as const)("parses a %s-endian stream split across chunks", (endian) => {
    const frames: CapturedFrame[] = [];
    const parser = new ClassicPcapParser({ onFrame: (f) => frames.push(f) });
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    parser.push(classicHeader(1, endian));
    parser.push(classicRecord(payload, 1700000000, endian).slice(0, 10));
    parser.push(classicRecord(payload, 1700000000, endian).slice(10));
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ linkType: "ethernet", timestampMs: 1_700_000_000_000 });
    expect([...(frames[0]?.data ?? [])]).toEqual([...payload]);
  });

  it("rejects unknown magic", () => {
    const parser = new ClassicPcapParser({ onFrame: () => {} });
    const bad = new Uint8Array(24);
    bad[0] = 0x12;
    expect(() => parser.push(bad)).toThrow(/unknown magic/);
  });
});

describe("PcapngParser", () => {
  it("parses SHB + IDB + EPB including a chunk-split packet", () => {
    const frames: CapturedFrame[] = [];
    const parser = new PcapngParser({ onFrame: (f) => frames.push(f) });

    const shbBody = new Uint8Array(16); // bom + version + length + reserved
    new DataView(shbBody.buffer).setUint32(0, 0x1a2b3c4d, true);
    const idbBody = new Uint8Array(20);
    new DataView(idbBody.buffer).setUint16(0, 1, true); // DLT EN10MB
    new DataView(idbBody.buffer).setUint32(4, 65535, true);
    const payload = new Uint8Array([0xaa, 0xbb, 0xcc, 0xdd]);
    const epbBody = new Uint8Array(20 + payload.length); // no options, 4-aligned
    const v = new DataView(epbBody.buffer);
    v.setUint32(0, 0, true); // interface 0
    v.setUint32(4, 1, true); // ts high
    v.setUint32(8, 500000, true); // ts low -> 1.5s
    v.setUint32(12, payload.length, true);
    v.setUint32(16, payload.length, true);
    epbBody.set(payload, 20);

    parser.push(pcapngBlock(0x0a0d0d0a, shbBody, "le"));
    parser.push(pcapngBlock(0x00000001, idbBody, "le"));
    const epb = pcapngBlock(0x00000006, epbBody, "le");
    parser.push(epb.slice(0, 18));
    parser.push(epb.slice(18));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ linkType: "ethernet" });
    expect([...(frames[0]?.data ?? [])]).toEqual([...payload]);
    // ts = (1 * 2^32 + 500000) * 1e-3 ms
    expect(frames[0]?.timestampMs).toBe(Math.floor((2 ** 32 + 500000) * 1e-3));
  });

  it("skips simple packet blocks with unknown interfaces gracefully", () => {
    const frames: CapturedFrame[] = [];
    const parser = new PcapngParser({ onFrame: (f) => frames.push(f) });
    const shbBody = new Uint8Array(16);
    new DataView(shbBody.buffer).setUint32(0, 0x1a2b3c4d, true);
    parser.push(pcapngBlock(0x0a0d0d0a, shbBody, "le"));
    const spbBody = new Uint8Array(8);
    parser.push(pcapngBlock(0x00000003, spbBody, "le"));
    expect(frames).toHaveLength(1); // SPB emitted as interface 0
    expect(frames[0]?.linkType).toBe("other");
  });
});

describe("CaptureStreamParser", () => {
  it("routes to classic or pcapng automatically", () => {
    const frames: CapturedFrame[] = [];
    const p = new CaptureStreamParser((f) => frames.push(f));
    p.push(classicHeader(1, "le"));
    p.push(classicRecord(new Uint8Array([9, 9, 9]), 1, "le"));
    expect(frames).toHaveLength(1);
  });
});
