import type { CapturedFrame } from "../../capture/packet-source.js";

/** Builds an Ethernet II frame (test fixture builder). */
export function ethernet(opts: {
  src: string;
  dst?: string;
  ethertype: number;
  payload: Uint8Array;
  vlan?: number;
}): Uint8Array {
  const macBytes = (mac: string) => mac.split(":").map((p) => Number.parseInt(p, 16));
  const headerLength = 14 + (opts.vlan !== undefined ? 4 : 0);
  const frame = new Uint8Array(headerLength + opts.payload.length);
  frame.set(macBytes(opts.dst ?? "ff:ff:ff:ff:ff:ff"), 0);
  frame.set(macBytes(opts.src), 6);
  const view = new DataView(frame.buffer);
  if (opts.vlan !== undefined) {
    view.setUint16(12, 0x8100);
    view.setUint16(14, opts.vlan);
    view.setUint16(16, opts.ethertype);
  } else {
    view.setUint16(12, opts.ethertype);
  }
  frame.set(opts.payload, headerLength);
  return frame;
}

export function arpPacket(opts: {
  operation: number;
  senderMac: string;
  senderIp: string;
  targetMac?: string;
  targetIp: string;
}): Uint8Array {
  const macBytes = (mac: string) => mac.split(":").map((p) => Number.parseInt(p, 16));
  const ipBytes = (ip: string) => ip.split(".").map((p) => Number.parseInt(p, 10));
  const buf = new Uint8Array(28);
  const view = new DataView(buf.buffer);
  view.setUint16(0, 1); // ethernet
  view.setUint16(2, 0x0800); // IPv4
  buf[4] = 6;
  buf[5] = 4;
  view.setUint16(6, opts.operation);
  buf.set(macBytes(opts.senderMac), 8);
  buf.set(ipBytes(opts.senderIp), 14);
  buf.set(macBytes(opts.targetMac ?? "00:00:00:00:00:00"), 18);
  buf.set(ipBytes(opts.targetIp), 24);
  return buf;
}

export function ipv4Packet(opts: {
  src: string;
  dst: string;
  protocol: number;
  payload: Uint8Array;
}): Uint8Array {
  const buf = new Uint8Array(20 + opts.payload.length);
  const view = new DataView(buf.buffer);
  buf[0] = 0x45;
  view.setUint16(2, buf.length);
  buf[8] = 64;
  buf[9] = opts.protocol;
  buf.set(
    opts.src.split(".").map((p) => Number.parseInt(p, 10)),
    12,
  );
  buf.set(
    opts.dst.split(".").map((p) => Number.parseInt(p, 10)),
    16,
  );
  buf.set(opts.payload, 20);
  return buf;
}

export function udpPacket(srcPort: number, dstPort: number, payload: Uint8Array): Uint8Array {
  const buf = new Uint8Array(8 + payload.length);
  const view = new DataView(buf.buffer);
  view.setUint16(0, srcPort);
  view.setUint16(2, dstPort);
  view.setUint16(4, buf.length);
  buf.set(payload, 8);
  return buf;
}

export function dhcpPacket(opts: {
  op: number;
  chaddr: string;
  messageType: number;
  requestedIp?: string;
  hostname?: string;
  ciaddr?: string;
}): Uint8Array {
  const buf = new Uint8Array(240 + 64);
  const view = new DataView(buf.buffer);
  buf[0] = opts.op;
  buf[28] = 0x02; // htype ethernet
  buf[29] = 6;
  view.setUint32(236, 0x63825363);
  const macBytes = opts.chaddr.split(":").map((p) => Number.parseInt(p, 16));
  buf.set(macBytes, 28);
  if (opts.ciaddr)
    buf.set(
      opts.ciaddr.split(".").map((p) => Number.parseInt(p, 10)),
      12,
    );
  let cursor = 240;
  buf[cursor++] = 53;
  buf[cursor++] = 1;
  buf[cursor++] = opts.messageType;
  if (opts.hostname) {
    const name = new TextEncoder().encode(opts.hostname);
    buf[cursor++] = 12;
    buf[cursor++] = name.length;
    buf.set(name, cursor);
    cursor += name.length;
  }
  if (opts.requestedIp) {
    buf[cursor++] = 50;
    buf[cursor++] = 4;
    buf.set(
      opts.requestedIp.split(".").map((p) => Number.parseInt(p, 10)),
      cursor,
    );
    cursor += 4;
  }
  buf[cursor] = 255;
  return buf;
}

/** A complete ARP-request frame from the canonical test device. */
export const DEVICE_MAC = "38:2a:8c:12:34:56";
export const DEVICE_IP = "192.168.5.100";

export function arpFrameFrom(mac = DEVICE_MAC, ip = DEVICE_IP): CapturedFrame {
  return {
    data: ethernet({
      src: mac,
      ethertype: 0x0806,
      payload: arpPacket({ operation: 1, senderMac: mac, senderIp: ip, targetIp: "192.168.5.1" }),
    }),
    timestampMs: Date.now(),
    linkType: "ethernet",
  };
}
