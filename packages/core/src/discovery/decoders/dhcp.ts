import { bytesToIpv4, bytesToMac } from "../../models/address.js";
import { u32 } from "./ethernet.js";

export const DHCP_SERVER_PORT = 67;
export const DHCP_CLIENT_PORT = 68;

export type DhcpMessageType =
  | "discover"
  | "offer"
  | "request"
  | "decline"
  | "ack"
  | "nak"
  | "release"
  | "inform";

const MESSAGE_TYPES: Record<number, DhcpMessageType> = {
  1: "discover",
  2: "offer",
  3: "request",
  4: "decline",
  5: "ack",
  6: "nak",
  7: "release",
  8: "inform",
};

export type DhcpPacket = {
  op: number;
  clientMac: string;
  ciaddr?: string;
  yiaddr?: string;
  messageType?: DhcpMessageType;
  hostname?: string;
  requestedIp?: string;
};

const MIN_BYTES = 236 + 4; // fixed header + magic cookie
const MAGIC_COOKIE = 0x63825363;

export function decodeDhcp(buf: Uint8Array, offset = 0): DhcpPacket | undefined {
  if (buf.length < offset + MIN_BYTES) return undefined;
  if (u32(buf, offset + 236) !== MAGIC_COOKIE) return undefined;
  const op = buf[offset] ?? 0;
  const clientMac = bytesToMac(buf, offset + 28);
  const ciaddr = bytesToIpv4(buf, offset + 12);
  const yiaddr = bytesToIpv4(buf, offset + 16);

  let messageType: DhcpMessageType | undefined;
  let hostname: string | undefined;
  let requestedIp: string | undefined;

  let cursor = offset + 240;
  while (cursor < buf.length) {
    const code = buf[cursor] ?? 0;
    if (code === 0) {
      cursor++;
      continue; // padding
    }
    if (code === 255) break; // end
    const len = buf[cursor + 1] ?? 0;
    const data = buf.subarray(cursor + 2, cursor + 2 + len);
    if (data.length < len) break;
    if (code === 53 && len >= 1) {
      messageType = MESSAGE_TYPES[data[0] ?? 0];
    } else if (code === 12) {
      hostname = new TextDecoder().decode(data);
    } else if (code === 50 && len === 4) {
      requestedIp = bytesToIpv4(data, 0);
    }
    cursor += 2 + len;
  }

  const zero = "0.0.0.0";
  return {
    op,
    clientMac,
    ciaddr: ciaddr === zero ? undefined : ciaddr,
    yiaddr: yiaddr === zero ? undefined : yiaddr,
    messageType,
    hostname,
    requestedIp,
  };
}
