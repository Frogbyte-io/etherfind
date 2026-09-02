import { Box, Text, useApp, useInput } from "ink";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  DISCOVERY_SOURCE_LABEL,
  DiscoveryEngine,
  type DeviceCandidate,
  type EngineEvent,
  type EngineOptions,
  type EngineServices,
  type NetworkInterfaceInfo,
  type ReachabilityResult,
} from "@etherfind/core";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function Spinner() {
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
    return () => clearInterval(t);
  }, []);
  return <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>;
}

const OK = (props: { children?: React.ReactNode }) => <Text color="green">✔ {props.children}</Text>;
const INFO = (props: { children?: React.ReactNode }) => <Text color="cyan">● {props.children}</Text>;
const WARN = (props: { children?: React.ReactNode }) => <Text color="yellow">⚠ {props.children}</Text>;

function Header() {
  return (
    <Box marginBottom={1} flexDirection="column">
      <Text bold color="cyan">
        Etherfind
      </Text>
      <Text dimColor>Find the IP address of a directly connected Ethernet device</Text>
    </Box>
  );
}

export type AppProps = {
  services: EngineServices;
  options: EngineOptions;
  debug: boolean;
  onFinished: () => void;
};

type PendingConfirm = {
  suggestion: Extract<ReachabilityResult, { reachable: false }>["suggestion"];
  resolve: (yes: boolean) => void;
};

type PendingSelect = {
  candidates: NetworkInterfaceInfo[];
  resolve: (info: NetworkInterfaceInfo) => void;
};

/**
 * Ink renders `useInput` handlers with potentially stale closures, so all
 * input-relevant state is mirrored into a ref that the handler reads.
 */
type UiState = {
  pendingSelect: PendingSelect | null;
  pendingConfirm: PendingConfirm | null;
  ready: { candidate: DeviceCandidate; reachable: boolean } | null;
  phase: string;
  timeoutMenu: boolean;
};

export function App(props: AppProps) {
  const { exit } = useApp();
  const engineRef = useRef<DiscoveryEngine | undefined>(undefined);

  const [phase, setPhase] = useState("idle");
  const [pendingSelect, setPendingSelect] = useState<PendingSelect | null>(null);
  const [selectIndex, setSelectIndex] = useState(0);
  const [selected, setSelected] = useState<NetworkInterfaceInfo | undefined>();
  const [linkState, setLinkState] = useState<string | undefined>();
  const [device, setDevice] = useState<DeviceCandidate | undefined>();
  const [reachability, setReachability] = useState<ReachabilityResult | undefined>();
  const [pendingConfirm, setPendingConfirm] = useState<PendingConfirm | null>(null);
  const [configuring, setConfiguring] = useState<{ ip: string; prefix: number } | undefined>();
  const [verification, setVerification] = useState<{ ok: boolean; detail: string } | undefined>();
  const [ready, setReady] = useState<{ candidate: DeviceCandidate; reachable: boolean } | null>(null);
  const [cleanupLines, setCleanupLines] = useState<string[]>([]);
  const [error, setError] = useState<{ message: string; fatal: boolean } | undefined>();
  const [listeningSeconds, setListeningSeconds] = useState(0);
  const [timeoutMenu, setTimeoutMenu] = useState(false);
  const [copyHint, setCopyHint] = useState<string | undefined>();
  const [finished, setFinished] = useState(false);

  const uiRef = useRef<UiState>({
    pendingSelect: null,
    pendingConfirm: null,
    ready: null,
    phase: "idle",
    timeoutMenu: false,
  });

  // Timer while listening.
  useEffect(() => {
    if (phase !== "listening") return;
    const t = setInterval(() => setListeningSeconds((s) => s + 1), 1000);
    return () => clearInterval(t);
  }, [phase]);

  // Engine lifecycle. Mounted once; the engine drives everything via events.
  // biome-ignore lint/correctness/useExhaustiveDependencies: lifecycle effect must run exactly once
  useEffect(() => {
    const engine = new DiscoveryEngine(props.services, props.options, {
      confirmConfigure: (result) =>
        new Promise<boolean>((resolve) => {
          const pending = { suggestion: result.suggestion, resolve };
          uiRef.current.pendingConfirm = pending;
          setPendingConfirm(pending);
        }),
      selectInterface: (cands) =>
        new Promise<NetworkInterfaceInfo>((resolve) => {
          setSelectIndex(0);
          const pending = { candidates: cands, resolve };
          uiRef.current.pendingSelect = pending;
          setPendingSelect(pending);
        }),
      onDebug: props.debug
        ? (line) => {
            process.stderr.write(`[debug] ${line}\n`);
          }
        : undefined,
    });
    engineRef.current = engine;

    const off = engine.onEvent((event: EngineEvent) => {
      if (props.debug) process.stderr.write(`[tui] event: ${event.type}\n`);
      switch (event.type) {
        case "phase-changed":
          uiRef.current.phase = event.to;
          setPhase(event.to);
          break;
        case "interface-selected":
          setSelected(event.info);
          uiRef.current.pendingSelect = null;
          setPendingSelect(null);
          break;
        case "link-state":
          setLinkState(event.state);
          break;
        case "device-found":
          setDevice(event.candidate);
          break;
        case "device-updated":
          setDevice(event.candidate);
          break;
        case "listening-timeout":
          uiRef.current.timeoutMenu = true;
          setTimeoutMenu(true);
          break;
        case "reachability":
          setReachability(event.result);
          break;
        case "configuration-start":
          setConfiguring({ ip: event.ip, prefix: event.prefix });
          break;
        case "configuration-failed":
          setError({ message: event.error, fatal: false });
          break;
        case "verification":
          setVerification(event);
          break;
        case "ready":
          uiRef.current.ready = { candidate: event.candidate, reachable: event.reachable };
          setReady({ candidate: event.candidate, reachable: event.reachable });
          break;
        case "cleanup-progress":
          setCleanupLines((lines) => [...lines, event.message]);
          break;
        case "error":
          setError({ message: event.error, fatal: event.fatal });
          break;
        default:
          break;
      }
    });

    uiRef.current.phase = engine.phase;
    setPhase(engine.phase);
    void engine.run().catch((err: unknown) => setError({ message: err instanceof Error ? err.message : String(err), fatal: true }));

    return () => {
      off();
    };
  }, []);

  async function finish() {
    if (props.debug) process.stderr.write("[tui] finish() called\n");
    const engine = engineRef.current;
    if (engine) {
      await engine.shutdown();
    }
    setFinished(true);
    // Give the user a moment to see the restoration summary before exiting.
    setTimeout(() => {
      props.onFinished();
      exit();
    }, 900);
  }

  useInput((input, key) => {
    const ui = uiRef.current;
    if (props.debug) {
      process.stderr.write(
        `[tui] input: ${JSON.stringify({ input, return: key.return, ctrl: key.ctrl })} pendingSelect=${String(ui.pendingSelect !== null)} pendingConfirm=${String(ui.pendingConfirm !== null)} ready=${String(ui.ready !== null)} phase=${ui.phase}\n`,
      );
    }
    // Ctrl+C (0x03) or q quits. Deliberately NOT any ctrl key: Ctrl+D (EOF
    // from a closed stdin pipe) must not tear down the workflow.
    if ((key.ctrl && input === "c") || input === "q") {
      void finish();
      return;
    }
    if (ui.pendingSelect) {
      if (key.upArrow) setSelectIndex((i) => Math.max(0, i - 1));
      if (key.downArrow) setSelectIndex((i) => Math.min(ui.pendingSelect!.candidates.length - 1, i + 1));
      if (key.return || input === "\n") {
        const choice = ui.pendingSelect.candidates[selectIndex];
        if (choice) ui.pendingSelect.resolve(choice);
      }
      return;
    }
    if (ui.pendingConfirm) {
      if (input === "y" || key.return || input === "\n") {
        ui.pendingConfirm.resolve(true);
        ui.pendingConfirm = null;
        setPendingConfirm(null);
      } else if (input === "n" || key.escape) {
        ui.pendingConfirm.resolve(false);
        ui.pendingConfirm = null;
        setPendingConfirm(null);
      }
      return;
    }
    if (ui.phase === "waiting-for-disconnect") {
      if (key.return || input === "\n") void engineRef.current?.confirmDisconnected();
      if (input === "s") void engineRef.current?.skipReplug();
      return;
    }
    if (ui.timeoutMenu && ui.phase === "listening") {
      if (input === "k") {
        ui.timeoutMenu = false;
        setTimeoutMenu(false);
        void engineRef.current?.keepListening();
      } else if (input === "r") {
        ui.timeoutMenu = false;
        setTimeoutMenu(false);
        void engineRef.current?.restartWorkflow();
      }
      return;
    }
    if (ui.ready) {
      if (key.return || input === "\n") void finish();
      if (input === "c") {
        void copyToClipboard(ui.ready.candidate.ip).then((ok) =>
          setCopyHint(ok ? "Copied to clipboard" : "Clipboard unavailable — select and copy manually"),
        );
      }
      if (input === "o") {
        void openBrowser(`http://${ui.ready.candidate.ip}`);
        setCopyHint("Opening browser…");
      }
    }
  });

  const listeningLabel = useMemo(() => `Listening for device traffic… (${listeningSeconds}s)`, [listeningSeconds]);

  return (
    <Box flexDirection="column" gap={1} paddingX={1}>
      <Header />

      {/* Interface selection */}
      {pendingSelect && (
        <Box flexDirection="column">
          <Text bold>Select Ethernet interface:</Text>
          <Box flexDirection="column" marginTop={1}>
            {pendingSelect.candidates.map((c, i) => (
              <Box key={c.name} paddingLeft={2}>
                <Text color={i === selectIndex ? "cyan" : undefined}>
                  {i === selectIndex ? "❯ " : "  "}
                  {c.displayName.padEnd(18)}
                </Text>
                <Text dimColor>
                  {c.driverDescription ?? c.kind} · {c.linkState}
                  {c.kind === "wifi" ? " · wifi" : ""}
                </Text>
              </Box>
            ))}
          </Box>
          <Box marginTop={1}>
            <Text dimColor>↑/↓ choose · Enter select · Ctrl+C quit</Text>
          </Box>
        </Box>
      )}

      {selected && !pendingSelect && (
        <Box>
          <Text dimColor>Interface</Text>
          <Text> {selected.displayName}</Text>
          {linkState && <Text dimColor> ({linkState})</Text>}
        </Box>
      )}

      {/* Workflow screens */}
      {phase === "waiting-for-disconnect" && (
        <Box flexDirection="column">
          <INFO>Disconnect the device from {selected?.displayName ?? "the interface"} if it is already connected.</INFO>
          <Box>
            <Text>Press </Text>
            <Text bold>Enter</Text>
            <Text> when ready · </Text>
            <Text bold>s</Text>
            <Text> to skip unplugging</Text>
          </Box>
        </Box>
      )}

      {phase === "waiting-for-link" && (
        <Box flexDirection="column">
          <Box>
            <Spinner />
            <Text> Waiting for Ethernet link…</Text>
          </Box>
          <Text>Connect the Ethernet cable to the device now.</Text>
          <Text dimColor>s — skip waiting and listen immediately</Text>
        </Box>
      )}

      {phase === "listening" && !device && (
        <Box flexDirection="column">
          <Box>
            <Spinner />
            <Text> {listeningLabel}</Text>
          </Box>
          {timeoutMenu ? (
            <Box flexDirection="column" marginTop={1}>
              <Text>No IP traffic detected.</Text>
              <Text>
                <Text bold>k</Text> keep listening · <Text bold>r</Text> reconnect Ethernet again · <Text bold>q</Text> quit
              </Text>
            </Box>
          ) : (
            <Text dimColor>Waiting for ARP, IPv4, DHCP or mDNS traffic from the device…</Text>
          )}
        </Box>
      )}

      {device && (
        <Box flexDirection="column">
          <OK>Device found</OK>
          <Box flexDirection="column" paddingLeft={2}>
            <Text>
              IP <Text bold>{device.ip}</Text>
            </Text>
            <Text>
              MAC <Text bold>{device.mac}</Text>
            </Text>
            <Text dimColor>
              Source {DISCOVERY_SOURCE_LABEL[device.source]}
              {device.hostname ? ` · ${device.hostname}` : ""}
            </Text>
          </Box>
        </Box>
      )}

      {reachability && !reachability.reachable && !ready && (
        <Box flexDirection="column">
          <WARN>Your computer cannot currently reach this network.</WARN>
          <Text>
            Suggested local address:{" "}
            <Text bold>
              {reachability.suggestion.ip}/{reachability.suggestion.prefix}
            </Text>
            <Text dimColor> (assumed /24)</Text>
          </Text>
        </Box>
      )}
      {reachability?.reachable && <OK>Already reachable via {reachability.via.interfaceName} ({reachability.via.ip})</OK>}

      {pendingConfirm && (
        <Box flexDirection="column">
          <Text>
            Configure <Text bold>{selected?.displayName}</Text> temporarily as{" "}
            <Text bold>
              {pendingConfirm.suggestion.ip}/{pendingConfirm.suggestion.prefix}
            </Text>
            ?
          </Text>
          <Text dimColor>y/Enter yes · n/Esc no — the address is temporary and removed on exit</Text>
        </Box>
      )}

      {phase === "configuring" && (
        <Box>
          <Spinner />
          <Text> Applying temporary address {configuring?.ip}/{configuring?.prefix}…</Text>
        </Box>
      )}

      {phase === "verifying" && (
        <Box>
          <Spinner />
          <Text> Verifying that the device responds…</Text>
        </Box>
      )}

      {verification && !ready && (phase === "verifying" || phase === "connected") && (
        <Box>{verification.ok ? <OK>Device responds</OK> : <WARN>Device did not respond to ping</WARN>}</Box>
      )}

      {ready && (
        <Box flexDirection="column">
          {ready.reachable ? <OK>Device reachable</OK> : <WARN>Found, but not reachable</WARN>}
          <Box flexDirection="column" paddingLeft={2}>
            <Text bold color="green">
              {ready.candidate.ip}
            </Text>
            <Text dimColor>http://{ready.candidate.ip}</Text>
          </Box>
          <Box marginTop={1}>
            <Text dimColor>c copy IP · o open browser · Enter finish · q quit</Text>
          </Box>
          {copyHint && <Text dimColor>{copyHint}</Text>}
        </Box>
      )}

      {cleanupLines.length > 0 && (
        <Box flexDirection="column">
          {cleanupLines.map((line, i) => (
            <Text key={`${i}:${line}`} dimColor>
              {line}
            </Text>
          ))}
        </Box>
      )}

      {error && (
        <Box flexDirection="column">
          <Text color="red">✖ {error.message}</Text>
          {error.fatal && <Text dimColor>Press q to quit.</Text>}
        </Box>
      )}

      {phase === "done" && finished && (
        <Box flexDirection="column">
          <OK>Network configuration restored</OK>
          <Text dimColor>Goodbye.</Text>
        </Box>
      )}
    </Box>
  );
}

async function copyToClipboard(text: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  const commands: Record<string, string[]> = {
    win32: ["clip"],
    darwin: ["pbcopy"],
    linux: ["xclip", "-selection", "clipboard"],
  };
  const [cmd, ...cmdArgs] = commands[process.platform] ?? [];
  if (!cmd) return false;
  return new Promise((resolve) => {
    try {
      const child = spawn(cmd, cmdArgs, { stdio: ["pipe", "ignore", "ignore"], shell: false });
      child.on("error", () => resolve(false));
      child.on("close", (code) => resolve(code === 0));
      child.stdin?.end(text);
    } catch {
      resolve(false);
    }
  });
}

async function openBrowser(url: string): Promise<void> {
  const { spawn } = await import("node:child_process");
  const argv =
    process.platform === "win32" ? ["cmd", "/c", "start", "", url] : process.platform === "darwin" ? ["open", url] : ["xdg-open", url];
  const [cmd, ...cmdArgs] = argv;
  if (!cmd) return;
  try {
    spawn(cmd, cmdArgs, { detached: true, stdio: "ignore", shell: false }).unref();
  } catch {
    // Browser opening is best-effort.
  }
}
