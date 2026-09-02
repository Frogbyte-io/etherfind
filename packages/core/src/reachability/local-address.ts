import {
  type Ipv4Address,
  type PrefixLength,
  broadcastOf,
  ipv4ToUint32,
  networkOf,
  sameSubnet,
  uint32ToIpv4,
} from "../models/address.js";
import type { NetworkInterfaceInfo } from "../models/interface.js";

export type ReachabilityResult =
  | {
      reachable: true;
      /** Which existing local configuration makes the device reachable. */
      via: { ip: Ipv4Address; prefix: PrefixLength; interfaceName: string };
    }
  | {
      reachable: false;
      /** Proposed temporary local address; `assumed` marks the /24 default. */
      suggestion: LocalAddressSuggestion;
    };

export type LocalAddressSuggestion = {
  ip: Ipv4Address;
  prefix: PrefixLength;
  /** True when the prefix is an assumption (no netmask evidence was available). */
  assumed: boolean;
  /** Candidate rejected because it equals the device's own address etc. */
};

/**
 * Pure logic: does the host already have a route to the device's subnet, and
 * if not, which local address should we suggest?
 *
 * v0.1 assumption: when no netmask evidence exists for the device, assume /24.
 * The suggestion carries `assumed: true` so callers can present it honestly.
 */
export function evaluateReachability(
  deviceIp: Ipv4Address,
  devicePrefixAssumption: PrefixLength,
  interfaces: NetworkInterfaceInfo[],
): ReachabilityResult {
  // Any existing local address on any interface that covers the device's subnet?
  for (const iface of interfaces) {
    for (const addr of iface.addresses) {
      const prefix = Math.min(addr.prefix, devicePrefixAssumption);
      if (sameSubnet(addr.ip, deviceIp, prefix) || sameSubnet(addr.ip, deviceIp, addr.prefix)) {
        return {
          reachable: true,
          via: { ip: addr.ip, prefix: addr.prefix, interfaceName: iface.name },
        };
      }
    }
  }
  const suggestion = suggestLocalAddress(deviceIp, interfaces);
  return { reachable: false, suggestion };
}

const PREFERRED_HOST_SUFFIXES = [254, 250, 200, 150, 100, 50, 20, 10, 2];

/**
 * Picks a local address in the device's /24 that is not the device itself,
 * not the network/broadcast address, and not used by any local interface.
 */
export function suggestLocalAddress(
  deviceIp: Ipv4Address,
  interfaces: NetworkInterfaceInfo[],
  prefix: PrefixLength = 24,
): LocalAddressSuggestion {
  const network = networkOf(deviceIp, prefix);
  const broadcast = broadcastOf(deviceIp, prefix);
  const usedIps = new Set<string>(interfaces.flatMap((i) => i.addresses.map((a) => a.ip)));
  usedIps.add(deviceIp);
  usedIps.add(network);
  usedIps.add(broadcast);

  const base = ipv4ToUint32(network);
  for (const suffix of PREFERRED_HOST_SUFFIXES) {
    const candidate = uint32ToIpv4(base + suffix);
    if (!usedIps.has(candidate)) {
      return { ip: candidate, prefix, assumed: true };
    }
  }
  // Deterministic fallback scan .2 upward.
  for (let suffix = 2; suffix < 254; suffix++) {
    const candidate = uint32ToIpv4(base + suffix);
    if (!usedIps.has(candidate)) {
      return { ip: candidate, prefix, assumed: true };
    }
  }
  throw new Error(`No free address found in ${network}/${prefix}`);
}
