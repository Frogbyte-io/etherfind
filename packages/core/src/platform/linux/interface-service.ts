import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { classifyByName } from "../../interfaces/filtering.js";
import type { InterfaceService } from "../../interfaces/interface-service.js";
import { PollingLinkMonitor } from "../../interfaces/polling-link-monitor.js";
import { type PrefixLength, isValidIpv4, isValidMac } from "../../models/address.js";
import type { LinkState, NetworkInterfaceInfo } from "../../models/interface.js";
import type { LinkMonitor } from "../../models/interface.js";

const SYS_CLASS_NET = "/sys/class/net";

export type LinuxInterfaceServiceOptions = {
  sysClassNetPath?: string;
};

/**
 * Linux interface enumeration via sysfs (no privileges required) merged with
 * address data from os.networkInterfaces().
 */
export class LinuxInterfaceService implements InterfaceService {
  readonly #sysClassNetPath: string;

  constructor(options: LinuxInterfaceServiceOptions = {}) {
    this.#sysClassNetPath = options.sysClassNetPath ?? SYS_CLASS_NET;
  }

  async enumerate(): Promise<NetworkInterfaceInfo[]> {
    let names: string[];
    try {
      names = await readdir(this.#sysClassNetPath);
    } catch {
      return [];
    }
    const infos = await Promise.all(
      names.filter((n) => n !== "." && n !== "..").map((n) => this.#describe(n)),
    );
    return infos.filter((info): info is NetworkInterfaceInfo => info !== undefined);
  }

  linkMonitor(interfaceName: string, intervalMs = 250): LinkMonitor {
    return new PollingLinkMonitor({
      interfaceName,
      intervalMs,
      readState: async () => {
        try {
          const operstate = (
            await readFile(path.join(this.#sysClassNetPath, interfaceName, "operstate"), "utf8")
          ).trim();
          if (operstate === "up") return "up";
          if (operstate === "down") return "down";
          // operstate "unknown"/"testing" etc: fall back to carrier
          const carrier = (
            await readFile(path.join(this.#sysClassNetPath, interfaceName, "carrier"), "utf8")
          ).trim();
          return carrier === "1" ? "up" : carrier === "0" ? "down" : "unknown";
        } catch {
          // carrier read fails with EINVAL on some drivers when link is down.
          return "down";
        }
      },
    });
  }

  async #describe(name: string): Promise<NetworkInterfaceInfo | undefined> {
    const base = path.join(this.#sysClassNetPath, name);
    const [mac, operstate, hasWireless, hasDevice, driver] = await Promise.all([
      readFileOrNull(path.join(base, "address")),
      readFileOrNull(path.join(base, "operstate")),
      exists(path.join(base, "wireless"), path.join(base, "phy80211")),
      exists(path.join(base, "device")),
      readDriver(base),
    ]);

    let linkState: LinkState = "unknown";
    if (operstate === "up") linkState = "up";
    else if (operstate === "down" || operstate === "lowerlayerdown") linkState = "down";

    const classified = classifyByName(name);
    let kind = classified.kind;
    if (!hasWireless) {
      if (kind === "loopback" || kind === "virtual") {
        // keep classification
      } else if (hasDevice) {
        // Device-backed non-wireless adapters (ens*/enp*/enx*/eth*/usb*) are Ethernet.
        kind = "ethernet";
      }
    }
    const physical = hasDevice && kind !== "virtual" && kind !== "loopback";

    const osIfaces = os.networkInterfaces();
    const addresses = (osIfaces[name] ?? [])
      .filter((a) => a.family === "IPv4" && isValidIpv4(a.address))
      .map((a) => ({ ip: a.address, prefix: maskToPrefix(a.netmask) }));

    return {
      name,
      displayName: name,
      mac: mac && isValidMac(mac) ? mac : undefined,
      linkState,
      kind,
      physical,
      addresses,
      driverDescription: driver ?? undefined,
    };
  }
}

async function readFileOrNull(file: string): Promise<string | undefined> {
  try {
    return (await readFile(file, "utf8")).trim();
  } catch {
    return undefined;
  }
}

async function exists(...candidates: string[]): Promise<boolean> {
  for (const candidate of candidates) {
    try {
      await import("node:fs/promises").then((fs) => fs.access(candidate));
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

async function readDriver(base: string): Promise<string | undefined> {
  try {
    const uevent = await readFile(path.join(base, "device", "uevent"), "utf8");
    const match = uevent.match(/^DRIVER=(.+)$/m);
    if (match) return match[1];
  } catch {
    // not a physical device
  }
  return undefined;
}

export function maskToPrefix(mask: string): PrefixLength {
  let prefix = 0;
  let sawPartial = false;
  for (const part of mask.split(".")) {
    let n = Number.parseInt(part ?? "0", 10) & 0xff;
    if (!sawPartial && n === 0xff) {
      prefix += 8;
      continue;
    }
    sawPartial = true;
    while (n & 0x80) {
      prefix++;
      n = (n << 1) & 0xff;
    }
  }
  return Math.min(32, Math.max(0, prefix));
}

async function readdir(dir: string): Promise<string[]> {
  const fs = await import("node:fs/promises");
  return fs.readdir(dir);
}
