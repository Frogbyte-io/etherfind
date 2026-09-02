import { bytesToIpv4 } from "../../models/address.js";
import { u16 } from "./ethernet.js";

export type DnsNameAndCursor = {
  name: string;
  cursor: number;
};

/**
 * Parses a (possibly compressed) DNS name starting at `offset`.
 * Returns the name joined by "." and the offset just past the name.
 */
export function parseDnsName(
  buf: Uint8Array,
  offset: number,
  depth = 0,
): DnsNameAndCursor | undefined {
  if (depth > 8) return undefined;
  const labels: string[] = [];
  let cursor = offset;
  let followedPointer = false;
  let endCursor = -1;
  for (;;) {
    const len = buf[cursor] ?? 0;
    if (len === 0) {
      cursor++;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const pointer = ((len & 0x3f) << 8) | (buf[cursor + 1] ?? 0);
      if (endCursor < 0) endCursor = cursor + 2;
      cursor = pointer;
      followedPointer = true;
      continue;
    }
    if ((len & 0xc0) !== 0 || len > 63) return undefined;
    const labelBytes = buf.subarray(cursor + 1, cursor + 1 + len);
    if (labelBytes.length < len) return undefined;
    labels.push(new TextDecoder().decode(labelBytes));
    cursor += 1 + len;
  }
  if (endCursor < 0) endCursor = cursor;
  if (!followedPointer && endCursor < 0) endCursor = cursor;
  return { name: labels.join("."), cursor: endCursor };
}

export type MdnsPacket = {
  /** hostname -> IPv4 from A records */
  aRecords: Array<{ name: string; ip: string }>;
  /** Other interesting names (PTR/SRV/AAAA owners). */
  names: string[];
};

const HEADER_BYTES = 12;
const TYPE_A = 1;
const TYPE_PTR = 12;
const TYPE_SRV = 33;
const TYPE_AAAA = 28;

/** Parses mDNS/DNS answer sections well enough to associate hostnames with A records. */
export function decodeMdns(buf: Uint8Array, offset = 0): MdnsPacket | undefined {
  if (buf.length < offset + HEADER_BYTES) return undefined;
  const qdcount = u16(buf, offset + 4);
  const ancount = u16(buf, offset + 6);
  const aRecords: MdnsPacket["aRecords"] = [];
  const names: string[] = [];
  let cursor = offset + HEADER_BYTES;

  for (let i = 0; i < qdcount; i++) {
    const q = parseDnsName(buf, cursor);
    if (!q) return undefined;
    cursor = q.cursor + 4; // qtype + qclass
    if (cursor > buf.length) return undefined;
  }

  for (let i = 0; i < ancount; i++) {
    const rr = parseDnsName(buf, cursor);
    if (!rr) break;
    cursor = rr.cursor;
    const type = u16(buf, cursor);
    const rdlength = u16(buf, cursor + 8);
    const rdata = cursor + 10;
    if (rdata + rdlength > buf.length) break;
    if (type === TYPE_A && rdlength === 4) {
      aRecords.push({ name: rr.name, ip: bytesToIpv4(buf, rdata) });
      names.push(rr.name);
    } else if (type === TYPE_PTR || type === TYPE_SRV || type === TYPE_AAAA) {
      names.push(rr.name);
      if (type === TYPE_SRV) {
        // SRV rdata: priority(2) weight(2) port(2) target
        const target = parseDnsName(buf, rdata + 6);
        if (target) names.push(target.name);
      }
    }
    cursor = rdata + rdlength;
  }

  return { aRecords, names };
}
