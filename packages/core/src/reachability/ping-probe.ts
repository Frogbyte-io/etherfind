import type { Ipv4Address } from "../models/address.js";
import { runFile } from "../platform/exec.js";

export type PingProbeResult = {
  ok: boolean;
  latencyMs?: number;
  detail: string;
};

/**
 * System ICMP ping probe. Used to verify reachability after adding the
 * temporary address. `ping` is invoked with a strict timeout and count so a
 * non-responsive device cannot hang the workflow.
 */
export async function pingProbe(ip: Ipv4Address, timeoutSeconds = 2): Promise<PingProbeResult> {
  const started = Date.now();
  try {
    if (process.platform === "win32") {
      const result = await runFile(
        "ping",
        ["-n", "1", "-w", String(timeoutSeconds * 1000), ip],
        timeoutSeconds * 1000 + 3000,
      );
      if (result.stdout.toLowerCase().includes("ttl=")) {
        return {
          ok: true,
          latencyMs: Date.now() - started,
          detail:
            result.stdout
              .split("\n")
              .find((l) => l.includes("TTL="))
              ?.trim() ?? "",
        };
      }
      return { ok: false, detail: result.stdout.trim() || result.stderr.trim() };
    }
    const result = await runFile(
      "ping",
      ["-c", "1", "-W", String(timeoutSeconds), ip],
      timeoutSeconds * 1000 + 3000,
    );
    if (result.code === 0 && /time[=<]/.test(result.stdout)) {
      return {
        ok: true,
        latencyMs: Date.now() - started,
        detail:
          result.stdout
            .split("\n")
            .find((l) => /time[=<]/.test(l))
            ?.trim() ?? "",
      };
    }
    return {
      ok: false,
      detail:
        result.stdout.trim() || result.stderr.trim() || `ping exited with code ${result.code}`,
    };
  } catch (error) {
    return { ok: false, detail: `ping failed: ${String(error)}` };
  }
}
