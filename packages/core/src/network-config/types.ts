import type { Ipv4Address, PrefixLength } from "../models/address.js";

/** Pre-change snapshot of an interface's IPv4 configuration. */
export type InterfaceSnapshot = {
  interfaceName: string;
  capturedAt: number;
  addresses: Array<{ ip: Ipv4Address; prefix: PrefixLength }>;
  dhcpEnabled?: boolean;
  /** Platform-specific values needed for exact restoration. */
  details: Record<string, string>;
};

/** A configuration change made by Etherfind that must be undone on exit. */
export type AppliedChange = {
  changeId: string;
  interfaceName: string;
  ip: Ipv4Address;
  prefix: PrefixLength;
  platform: "linux" | "windows";
  appliedAt: number;
  /** Platform-specific values needed for exact restoration. */
  restoreDetails: Record<string, string>;
};

/**
 * Port: add/remove IPv4 addresses on one specific interface. Implementations
 * must be additive (never touch existing addresses or DHCP state) and must
 * only ever address the interface they were given.
 */
export interface NetworkConfigService {
  snapshot(interfaceName: string): Promise<InterfaceSnapshot>;
  /** Adds a secondary address; returns platform details required to undo it. */
  addAddress(
    interfaceName: string,
    ip: Ipv4Address,
    prefix: PrefixLength,
  ): Promise<Record<string, string>>;
  /** Removes exactly the address added earlier. */
  removeAddress(
    interfaceName: string,
    ip: Ipv4Address,
    prefix: PrefixLength,
    restoreDetails: Record<string, string>,
  ): Promise<void>;
}
