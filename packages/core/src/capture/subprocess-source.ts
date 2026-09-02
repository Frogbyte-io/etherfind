import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
  CaptureError,
  type CaptureErrorKind,
  type CapturedFrame,
  type PacketSource,
} from "./packet-source.js";
import { CaptureStreamParser } from "./pcap/capture-stream-parser.js";

export type SubprocessBackend = {
  /** Binary to spawn (resolved PATH; spawned without a shell). */
  command: string;
  /** argv for "write classic-pcap/pcapng stream of this interface to stdout". */
  args: (captureDevice: string, filter: string) => string[];
  /** Classify stderr output into a typed capture error. */
  classifyError: (stderr: string, code: number | null) => CaptureError;
  /** Reported when the capture binary itself cannot be found. */
  missingTool: { kind: CaptureErrorKind; guidance: string };
};

/**
 * The Wireshark installer does not add dumpcap.exe to PATH, so a bare
 * spawn("dumpcap") fails with ENOENT on an otherwise correctly configured
 * machine (Npcap installed and working). Search PATH first, then the
 * standard Wireshark install directories, before giving up.
 */
export function resolveDumpcapCommand(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  const pathDirs = (env.PATH ?? env.Path ?? "").split(";").filter((dir) => dir.length > 0);
  const installDirs = [env.ProgramW6432, env.ProgramFiles, env["ProgramFiles(x86)"]]
    .filter((root): root is string => Boolean(root))
    .map((root) => join(root, "Wireshark"));
  for (const dir of [...pathDirs, ...installDirs]) {
    const candidate = join(dir, "dumpcap.exe");
    if (exists(candidate)) return candidate;
  }
  return "dumpcap";
}

export const TCPDUMP_BACKEND: SubprocessBackend = {
  command: "tcpdump",
  args: (captureDevice, filter) => [
    "-U",
    "-n",
    "-i",
    captureDevice,
    "-w",
    "-",
    ...(filter ? [filter] : []),
  ],
  classifyError: (stderr) => {
    const text = stderr.toLowerCase();
    if (
      text.includes("operation not permitted") ||
      text.includes("don't have permission") ||
      text.includes("permission denied")
    ) {
      return new CaptureError(
        "no-permission",
        stderr.trim(),
        "Packet capture on Linux requires CAP_NET_RAW. Etherfind will offer to run a narrow privileged helper (sudo), or you can grant it once with: sudo setcap cap_net_raw+ep $(which tcpdump)",
      );
    }
    if (text.includes("no such device") || text.includes("invalid device")) {
      return new CaptureError(
        "unknown",
        stderr.trim(),
        "The selected interface disappeared. Restart Etherfind and pick it again.",
      );
    }
    if (text.includes("command not found") || text.includes("not found")) {
      return new CaptureError(
        "tool-missing",
        stderr.trim(),
        "Install tcpdump (e.g. `apt install tcpdump` or `dnf install tcpdump`).",
      );
    }
    return new CaptureError(
      "crashed",
      stderr.trim(),
      "tcpdump exited unexpectedly. Run with --debug for details.",
    );
  },
  missingTool: {
    kind: "tool-missing",
    guidance:
      "Install tcpdump (e.g. `apt install tcpdump` or `dnf install tcpdump`), then run Etherfind again.",
  },
};

export const DUMPCAP_BACKEND: SubprocessBackend = {
  command: "dumpcap",
  args: (captureDevice, filter) => [
    "-i",
    captureDevice,
    "-w",
    "-",
    "-q",
    ...(filter ? ["-f", filter] : []),
  ],
  classifyError: (stderr, code) => {
    const text = stderr.toLowerCase();
    if (text.includes("npcap") || text.includes("wpcap.dll")) {
      return new CaptureError(
        "npcap-missing",
        stderr.trim(),
        "Npcap is required for Ethernet packet capture on Windows. Install Npcap (https://npcap.com) or Wireshark (which bundles Npcap) and run Etherfind again.",
      );
    }
    if (
      text.includes("administrator") ||
      text.includes("access is denied") ||
      text.includes("error opening adapter")
    ) {
      return new CaptureError(
        "no-permission",
        stderr.trim(),
        "Npcap is configured to restrict capture to Administrators. Re-run Etherfind elevated once, or reinstall Npcap without the 'restrict to Administrators only' option.",
      );
    }
    if (text.includes("no such device") || text.includes("invalid device")) {
      return new CaptureError(
        "unknown",
        stderr.trim(),
        "The selected interface disappeared. Restart Etherfind and pick it again.",
      );
    }
    return new CaptureError(
      "crashed",
      stderr.trim(),
      `dumpcap exited with code ${code ?? "unknown"}. Run with --debug for details.`,
    );
  },
  missingTool: {
    kind: "npcap-missing",
    guidance:
      "Npcap is required for Ethernet packet capture on Windows. Install Npcap (https://npcap.com) or Wireshark (which bundles Npcap), then run Etherfind again.",
  },
};

export type SubprocessSourceOptions = {
  backend: SubprocessBackend;
  /** Capture-level device name (`eth0`, `\\Device\\NPF_{...}`). */
  captureDevice: string;
  /** BPF filter limiting captured traffic. */
  filter?: string;
  onDebug?: (line: string) => void;
};

const DEFAULT_FILTER = "arp or ip or ip6";

/**
 * Runs tcpdump (Linux) or dumpcap (Windows) as an unprivileged-as-possible
 * subprocess, parses its pcap/pcapng stdout stream, and maps failures to
 * actionable CaptureErrors. No shell is involved: argv is built as an array.
 */
export class SubprocessPacketSource implements PacketSource {
  readonly descriptor: string;
  readonly #options: SubprocessSourceOptions;
  #child: ChildProcess | undefined;
  #parser: CaptureStreamParser | undefined;
  #onError: ((error: CaptureError) => void) | undefined;
  #stderrTail: string[] = [];
  #stopping = false;
  #errorReported = false;

  constructor(options: SubprocessSourceOptions) {
    this.#options = options;
    this.descriptor = `${options.backend.command} on ${options.captureDevice}`;
  }

  async start(handlers: {
    onFrame: (frame: CapturedFrame) => void;
    onError: (error: CaptureError) => void;
  }): Promise<void> {
    // A failed spawn emits both 'error' and 'close'; report only the first,
    // or the real cause is followed by a bogus "exited with code -4058".
    const report = (error: CaptureError) => {
      if (this.#errorReported) return;
      this.#errorReported = true;
      handlers.onError(error);
    };
    this.#onError = handlers.onError;
    this.#parser = new CaptureStreamParser(handlers.onFrame);
    const args = this.#options.backend.args(
      this.#options.captureDevice,
      this.#options.filter ?? DEFAULT_FILTER,
    );
    this.#options.onDebug?.(`spawn: ${this.#options.backend.command} ${args.join(" ")}`);
    let child: ChildProcess;
    try {
      child = spawn(this.#options.backend.command, args, {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      report(
        new CaptureError(
          "tool-missing",
          String(error),
          `${this.#options.backend.command} could not be started.`,
        ),
      );
      return;
    }
    this.#child = child;

    child.stdout?.on("data", (chunk: Buffer) => {
      try {
        this.#parser?.push(new Uint8Array(chunk));
      } catch (error) {
        this.#options.onDebug?.(`parse error: ${String(error)}`);
      }
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const line = chunk.toString().trim();
      if (line.length > 0) {
        this.#stderrTail.push(line);
        if (this.#stderrTail.length > 20) this.#stderrTail.shift();
        this.#options.onDebug?.(`stderr: ${line}`);
      }
    });
    child.on("error", (error) => {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        report(this.#missingToolError());
        return;
      }
      report(new CaptureError("unknown", String(error), "Packet capture could not be started."));
    });
    child.on("close", (code) => {
      if (this.#stopping) return;
      const stderr = this.#stderrTail.join("\n");
      report(
        code === 0 || code === null
          ? new CaptureError(
              "crashed",
              "capture ended",
              "The capture process exited. Run with --debug for details.",
            )
          : this.#options.backend.classifyError(stderr, code),
      );
    });
  }

  #missingToolError(): CaptureError {
    const { kind, guidance } = this.#options.backend.missingTool;
    return new CaptureError(kind, `${this.#options.backend.command} not found`, guidance);
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    this.#child = undefined;
    if (!child) return;
    // The process may already be gone (spawn failure, tool crash). Waiting for
    // another 'close' that will never arrive just burns the kill timeout.
    if (child.exitCode !== null || child.signalCode !== null) {
      this.#stopping = false;
      return;
    }
    await new Promise<void>((resolve) => {
      child.once("close", () => resolve());
      child.kill("SIGTERM");
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // Already gone.
        }
        resolve();
      }, 2000).unref();
    });
    this.#stopping = false;
  }
}
