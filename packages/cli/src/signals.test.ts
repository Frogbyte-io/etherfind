import { describe, expect, it } from "vitest";
import { installShutdownSignals } from "./signals.js";

function fakeEngine() {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    async shutdown() {
      calls++;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe("installShutdownSignals", () => {
  // Regression: no signal handlers existed, so Ctrl+C in --json mode or a
  // closed terminal left the temporary address configured on the interface.
  it("restores configuration on SIGINT", async () => {
    const engine = fakeEngine();
    const codes: number[] = [];
    const uninstall = installShutdownSignals(engine, (code) => codes.push(code));
    process.emit("SIGINT");
    await tick();
    uninstall();
    expect(engine.calls).toBe(1);
    expect(codes).toEqual([130]);
  });

  it("restores configuration on SIGTERM", async () => {
    const engine = fakeEngine();
    const codes: number[] = [];
    const uninstall = installShutdownSignals(engine, (code) => codes.push(code));
    process.emit("SIGTERM");
    await tick();
    uninstall();
    expect(engine.calls).toBe(1);
    expect(codes).toEqual([143]);
  });

  it("ignores a second signal so two Ctrl+C presses do not race", async () => {
    const engine = fakeEngine();
    const codes: number[] = [];
    const uninstall = installShutdownSignals(engine, (code) => codes.push(code));
    process.emit("SIGINT");
    process.emit("SIGINT");
    process.emit("SIGTERM");
    await tick();
    uninstall();
    expect(engine.calls).toBe(1);
    expect(codes).toEqual([130]);
  });

  it("still exits when the restore itself fails", async () => {
    const codes: number[] = [];
    const uninstall = installShutdownSignals(
      {
        shutdown: async () => {
          throw new Error("netsh unavailable");
        },
      },
      (code) => codes.push(code),
    );
    process.emit("SIGTERM");
    await tick();
    uninstall();
    expect(codes).toEqual([143]);
  });

  it("removes its handlers on uninstall", async () => {
    const engine = fakeEngine();
    const before = process.listenerCount("SIGINT");
    const uninstall = installShutdownSignals(engine, () => {});
    expect(process.listenerCount("SIGINT")).toBe(before + 1);
    uninstall();
    expect(process.listenerCount("SIGINT")).toBe(before);
    process.emit("SIGINT");
    await tick();
    expect(engine.calls).toBe(0);
  });
});
