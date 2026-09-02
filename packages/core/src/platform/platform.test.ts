import { describe, expect, it } from "vitest";
import type { ExecResult } from "./exec.js";
import { LinuxNetworkConfigService } from "./linux/network-config.js";
import { WindowsInterfaceService } from "./windows/interface-service.js";
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

describe("WindowsInterfaceService", () => {
  const inventory = (adapters: unknown, addresses: unknown = []) =>
    JSON.stringify({ adapters, addresses });

  const adapter = (over: Record<string, unknown> = {}) => ({
    Name: "Ethernet 2",
    InterfaceDescription: "Realtek USB GbE Family Controller",
    InterfaceIndex: 12,
    InterfaceGuid: "{AAAA-BBBB}",
    MacAddress: "00-11-22-33-44-55",
    Status: "Up",
    MediaType: "802.3",
    PhysicalMediaType: "802.3",
    DriverDescription: "Realtek USB GbE Family Controller",
    Virtual: false,
    ...over,
  });

  it("parses a nested inventory object and classifies a physical NIC", async () => {
    const service = new WindowsInterfaceService({
      run: async () =>
        ok(
          inventory([adapter()], [{ InterfaceIndex: 12, IPAddress: "10.0.0.5", PrefixLength: 24 }]),
        ),
    });
    const infos = await service.enumerate();
    expect(infos).toHaveLength(1);
    expect(infos[0]?.kind).toBe("ethernet");
    expect(infos[0]?.physical).toBe(true);
    expect(infos[0]?.mac).toBe("00:11:22:33:44:55");
    expect(infos[0]?.addresses).toEqual([{ ip: "10.0.0.5", prefix: 24 }]);
    expect(infos[0]?.captureName).toBe("\\Device\\NPF_{AAAA-BBBB}");
  });

  it("tolerates PowerShell collapsing a single-element array to an object", async () => {
    const service = new WindowsInterfaceService({
      run: async () =>
        ok(inventory(adapter(), { InterfaceIndex: 12, IPAddress: "10.0.0.5", PrefixLength: 24 })),
    });
    const infos = await service.enumerate();
    expect(infos).toHaveLength(1);
    expect(infos[0]?.addresses).toEqual([{ ip: "10.0.0.5", prefix: 24 }]);
  });

  // Regression: Windows PowerShell 5.1 has no `ConvertTo-Json -AsArray`, so the
  // original script emitted {"adapters":null,"addresses":null} and enumerate()
  // died with "Cannot read properties of null (reading 'Status')".
  it("reports an actionable error when PowerShell yields a null inventory", async () => {
    const service = new WindowsInterfaceService({
      run: async () => ok('{"adapters":null,"addresses":null}'),
    });
    await expect(service.enumerate()).rejects.toThrow(/no network adapter inventory/i);
  });

  it("uses a Windows PowerShell 5.1 compatible inventory script", async () => {
    let script = "";
    const service = new WindowsInterfaceService({
      run: async (_cmd, args) => {
        script = args[args.length - 1] ?? "";
        return ok(inventory([adapter()]));
      },
    });
    await service.enumerate();
    // -AsArray is PowerShell 6+ only; on 5.1 it throws and yields null.
    expect(script).not.toContain("-AsArray");
    // The inner results must not be pre-serialized into strings before the
    // outer ConvertTo-Json, or they arrive double-encoded.
    expect(script).toMatch(/ConvertTo-Json[^\n]*-Depth/);
    expect(script.match(/ConvertTo-Json/g) ?? []).toHaveLength(1);
  });
});
