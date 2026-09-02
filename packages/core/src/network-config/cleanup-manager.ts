import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";
import type { Ipv4Address, PrefixLength } from "../models/address.js";
import type { AppliedChange, NetworkConfigService } from "./types.js";

export type Journal = {
  version: 1;
  changes: AppliedChange[];
};

export type CleanupManagerOptions = {
  service: NetworkConfigService;
  /** Where the crash-recovery journal is stored. */
  journalPath?: string;
  now?: () => number;
  readFile?: (path: string) => Promise<string>;
  writeFile?: (path: string, contents: string) => Promise<void>;
  deleteFile?: (path: string) => Promise<void>;
};

const DEFAULT_JOURNAL_DIR = process.env.XDG_STATE_DIR ?? path.join(os.homedir(), ".local", "state");

function defaultJournalPath(): string {
  return process.platform === "win32"
    ? path.join(
        process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
        "etherfind",
        "journal.json",
      )
    : path.join(DEFAULT_JOURNAL_DIR, "etherfind", "journal.json");
}

/**
 * Tracks exactly the configuration Etherfind applied and guarantees its
 * removal — on success, on Ctrl+C, on workflow restart. Only recorded changes
 * are ever removed; state is never inferred from IP values.
 */
export class CleanupManager {
  readonly #service: NetworkConfigService;
  readonly #journalPath: string;
  readonly #now: () => number;
  readonly #readFile: (path: string) => Promise<string>;
  readonly #writeFile: (path: string, contents: string) => Promise<void>;
  readonly #deleteFile: (path: string) => Promise<void>;
  #changes: AppliedChange[] = [];

  constructor(options: CleanupManagerOptions) {
    this.#service = options.service;
    this.#journalPath = options.journalPath ?? defaultJournalPath();
    this.#now = options.now ?? Date.now;
    const fsRead = async (p: string) => {
      const fs = await import("node:fs/promises");
      return fs.readFile(p, "utf8");
    };
    const fsWrite = async (p: string, contents: string) => {
      const fs = await import("node:fs/promises");
      await fs.mkdir(path.dirname(p), { recursive: true });
      await fs.writeFile(p, contents, "utf8");
    };
    const fsDelete = async (p: string) => {
      const fs = await import("node:fs/promises");
      await fs.rm(p, { force: true });
    };
    this.#readFile = options.readFile ?? fsRead;
    this.#writeFile = options.writeFile ?? fsWrite;
    this.#deleteFile = options.deleteFile ?? fsDelete;
  }

  /** Loads a leftover journal from a previous crashed session. */
  async loadJournal(): Promise<AppliedChange[]> {
    try {
      const raw = await this.#readFile(this.#journalPath);
      const journal = JSON.parse(raw) as Journal;
      if (journal.version === 1 && Array.isArray(journal.changes)) {
        this.#changes = journal.changes;
        return this.#changes;
      }
    } catch {
      // No journal or unreadable: nothing to recover.
    }
    return [];
  }

  get changes(): readonly AppliedChange[] {
    return this.#changes;
  }

  get hasChanges(): boolean {
    return this.#changes.length > 0;
  }

  /**
   * Snapshots the interface, adds the temporary address, records the change
   * durably before returning. Aborts without any change if snapshot fails.
   */
  async applyTemporaryAddress(
    interfaceName: string,
    ip: Ipv4Address,
    prefix: PrefixLength,
  ): Promise<AppliedChange> {
    // Snapshot first so we always know the pre-change state.
    const snapshot = await this.#service.snapshot(interfaceName);
    const restoreDetails = await this.#service.addAddress(interfaceName, ip, prefix);
    const change: AppliedChange = {
      changeId: randomUUID(),
      interfaceName,
      ip,
      prefix,
      platform: process.platform === "win32" ? "windows" : "linux",
      appliedAt: this.#now(),
      restoreDetails: { ...restoreDetails, snapshotJson: JSON.stringify(snapshot) },
    };
    this.#changes.push(change);
    await this.#persist();
    return change;
  }

  /** Removes every change made in this session (or loaded from the journal). */
  async restore(onProgress?: (message: string) => void): Promise<void> {
    const failures: Error[] = [];
    for (const change of [...this.#changes].reverse()) {
      onProgress?.(`Removing ${change.ip}/${change.prefix} from ${change.interfaceName}...`);
      try {
        await this.#service.removeAddress(
          change.interfaceName,
          change.ip,
          change.prefix,
          change.restoreDetails,
        );
      } catch (error) {
        failures.push(error instanceof Error ? error : new Error(String(error)));
        onProgress?.(`Warning: failed to remove ${change.ip} — will retry on next run.`);
        continue;
      }
      this.#changes = this.#changes.filter((c) => c.changeId !== change.changeId);
      await this.#persist();
    }
    if (this.#changes.length === 0) {
      await this.#deleteFile(this.#journalPath).catch(() => {});
    }
    if (failures.length > 0) {
      throw failures[0];
    }
  }

  async #persist(): Promise<void> {
    const journal: Journal = { version: 1, changes: this.#changes };
    try {
      await this.#writeFile(this.#journalPath, JSON.stringify(journal, null, 2));
    } catch {
      // Crash-recovery journal is best-effort; in-session restore still works
      // because changes remain tracked in memory.
    }
  }

  /** Registers process exit handlers; returns a disposer. */
  registerSignalHooks(onRestore: () => Promise<void>): () => void {
    const handler = (signal: string) => {
      void (async () => {
        try {
          await onRestore();
        } finally {
          process.exit(signal === "SIGINT" ? 130 : 143);
        }
      })();
    };
    process.on("SIGINT", handler);
    process.on("SIGTERM", handler);
    process.on("exit", () => {
      // Synchronous best-effort note; async restore is handled by signals.
    });
    return () => {
      process.off("SIGINT", handler);
      process.off("SIGTERM", handler);
    };
  }
}
