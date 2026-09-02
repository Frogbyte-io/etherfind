import type { PacketSource } from "./capture/packet-source.js";
import { SimulatedPacketSource } from "./capture/simulated-source.js";
import {
  DEVICE_IP,
  DEVICE_MAC,
  arpPacket,
  ethernet,
  ipv4Packet,
  udpPacket,
} from "./discovery/decoders/test-packets.js";
import { DiscoveryEngine, type EngineServices } from "./engine.js";
import type { Ipv4Address } from "./models/address.js";
import type { LinkMonitor, NetworkInterfaceInfo, Unsubscribe } from "./models/interface.js";
import type { InterfaceSnapshot, NetworkConfigService } from "./network-config/types.js";

/** Manual link monitor driven by the simulation script. */
export class ManualLinkMonitor implements LinkMonitor {
  readonly interfaceName: string;
  #state: "up" | "down" | "unknown";
  #listeners = new Set<(state: "up" | "down" | "unknown") => void>();

  constructor(interfaceName: string, initial: "up" | "down" | "unknown" = "up") {
    this.interfaceName = interfaceName;
    this.#state = initial;
  }

  start(): void {}
  current(): "up" | "down" | "unknown" {
    return this.#state;
  }
  subscribe(listener: (state: "up" | "down" | "unknown") => void): Unsubscribe {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  dispose(): void {
    this.#listeners.clear();
  }
  set(state: "up" | "down" | "unknown"): void {
    if (state === this.#state) return;
    this.#state = state;
    for (const l of [...this.#listeners]) l(state);
  }
}

/** Fake network configuration tracking adds/removes in memory. */
export class SimulatedNetworkConfig implements NetworkConfigService {
  added: Array<{ interfaceName: string; ip: Ipv4Address; prefix: number }> = [];
  failNextAdd = false;

  async snapshot(interfaceName: string): Promise<InterfaceSnapshot> {
    return { interfaceName, capturedAt: Date.now(), addresses: [], dhcpEnabled: true, details: {} };
  }

  async addAddress(
    interfaceName: string,
    ip: Ipv4Address,
    prefix: number,
  ): Promise<Record<string, string>> {
    if (this.failNextAdd) {
      this.failNextAdd = false;
      throw new Error("simulated configuration failure");
    }
    this.added.push({ interfaceName, ip, prefix });
    return {};
  }

  async removeAddress(interfaceName: string, ip: Ipv4Address, prefix: number): Promise<void> {
    this.added = this.added.filter(
      (a) => !(a.interfaceName === interfaceName && a.ip === ip && a.prefix === prefix),
    );
  }
}

export type SimulatedDeviceOptions = {
  mac?: string;
  ip?: Ipv4Address;
  /** Whether the simulated device announces a gratuitous ARP on link-up. */
  announceOnLinkUp?: boolean;
};

/**
 * Complete simulated platform: interfaces, link, packets and configuration.
 * Powers `etherfind --simulate` and E2E tests without physical hardware.
 */
export class SimulatedPlatform {
  readonly source = new SimulatedPacketSource("simulated device link");
  readonly monitor: ManualLinkMonitor;
  readonly networkConfig = new SimulatedNetworkConfig();
  readonly interfaces: NetworkInterfaceInfo[];
  device: Required<SimulatedDeviceOptions>;
  pingOk = true;

  constructor(device: SimulatedDeviceOptions = {}) {
    this.device = {
      mac: device.mac ?? DEVICE_MAC,
      ip: device.ip ?? DEVICE_IP,
      announceOnLinkUp: device.announceOnLinkUp ?? true,
    };
    this.interfaces = [
      {
        name: "simeth0",
        displayName: "Simulated Ethernet",
        mac: "aa:bb:cc:dd:ee:01",
        linkState: "up",
        kind: "ethernet",
        physical: true,
        addresses: [],
        driverDescription: "Etherfind Simulated NIC",
      },
      {
        name: "simwlan0",
        displayName: "Simulated Wi-Fi",
        mac: "aa:bb:cc:dd:ee:02",
        linkState: "up",
        kind: "wifi",
        physical: true,
        addresses: [{ ip: "192.168.1.10", prefix: 24 }],
        driverDescription: "Etherfind Simulated WLAN",
      },
    ];
    // The simulated device starts connected, like the real scenario.
    this.monitor = new ManualLinkMonitor("simeth0", "up");
  }

  /** The user plugs the cable into the device: link comes up, device announces itself. */
  plugInDevice(delayMs = 300): void {
    this.monitor.set("up");
    if (this.device.announceOnLinkUp) {
      setTimeout(() => {
        this.emitGratuitousArp();
        this.emitIpv4Traffic();
      }, delayMs);
    }
  }

  /** The user unplugs the cable. */
  unplug(): void {
    this.monitor.set("down");
  }

  emitGratuitousArp(mac = this.device.mac, ip = this.device.ip): void {
    const payload = arpPacket({ operation: 1, senderMac: mac, senderIp: ip, targetIp: ip });
    this.source.emit(ethernet({ src: mac, ethertype: 0x0806, payload }));
  }

  emitIpv4Traffic(mac = this.device.mac, ip = this.device.ip): void {
    const udp = udpPacket(40000, 5353, new Uint8Array(24));
    const pkt = ipv4Packet({ src: ip, dst: "224.0.0.251", protocol: 17, payload: udp });
    this.source.emit(ethernet({ src: mac, ethertype: 0x0800, payload: pkt }));
  }

  services(): EngineServices {
    return {
      interfaceService: {
        enumerate: async () => this.interfaces,
      },
      packetSourceFactory: (): PacketSource => this.source,
      linkMonitorFactory: (): LinkMonitor => this.monitor,
      networkConfig: this.networkConfig,
      pingProbe: async (ip) => ({
        ok: this.pingOk,
        detail: this.pingOk ? `simulated ping to ${ip} ok` : "simulated timeout",
      }),
    };
  }

  createEngine(
    options: ConstructorParameters<typeof DiscoveryEngine>[1] = {},
    callbacks: ConstructorParameters<typeof DiscoveryEngine>[2] = {},
  ): DiscoveryEngine {
    return new DiscoveryEngine(this.services(), options, callbacks);
  }
}
