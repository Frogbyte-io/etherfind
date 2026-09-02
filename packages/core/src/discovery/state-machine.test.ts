import { describe, expect, it } from "vitest";
import { DiscoveryStateMachine } from "./state-machine.js";

function phases(sm: DiscoveryStateMachine): string[] {
  const seen: string[] = [];
  sm.onEvent((e) => seen.push(e.to));
  return seen;
}

describe("DiscoveryStateMachine", () => {
  it("starts in idle", () => {
    expect(new DiscoveryStateMachine().phase).toBe("idle");
  });

  it("walks the full replug workflow", () => {
    const sm = new DiscoveryStateMachine();
    const events = phases(sm);
    sm.start();
    expect(sm.phase).toBe("waiting-for-disconnect");
    sm.linkDown();
    expect(sm.phase).toBe("waiting-for-link");
    sm.linkUp();
    expect(sm.phase).toBe("listening");
    sm.deviceFound();
    expect(sm.phase).toBe("device-found");
    sm.startConfigure();
    expect(sm.phase).toBe("configuring");
    sm.configApplied();
    expect(sm.phase).toBe("verifying");
    expect(sm.configActive).toBe(true);
    sm.verificationSucceeded();
    expect(sm.phase).toBe("connected");
    sm.beginCleanup();
    sm.cleanupComplete();
    expect(sm.phase).toBe("done");
    expect(events).toEqual([
      "waiting-for-disconnect",
      "waiting-for-link",
      "listening",
      "device-found",
      "configuring",
      "verifying",
      "connected",
      "cleanup",
      "done",
    ]);
  });

  it("can skip the replug flow", () => {
    const sm = new DiscoveryStateMachine();
    sm.start({ skipReplug: true });
    expect(sm.phase).toBe("listening");
  });

  it("auto-advances on link down only from waiting-for-disconnect", () => {
    const sm = new DiscoveryStateMachine();
    sm.start();
    sm.linkDown();
    sm.linkDown(); // duplicate is tolerated
    expect(sm.phase).toBe("waiting-for-link");
  });

  it("supports manual confirmation of disconnect", () => {
    const sm = new DiscoveryStateMachine();
    sm.start();
    sm.confirmDisconnected();
    expect(sm.phase).toBe("waiting-for-link");
    sm.skipReplug();
    expect(sm.phase).toBe("listening");
  });

  it("rejected configure returns to device-found", () => {
    const sm = new DiscoveryStateMachine();
    sm.start({ skipReplug: true });
    sm.deviceFound();
    sm.startConfigure();
    sm.configureFailed();
    expect(sm.phase).toBe("device-found");
    expect(sm.configActive).toBe(false);
  });

  it("declining configure goes to connected without configActive", () => {
    const sm = new DiscoveryStateMachine();
    sm.start({ skipReplug: true });
    sm.deviceFound();
    sm.configureDeclined();
    expect(sm.phase).toBe("connected");
    expect(sm.configActive).toBe(false);
  });

  it("verification failure still ends connected, cleanup removes config", () => {
    const sm = new DiscoveryStateMachine();
    sm.start({ skipReplug: true });
    sm.deviceFound();
    sm.startConfigure();
    sm.configApplied();
    sm.verificationFailed();
    expect(sm.phase).toBe("connected");
    expect(sm.configActive).toBe(true);
  });

  it("restart resets config state and returns to waiting-for-disconnect", () => {
    const sm = new DiscoveryStateMachine();
    sm.start({ skipReplug: true });
    sm.deviceFound();
    sm.startConfigure();
    sm.configApplied();
    sm.restart();
    expect(sm.phase).toBe("waiting-for-disconnect");
    expect(sm.configActive).toBe(false);
  });

  it("fail records a reason and ignores further transitions except cleanup", () => {
    const sm = new DiscoveryStateMachine();
    sm.start({ skipReplug: true });
    sm.fail("capture exploded");
    expect(sm.phase).toBe("error");
    expect(sm.failReason).toBe("capture exploded");
    expect(() => sm.linkUp()).toThrow();
    sm.beginCleanup();
    expect(sm.phase).toBe("cleanup");
    sm.cleanupComplete();
    expect(sm.phase).toBe("done");
  });

  it("throws on invalid transitions", () => {
    const sm = new DiscoveryStateMachine();
    expect(() => sm.deviceFound()).toThrow(/Invalid transition/);
    sm.start();
    expect(() => sm.linkUp()).toThrow(/linkUp/);
    expect(() => sm.startConfigure()).toThrow(/startConfigure/);
    sm.beginCleanup();
    sm.cleanupComplete();
    // Restarting after a completed session is a supported flow.
    sm.restart();
    expect(sm.phase).toBe("waiting-for-disconnect");
    expect(sm.configActive).toBe(false);
  });

  it("beginCleanup is idempotent and accepts all pre-completion phases", () => {
    const sm = new DiscoveryStateMachine();
    sm.start();
    sm.beginCleanup();
    sm.beginCleanup();
    sm.cleanupComplete();
    sm.cleanupComplete();
    expect(sm.phase).toBe("done");
  });
});
