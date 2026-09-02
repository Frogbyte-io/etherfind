import { bytesToMac } from "../../models/address.js";

export const ETHERTYPE_IPV4 = 0x0800;
export const ETHERTYPE_ARP = 0x0806;
export const ETHERTYPE_IPV6 = 0x86dd;
export const ETHERTYPE_VLAN = 0x8100;

export type EthernetFrame = {
  dstMac: string;
  srcMac: string;
  ethertype: number;
  payloadOffset: number;
};

const HEADER_BYTES = 14;
const MAX_VLAN_TAGS = 2;

/** Decodes an Ethernet II header, skipping up to two 802.1Q VLAN tags. */
export function decodeEthernet(buf: Uint8Array, offset = 0): EthernetFrame | undefined {
  if (buf.length < offset + HEADER_BYTES) return undefined;
  let cursor = offset;
  const dstMac = bytesToMac(buf, cursor);
  const srcMac = bytesToMac(buf, cursor + 6);
  cursor += 12;
  let ethertype = u16(buf, cursor);
  cursor += 2;
  for (let i = 0; i < MAX_VLAN_TAGS && ethertype === ETHERTYPE_VLAN; i++) {
    if (buf.length < cursor + 4) return undefined;
    ethertype = u16(buf, cursor + 2);
    cursor += 4;
  }
  return { dstMac, srcMac, ethertype, payloadOffset: cursor };
}

export function u16(buf: Uint8Array, offset: number): number {
  return ((buf[offset] ?? 0) << 8) | (buf[offset + 1] ?? 0);
}

export function u32(buf: Uint8Array, offset: number): number {
  return (
    (((buf[offset] ?? 0) << 24) |
      ((buf[offset + 1] ?? 0) << 16) |
      ((buf[offset + 2] ?? 0) << 8) |
      (buf[offset + 3] ?? 0)) >>>
    0
  );
}
