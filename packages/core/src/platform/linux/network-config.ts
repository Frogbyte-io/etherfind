import type { Ipv4Address, PrefixLength } from "../../models/address.js";
import type { InterfaceSnapshot, NetworkConfigService } from "../../network-config/types.js";
import type { ExecResult } from "../exec.js";

export type LinuxNetworkConfigOptions = {
  /**
   * Executor used for privileged operations. The default runs `ip` directly
   * (works when the process already has cap_net_admin); the CLI injects a
   * sudo-based variant that prompts once for the narrowly scoped helper.
   */
  runPrivileged?: (args: string[]) => Promise<ExecResult>;
  /** Executor for unprivileged reads. */
  runUnprivileged?: (args: string[]) => Promise<ExecResult>;
};

const IP = "ip";

/**
 * Linux address configuration via `ip addr add/del`. The operations are purely
 * additive: existing addresses and DHCP state are never touched.
 */
export class LinuxNetworkConfigService implements NetworkConfigService {
  readonly #runPrivileged: (args: string[]) => Promise<ExecResult>;

  constructor(options: LinuxNetworkConfigOptions = {}) {
    this.#runPrivileged =
      options.runPrivileged ??
      (async (args) => {
        const { runFile } = await import("../exec.js");
        return runFile(IP, args);
      });
    if (options.runUnprivileged) {
      this.#runUnprivileged = options.runUnprivileged;
    }
  }

  #runUnprivileged?: (args: string[]) => Promise<ExecResult>;

  async snapshot(interfaceName: string): Promise<InterfaceSnapshot> {
    const runner = this.#runUnprivileged ?? this.#runPrivileged;
    const result = await runner(["-4", "-j", "addr", "show", "dev", interfaceName]);
    const dhcpHint = await runner(["-j", "route", "show", "dev", interfaceName]).catch(() => ({
      stdout: "[]",
      stderr: "",
      code: 0,
    }));
    let addresses: InterfaceSnapshot["addresses"] = [];
    try {
      const parsed = JSON.parse(result.stdout) as Array<{
        addr_info?: Array<{ local?: string; prefixlen?: number; dynamic?: string }>;
      }>;
      addresses = (parsed[0]?.addr_info ?? [])
        .filter((a) => typeof a.local === "string" && typeof a.prefixlen === "number")
        .map((a) => ({ ip: a.local as string, prefix: a.prefixlen as PrefixLength }));
    } catch {
      // Leave empty; snapshot is best-effort.
    }
    const dhcpEnabled = (JSON.parse(dhcpHint.stdout || "[]") as Array<{ dynamic?: boolean }>).some(
      (r) => r.dynamic,
    );
    return {
      interfaceName,
      capturedAt: Date.now(),
      addresses,
      dhcpEnabled,
      details: {},
    };
  }

  async addAddress(
    interfaceName: string,
    ip: Ipv4Address,
    prefix: PrefixLength,
  ): Promise<Record<string, string>> {
    const result = await this.#runPrivileged([
      "addr",
      "add",
      `${ip}/${prefix}`,
      "dev",
      interfaceName,
    ]);
    if (result.code !== 0) {
      throw new Error(`ip addr add failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
    }
    return { tool: "ip" };
  }

  async removeAddress(
    interfaceName: string,
    ip: Ipv4Address,
    prefix: PrefixLength,
    _restoreDetails: Record<string, string>,
  ): Promise<void> {
    const result = await this.#runPrivileged([
      "addr",
      "del",
      `${ip}/${prefix}`,
      "dev",
      interfaceName,
    ]);
    if (result.code !== 0 && !/cannot assign requested address|no such/i.test(result.stderr)) {
      throw new Error(`ip addr del failed: ${result.stderr.trim() || `exit code ${result.code}`}`);
    }
  }
}
