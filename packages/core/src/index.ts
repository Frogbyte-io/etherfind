// Models
export type { MacAddress, Ipv4Address, PrefixLength } from "./models/address.js";
export {
  isValidMac,
  normalizeMac,
  isValidIpv4,
  ipv4ToUint32,
  uint32ToIpv4,
  networkOf,
  broadcastOf,
  sameSubnet,
  isPrivateIpv4,
} from "./models/address.js";
export type {
  LinkState,
  InterfaceKind,
  InterfaceAddress,
  NetworkInterfaceInfo,
  LinkMonitor,
  Unsubscribe,
} from "./models/interface.js";
export type { DeviceCandidate, DiscoverySource, ArpObservation } from "./models/device.js";
export {
  DISCOVERY_SOURCE_CONFIDENCE,
  DISCOVERY_SOURCE_LABEL,
  bestDiscoverySource,
} from "./models/device.js";

// State machine
export { DiscoveryStateMachine, type DiscoveryPhase } from "./discovery/state-machine.js";

// Capture
export type { PacketSource, CapturedFrame, CaptureErrorKind } from "./capture/packet-source.js";
export { CaptureError } from "./capture/packet-source.js";
export { SimulatedPacketSource } from "./capture/simulated-source.js";
export {
  SubprocessPacketSource,
  TCPDUMP_BACKEND,
  DUMPCAP_BACKEND,
  resolveDumpcapCommand,
  type SubprocessBackend,
} from "./capture/subprocess-source.js";
export {
  CaptureStreamParser,
  ClassicPcapParser,
  PcapngParser,
} from "./capture/pcap/capture-stream-parser.js";

// Discovery
export {
  DeviceObserver,
  type DeviceObserverEvent,
  type DeviceObserverOptions,
} from "./discovery/device-observer.js";
export { extractObservations, type Observation } from "./discovery/extractor.js";

// Interfaces
export type { InterfaceService } from "./interfaces/interface-service.js";
export {
  selectEthernetInterfaces,
  classifyByName,
  classifyByDescription,
} from "./interfaces/filtering.js";
export { PollingLinkMonitor } from "./interfaces/polling-link-monitor.js";

// Reachability
export {
  evaluateReachability,
  suggestLocalAddress,
  type ReachabilityResult,
  type LocalAddressSuggestion,
} from "./reachability/local-address.js";
export { pingProbe, type PingProbeResult } from "./reachability/ping-probe.js";

// Network configuration
export type {
  NetworkConfigService,
  InterfaceSnapshot,
  AppliedChange,
} from "./network-config/types.js";
export { CleanupManager, type Journal } from "./network-config/cleanup-manager.js";

// Platform
export { LinuxInterfaceService, maskToPrefix } from "./platform/linux/interface-service.js";
export {
  LinuxNetworkConfigService,
  type LinuxNetworkConfigOptions,
} from "./platform/linux/network-config.js";
export {
  WindowsInterfaceService,
  type WinInventory,
} from "./platform/windows/interface-service.js";
export {
  WindowsNetworkConfigService,
  type WindowsNetworkConfigOptions,
} from "./platform/windows/network-config.js";
export { SudoElevator, UacElevator, type Elevator } from "./platform/elevation.js";
export { runFile, type ExecResult } from "./platform/exec.js";

// Engine
export {
  DiscoveryEngine,
  type EngineEvent,
  type EngineOptions,
  type EngineResult,
  type EngineServices,
  type EngineCallbacks,
} from "./engine.js";

// Simulation
export { SimulatedPlatform, ManualLinkMonitor, SimulatedNetworkConfig } from "./simulate.js";
