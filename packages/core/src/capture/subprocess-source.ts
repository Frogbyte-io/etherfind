import { type ChildProcess, spawn } from "node:child_process";
import { CaptureError, type CapturedFrame, type PacketSource } from "./packet-source.js";
import { CaptureStreamParser } from "./pcap/capture-stream-parser.js";

export type SubprocessBackend = {
  /** Binary to spawn (resolved PATH; spawned without a shell). */
  command: string;
  /** argv for "write classic-pcap/pcapng stream of this interface to stdout". */
  args: (captureDevice: string, filter: string) => string[];
  /** Classify stderr output into a typed capture error. */
  classifyError: (stderr: string, code: number | null) => CaptureError;
};

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

  constructor(options: SubprocessSourceOptions) {
    this.#options = options;
    this.descriptor = `${options.backend.command} on ${options.captureDevice}`;
  }

  async start(handlers: {
    onFrame: (frame: CapturedFrame) => void;
    onError: (error: CaptureError) => void;
  }): Promise<void> {
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
      handlers.onError(
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
        handlers.onError(this.#missingToolError());
        return;
      }
      handlers.onError(
        new CaptureError("unknown", String(error), "Packet capture could not be started."),
      );
    });
    child.on("close", (code) => {
      if (this.#stopping) return;
      const stderr = this.#stderrTail.join("\n");
      handlers.onError(
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
    if (this.#options.backend === DUMPCAP_BACKEND) {
      return new CaptureError(
        "npcap-missing",
        "dumpcap not found",
        "Npcap is required for Ethernet packet capture on Windows. Install Npcap (https://npcap.com) or Wireshark (which bundles Npcap), then run Etherfind again.",
      );
    }
    return new CaptureError(
      "tool-missing",
      "tcpdump not found",
      "Install tcpdump (e.g. `apt install tcpdump` or `dnf install tcpdump`), then run Etherfind again.",
    );
  }

  async stop(): Promise<void> {
    this.#stopping = true;
    const child = this.#child;
    this.#child = undefined;
    if (!child) return;
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
