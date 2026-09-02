import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CleanupManager } from "./cleanup-manager.js";
import type { InterfaceSnapshot, NetworkConfigService } from "./types.js";

/** Records removals without touching anything, like the simulated backend. */
function fakeService(): NetworkConfigService & { removed: string[] } {
  return {
    removed: [],
    async snapshot(interfaceName: string): Promise<InterfaceSnapshot> {
      return { interfaceName, capturedAt: 0, addresses: [], dhcpEnabled: true, details: {} };
    },
    async addAddress() {
      return {};
    },
    async removeAddress(_interfaceName: string, ip: string) {
      this.removed.push(ip);
    },
  };
}

const realJournal = (dir: string) => {
  const p = join(dir, "journal.json");
  writeFileSync(
    p,
    JSON.stringify({
      version: 1,
      changes: [
        {
          changeId: "abc",
          interfaceName: "Ethernet",
          ip: "192.168.68.254",
          prefix: 24,
          platform: "windows",
          appliedAt: 1,
          restoreDetails: {},
        },
      ],
    }),
  );
  return p;
};

describe("cleanup journal isolation", () => {
  // Regression: --simulate used the default journal path, so a simulated run
  // replayed a real leftover change through the fake network service and then
  // deleted the journal — leaving 192.168.68.254/24 applied to a real NIC with
  // nothing left to recover it from.
  it("a journal at another path is left untouched", async () => {
    const dir = mkdtempSync(join(tmpdir(), "etherfind-real-"));
    const realPath = realJournal(dir);
    const simDir = mkdtempSync(join(tmpdir(), "etherfind-sim-"));

    const service = fakeService();
    const manager = new CleanupManager({
      service,
      journalPath: join(simDir, "journal.json"),
    });

    const leftovers = await manager.loadJournal();
    expect(leftovers).toHaveLength(0);
    await manager.restore();

    expect(service.removed).toEqual([]);
    const stillThere = JSON.parse(readFileSync(realPath, "utf8"));
    expect(stillThere.changes).toHaveLength(1);
    expect(stillThere.changes[0].ip).toBe("192.168.68.254");
  });

  it("keeps the journal when removal fails, so --cleanup can retry", async () => {
    const dir = mkdtempSync(join(tmpdir(), "etherfind-fail-"));
    const journalPath = realJournal(dir);
    const manager = new CleanupManager({
      service: {
        ...fakeService(),
        async removeAddress() {
          throw new Error("elevation declined");
        },
      },
      journalPath,
    });
    expect(await manager.loadJournal()).toHaveLength(1);
    await expect(manager.restore()).rejects.toThrow(/elevation declined/);
    const kept = JSON.parse(readFileSync(journalPath, "utf8"));
    expect(kept.changes).toHaveLength(1);
  });
});
