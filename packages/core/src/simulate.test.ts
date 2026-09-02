import { describe, expect, it } from "vitest";
import { DEVICE_IP, DEVICE_MAC } from "./discovery/decoders/test-packets.js";
import { SimulatedPlatform } from "./simulate.js";
import { whenCapturing, whenPhase } from "./test-support/wait-for.js";

/**
 * End-to-end: the complete workflow over the simulated platform, exactly like
 * `--simulate` drives it, but deterministic.
 */
describe("SimulatedPlatform E2E", () => {
  it("full flow: select → replug → discover → configure → verify → cleanup", async () => {
    const platform = new SimulatedPlatform();
    const events: string[] = [];
    const engine = platform.createEngine(
      {},
      {
        selectInterface: async (candidates) => {
          expect(candidates.some((c) => c.kind === "ethernet")).toBe(true);
          return candidates.find((c) => c.kind === "ethernet") as NonNullable<
            (typeof candidates)[number]
          >;
        },
        confirmConfigure: async () => true,
      },
    );
    engine.onEvent((e) => events.push(e.type));

    const runPromise = engine.run();
    await whenPhase(engine, "waiting-for-disconnect");

    // Simulate the user replugging: unplug → plug back in.
    platform.unplug();
    await whenPhase(engine, "waiting-for-link");
    platform.plugInDevice(20); // announce almost immediately

    const result = await runPromise;
    expect(result.candidate).toMatchObject({ ip: DEVICE_IP, mac: DEVICE_MAC });
    expect(result.reachable).toBe(true);
    expect(result.viaTemporaryAddress).toBe(true);
    expect(platform.networkConfig.added).toEqual([
      { interfaceName: "simeth0", ip: "192.168.5.254", prefix: 24 },
    ]);

    // Now exit: cleanup must remove the temporary address.
    await engine.shutdown();
    expect(platform.networkConfig.added).toHaveLength(0);
    expect(events).toContain("device-found");
    expect(events).toContain("configuration-applied");
    expect(events).toContain("verification");
    expect(events).toContain("ready");
  });

  it("wifi interfaces are excluded from selection", async () => {
    const platform = new SimulatedPlatform();
    let seen: string[] = [];
    const engine = platform.createEngine(
      {},
      {
        selectInterface: async (candidates) => {
          seen = candidates.map((c) => c.name);
          return candidates[0] as NonNullable<(typeof candidates)[number]>;
        },
        confirmConfigure: async () => false,
      },
    );
    const runPromise = engine.run();
    await whenPhase(engine, "waiting-for-disconnect");
    platform.unplug();
    platform.plugInDevice(10);
    await runPromise;
    expect(seen).toEqual(["simeth0"]);
  });

  it("graceful exit restores configuration even when the user declined nothing", async () => {
    const platform = new SimulatedPlatform({ announceOnLinkUp: false });
    const engine = platform.createEngine(
      { skipReplug: true },
      { confirmConfigure: async () => true },
    );
    const runPromise = engine.run();
    await whenCapturing(platform.source, engine);
    platform.emitGratuitousArp();
    const result = await runPromise;
    expect(result.candidate).toBeDefined();
    await engine.shutdown();
    expect(platform.networkConfig.added).toHaveLength(0);
  });
});
