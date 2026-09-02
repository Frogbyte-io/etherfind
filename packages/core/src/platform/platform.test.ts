import { describe, expect, it } from "vitest";
import type { ExecResult } from "./exec.js";
import { LinuxNetworkConfigService } from "./linux/network-config.js";
import { WindowsNetworkConfigService, assertValidInterface } from "./windows/network-config.js";

const ok = (stdout = ""): ExecResult => ({ stdout, stderr: "", code: 0 });

describe("LinuxNetworkConfigService", () => {
  it("runs additive ip addr add/del commands", async () => {
    const calls: string[][] = [];
    const service = new LinuxNetworkConfigService({
      runPrivileged: async (args) => {
        calls.push(args);
        if (args[0] === "-4") return ok('[{"addr_info":[{"local":"10.0.0.5","prefixlen":24}]}]');
        return ok();
      },
    });
    await service.addAddress("eth0", "192.168.5.254", 24);
    await service.removeAddress("eth0", "192.168.5.254", 24, {});
    expect(calls[0]).toEqual(["addr", "add", "192.168.5.254/24", "dev", "eth0"]);
    expect(calls[1]).toEqual(["addr", "del", "192.168.5.254/24", "dev", "eth0"]);
  });

  it("throws on failed add", async () => {
    const service = new LinuxNetworkConfigService({
      runPrivileged: async () => ({
        stdout: "",
        stderr: "RTNETLINK answers: Permission denied",
        code: 2,
      }),
    });
    await expect(service.addAddress("eth0", "192.168.5.254", 24)).rejects.toThrow(
      /Permission denied/,
    );
  });

  it("tolerates already-removed addresses", async () => {
    const service = new LinuxNetworkConfigService({
      runPrivileged: async () => ({
        stdout: "",
        stderr: "Cannot assign requested address",
        code: 2,
      }),
    });
    await expect(service.removeAddress("eth0", "192.168.5.254", 24, {})).resolves.toBeUndefined();
  });
});

describe("WindowsNetworkConfigService", () => {
  it("uses the dhcpstaticipcoexistence + store=active recipe and restores the flag", async () => {
    const elevated: string[] = [];
    const service = new WindowsNetworkConfigService({
      runElevated: async (argv: string[]) => {
        elevated.push(argv[argv.length - 1] ?? "");
        return ok();
      },
      runUnprivileged: async (argv: string[]) => {
        const script = argv[argv.length - 1] ?? "";
        if (script.includes("Dhcp")) return ok("Enabled");
        return ok('[{"IPAddress":"10.0.0.5","PrefixLength":24}]');
      },
    });
    const snapshot = await service.snapshot("Ethernet 2");
    expect(snapshot.dhcpEnabled).toBe(true);
    const details = await service.addAddress("Ethernet 2", "192.168.5.254", 24);
    expect(elevated[0]).toContain("dhcpstaticipcoexistence=enabled");
    expect(elevated[0]).toContain(
      "add address 'Ethernet 2' 192.168.5.254/24 store=active skipassource=true",
    );
    await service.removeAddress("Ethernet 2", "192.168.5.254", 24, details);
    expect(elevated[1]).toContain("delete address 'Ethernet 2' 192.168.5.254");
    expect(elevated[1]).toContain("dhcpstaticipcoexistence=disabled");
  });

  it("does not disable coexistence if it did not enable it", async () => {
    const elevated: string[] = [];
    const service = new WindowsNetworkConfigService({
      runElevated: async (argv: string[]) => {
        elevated.push(argv[argv.length - 1] ?? "");
        return ok();
      },
    });
    await service.removeAddress("Ethernet", "192.168.5.254", 24, {});
    expect(elevated[0]).not.toContain("dhcpstaticipcoexistence");
  });

  it("refuses invalid inputs", async () => {
    const service = new WindowsNetworkConfigService({ runElevated: async () => ok() });
    await expect(service.addAddress("Ethernet", "999.1.1.1", 24)).rejects.toThrow(/invalid IP/);
    expect(() => assertValidInterface("eth0; rm -rf /")).toThrow(/suspicious/);
  });
});
