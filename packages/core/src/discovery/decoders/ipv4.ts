import { bytesToIpv4 } from "../../models/address.js";
import { u16 } from "./ethernet.js";

export const IPV4_PROTO_ICMP = 1;
export const IPV4_PROTO_TCP = 6;
export const IPV4_PROTO_UDP = 17;

export type Ipv4Packet = {
  srcIp: string;
  dstIp: string;
  protocol: number;
  payloadOffset: number;
};

const MIN_BYTES = 20;

export function decodeIpv4(buf: Uint8Array, offset = 0): Ipv4Packet | undefined {
  if (buf.length < offset + MIN_BYTES) return undefined;
  const first = buf[offset] ?? 0;
  if (first >> 4 !== 4) return undefined;
  const ihl = (first & 0x0f) * 4;
  if (ihl < MIN_BYTES) return undefined;
  if (buf.length < offset + ihl) return undefined;
  return {
    srcIp: bytesToIpv4(buf, offset + 12),
    dstIp: bytesToIpv4(buf, offset + 16),
    protocol: buf[offset + 9] ?? 0,
    payloadOffset: offset + ihl,
  };
}

export type Ipv6Packet = {
  srcIp: string;
  dstIp: string;
  nextHeader: number;
  payloadOffset: number;
};

const IPV6_HEADER_BYTES = 40;

/** Minimal IPv6 header decode, sufficient for neighbor discovery. */
export function decodeIpv6(buf: Uint8Array, offset = 0): Ipv6Packet | undefined {
  if (buf.length < offset + IPV6_HEADER_BYTES) return undefined;
  if ((buf[offset] ?? 0) >> 4 !== 6) return undefined;
  const parts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const hi = (buf[offset + 8 + i * 2] ?? 0).toString(16).padStart(2, "0");
    const lo = (buf[offset + 9 + i * 2] ?? 0).toString(16).padStart(2, "0");
    parts.push(`${hi}${lo}`);
  }
  // Compress the longest run of zero groups for a sane display form.
  const srcIp = compressIpv6(parts);
  const dstParts: string[] = [];
  for (let i = 0; i < 8; i++) {
    const hi = (buf[offset + 24 + i * 2] ?? 0).toString(16).padStart(2, "0");
    const lo = (buf[offset + 25 + i * 2] ?? 0).toString(16).padStart(2, "0");
    dstParts.push(`${hi}${lo}`);
  }
  return {
    srcIp,
    dstIp: compressIpv6(dstParts),
    nextHeader: buf[offset + 6] ?? 0,
    payloadOffset: offset + IPV6_HEADER_BYTES,
  };
}

function compressIpv6(groups: string[]): string {
  const zipped = groups.map((g) => {
    const stripped = g.replace(/^0+/, "");
    return stripped === "" ? "0" : stripped;
  });
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < zipped.length; i++) {
    if (zipped[i] === "0") {
      if (curStart < 0) curStart = i;
      curLen++;
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  if (bestLen < 2) return zipped.join(":");
  return `${zipped.slice(0, bestStart).join(":")}::${zipped.slice(bestStart + bestLen).join(":")}`;
}
