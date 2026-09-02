import { classifyByDescription } from "../../interfaces/filtering.js";
import type { InterfaceService } from "../../interfaces/interface-service.js";
import { PollingLinkMonitor } from "../../interfaces/polling-link-monitor.js";
import type { PrefixLength } from "../../models/address.js";
import type { LinkState, NetworkInterfaceInfo } from "../../models/interface.js";
import type { LinkMonitor } from "../../models/interface.js";
import { type ExecResult, POWERSHELL, runFile } from "../exec.js";

export type WinAdapter = {
  Name: string;
  InterfaceDescription: string;
  InterfaceIndex: number;
  InterfaceGuid: string;
  MacAddress?: string;
  Status: string;
  MediaType?: string;
  PhysicalMediaType?: string;
  DriverDescription?: string;
  Virtual?: boolean;
};

export type WinIpAddress = {
  InterfaceIndex: number;
  IPAddress: string;
  PrefixLength: number;
};

export type WinInventory = {
  adapters: WinAdapter[];
  addresses: WinIpAddress[];
};

export type WindowsInterfaceServiceOptions = {
  /** Injectable runner (tests provide a fake; default spawns powershell.exe). */
  run?: (command: string, args: string[]) => Promise<ExecResult>;
  powershell?: string;
};

const INVENTORY_SCRIPT = `
$ErrorActionPreference = 'Stop';
$adapters = @(Get-NetAdapter -IncludeHidden |
  Select-Object Name, InterfaceDescription, InterfaceIndex, InterfaceGuid, MacAddress, Status, MediaType, PhysicalMediaType, DriverDescription, Virtual);
$addresses = @(Get-NetIPAddress -AddressFamily IPv4 |
  Select-Object InterfaceIndex, IPAddress, PrefixLength);
[pscustomobject]@{ adapters = $adapters; addresses = $addresses } | ConvertTo-Json -Compress -Depth 5
`;

function normalizeInventory(stdout: string): WinInventory {
  const parsed = JSON.parse(stdout) as
    | (Partial<WinInventory> & {
        adapters?: WinAdapter | WinAdapter[] | null;
        addresses?: WinIpAddress | WinIpAddress[] | null;
      })
    | null;
  // Windows PowerShell 5.1 has no `ConvertTo-Json -AsArray`: a script using it
  // still exits 0 but emits {"adapters":null,...}. Fail loudly rather than
  // dereferencing nulls further down.
  if (!parsed || typeof parsed !== "object" || parsed.adapters == null) {
    throw new Error(
      "PowerShell returned no network adapter inventory. Verify that Get-NetAdapter " +
        "runs in this shell (Windows PowerShell 5.1 or PowerShell 7+ is required).",
    );
  }
  const toArray = <T>(v: T | T[] | null | undefined): T[] =>
    v == null ? [] : Array.isArray(v) ? v.filter((item) => item != null) : [v];
  return {
    adapters: toArray(parsed.adapters),
    addresses: toArray(parsed.addresses),
  };
}

/**
 * Windows interface enumeration through PowerShell (Get-NetAdapter /
 * Get-NetIPAddress). Read-only; requires no elevation. The runner is
 * injectable so tests can feed fixture JSON.
 */
export class WindowsInterfaceService implements InterfaceService {
  readonly #run: (command: string, args: string[]) => Promise<ExecResult>;
  readonly #powershell: string;

  constructor(options: WindowsInterfaceServiceOptions = {}) {
    this.#run = options.run ?? ((command, args) => runFile(command, args));
    this.#powershell = options.powershell ?? POWERSHELL;
  }

  async enumerate(): Promise<NetworkInterfaceInfo[]> {
    const result = await this.#run(this.#powershell, [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      INVENTORY_SCRIPT,
    ]);
    if (result.code !== 0 || !result.stdout.trim()) {
      throw new Error(
        `Get-NetAdapter inventory failed (exit ${result.code}): ${result.stderr.trim()}`,
      );
    }
    const inventory = normalizeInventory(result.stdout);
    return inventory.adapters.map((adapter) => this.#toInfo(adapter, inventory.addresses));
  }

  #toInfo(adapter: WinAdapter, addresses: WinIpAddress[]): NetworkInterfaceInfo {
    const linkState: LinkState =
      adapter.Status === "Up"
        ? "up"
        : adapter.Status === "Disconnected" || adapter.Status === "Disabled"
          ? "down"
          : "unknown";
    const media = (adapter.PhysicalMediaType ?? adapter.MediaType ?? "").toLowerCase();
    const classified = classifyByDescription(adapter.InterfaceDescription);
    const isWifi = media.includes("802.11") || classified.kind === "wifi";
    const isLoopback = /loopback/i.test(adapter.InterfaceDescription);
    const isVirtual = adapter.Virtual === true || classified.kind === "virtual" || media === "";

    const ownAddresses = addresses
      .filter((a) => a.InterfaceIndex === adapter.InterfaceIndex)
      .map((a) => ({ ip: a.IPAddress, prefix: (a.PrefixLength ?? 24) as PrefixLength }));

    return {
      name: adapter.Name,
      displayName: adapter.Name,
      mac: adapter.MacAddress ? adapter.MacAddress.toLowerCase().replaceAll("-", ":") : undefined,
      linkState,
      kind: isLoopback ? "loopback" : isWifi ? "wifi" : isVirtual ? "virtual" : "ethernet",
      physical: !isVirtual && !isLoopback,
      addresses: ownAddresses,
      driverDescription: adapter.DriverDescription ?? adapter.InterfaceDescription,
      virtualizationHint: isVirtual
        ? adapter.Virtual === true
          ? "virtual adapter"
          : classified.hint
        : undefined,
      captureName: `\\Device\\NPF_${adapter.InterfaceGuid}`,
    };
  }

  linkMonitor(interfaceName: string, intervalMs = 400): LinkMonitor {
    return new PollingLinkMonitor({
      interfaceName,
      intervalMs,
      readState: async () => {
        const result = await this.#run(this.#powershell, [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          `(Get-NetAdapter -InterfaceAlias '${interfaceName.replace(/'/g, "''")}').Status`,
        ]);
        const status = result.stdout.trim();
        if (status === "Up") return "up";
        if (status === "Disconnected" || status === "Disabled") return "down";
        return "unknown";
      },
    });
  }
}
