import {
  DUMPCAP_BACKEND,
  type Elevator,
  type EngineServices,
  type InterfaceService,
  LinuxInterfaceService,
  LinuxNetworkConfigService,
  type NetworkInterfaceInfo,
  type PacketSource,
  SubprocessPacketSource,
  SudoElevator,
  TCPDUMP_BACKEND,
  UacElevator,
  WindowsInterfaceService,
  WindowsNetworkConfigService,
  pingProbe,
} from "@etherfind/core";

export type ServiceOverrides = {
  /** Elevator override (tests / custom privilege flows). */
  elevator?: Elevator;
  onDebug?: (line: string) => void;
  /** Restrict enumeration to a specific interface. */
  allInterfaces?: boolean;
};

const CAPTURE_FILTER = "arp or ip or ip6";

/**
 * Builds the real platform wiring: interface enumeration, link monitoring,
 * packet capture (tcpdump on Linux, dumpcap+Npcap on Windows) and the
 * narrow-privilege network configuration layer.
 *
 * The Node process itself stays unprivileged:
 * - Linux: capture via tcpdump (may be pre-authorized through filecaps or a
 *   scoped sudoers entry); address changes go through a short `sudo` call.
 * - Windows: capture via dumpcap (Npcap); address changes through a UAC
 *   elevated child process started with Start-Process -Verb RunAs.
 */
export function createRealServices(overrides: ServiceOverrides = {}): EngineServices {
  const onDebug = overrides.onDebug;

  const packetSourceFactory = (info: NetworkInterfaceInfo): PacketSource => {
    if (process.platform === "win32") {
      const captureDevice = info.captureName ?? info.name;
      onDebug?.(`capture backend: dumpcap on ${captureDevice}`);
      return new SubprocessPacketSource({
        backend: DUMPCAP_BACKEND,
        captureDevice,
        filter: CAPTURE_FILTER,
        onDebug,
      });
    }
    onDebug?.(`capture backend: tcpdump on ${info.name}`);
    return new SubprocessPacketSource({
      backend: TCPDUMP_BACKEND,
      captureDevice: info.name,
      filter: CAPTURE_FILTER,
      onDebug,
    });
  };

  if (process.platform === "win32") {
    const interfaceService = new WindowsInterfaceService();
    const elevator = overrides.elevator ?? new UacElevator();
    const networkConfig = new WindowsNetworkConfigService({
      runElevated: (argv) => elevator.run(argv),
    });
    return {
      interfaceService,
      packetSourceFactory,
      linkMonitorFactory: (info) => interfaceService.linkMonitor(info.name),
      networkConfig,
      pingProbe: async (ip) => {
        const r = await pingProbe(ip);
        return { ok: r.ok, detail: r.detail };
      },
    };
  }

  const interfaceService: InterfaceService = new LinuxInterfaceService();
  const linuxIface = interfaceService as LinuxInterfaceService;
  const elevator = overrides.elevator ?? new SudoElevator();
  const networkConfig = new LinuxNetworkConfigService({
    runPrivileged: async (args) => {
      onDebug?.(`privileged: ip ${args.join(" ")}`);
      return elevator.run(["ip", ...args]);
    },
  });
  return {
    interfaceService,
    packetSourceFactory,
    linkMonitorFactory: (info) => linuxIface.linkMonitor(info.name),
    networkConfig,
    pingProbe: async (ip) => {
      const r = await pingProbe(ip);
      return { ok: r.ok, detail: r.detail };
    },
  };
}
