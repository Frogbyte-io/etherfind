import type { CapturedFrame } from "../capture/packet-source.js";
import { bytesToMac } from "../models/address.js";
import type {
  ArpObservation,
  DhcpObservation,
  Ipv4Observation,
  MdnsObservation,
} from "../models/device.js";
import { decodeArp } from "./decoders/arp.js";
import { DHCP_CLIENT_PORT, DHCP_SERVER_PORT, decodeDhcp } from "./decoders/dhcp.js";
import {
  ETHERTYPE_ARP,
  ETHERTYPE_IPV4,
  ETHERTYPE_IPV6,
  decodeEthernet,
} from "./decoders/ethernet.js";
import { decodeIpv4, decodeIpv6 } from "./decoders/ipv4.js";
import { decodeMdns } from "./decoders/mdns.js";
import { decodeUdp } from "./decoders/udp.js";

export const ICMPV6_NEIGHBOR_SOLICITATION = 135;
export const ICMPV6_NEIGHBOR_ADVERTISEMENT = 136;

export type NdpObservation = {
  mac: string;
  ipv6: string;
  kind: "solicitation" | "advertisement";
};

export type Observation =
  | { kind: "arp"; at: number; data: ArpObservation }
  | { kind: "ipv4"; at: number; data: Ipv4Observation }
  | { kind: "dhcp"; at: number; data: DhcpObservation }
  | { kind: "mdns"; at: number; data: MdnsObservation }
  | { kind: "ndp"; at: number; data: NdpObservation };

/**
 * Pure decoder pipeline: one captured Ethernet frame -> zero or more typed
 * observations. No state, no filtering of host traffic (that is the
 * DeviceObserver's job), fully unit-testable with byte fixtures.
 */
export function extractObservations(frame: CapturedFrame): Observation[] {
  if (frame.linkType !== "ethernet") return [];
  const eth = decodeEthernet(frame.data);
  if (!eth) return [];
  const at = frame.timestampMs;
  const observations: Observation[] = [];
  const payload = frame.data;

  switch (eth.ethertype) {
    case ETHERTYPE_ARP: {
      const arp = decodeArp(payload, eth.payloadOffset);
      if (arp) {
        observations.push({
          kind: "arp",
          at,
          data: {
            mac: arp.senderMac,
            ip: arp.senderIp,
            gratuitous: arp.gratuitous,
            kind: arp.operation === 2 ? "reply" : "request",
          },
        });
      }
      break;
    }
    case ETHERTYPE_IPV4: {
      const ip = decodeIpv4(payload, eth.payloadOffset);
      if (!ip) break;
      observations.push({ kind: "ipv4", at, data: { mac: eth.srcMac, ip: ip.srcIp } });
      const udp = ip.protocol === 17 ? decodeUdp(payload, ip.payloadOffset) : undefined;
      if (!udp) break;
      const isDhcp =
        (udp.srcPort === DHCP_CLIENT_PORT && udp.dstPort === DHCP_SERVER_PORT) ||
        (udp.srcPort === DHCP_SERVER_PORT && udp.dstPort === DHCP_CLIENT_PORT);
      if (isDhcp) {
        const dhcp = decodeDhcp(payload, udp.payloadOffset);
        if (dhcp) {
          observations.push({
            kind: "dhcp",
            at,
            data: {
              mac: dhcp.clientMac,
              ip: dhcp.requestedIp ?? dhcp.ciaddr ?? dhcp.yiaddr,
              hostname: dhcp.hostname,
              messageType: dhcp.messageType,
            },
          });
        }
      }
      if (udp.srcPort === 5353 || udp.dstPort === 5353) {
        const mdns = decodeMdns(payload, udp.payloadOffset);
        if (mdns) {
          observations.push({
            kind: "mdns",
            at,
            data: {
              mac: eth.srcMac,
              ip: mdns.aRecords[0]?.ip,
              hostname: mdns.aRecords[0]?.name ?? mdns.names[0],
            },
          });
        }
      }
      break;
    }
    case ETHERTYPE_IPV6: {
      const ip6 = decodeIpv6(payload, eth.payloadOffset);
      if (!ip6) break;
      // ICMPv6 neighbor discovery: type byte is the first payload byte.
      const icmpType = payload[ip6.payloadOffset] ?? 0;
      if (icmpType === ICMPV6_NEIGHBOR_SOLICITATION || icmpType === ICMPV6_NEIGHBOR_ADVERTISEMENT) {
        // Options (incl. link-layer address) begin 20 bytes into the ICMPv6 message.
        const optCursor = ip6.payloadOffset + 20;
        if (optCursor + 8 <= payload.length) {
          const optType = payload[optCursor] ?? 0;
          if (optType === 1 || optType === 2) {
            observations.push({
              kind: "ndp",
              at,
              data: {
                mac: bytesToMac(payload, optCursor + 2),
                ipv6: ip6.srcIp,
                kind: icmpType === ICMPV6_NEIGHBOR_SOLICITATION ? "solicitation" : "advertisement",
              },
            });
          }
        }
      }
      break;
    }
    default:
      break;
  }
  return observations;
}
