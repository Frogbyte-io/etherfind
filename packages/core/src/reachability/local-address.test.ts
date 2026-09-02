import { describe, expect, it } from "vitest";
import type { NetworkInterfaceInfo } from "../models/interface.js";
import { evaluateReachability, suggestLocalAddress } from "./local-address.js";

function iface(
  name: string,
  addresses: Array<{ ip: string; prefix: number }>,
): NetworkInterfaceInfo {
  return { name, displayName: name, linkState: "up", kind: "ethernet", physical: true, addresses };
}

describe("suggestLocalAddress", () => {
  it("prefers .254 in the device's /24", () => {
    expect(suggestLocalAddress("192.168.5.100", [])).toEqual({
      ip: "192.168.5.254",
      prefix: 24,
      assumed: true,
    });
  });

  it("avoids the device's own address", () => {
    expect(suggestLocalAddress("192.168.5.254", []).ip).toBe("192.168.5.250");
  });

  it("avoids network and broadcast addresses", () => {
    const suggestion = suggestLocalAddress("10.137.42.83", []);
    expect(suggestion.ip).toBe("10.137.42.254");
    expect(suggestion.assumed).toBe(true);
  });

  it("avoids addresses used by other local interfaces", () => {
    const existing = [iface("wlan0", [{ ip: "192.168.5.254", prefix: 24 }])];
    expect(suggestLocalAddress("192.168.5.100", existing).ip).toBe("192.168.5.250");
  });

  it("falls back to a scan when preferred suffixes are taken", () => {
    const existing = [1, 2, 10, 20, 50, 100, 150, 200, 250, 254].map((s) =>
      iface(`x${s}`, [{ ip: `192.168.5.${s}`, prefix: 24 }]),
    );
    const suggestion = suggestLocalAddress("192.168.5.100", existing);
    expect(suggestion.ip).toBe("192.168.5.3");
  });
});

describe("evaluateReachability", () => {
  it("reports reachable when the host already has an address in the subnet", () => {
    const ifaces = [iface("eth0", [{ ip: "192.168.5.7", prefix: 24 }])];
    const result = evaluateReachability("192.168.5.100", 24, ifaces);
    expect(result).toEqual({
      reachable: true,
      via: { ip: "192.168.5.7", prefix: 24, interfaceName: "eth0" },
    });
  });

  it("reports reachable when local prefix is wider than the assumption", () => {
    const ifaces = [iface("eth0", [{ ip: "192.168.0.7", prefix: 16 }])];
    const result = evaluateReachability("192.168.5.100", 24, ifaces);
    expect(result.reachable).toBe(true);
  });

  it("suggests a temporary address when the subnet is unknown to the host", () => {
    const ifaces = [iface("wlan0", [{ ip: "10.0.0.5", prefix: 24 }])];
    const result = evaluateReachability("192.168.5.100", 24, ifaces);
    if (result.reachable) throw new Error("expected unreachable");
    expect(result.suggestion).toEqual({ ip: "192.168.5.254", prefix: 24, assumed: true });
  });

  it("never suggests the device's own address", () => {
    const ifaces = [iface("wlan0", [{ ip: "172.16.0.5", prefix: 24 }])];
    const result = evaluateReachability("172.16.30.254", 24, ifaces);
    if (result.reachable) throw new Error("expected unreachable");
    expect(result.suggestion.ip).toBe("172.16.30.250");
  });
});
