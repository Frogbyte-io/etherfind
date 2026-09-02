import { u16 } from "./ethernet.js";

export type UdpPacket = {
  srcPort: number;
  dstPort: number;
  payloadOffset: number;
  payloadLength: number;
};

const HEADER_BYTES = 8;

export function decodeUdp(buf: Uint8Array, offset = 0): UdpPacket | undefined {
  if (buf.length < offset + HEADER_BYTES) return undefined;
  const length = u16(buf, offset + 4);
  if (length < HEADER_BYTES) return undefined;
  return {
    srcPort: u16(buf, offset),
    dstPort: u16(buf, offset + 2),
    payloadOffset: offset + HEADER_BYTES,
    payloadLength: length - HEADER_BYTES,
  };
}
