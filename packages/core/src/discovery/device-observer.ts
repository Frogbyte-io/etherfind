import type { CapturedFrame } from "../capture/packet-source.js";
import type { Ipv4Address, MacAddress } from "../models/address.js";
import {
  type ArpObservation,
  type DeviceCandidate,
  type DhcpObservation,
  type DiscoverySource,
  type Ipv4Observation,
  type MdnsObservation,
  bestDiscoverySource,
} from "../models/device.js";
import type { Observation } from "./extractor.js";

export type DeviceObserverOptions = {
  /** MACs belonging to the host (or capture tool); their traffic is ignored. */
  hostMacs?: MacAddress[];
  /** IPv4 addresses belonging to the host; IPv4 sources matching them are ignored. */
  hostIps?: Ipv4Address[];
  now?: () => number;
};

export type DeviceObserverEvent =
  | { type: "device-found"; candidate: DeviceCandidate }
  | { type: "device-updated"; candidate: DeviceCandidate };

type IpState = {
  sources: Set<DiscoverySource>;
  firstSeen: number;
  lastSeen: number;
};

type MacState = {
  hostnames: Set<string>;
  ips: Map<Ipv4Address, IpState>;
};

function isMulticastOrUnroutable(ip: Ipv4Address): boolean {
  if (ip === "0.0.0.0" || ip === "255.255.255.255") return true;
  if (ip.startsWith("127.")) return true;
  const first = Number.parseInt(ip.split(".")[0] ?? "0", 10);
  return first >= 224; // multicast + reserved class E
}

/**
 * Aggregates decoded observations into device candidates. Emits "device-found"
 * exactly once per (MAC, IP) pair and "device-updated" as evidence improves.
 * The identity of the host is excluded throughout.
 */
export class DeviceObserver {
  readonly #hostMacs: Set<MacAddress>;
  readonly #hostIps: Set<Ipv4Address>;
  readonly #macs = new Map<MacAddress, MacState>();
  /** Pending knowledge about MACs without an IP yet (e.g. DHCP hostname). */
  readonly #hostnameByMac = new Map<MacAddress, string>();
  readonly #events: ((event: DeviceObserverEvent) => void)[] = [];
  readonly #now: () => number;

  constructor(options: DeviceObserverOptions = {}) {
    this.#hostMacs = new Set((options.hostMacs ?? []).map((m) => m.toLowerCase()));
    this.#hostIps = new Set(options.hostIps ?? []);
    this.#now = options.now ?? Date.now;
  }

  onEvent(listener: (event: DeviceObserverEvent) => void): () => void {
    this.#events.push(listener);
    return () => {
      const i = this.#events.indexOf(listener);
      if (i >= 0) this.#events.splice(i, 1);
    };
  }

  /** Snapshot of all candidates, best source first. */
  candidates(): DeviceCandidate[] {
    const out: DeviceCandidate[] = [];
    for (const [mac, state] of this.#macs) {
      for (const [ip, ipState] of state.ips) {
        out.push(this.#candidate(mac, ip, ipState, state));
      }
    }
    return out.sort((a, b) => b.lastSeen - a.lastSeen);
  }

  #candidate(mac: MacAddress, ip: Ipv4Address, ipState: IpState, state: MacState): DeviceCandidate {
    const source = bestDiscoverySource(ipState.sources) ?? "ipv4-source";
    return {
      mac,
      ip,
      source,
      sources: [...ipState.sources],
      hostname: [...state.hostnames][0],
      firstSeen: ipState.firstSeen,
      lastSeen: ipState.lastSeen,
    };
  }

  #emit(event: DeviceObserverEvent): void {
    for (const listener of this.#events) listener(event);
  }

  #recordIp(mac: MacAddress, ip: Ipv4Address, source: DiscoverySource, at: number): void {
    let state = this.#macs.get(mac);
    if (!state) {
      state = { hostnames: new Set(), ips: new Map() };
      const hostname = this.#hostnameByMac.get(mac);
      if (hostname) state.hostnames.add(hostname);
      this.#macs.set(mac, state);
    }
    let ipState = state.ips.get(ip);
    const isNew = !ipState;
    if (!ipState) {
      ipState = { sources: new Set(), firstSeen: at, lastSeen: at };
      state.ips.set(ip, ipState);
    }
    ipState.lastSeen = at;
    const bestBefore = bestDiscoverySource(ipState.sources);
    const sourceCountBefore = ipState.sources.size;
    ipState.sources.add(source);
    const candidate = this.#candidate(mac, ip, ipState, state);
    if (isNew) {
      this.#emit({ type: "device-found", candidate });
      return;
    }
    if (
      bestDiscoverySource(ipState.sources) !== bestBefore ||
      ipState.sources.size !== sourceCountBefore
    ) {
      this.#emit({ type: "device-updated", candidate });
    }
  }

  #isHostMac(mac: MacAddress): boolean {
    return this.#hostMacs.has(mac.toLowerCase());
  }

  observe(observation: Observation): void {
    const at = observation.at || this.#now();
    switch (observation.kind) {
      case "arp": {
        const o: ArpObservation = observation.data;
        if (this.#isHostMac(o.mac)) return;
        if (o.ip === "0.0.0.0") return;
        const source: DiscoverySource = o.gratuitous
          ? "gratuitous-arp"
          : o.kind === "reply"
            ? "arp-reply"
            : "arp-request";
        this.#recordIp(o.mac, o.ip, source, at);
        return;
      }
      case "ipv4": {
        const o: Ipv4Observation = observation.data;
        if (this.#isHostMac(o.mac)) return;
        if (this.#hostIps.has(o.ip) || isMulticastOrUnroutable(o.ip)) return;
        this.#recordIp(o.mac, o.ip, "ipv4-source", at);
        return;
      }
      case "dhcp": {
        const o: DhcpObservation = observation.data;
        if (this.#isHostMac(o.mac)) return;
        if (o.hostname) {
          this.#hostnameByMac.set(o.mac, o.hostname);
          this.#macs.get(o.mac)?.hostnames.add(o.hostname);
        }
        if (!o.ip) return;
        if (isMulticastOrUnroutable(o.ip)) return;
        this.#recordIp(o.mac, o.ip, "dhcp", at);
        return;
      }
      case "mdns": {
        const o: MdnsObservation = observation.data;
        if (this.#isHostMac(o.mac)) return;
        if (o.hostname) {
          this.#hostnameByMac.set(o.mac, o.hostname);
          this.#macs.get(o.mac)?.hostnames.add(o.hostname);
        }
        if (!o.ip || this.#hostIps.has(o.ip) || isMulticastOrUnroutable(o.ip)) return;
        this.#recordIp(o.mac, o.ip, "mdns", at);
        return;
      }
      case "ndp":
        return; // IPv6 identity is informational only in v0.1.
      default:
        return;
    }
  }

  /** Feeds a raw captured frame through the decoder pipeline. */
  feedFrame(frame: CapturedFrame, extract: (f: CapturedFrame) => Observation[]): void {
    for (const observation of extract(frame)) this.observe(observation);
  }
}
