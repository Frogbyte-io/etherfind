import type { Ipv4Address, MacAddress, PrefixLength } from "./address.js";

export type LinkState = "up" | "down" | "unknown";

export type InterfaceKind = "ethernet" | "wifi" | "loopback" | "virtual" | "other";

export type InterfaceAddress = {
  ip: Ipv4Address;
  prefix: PrefixLength;
};

/**
 * A network interface as presented to selection and discovery logic.
 * All platform-specific details are normalized away.
 */
export type NetworkInterfaceInfo = {
  /** System identifier used by the OS (e.g. `eth0`, `\\DEVICE\\...` GUID name). */
  name: string;
  /** Human-friendly display name (e.g. `Ethernet 2`, `USB Ethernet`). */
  displayName: string;
  mac?: MacAddress;
  linkState: LinkState;
  kind: InterfaceKind;
  /** True when the adapter is a physical device (PCI/USB), false for virtual. */
  physical: boolean;
  addresses: InterfaceAddress[];
  /** Driver/controller description when available (e.g. `Intel I225-V`). */
  driverDescription?: string;
  /** Additional reasons this interface is a virtualization/VPN adapter, if any. */
  virtualizationHint?: string;
  /** Capture-level device name to open (differs from `name` on Windows). */
  captureName?: string;
};

export type Unsubscribe = () => void;

/**
 * Observes physical link state of one interface. Pure port: platforms provide
 * implementations, tests provide fakes.
 */
export interface LinkMonitor {
  readonly interfaceName: string;
  /** Starts monitoring. Idempotent. */
  start(): Promise<void> | void;
  current(): LinkState;
  subscribe(listener: (state: LinkState) => void): Unsubscribe;
  dispose(): void;
}
