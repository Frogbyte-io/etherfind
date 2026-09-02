import { describe, expect, it, vi } from "vitest";
import { DeviceObserver } from "./device-observer.js";
import type { Observation } from "./extractor.js";

const T0 = 1_000;

function arp(over: Partial<Extract<Observation, { kind: "arp" }>["data"]> = {}): Observation {
  return {
    kind: "arp",
    at: T0,
    data: {
      mac: "38:2a:8c:12:34:56",
      ip: "192.168.5.100",
      gratuitous: false,
      kind: "request",
      ...over,
    },
  };
}

describe("DeviceObserver", () => {
  it("extracts IP and MAC from an ARP packet", () => {
    const observer = new DeviceObserver();
    const events: unknown[] = [];
    observer.onEvent((e) => events.push(e));
    observer.observe(arp({ kind: "request" }));
    expect(observer.candidates()).toEqual([
      expect.objectContaining({
        mac: "38:2a:8c:12:34:56",
        ip: "192.168.5.100",
        source: "arp-request",
      }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "device-found" });
  });

  it("prefers gratuitous ARP as the highest-confidence source", () => {
    const observer = new DeviceObserver();
    const updates: string[] = [];
    observer.onEvent((e) => {
      if (e.type === "device-updated") updates.push(e.candidate.source);
    });
    observer.observe(arp({ kind: "request" }));
    expect(observer.candidates()[0]?.source).toBe("arp-request");
    observer.observe(arp({ gratuitous: true }));
    expect(observer.candidates()[0]?.source).toBe("gratuitous-arp");
    expect(updates).toContain("gratuitous-arp");
  });

  it("ignores packets originating from the host MAC or host IP", () => {
    const observer = new DeviceObserver({
      hostMacs: ["aa:bb:cc:dd:ee:ff"],
      hostIps: ["192.168.5.7"],
    });
    observer.observe(arp({ mac: "aa:bb:cc:dd:ee:ff" }));
    observer.observe({
      kind: "ipv4",
      at: T0,
      data: { mac: "38:2a:8c:12:34:56", ip: "192.168.5.7" },
    });
    observer.observe({
      kind: "mdns",
      at: T0,
      data: { mac: "38:2a:8c:12:34:56", ip: "192.168.5.7" },
    });
    expect(observer.candidates()).toHaveLength(0);
  });

  it("ignores multicast, loopback and unspecified IPv4 sources", () => {
    const observer = new DeviceObserver();
    for (const ip of [
      "0.0.0.0",
      "224.0.0.251",
      "239.255.255.250",
      "255.255.255.255",
      "127.0.0.1",
    ]) {
      observer.observe({ kind: "ipv4", at: T0, data: { mac: "38:2a:8c:12:34:56", ip } });
    }
    expect(observer.candidates()).toHaveLength(0);
  });

  it("accepts APIPA addresses as real device addresses", () => {
    const observer = new DeviceObserver();
    observer.observe(arp({ ip: "169.254.77.3" }));
    expect(observer.candidates()).toHaveLength(1);
  });

  it("merges evidence for the same MAC and emits device-updated", () => {
    const observer = new DeviceObserver();
    const events: string[] = [];
    observer.onEvent((e) => events.push(e.type));
    observer.observe(arp({ mac: "38:2a:8c:12:34:56", ip: "192.168.5.100" }));
    observer.observe({
      kind: "ipv4",
      at: T0 + 1,
      data: { mac: "38:2a:8c:12:34:56", ip: "192.168.5.100" },
    });
    const candidate = observer.candidates()[0];
    expect(candidate?.sources).toEqual(expect.arrayContaining(["arp-request", "ipv4-source"]));
    expect(events).toEqual(["device-found", "device-updated"]);
  });

  it("attaches mDNS hostname to an existing candidate", () => {
    const observer = new DeviceObserver();
    observer.observe(arp({ ip: "192.168.5.100" }));
    observer.observe({
      kind: "mdns",
      at: T0 + 1,
      data: { mac: "38:2a:8c:12:34:56", ip: "192.168.5.100", hostname: "dev.local" },
    });
    expect(observer.candidates()[0]?.hostname).toBe("dev.local");
  });

  it("remembers a DHCP hostname for a MAC that has no IP yet", () => {
    const observer = new DeviceObserver();
    observer.observe({
      kind: "dhcp",
      at: T0,
      data: { mac: "38:2a:8c:12:34:56", hostname: "tool" },
    });
    expect(observer.candidates()).toHaveLength(0);
    observer.observe(arp({ ip: "10.0.0.9" }));
    expect(observer.candidates()[0]).toMatchObject({ ip: "10.0.0.9", hostname: "tool" });
  });

  it("tracks multiple devices and sorts by recency", () => {
    const observer = new DeviceObserver();
    observer.observe(arp({ mac: "aa:aa:aa:aa:aa:aa", ip: "10.0.0.1" }));
    observer.observe({
      kind: "ipv4",
      at: T0 + 5,
      data: { mac: "bb:bb:bb:bb:bb:bb", ip: "10.0.0.2" },
    });
    expect(observer.candidates().map((c) => c.mac)).toEqual([
      "bb:bb:bb:bb:bb:bb",
      "aa:aa:aa:aa:aa:aa",
    ]);
  });

  it("unsubscribes listeners", () => {
    const observer = new DeviceObserver();
    const spy = vi.fn();
    const off = observer.onEvent(spy);
    off();
    observer.observe(arp());
    expect(spy).not.toHaveBeenCalled();
  });
});
