import { bytesToIpv4, bytesToMac } from "../../models/address.js";
import { u16 } from "./ethernet.js";

export const ARP_OPERATION_REQUEST = 1;
export const ARP_OPERATION_REPLY = 2;

export type ArpPacket = {
  operation: number;
  senderMac: string;
  senderIp: string;
  targetMac: string;
  targetIp: string;
  /** senderIp === targetIp: announcement of an existing configuration. */
  gratuitous: boolean;
};

const MIN_BYTES = 28;

export function decodeArp(buf: Uint8Array, offset = 0): ArpPacket | undefined {
  if (buf.length < offset + MIN_BYTES) return undefined;
  // Ethernet/IPv4 hardware+protocol types and lengths are expected; bail on oddities.
  if (u16(buf, offset) !== 1) return undefined; // hardware type: ethernet
  if (u16(buf, offset + 2) !== 0x0800) return undefined; // protocol: IPv4
  if (buf[offset + 4] !== 6 || buf[offset + 5] !== 4) return undefined;
  const operation = u16(buf, offset + 6);
  const senderMac = bytesToMac(buf, offset + 8);
  const senderIp = bytesToIpv4(buf, offset + 14);
  const targetMac = bytesToMac(buf, offset + 18);
  const targetIp = bytesToIpv4(buf, offset + 24);
  return {
    operation,
    senderMac,
    senderIp,
    targetMac,
    targetIp,
    gratuitous: senderIp === targetIp && senderIp !== "0.0.0.0",
  };
}
