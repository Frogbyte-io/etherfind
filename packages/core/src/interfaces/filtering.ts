import type { InterfaceKind, NetworkInterfaceInfo } from "../models/interface.js";

/** Name/description patterns of virtual adapters we hide by default. */
const VIRTUAL_PATTERNS: Array<{ pattern: RegExp; hint: string }> = [
  { pattern: /^docker\d*|^br-[0-9a-f]{12}|^veth/i, hint: "Docker" },
  { pattern: /hyper-v|vEthernet/i, hint: "Hyper-V" },
  { pattern: /vmware|vmnet/i, hint: "VMware" },
  { pattern: /virtualbox|vboxnet/i, hint: "VirtualBox" },
  { pattern: /tailscale/i, hint: "Tailscale" },
  { pattern: /zerotier/i, hint: "ZeroTier" },
  { pattern: /wireguard|^wg\d/i, hint: "WireGuard" },
  { pattern: /openvpn|^tun\d|^tap\d/i, hint: "VPN tunnel" },
  { pattern: /loopback|kubernetes|cilium|weave|flannel|cni|calico/i, hint: "container/loopback" },
];

export function classifyByName(name: string): { kind: InterfaceKind; hint?: string } {
  if (/^lo\d*$/i.test(name)) return { kind: "loopback" };
  if (/^(wl|wifi|wlan|ath|intwireless|wi-)/i.test(name)) return { kind: "wifi" };
  for (const { pattern, hint } of VIRTUAL_PATTERNS) {
    if (pattern.test(name)) return { kind: "virtual", hint };
  }
  return { kind: "other" };
}

export function classifyByDescription(description: string): { kind: InterfaceKind; hint?: string } {
  if (/802\.11|wi-?fi|wireless/i.test(description)) return { kind: "wifi" };
  for (const { pattern, hint } of VIRTUAL_PATTERNS) {
    if (pattern.test(description)) return { kind: "virtual", hint };
  }
  if (/virtual|tap-windows|tunnel/i.test(description))
    return { kind: "virtual", hint: description };
  return { kind: "other" };
}

export type InterfaceFilterOptions = {
  /** Include Wi-Fi, loopback and virtual adapters (for `--all-interfaces`). */
  all?: boolean;
};

/**
 * Selects candidate interfaces for the Ethernet workflow. Wi-Fi and virtual
 * adapters are de-prioritized (excluded by default, architecture stays
 * name-independent via the `kind` classification).
 */
export function selectEthernetInterfaces(
  infos: NetworkInterfaceInfo[],
  options: InterfaceFilterOptions = {},
): NetworkInterfaceInfo[] {
  const filtered = infos.filter((info) => {
    if (options.all) return true;
    if (info.kind === "loopback" || info.kind === "wifi" || info.kind === "virtual") return false;
    return true;
  });
  // Prefer connected, physical Ethernet-ish adapters; keep everything visible otherwise.
  return filtered.sort((a, b) => score(b) - score(a));
}

function score(info: NetworkInterfaceInfo): number {
  let s = 0;
  if (info.linkState === "up") s += 4;
  if (info.physical) s += 2;
  if (info.kind === "ethernet") s += 2;
  if (info.addresses.length > 0) s += 1;
  return s;
}
