import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CaptureError } from "./packet-source.js";
import {
  DUMPCAP_BACKEND,
  SubprocessPacketSource,
  TCPDUMP_BACKEND,
  resolveDumpcapCommand,
} from "./subprocess-source.js";

describe("resolveDumpcapCommand", () => {
  // Regression: the Wireshark installer does not put dumpcap.exe on PATH, so
  // spawning bare "dumpcap" failed with ENOENT and Etherfind wrongly reported
  // "Npcap missing" on machines where Npcap was installed and working.
  it("finds dumpcap in the standard Wireshark directory when it is not on PATH", () => {
    const installed = join("C:/Program Files", "Wireshark", "dumpcap.exe");
    const command = resolveDumpcapCommand(
      { PATH: "C:/Windows/System32", ProgramFiles: "C:/Program Files" },
      (path) => path === installed,
    );
    expect(command).toBe(installed);
  });

  it("prefers a dumpcap already on PATH", () => {
    const onPath = join("C:/tools", "dumpcap.exe");
    const command = resolveDumpcapCommand(
      { PATH: "C:/tools;C:/Windows/System32", ProgramFiles: "C:/Program Files" },
      (path) => path === onPath || path === join("C:/Program Files", "Wireshark", "dumpcap.exe"),
    );
    expect(command).toBe(onPath);
  });

  it("checks the 32-bit install directory too", () => {
    const installed = join("C:/Program Files (x86)", "Wireshark", "dumpcap.exe");
    const command = resolveDumpcapCommand(
      { "ProgramFiles(x86)": "C:/Program Files (x86)" },
      (path) => path === installed,
    );
    expect(command).toBe(installed);
  });

  it("falls back to a bare command name when nothing is found", () => {
    expect(resolveDumpcapCommand({ PATH: "C:/Windows/System32" }, () => false)).toBe("dumpcap");
  });
});

describe("SubprocessPacketSource", () => {
  const startAndCollect = async (backend: typeof DUMPCAP_BACKEND) => {
    const errors: CaptureError[] = [];
    const source = new SubprocessPacketSource({
      backend,
      captureDevice: "test0",
      onDebug: () => {},
    });
    await source.start({ onFrame: () => {}, onError: (error) => errors.push(error) });
    // Let both the 'error' and 'close' events fire.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await source.stop();
    return errors;
  };

  // Regression: a failed spawn emits 'error' *and* 'close', so the real cause
  // was followed by a misleading "dumpcap exited with code -4058".
  it("reports a missing binary exactly once", async () => {
    const errors = await startAndCollect({
      ...DUMPCAP_BACKEND,
      command: "etherfind-nonexistent-capture-binary",
    });
    expect(errors).toHaveLength(1);
  });

  // Regression: guidance used to be chosen by `backend === DUMPCAP_BACKEND`,
  // which breaks as soon as the command is overridden via a spread copy.
  it("keeps Windows guidance when the dumpcap command is overridden", async () => {
    const errors = await startAndCollect({
      ...DUMPCAP_BACKEND,
      command: "etherfind-nonexistent-capture-binary",
    });
    expect(errors[0]?.kind).toBe("npcap-missing");
    expect(errors[0]?.guidance).toMatch(/Npcap/);
  });

  it("gives tcpdump guidance for the Linux backend", async () => {
    const errors = await startAndCollect({
      ...TCPDUMP_BACKEND,
      command: "etherfind-nonexistent-capture-binary",
    });
    expect(errors[0]?.kind).toBe("tool-missing");
    expect(errors[0]?.guidance).toMatch(/tcpdump/);
  });
});
