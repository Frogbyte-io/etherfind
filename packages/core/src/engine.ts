import type { CaptureError, PacketSource } from "./capture/packet-source.js";
import { DeviceObserver } from "./discovery/device-observer.js";
import { extractObservations } from "./discovery/extractor.js";
import { type DiscoveryPhase, DiscoveryStateMachine } from "./discovery/state-machine.js";
import { selectEthernetInterfaces } from "./interfaces/filtering.js";
import type { InterfaceService } from "./interfaces/interface-service.js";
import type { Ipv4Address, PrefixLength } from "./models/address.js";
import type { DeviceCandidate } from "./models/device.js";
import type { LinkState, NetworkInterfaceInfo } from "./models/interface.js";
import type { LinkMonitor } from "./models/interface.js";
import { CleanupManager } from "./network-config/cleanup-manager.js";
import type { AppliedChange, NetworkConfigService } from "./network-config/types.js";
import { type ReachabilityResult, evaluateReachability } from "./reachability/local-address.js";
import { Emitter } from "./util/emitter.js";

export type EngineServices = {
  interfaceService: InterfaceService;
  /** Creates the packet capture for a selected interface. */
  packetSourceFactory: (info: NetworkInterfaceInfo) => PacketSource;
  /** Creates a link monitor for a selected interface. */
  linkMonitorFactory?: (info: NetworkInterfaceInfo) => LinkMonitor;
  /** Reachability probe (ICMP). Optional; verification is skipped when absent. */
  pingProbe?: (ip: Ipv4Address) => Promise<{ ok: boolean; detail: string }>;
  networkConfig?: NetworkConfigService;
};

export type EngineCallbacks = {
  /** Ask the user to confirm applying a temporary address. */
  confirmConfigure?: (suggestion: ReachabilityResult & { reachable: false }) => Promise<boolean>;
  /** Let the user pick an interface; resolved automatically when absent. */
  selectInterface?: (candidates: NetworkInterfaceInfo[]) => Promise<NetworkInterfaceInfo>;
  onDebug?: (line: string) => void;
};

export type EngineOptions = {
  /** Explicit interface name (non-interactive). */
  interfaceName?: string;
  /** Skip the unplug/replug guidance. */
  skipReplug?: boolean;
  /** Discover but never modify network configuration. */
  noConfigure?: boolean;
  /** Stop as soon as the device is found (no reachability/config steps). */
  listenOnly?: boolean;
  /** Seconds without device traffic before offering timeout actions. */
  listeningTimeoutSeconds?: number;
  journalPath?: string;
};

export type EngineEvent =
  | { type: "phase-changed"; from: DiscoveryPhase; to: DiscoveryPhase }
  | { type: "interfaces"; candidates: NetworkInterfaceInfo[] }
  | { type: "interface-selected"; info: NetworkInterfaceInfo }
  | { type: "link-state"; state: LinkState }
  | { type: "listening" }
  | { type: "device-found"; candidate: DeviceCandidate }
  | { type: "device-updated"; candidate: DeviceCandidate }
  | { type: "listening-timeout"; elapsedMs: number }
  | { type: "reachability"; result: ReachabilityResult }
  | { type: "configuration-start"; ip: Ipv4Address; prefix: PrefixLength; interfaceName: string }
  | { type: "configuration-applied"; change: AppliedChange }
  | { type: "configuration-failed"; error: string }
  | { type: "verification"; ok: boolean; detail: string }
  | { type: "ready"; candidate: DeviceCandidate; reachable: boolean }
  | { type: "cleanup-progress"; message: string }
  | { type: "cleanup-done" }
  | { type: "error"; error: string; fatal: boolean };

export type EngineResult = {
  candidate?: DeviceCandidate;
  reachable: boolean;
  viaTemporaryAddress: boolean;
};

/**
 * Core workflow engine: guides replug, captures traffic, discovers the device,
 * optionally configures a temporary address, verifies reachability and cleans
 * up. Entirely UI-independent: the TUI subscribes to events and answers the
 * injected confirmation callbacks.
 */
export class DiscoveryEngine {
  readonly #services: EngineServices;
  readonly #callbacks: EngineCallbacks;
  readonly #options: EngineOptions;
  readonly #events = new Emitter<EngineEvent>();
  readonly #state = new DiscoveryStateMachine();

  #selected?: NetworkInterfaceInfo;
  #linkMonitor?: LinkMonitor;
  #packetSource?: PacketSource;
  #observer?: DeviceObserver;
  #cleanup?: CleanupManager;
  #bestCandidate?: DeviceCandidate;
  #tempChange?: AppliedChange;
  #timeoutTimer?: NodeJS.Timeout;
  #listeningSince?: number;
  #runAbort = new AbortController();

  constructor(
    services: EngineServices,
    options: EngineOptions = {},
    callbacks: EngineCallbacks = {},
  ) {
    this.#services = services;
    this.#options = options;
    this.#callbacks = callbacks;
    // Bridge state-machine transitions onto engine events.
    this.#state.onEvent((event) => {
      this.#events.emit({ type: "phase-changed", from: event.from, to: event.to });
    });
  }

  onEvent(listener: (event: EngineEvent) => void): () => void {
    return this.#events.subscribe(listener);
  }

  get phase(): DiscoveryPhase {
    return this.#state.phase;
  }

  get selectedInterface(): NetworkInterfaceInfo | undefined {
    return this.#selected;
  }

  get bestCandidate(): DeviceCandidate | undefined {
    return this.#bestCandidate;
  }

  #debug(line: string): void {
    this.#callbacks.onDebug?.(line);
  }

  // -- public control surface ------------------------------------------------

  /** Selects the interface and starts the guided workflow. */
  async run(): Promise<EngineResult> {
    const candidates = await this.#services.interfaceService.enumerate();
    const selectable = selectEthernetInterfaces(candidates, {
      all: this.#options.interfaceName !== undefined,
    });
    this.#events.emit({ type: "interfaces", candidates: selectable });

    let selected: NetworkInterfaceInfo | undefined;
    if (this.#options.interfaceName) {
      selected = candidates.find(
        (c) =>
          c.name.toLowerCase() === this.#options.interfaceName?.toLowerCase() ||
          c.displayName.toLowerCase() === this.#options.interfaceName?.toLowerCase(),
      );
      if (!selected) throw new Error(`Interface "${this.#options.interfaceName}" not found.`);
    } else if (selectable.length === 0) {
      throw new Error("No usable Ethernet interface found. Try --all-interfaces.");
    } else if (this.#callbacks.selectInterface) {
      // Always let the UI present the choice when a selector is registered.
      selected = await this.#callbacks.selectInterface(selectable);
    } else {
      selected = selectable[0];
    }
    if (!selected) throw new Error("No usable Ethernet interface found. Try --all-interfaces.");
    this.#selected = selected;
    this.#events.emit({ type: "interface-selected", info: selected });

    if (this.#services.networkConfig) {
      this.#cleanup = new CleanupManager({
        service: this.#services.networkConfig,
        journalPath: this.#options.journalPath,
      });
      const leftovers = await this.#cleanup.loadJournal();
      if (leftovers.length > 0) {
        this.#debug(
          `found ${leftovers.length} leftover change(s) from a previous session; restoring them now`,
        );
        await this.#cleanup.restore((m) =>
          this.#events.emit({ type: "cleanup-progress", message: m }),
        );
      }
    }

    this.#state.start({ skipReplug: this.#options.skipReplug });
    if (this.#state.phase === "listening") {
      await this.#enterListening();
    } else {
      this.#startLinkWatch();
    }

    return this.#awaitCompletion();
  }

  /** User confirmed they disconnected the cable manually. */
  async confirmDisconnected(): Promise<void> {
    this.#state.confirmDisconnected();
    this.#startLinkWatch();
  }

  /** Skip the replug guidance. */
  async skipReplug(): Promise<void> {
    this.#state.skipReplug();
    await this.#enterListening();
  }

  /** Timeout action: keep listening. */
  async keepListening(): Promise<void> {
    this.#listeningSince = Date.now();
    this.#armListeningTimeout();
  }

  /** Timeout action: restart the replug workflow. */
  async restartWorkflow(): Promise<void> {
    await this.#stopCapture();
    this.#linkMonitor?.dispose();
    this.#linkMonitor = undefined;
    this.#state.restart();
    this.#startLinkWatch();
  }

  /** Ctrl+C / exit: stop capture and restore any configuration. */
  async shutdown(): Promise<void> {
    this.#runAbort.abort();
    clearTimeout(this.#timeoutTimer);
    await this.#stopCapture();
    this.#linkMonitor?.dispose();
    this.#state.beginCleanup();
    await this.#restoreConfiguration();
    this.#state.cleanupComplete();
  }

  // -- workflow internals ----------------------------------------------------

  #startLinkWatch(): void {
    if (!this.#selected || this.#state.phase === "listening") return;
    const monitor = this.#linkMonitorFactory();
    void monitor.start();
    monitor.subscribe((state) => {
      this.#events.emit({ type: "link-state", state });
      if (state === "down" && this.#state.phase === "waiting-for-disconnect") {
        this.#state.linkDown();
      }
      if (state === "up" && this.#state.phase === "waiting-for-link") {
        this.#state.linkUp();
        void this.#enterListening();
      }
    });
  }

  #linkMonitorFactory(): LinkMonitor {
    if (!this.#linkMonitor) {
      const factory = this.#services.linkMonitorFactory ?? (() => this.#fallbackMonitor());
      this.#linkMonitor = factory(this.#selected as NetworkInterfaceInfo);
    }
    return this.#linkMonitor;
  }

  #fallbackMonitor(): LinkMonitor {
    // Without a platform link monitor we rely on capture only; provide a
    // static "up" monitor so the workflow can proceed.
    const info = this.#selected as NetworkInterfaceInfo;
    return {
      interfaceName: info.name,
      current: () => info.linkState,
      subscribe: () => () => {},
      dispose: () => {},
      start: async () => {},
    };
  }

  async #enterListening(): Promise<void> {
    const info = this.#selected as NetworkInterfaceInfo;
    this.#events.emit({ type: "listening" });
    const observer = new DeviceObserver({
      hostMacs: info.mac ? [info.mac] : [],
      hostIps: info.addresses.map((a) => a.ip),
    });
    observer.onEvent((event) => {
      if (event.type === "device-found") {
        if (!this.#bestCandidate) {
          this.#bestCandidate = event.candidate;
          clearTimeout(this.#timeoutTimer);
          try {
            this.#state.deviceFound();
          } catch {
            // Race with shutdown; ignore.
          }
          this.#events.emit({ type: "device-found", candidate: event.candidate });
          void this.#afterDeviceFound();
          return;
        }
      }
      if (event.type === "device-updated" && event.candidate.mac === this.#bestCandidate?.mac) {
        this.#bestCandidate = event.candidate;
        this.#events.emit({ type: "device-updated", candidate: event.candidate });
      }
    });
    this.#observer = observer;

    const source = this.#services.packetSourceFactory(info);
    this.#packetSource = source;
    await source.start({
      onFrame: (frame) => {
        for (const observation of extractObservations(frame)) observer.observe(observation);
      },
      onError: (error: CaptureError) => {
        this.#events.emit({
          type: "error",
          error: `${error.message} ${error.guidance}`.trim(),
          fatal: true,
        });
        void this.shutdown();
      },
    });
    this.#listeningSince = Date.now();
    this.#armListeningTimeout();
  }

  #armListeningTimeout(): void {
    clearTimeout(this.#timeoutTimer);
    const seconds = this.#options.listeningTimeoutSeconds ?? 10;
    this.#timeoutTimer = setTimeout(() => {
      if (this.#state.phase === "listening" && !this.#bestCandidate && this.#listeningSince) {
        this.#events.emit({
          type: "listening-timeout",
          elapsedMs: Date.now() - this.#listeningSince,
        });
      }
    }, seconds * 1000);
    this.#timeoutTimer.unref?.();
  }

  async #afterDeviceFound(): Promise<void> {
    if (this.#options.listenOnly) {
      this.#finishConnected(false);
      return;
    }
    // Re-enumerate: host addresses may have changed since startup.
    const interfaces = await this.#services.interfaceService.enumerate().catch(() => []);
    const deviceIp = (this.#bestCandidate as DeviceCandidate).ip;
    const reachability = evaluateReachability(deviceIp, 24, interfaces);
    this.#events.emit({ type: "reachability", result: reachability });

    if (reachability.reachable) {
      await this.#verify(false);
      return;
    }
    if (this.#options.noConfigure || !this.#services.networkConfig) {
      this.#finishConnected(false);
      return;
    }
    const confirmed = (await this.#callbacks.confirmConfigure?.(reachability)) ?? false;
    if (!confirmed) {
      this.#state.configureDeclined();
      this.#finishConnected(false);
      return;
    }
    // Configure
    this.#state.startConfigure();
    const ifaceName = this.#selected?.name ?? "";
    this.#events.emit({
      type: "configuration-start",
      ip: reachability.suggestion.ip,
      prefix: reachability.suggestion.prefix,
      interfaceName: ifaceName,
    });
    try {
      const change = await (this.#cleanup as CleanupManager).applyTemporaryAddress(
        ifaceName,
        reachability.suggestion.ip,
        reachability.suggestion.prefix,
      );
      this.#tempChange = change;
      this.#state.configApplied();
      this.#events.emit({ type: "configuration-applied", change });
    } catch (error) {
      this.#state.configureFailed();
      this.#events.emit({
        type: "configuration-failed",
        error: error instanceof Error ? error.message : String(error),
      });
      this.#finishConnected(false);
      return;
    }
    await this.#verify(true);
  }

  async #verify(_viaTemporary: boolean): Promise<void> {
    // configApplied() already transitioned configuring→verifying; the
    // already-reachable path still needs device-found→verifying.
    if (this.#state.phase === "device-found") {
      this.#state.startVerify();
    }
    const ip = (this.#bestCandidate as DeviceCandidate).ip;
    if (!this.#services.pingProbe) {
      // No probe available; treat "configured" as success per v0.1 scope.
      this.#state.verificationSucceeded();
      this.#events.emit({
        type: "verification",
        ok: true,
        detail: "skipped (no probe configured)",
      });
      this.#finishConnected(true);
      return;
    }
    // Small settle delay so the OS installs the connected route.
    await new Promise((r) => setTimeout(r, 500));
    let last = { ok: false, detail: "" };
    for (let attempt = 0; attempt < 3; attempt++) {
      last = await this.#services.pingProbe(ip);
      if (last.ok) break;
      await new Promise((r) => setTimeout(r, 800));
    }
    if (last.ok) this.#state.verificationSucceeded();
    else this.#state.verificationFailed();
    this.#events.emit({ type: "verification", ok: last.ok, detail: last.detail });
    this.#finishConnected(last.ok);
  }

  #finishConnected(reachable: boolean): void {
    // Drive the state machine to "connected" from wherever we are, guarding
    // against double transitions from races.
    if (this.#state.phase === "device-found") {
      this.#state.startVerify();
    }
    if (this.#state.phase === "verifying") {
      this.#state.verificationSucceeded();
    }
    const candidate = this.#bestCandidate;
    if (candidate) {
      this.#events.emit({ type: "ready", candidate, reachable });
    }
  }

  async #restoreConfiguration(): Promise<void> {
    if (!this.#cleanup?.hasChanges) return;
    this.#events.emit({ type: "cleanup-progress", message: "Restoring network configuration..." });
    try {
      await this.#cleanup.restore((message) =>
        this.#events.emit({ type: "cleanup-progress", message }),
      );
      this.#events.emit({ type: "cleanup-progress", message: "Temporary address removed" });
    } catch (error) {
      this.#events.emit({
        type: "error",
        error: `Cleanup failed: ${error instanceof Error ? error.message : String(error)}. Run \`etherfind --cleanup\` to retry.`,
        fatal: false,
      });
    }
    this.#events.emit({ type: "cleanup-done" });
  }

  async #stopCapture(): Promise<void> {
    try {
      await this.#packetSource?.stop();
    } catch (error) {
      this.#debug(`capture stop error: ${String(error)}`);
    }
    this.#packetSource = undefined;
  }

  #awaitCompletion(): Promise<EngineResult> {
    return new Promise<EngineResult>((resolve) => {
      const off = this.#events.subscribe((event) => {
        if (event.type === "ready") {
          off();
          resolve({
            candidate: event.candidate,
            reachable: event.reachable,
            viaTemporaryAddress: this.#tempChange !== undefined,
          });
        } else if (event.type === "error" && event.fatal) {
          off();
          resolve({ reachable: false, viaTemporaryAddress: false });
        }
      });
      this.#runAbort.signal.addEventListener("abort", () => off(), { once: true });
    });
  }
}
