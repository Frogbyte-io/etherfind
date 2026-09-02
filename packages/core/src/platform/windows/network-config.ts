import type { Ipv4Address, PrefixLength } from "../../models/address.js";
import { isValidIpv4 } from "../../models/address.js";
import type { InterfaceSnapshot, NetworkConfigService } from "../../network-config/types.js";
import type { ExecResult } from "../exec.js";

export type WindowsNetworkConfigOptions = {
  /**
   * Elevated executor (UAC). Receives full argv including the executable.
   * Injected; the CLI wires the UAC implementation.
   */
  runElevated: (argv: string[]) => Promise<ExecResult>;
  /** Non-elevated executor for reads (full argv). */
  runUnprivileged?: (argv: string[]) => Promise<ExecResult>;
  powershell?: string;
};

const PS = "powershell.exe";

/**
 * Windows address configuration implementing the researched safe recipe:
 *
 *   1. record DHCP state (Get-NetIPInterface)
 *   2. netsh int ipv4 set interface "X" dhcpstaticipcoexistence=enabled
 *   3. netsh int ipv4 add address "X" <ip>/<len> store=active skipassource=true
 *
 * - `store=active`: the address is non-persistent (gone on reboot) — a safety
 *   net if the process crashes.
 * - `skipassource=true`: the temporary address is never used as the source for
 *   outbound traffic and is not registered in DNS.
 * - DHCP is never disabled: coexistence allows static + DHCP side by side.
 *
 * `New-NetIPAddress` is deliberately NOT used: it disables DHCP on
 * DHCP-configured interfaces.
 */
export class WindowsNetworkConfigService implements NetworkConfigService {
  readonly #runElevated: (argv: string[]) => Promise<ExecResult>;
  readonly #runUnprivileged: (argv: string[]) => Promise<ExecResult>;
  readonly #powershell: string;

  constructor(options: WindowsNetworkConfigOptions) {
    this.#runElevated = options.runElevated;
    this.#runUnprivileged =
      options.runUnprivileged ??
      (async (argv) => {
        const { runFile } = await import("../exec.js");
        const exe = argv[0];
        if (!exe) throw new Error("Empty argv for privileged operation");
        return runFile(exe, argv.slice(1));
      });
    this.#powershell = options.powershell ?? PS;
  }

  async snapshot(interfaceName: string): Promise<InterfaceSnapshot> {
    const dhcp = await this.#runUnprivileged([
      this.#powershell,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `(Get-NetIPInterface -InterfaceAlias '${escapeSingle(interfaceName)}' -AddressFamily IPv4).Dhcp`,
    ]);
    const addr = await this.#runUnprivileged([
      this.#powershell,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `Get-NetIPAddress -InterfaceAlias '${escapeSingle(interfaceName)}' -AddressFamily IPv4 | Select-Object IPAddress, PrefixLength | ConvertTo-Json -Compress`,
    ]);
    const dhcpEnabled = dhcp.stdout.trim().toLowerCase() === "enabled";
    let addresses: InterfaceSnapshot["addresses"] = [];
    try {
      const parsed = JSON.parse(addr.stdout || "[]") as
        | Array<{ IPAddress: string; PrefixLength: number }>
        | { IPAddress: string; PrefixLength: number };
      const list = Array.isArray(parsed) ? parsed : [parsed];
      addresses = list
        .filter((a) => isValidIpv4(a.IPAddress))
        .map((a) => ({ ip: a.IPAddress, prefix: a.PrefixLength }));
    } catch {
      // best-effort
    }
    return {
      interfaceName,
      capturedAt: Date.now(),
      addresses,
      dhcpEnabled,
      details: { dhcpEnabledBefore: String(dhcpEnabled) },
    };
  }

  async addAddress(
    interfaceName: string,
    ip: Ipv4Address,
    prefix: PrefixLength,
  ): Promise<Record<string, string>> {
    assertValidIp(ip);
    assertValidInterface(interfaceName);
    // Only claim ownership of the coexistence flag when we positively observed
    // it disabled beforehand. If it was already enabled — or we could not read
    // it — cleanup leaves it alone rather than turning off a setting the user
    // may depend on for their own static+DHCP configuration.
    const coexistenceBefore = await this.#readCoexistence(interfaceName);
    const enabledByUs = coexistenceBefore === "disabled";
    const commands: string[] = [];
    if (coexistenceBefore !== "enabled") {
      commands.push(
        `netsh interface ipv4 set interface interface='${escapeSingle(interfaceName)}' dhcpstaticipcoexistence=enabled`,
      );
    }
    commands.push(
      `netsh interface ipv4 add address '${escapeSingle(interfaceName)}' ${ip}/${prefix} store=active skipassource=true`,
    );
    const results = await this.#runElevated([
      this.#powershell,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      commands.join("; "),
    ]);
    if (results.code !== 0 || /failed|error/i.test(results.stderr)) {
      throw new Error(
        `Failed to add address on ${interfaceName}: ${results.stderr.trim() || `exit code ${results.code}`}`,
      );
    }
    return { coexistenceEnabledByUs: String(enabledByUs) };
  }

  /**
   * Reads the current DHCP/static coexistence flag. Returns "unknown" when the
   * value cannot be determined (non-English Windows translates the label), in
   * which case the caller must not try to restore it.
   */
  async #readCoexistence(interfaceName: string): Promise<"enabled" | "disabled" | "unknown"> {
    try {
      const result = await this.#runUnprivileged([
        this.#powershell,
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `netsh interface ipv4 show interface '${escapeSingle(interfaceName)}'`,
      ]);
      const line = result.stdout.split(/\r?\n/).find((candidate) => /coexistence/i.test(candidate));
      const value = line?.split(":").pop()?.trim().toLowerCase();
      if (value === "enabled" || value === "disabled") return value;
    } catch {
      // Fall through to "unknown"; never block configuration on this read.
    }
    return "unknown";
  }

  async removeAddress(
    interfaceName: string,
    ip: Ipv4Address,
    prefix: PrefixLength,
    restoreDetails: Record<string, string>,
  ): Promise<void> {
    assertValidIp(ip);
    assertValidInterface(interfaceName);
    const commands = [
      `netsh interface ipv4 delete address '${escapeSingle(interfaceName)}' ${ip} store=active`,
    ];
    // Restore the coexistence flag only if we enabled it.
    if (restoreDetails.coexistenceEnabledByUs === "true") {
      commands.push(
        `netsh interface ipv4 set interface interface='${escapeSingle(interfaceName)}' dhcpstaticipcoexistence=disabled`,
      );
    }
    const result = await this.#runElevated([
      this.#powershell,
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      commands.join("; "),
    ]);
    if (result.code !== 0) {
      throw new Error(
        `Failed to remove address from ${interfaceName}: ${result.stderr.trim() || `exit code ${result.code}`}`,
      );
    }
  }
}

function escapeSingle(value: string): string {
  return value.replaceAll("'", "''");
}

function assertValidIp(ip: string): void {
  if (!isValidIpv4(ip)) throw new Error(`Refusing to use invalid IP: ${ip}`);
}

function assertValidInterface(name: string): void {
  if (!/^[\w .\-()]{1,64}$/.test(name))
    throw new Error(`Refusing to use suspicious interface name: ${name}`);
}

export { escapeSingle, assertValidIp, assertValidInterface };
