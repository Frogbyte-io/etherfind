import type { Ipv4Address, MacAddress } from "./address.js";

/**
 * Where a device identity was inferred from. Ordered from strongest to weakest
 * evidence; the list order doubles as the confidence ranking.
 */
export type DiscoverySource =
  | "gratuitous-arp"
  | "arp-reply"
  | "arp-request"
  | "ipv4-source"
  | "dhcp"
  | "mdns"
  | "ndp";

export const DISCOVERY_SOURCE_CONFIDENCE: Readonly<Record<DiscoverySource, number>> = Object.freeze(
  {
    "gratuitous-arp": 100,
    "arp-reply": 90,
    "arp-request": 70,
    "ipv4-source": 50,
    dhcp: 40,
    mdns: 30,
    ndp: 20,
  },
);

export const DISCOVERY_SOURCE_LABEL: Readonly<Record<DiscoverySource, string>> = Object.freeze({
  "gratuitous-arp": "gratuitous ARP",
  "arp-reply": "ARP reply",
  "arp-request": "ARP request",
  "ipv4-source": "IPv4 source address",
  dhcp: "DHCP",
  mdns: "mDNS",
  ndp: "IPv6 neighbor discovery",
});

export function bestDiscoverySource(
  sources: Iterable<DiscoverySource>,
): DiscoverySource | undefined {
  let best: DiscoverySource | undefined;
  let bestScore = -1;
  for (const s of sources) {
    const score = DISCOVERY_SOURCE_CONFIDENCE[s];
    if (score > bestScore) {
      best = s;
      bestScore = score;
    }
  }
  return best;
}

/** A device identity inferred from observed packets. */
export type DeviceCandidate = {
  mac: MacAddress;
  ip: Ipv4Address;
  /** Highest-confidence source observed for this (mac, ip) pair. */
  source: DiscoverySource;
  /** All sources that reported this pair. */
  sources: DiscoverySource[];
  /** mDNS hostname when discovered. */
  hostname?: string;
  /** Vendor from OUI lookup when available (not implemented in v0.1). */
  vendor?: string;
  firstSeen: number;
  lastSeen: number;
};

export type ObservedPacket<T> = {
  source: DiscoverySource;
  timestamp: number;
  data: T;
};

export type ArpObservation = {
  mac: MacAddress;
  ip: Ipv4Address;
  /** True when this is a gratuitous ARP (sender == target) or announcement. */
  gratuitous: boolean;
  kind: "request" | "reply";
};

export type Ipv4Observation = {
  mac: MacAddress;
  ip: Ipv4Address;
};

export type DhcpObservation = {
  mac: MacAddress;
  ip?: Ipv4Address;
  hostname?: string;
  messageType?: "discover" | "offer" | "request" | "ack" | "nak" | "decline" | "release" | "inform";
};

export type MdnsObservation = {
  mac: MacAddress;
  ip?: Ipv4Address;
  hostname?: string;
};
