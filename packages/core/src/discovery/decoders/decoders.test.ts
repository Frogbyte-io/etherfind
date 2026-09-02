import { describe, expect, it } from "vitest";
import type { CapturedFrame } from "../../capture/packet-source.js";
import { extractObservations } from "../extractor.js";
import { decodeArp } from "./arp.js";
import { decodeDhcp } from "./dhcp.js";
import { decodeEthernet } from "./ethernet.js";
import { decodeIpv4, decodeIpv6 } from "./ipv4.js";
import { decodeMdns } from "./mdns.js";
import { arpPacket, dhcpPacket, ethernet, ipv4Packet, udpPacket } from "./test-packets.js";
import { decodeUdp } from "./udp.js";

describe("ethernet decoder", () => {
  it("decodes plain and VLAN-tagged frames", () => {
    const payload = new Uint8Array([1, 2, 3]);
    const plain = ethernet({ src: "aa:aa:aa:aa:aa:aa", ethertype: 0x0806, payload });
    const eth = decodeEthernet(plain);
    expect(eth).toMatchObject({
      srcMac: "aa:aa:aa:aa:aa:aa",
      ethertype: 0x0806,
      payloadOffset: 14,
    });

    const tagged = ethernet({ src: "aa:aa:aa:aa:aa:aa", ethertype: 0x0806, payload, vlan: 42 });
    const eth2 = decodeEthernet(tagged);
    expect(eth2).toMatchObject({ ethertype: 0x0806, payloadOffset: 18 });
  });

  it("rejects truncated frames", () => {
    expect(decodeEthernet(new Uint8Array(10))).toBeUndefined();
  });
});

describe("arp decoder", () => {
  it("decodes a who-has request", () => {
    const pkt = arpPacket({
      operation: 1,
      senderMac: "38:2a:8c:12:34:56",
      senderIp: "192.168.5.100",
      targetIp: "192.168.5.1",
    });
    const arp = decodeArp(pkt);
    expect(arp).toMatchObject({
      operation: 1,
      senderMac: "38:2a:8c:12:34:56",
      senderIp: "192.168.5.100",
      targetIp: "192.168.5.1",
      gratuitous: false,
    });
  });

  it("flags gratuitous ARP when sender == target", () => {
    const pkt = arpPacket({
      operation: 1,
      senderMac: "38:2a:8c:12:34:56",
      senderIp: "192.168.5.100",
      targetIp: "192.168.5.100",
    });
    expect(decodeArp(pkt)?.gratuitous).toBe(true);
  });

  it("rejects non-Ethernet hardware types and short buffers", () => {
    const pkt = arpPacket({
      operation: 1,
      senderMac: "38:2a:8c:12:34:56",
      senderIp: "1.2.3.4",
      targetIp: "1.2.3.4",
    });
    pkt[0] = 24; // some other htype
    expect(decodeArp(pkt)).toBeUndefined();
    expect(decodeArp(new Uint8Array(10))).toBeUndefined();
  });
});

describe("ipv4 decoder", () => {
  it("extracts source/destination", () => {
    const pkt = ipv4Packet({
      src: "10.1.2.3",
      dst: "10.1.2.4",
      protocol: 17,
      payload: new Uint8Array(8),
    });
    const ip = decodeIpv4(pkt);
    expect(ip).toMatchObject({
      srcIp: "10.1.2.3",
      dstIp: "10.1.2.4",
      protocol: 17,
      payloadOffset: 20,
    });
  });

  it("skips IP options", () => {
    const pkt = ipv4Packet({
      src: "10.1.2.3",
      dst: "10.1.2.4",
      protocol: 1,
      payload: new Uint8Array(8),
    });
    pkt[0] = 0x46; // IHL = 6 (24 bytes)
    const ip = decodeIpv4(pkt);
    expect(ip?.payloadOffset).toBe(24);
  });

  it("rejects non-IPv4", () => {
    expect(decodeIpv4(new Uint8Array(20).fill(0x60))).toBeUndefined();
  });
});

describe("ipv6 decoder", () => {
  it("decodes and compresses link-local addresses", () => {
    const buf = new Uint8Array(40);
    buf[0] = 0x60;
    buf[6] = 58; // ICMPv6
    buf[8] = 0xfe;
    buf[9] = 0x80;
    const ip6 = decodeIpv6(buf);
    expect(ip6?.srcIp.startsWith("fe80::")).toBe(true);
  });
});

describe("dhcp decoder", () => {
  it("extracts chaddr, message type, hostname and requested IP", () => {
    const pkt = dhcpPacket({
      op: 1,
      chaddr: "38:2a:8c:12:34:56",
      messageType: 3,
      hostname: "mydevice",
      requestedIp: "192.168.10.55",
    });
    const dhcp = decodeDhcp(pkt);
    expect(dhcp).toMatchObject({
      clientMac: "38:2a:8c:12:34:56",
      messageType: "request",
      hostname: "mydevice",
      requestedIp: "192.168.10.55",
    });
  });

  it("rejects packets without the magic cookie", () => {
    const pkt = dhcpPacket({ op: 1, chaddr: "38:2a:8c:12:34:56", messageType: 1 });
    expect(decodeDhcp(pkt.subarray(0, 200))).toBeUndefined();
  });
});

describe("mdns decoder", () => {
  it("parses A records from a minimal answer", () => {
    // header + one RR: name "myservice.local" + type A + class + ttl + rdlength 4 + rdata
    const name = "\x09myservice\x05local\x00";
    const nameBytes = [...name].map((c) => c.charCodeAt(0));
    const rest = new Uint8Array(14);
    const view = new DataView(rest.buffer);
    view.setUint16(0, 1); // type A
    view.setUint16(8, 4); // rdlength
    rest.set([192, 168, 5, 100], 10); // rdata
    const buf = new Uint8Array(12 + nameBytes.length + rest.length);
    buf[2] = 0x84; // QR response
    buf[7] = 1; // ancount = 1
    buf.set(nameBytes, 12);
    buf.set(rest, 12 + nameBytes.length);
    const mdns = decodeMdns(buf);
    expect(mdns?.aRecords).toEqual([{ name: "myservice.local", ip: "192.168.5.100" }]);
  });
});

describe("udp decoder", () => {
  it("decodes ports and payload length", () => {
    const payload = new Uint8Array(12);
    const udp = decodeUdp(udpPacket(5353, 5353, payload));
    expect(udp).toMatchObject({ srcPort: 5353, dstPort: 5353, payloadLength: 12 });
  });
});

describe("extractObservations", () => {
  const frame = (data: Uint8Array): CapturedFrame => ({
    data,
    timestampMs: 1000,
    linkType: "ethernet",
  });

  it("turns an ARP request frame into an arp observation", () => {
    const pkt = arpPacket({
      operation: 1,
      senderMac: "38:2a:8c:12:34:56",
      senderIp: "192.168.10.55",
      targetIp: "192.168.10.1",
    });
    const obs = extractObservations(
      frame(ethernet({ src: "38:2a:8c:12:34:56", ethertype: 0x0806, payload: pkt })),
    );
    expect(obs).toHaveLength(1);
    expect(obs[0]).toMatchObject({
      kind: "arp",
      data: { mac: "38:2a:8c:12:34:56", ip: "192.168.10.55", kind: "request", gratuitous: false },
    });
  });

  it("turns an IPv4 frame into an ipv4 observation and nested UDP into dhcp", () => {
    const dhcp = dhcpPacket({
      op: 1,
      chaddr: "38:2a:8c:12:34:56",
      messageType: 1,
      requestedIp: "192.168.10.55",
    });
    const ipPkt = ipv4Packet({
      src: "0.0.0.0",
      dst: "255.255.255.255",
      protocol: 17,
      payload: udpPacket(68, 67, dhcp),
    });
    const obs = extractObservations(
      frame(ethernet({ src: "38:2a:8c:12:34:56", ethertype: 0x0800, payload: ipPkt })),
    );
    expect(obs.map((o) => o.kind)).toEqual(["ipv4", "dhcp"]);
    const dhcpObs = obs.find((o) => o.kind === "dhcp");
    expect(dhcpObs).toMatchObject({
      data: { mac: "38:2a:8c:12:34:56", ip: "192.168.10.55", messageType: "discover" },
    });
  });

  it("ignores non-ethernet link types", () => {
    const obs = extractObservations({
      data: new Uint8Array(64),
      timestampMs: 0,
      linkType: "other",
    });
    expect(obs).toHaveLength(0);
  });
});
