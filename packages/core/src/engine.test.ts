import { describe, expect, it } from "vitest";
import type { CapturedFrame } from "./capture/packet-source.js";
import { SimulatedPacketSource } from "./capture/simulated-source.js";
import {
  DEVICE_IP,
  DEVICE_MAC,
  arpFrameFrom as arpFrame,
} from "./discovery/decoders/test-packets.js";
import { DiscoveryEngine, type EngineEvent, type EngineServices } from "./engine.js";
import type { NetworkInterfaceInfo } from "./models/interface.js";
import type { InterfaceSnapshot, NetworkConfigService } from "./network-config/types.js";
import { waitFor, whenCapturing, whenPhase } from "./test-support/wait-for.js";

function iface(name: string, over: Partial<NetworkInterfaceInfo> = {}): NetworkInterfaceInfo {
  return {
    name,
    displayName: name,
    linkState: "up",
    kind: "ethernet",
    physical: true,
    addresses: [],
    mac: "aa:bb:cc:dd:ee:ff",
    ...over,
  };
}

class FakeLinkMonitor {
  listeners: Array<(s: "up" | "down") => void> = [];
  state: "up" | "down" = "up";
  disposed = false;
  interfaceName: string;
  constructor(name: string) {
    this.interfaceName = name;
  }
  start(): void {}
  current(): "up" | "down" {
    return this.state;
  }
  subscribe(listener: (s: "up" | "down") => void): () => void {
    this.listeners.push(listener);
    return () => {};
  }
  dispose(): void {
    this.disposed = true;
  }
  set(state: "up" | "down"): void {
    this.state = state;
    for (const l of [...this.listeners]) l(state);
  }
}

function fakeConfigService(): NetworkConfigService & { added: string[]; removed: string[] } {
  return {
    added: [],
    removed: [],
    async snapshot(interfaceName: string): Promise<InterfaceSnapshot> {
      return { interfaceName, capturedAt: 0, addresses: [], dhcpEnabled: true, details: {} };
    },
    async addAddress(_interfaceName: string, ip: string) {
      this.added.push(ip);
      return {};
    },
    async removeAddress(_interfaceName: string, ip: string) {
      this.removed.push(ip);
    },
  };
}

type Harness = {
  engine: DiscoveryEngine;
  runPromise: Promise<{
    candidate?: { ip: string; mac: string };
    reachable: boolean;
    viaTemporaryAddress: boolean;
  }>;
  source: SimulatedPacketSource;
  monitor: FakeLinkMonitor;
  config: ReturnType<typeof fakeConfigService>;
  events: EngineEvent[];
};

function makeHarness(opts: {
  ifaces?: NetworkInterfaceInfo[];
  engineOptions?: { skipReplug?: boolean; noConfigure?: boolean; listenOnly?: boolean };
  confirm?: boolean;
  ping?: (ip: string) => Promise<{ ok: boolean; detail: string }>;
}): Harness {
  const source = new SimulatedPacketSource();
  const monitor = new FakeLinkMonitor("eth0");
  const config = fakeConfigService();
  const services: EngineServices = {
    interfaceService: { enumerate: async () => opts.ifaces ?? [iface("eth0")] },
    packetSourceFactory: () => source,
    linkMonitorFactory: () => monitor,
    networkConfig: config,
    pingProbe: opts.ping,
  };
  const events: EngineEvent[] = [];
  const engine = new DiscoveryEngine(services, opts.engineOptions ?? {}, {
    confirmConfigure: async () => opts.confirm ?? true,
  });
  engine.onEvent((e) => events.push(e));
  const runPromise = engine.run() as Harness["runPromise"];
  return { engine, runPromise, source, monitor, config, events };
}

describe("DiscoveryEngine", () => {
  it("guides replug: link down → link up → ARP → configure → verified", async () => {
    const h = makeHarness({
      confirm: true,
      ping: async (ip) => ({ ok: true, detail: `ttl=64 ${ip}` }),
    });
    await whenPhase(h.engine, "waiting-for-disconnect");
    expect(h.engine.phase).toBe("waiting-for-disconnect");
    h.monitor.set("down");
    expect(h.engine.phase).toBe("waiting-for-link");
    h.monitor.set("up");
    await whenCapturing(h.source, h.engine);
    expect(h.engine.phase).toBe("listening");
    h.source.emit(arpFrame().data);
    const result = await h.runPromise;
    expect(result.candidate).toMatchObject({ ip: DEVICE_IP, mac: DEVICE_MAC });
    expect(result.reachable).toBe(true);
    expect(result.viaTemporaryAddress).toBe(true);
    expect(h.config.added).toEqual(["192.168.5.254"]);
    const kinds = h.events.map((e) => e.type);
    expect(kinds).toEqual([
      "interfaces",
      "interface-selected",
      "phase-changed", // waiting-for-disconnect
      "link-state", // down
      "phase-changed", // waiting-for-link
      "link-state", // up
      "phase-changed", // listening
      "listening",
      "phase-changed", // device-found
      "device-found",
      "reachability",
      "phase-changed", // configuring
      "configuration-start",
      "phase-changed", // verifying
      "configuration-applied",
      "phase-changed", // connected
      "verification",
      "ready",
    ]);
  });

  it("skipReplug + noConfigure discovers without touching the network", async () => {
    const h = makeHarness({ engineOptions: { skipReplug: true, noConfigure: true } });
    await whenCapturing(h.source, h.engine);
    h.source.emit(arpFrame().data);
    const result = await h.runPromise;
    expect(result.candidate).toMatchObject({ ip: DEVICE_IP });
    expect(result.reachable).toBe(false);
    expect(h.config.added).toHaveLength(0);
    expect(h.events.some((e) => e.type === "device-found")).toBe(true);
  });

  it("declining configuration leaves the network untouched", async () => {
    const h = makeHarness({
      ifaces: [iface("eth0", { addresses: [{ ip: "10.9.9.5", prefix: 24 }] })],
      confirm: false,
      ping: async () => ({ ok: true, detail: "" }),
    });
    await whenPhase(h.engine, "waiting-for-disconnect");
    h.monitor.set("down");
    h.monitor.set("up");
    await whenCapturing(h.source, h.engine);
    h.source.emit(arpFrame().data);
    const result = await h.runPromise;
    expect(result.reachable).toBe(false);
    expect(h.config.added).toHaveLength(0);
    expect(h.events.some((e) => e.type === "reachability" && !e.result.reachable)).toBe(true);
  });

  it("already-reachable subnet skips configuration and verifies directly", async () => {
    const h = makeHarness({
      ifaces: [iface("eth0", { addresses: [{ ip: "192.168.5.7", prefix: 24 }] })],
      ping: async () => ({ ok: true, detail: "ttl=64" }),
    });
    await whenPhase(h.engine, "waiting-for-disconnect");
    h.monitor.set("down");
    h.monitor.set("up");
    await whenCapturing(h.source, h.engine);
    h.source.emit(arpFrame().data);
    const result = await h.runPromise;
    expect(result.reachable).toBe(true);
    expect(result.viaTemporaryAddress).toBe(false);
    expect(h.config.added).toHaveLength(0);
  });

  it("failed ping reports unreachable even after applying the temporary address", async () => {
    const h = makeHarness({ confirm: true, ping: async () => ({ ok: false, detail: "timeout" }) });
    await whenPhase(h.engine, "waiting-for-disconnect");
    h.monitor.set("down");
    h.monitor.set("up");
    await whenCapturing(h.source, h.engine);
    h.source.emit(arpFrame().data);
    const result = await h.runPromise;
    expect(h.config.added).toEqual(["192.168.5.254"]);
    expect(result.reachable).toBe(false);
    expect(h.events.some((e) => e.type === "verification" && !e.ok)).toBe(true);
  });

  it("listenOnly stops right after discovery", async () => {
    const h = makeHarness({ engineOptions: { skipReplug: true, listenOnly: true } });
    await whenCapturing(h.source, h.engine);
    h.source.emit(arpFrame().data);
    const result = await h.runPromise;
    expect(result.candidate).toMatchObject({ ip: DEVICE_IP });
    expect(h.config.added).toHaveLength(0);
  });

  it("shutdown disposes capture/monitor; restore removes applied addresses", async () => {
    const h = makeHarness({});
    await whenPhase(h.engine, "waiting-for-disconnect");
    h.monitor.set("down");
    h.monitor.set("up");
    await whenCapturing(h.source, h.engine);
    h.source.emit(arpFrame().data);
    await h.runPromise;
    await h.engine.shutdown();
    expect(h.source.isRunning).toBe(false);
    expect(h.monitor.disposed).toBe(true);
  });

  it("fatal capture error ends the run with a clear error event", async () => {
    const source: SimulatedPacketSource = new SimulatedPacketSource();
    const engine = new DiscoveryEngine(
      {
        interfaceService: { enumerate: async () => [iface("eth0")] },
        packetSourceFactory: () => source,
      },
      { skipReplug: true },
    );
    const events: EngineEvent[] = [];
    engine.onEvent((e) => events.push(e));
    const runPromise = engine.run();
    await whenCapturing(source, engine);
    source.fail("You don't have permission to perform this capture");
    const result = await runPromise;
    expect(result.candidate).toBeUndefined();
    expect(events.some((e) => e.type === "error" && e.fatal)).toBe(true);
  });

  it("selects the explicit interface by name", async () => {
    const source = new SimulatedPacketSource();
    const engine = new DiscoveryEngine(
      {
        interfaceService: { enumerate: async () => [iface("eth0"), iface("eth1")] },
        packetSourceFactory: () => source,
      },
      { skipReplug: true, noConfigure: true, interfaceName: "eth1" },
    );
    const runPromise = engine.run();
    await waitFor(
      () => engine.selectedInterface !== undefined,
      () => "the interface to be selected",
    );
    expect(engine.selectedInterface?.name).toBe("eth1");
    source.fail("stop"); // end the run
    await runPromise;
  });

  it("throws when the requested interface does not exist", async () => {
    const engine = new DiscoveryEngine(
      {
        interfaceService: { enumerate: async () => [iface("eth0")] },
        packetSourceFactory: () => new SimulatedPacketSource(),
      },
      { interfaceName: "nope0" },
    );
    await expect(engine.run()).rejects.toThrow(/not found/);
  });

  // Regression: on a machine with no Ethernet NIC, run() throws during
  // interface selection while the phase is still "idle". shutdown() then hit
  // "Invalid transition: beginCleanup in phase \"idle\"" and crashed the CLI
  // with an unhandled rejection instead of reporting the real error.
  it("shuts down cleanly when no usable interface exists", async () => {
    const h = makeHarness({ ifaces: [] });
    await expect(h.runPromise).rejects.toThrow(/No usable Ethernet interface/);
    expect(h.engine.phase).toBe("idle");
    await expect(h.engine.shutdown()).resolves.toBeUndefined();
  });

  it("tolerates shutdown() being called twice", async () => {
    const h = makeHarness({ ifaces: [] });
    await expect(h.runPromise).rejects.toThrow();
    await h.engine.shutdown();
    await expect(h.engine.shutdown()).resolves.toBeUndefined();
  });
});
