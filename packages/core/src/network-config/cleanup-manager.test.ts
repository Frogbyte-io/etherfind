import { describe, expect, it, vi } from "vitest";
import { CleanupManager } from "./cleanup-manager.js";
import type { InterfaceSnapshot, NetworkConfigService } from "./types.js";

function fakeService(): NetworkConfigService & {
  added: Array<[string, string, number]>;
  removed: Array<[string, string, number]>;
} {
  return {
    added: [],
    removed: [],
    async snapshot(interfaceName: string): Promise<InterfaceSnapshot> {
      return {
        interfaceName,
        capturedAt: 0,
        addresses: [{ ip: "10.0.0.5", prefix: 24 }],
        dhcpEnabled: true,
        details: {},
      };
    },
    async addAddress(interfaceName, ip, prefix) {
      this.added.push([interfaceName, ip, prefix]);
      return { coexistenceEnabledByUs: "true" };
    },
    async removeAddress(interfaceName, ip, prefix) {
      this.removed.push([interfaceName, ip, prefix]);
    },
  };
}

function fakeStorage() {
  const files = new Map<string, string>();
  return {
    files,
    readFile: async (p: string) => {
      const v = files.get(p);
      if (v === undefined) throw new Error("not found");
      return v;
    },
    writeFile: async (p: string, c: string) => {
      files.set(p, c);
    },
    deleteFile: async (p: string) => {
      files.delete(p);
    },
  };
}

describe("CleanupManager", () => {
  it("snapshots before adding, records the change, and restores exactly it", async () => {
    const service = fakeService();
    const storage = fakeStorage();
    const manager = new CleanupManager({ service, ...storage, journalPath: "/j/journal.json" });

    await manager.applyTemporaryAddress("eth0", "192.168.5.254", 24);
    expect(service.added).toEqual([["eth0", "192.168.5.254", 24]]);
    expect(storage.files.has("/j/journal.json")).toBe(true);

    await manager.restore();
    expect(service.removed).toEqual([["eth0", "192.168.5.254", 24]]);
    expect(manager.hasChanges).toBe(false);
    expect(storage.files.has("/j/journal.json")).toBe(false);
  });

  it("continues when the journal cannot be written (in-memory restore still works)", async () => {
    const service = fakeService();
    const failingWrite = async () => {
      throw new Error("disk full");
    };
    const manager = new CleanupManager({
      service,
      journalPath: "/j/journal.json",
      writeFile: failingWrite,
      readFile: async () => {
        throw new Error("not found");
      },
      deleteFile: async () => {},
    });
    await expect(manager.applyTemporaryAddress("eth0", "192.168.5.254", 24)).resolves.toBeTruthy();
    await expect(manager.restore()).resolves.toBeUndefined();
    expect(service.removed).toEqual([["eth0", "192.168.5.254", 24]]);
  });

  it("restores in reverse order and keeps the journal when a removal fails", async () => {
    const service = fakeService();
    const storage = fakeStorage();
    const manager = new CleanupManager({ service, ...storage, journalPath: "/j/journal.json" });
    await manager.applyTemporaryAddress("eth0", "192.168.5.254", 24);
    await manager.applyTemporaryAddress("eth0", "10.1.2.254", 24);

    // Make the most recent removal fail once.
    service.removed.push(["sentinel", "0.0.0.1", 0]);
    vi.spyOn(service, "removeAddress").mockRejectedValueOnce(new Error("boom"));

    await expect(manager.restore()).rejects.toThrow("boom");
    expect(manager.hasChanges).toBe(true); // surviving change stays journaled
    expect(service.removed.filter(([i]) => i === "eth0")).toHaveLength(1);
  });

  it("loads a leftover journal for crash recovery", async () => {
    const storage = fakeStorage();
    storage.files.set(
      "/j/journal.json",
      JSON.stringify({
        version: 1,
        changes: [
          {
            changeId: "abc",
            interfaceName: "eth0",
            ip: "192.168.5.254",
            prefix: 24,
            platform: "linux",
            appliedAt: 1,
            restoreDetails: {},
          },
        ],
      }),
    );
    const service = fakeService();
    const manager = new CleanupManager({ service, ...storage, journalPath: "/j/journal.json" });
    const loaded = await manager.loadJournal();
    expect(loaded).toHaveLength(1);
    await manager.restore();
    expect(service.removed).toEqual([["eth0", "192.168.5.254", 24]]);
  });

  it("does not remove anything when nothing was applied", async () => {
    const service = fakeService();
    const manager = new CleanupManager({
      service,
      ...fakeStorage(),
      journalPath: "/j/journal.json",
    });
    await manager.restore();
    expect(service.removed).toHaveLength(0);
  });
});
