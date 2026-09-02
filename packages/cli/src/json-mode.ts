import {
  DiscoveryEngine,
  type EngineEvent,
  type EngineOptions,
  type EngineServices,
} from "@etherfind/core";

export type JsonModeOptions = {
  services: EngineServices;
  options: EngineOptions;
  /** Auto-confirm configuration changes (default true in JSON mode). */
  autoConfirm?: boolean;
  onEvent?: (event: EngineEvent) => void;
};

/**
 * Machine-readable mode: emits NDJSON events on stdout and a final summary
 * object. Designed for agents, automation and test systems:
 *
 *   etherfind --interface eth0 --json
 */
export async function runJsonMode(options: JsonModeOptions): Promise<FinalJson> {
  const write = (line: unknown) => process.stdout.write(`${JSON.stringify(line)}\n`);
  const engine = new DiscoveryEngine(options.services, options.options, {
    confirmConfigure: async () => options.autoConfirm ?? true,
  });
  engine.onEvent((event) => {
    options.onEvent?.(event);
    write({
      event: event.type,
      ...("candidate" in event ? { candidate: publicCandidate(event.candidate) } : {}),
      ...restOf(event),
    });
  });

  let result: Awaited<ReturnType<DiscoveryEngine["run"]>>;
  try {
    result = await engine.run();
  } catch (error) {
    write({
      event: "error",
      fatal: true,
      message: error instanceof Error ? error.message : String(error),
    });
    await engine.shutdown();
    return {
      ok: false,
      reachable: false,
      viaTemporaryAddress: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  await engine.shutdown();
  const final: FinalJson = {
    ok: result.candidate !== undefined,
    interface: options.options.interfaceName,
    device: result.candidate
      ? {
          ip: result.candidate.ip,
          mac: result.candidate.mac,
          hostname: result.candidate.hostname,
        }
      : undefined,
    discovery: result.candidate
      ? { method: result.candidate.source, sources: result.candidate.sources }
      : undefined,
    reachable: result.reachable,
    viaTemporaryAddress: result.viaTemporaryAddress,
  };
  write({ event: "final", ...final });
  return final;
}

export type FinalJson = {
  ok: boolean;
  interface?: string;
  device?: { ip: string; mac: string; hostname?: string };
  discovery?: { method: string; sources: string[] };
  reachable: boolean;
  viaTemporaryAddress: boolean;
  error?: string;
};

function publicCandidate(candidate: {
  ip: string;
  mac: string;
  hostname?: string;
  source: string;
  sources: string[];
}) {
  return {
    ip: candidate.ip,
    mac: candidate.mac,
    hostname: candidate.hostname,
    source: candidate.source,
    sources: candidate.sources,
  };
}

function restOf(event: EngineEvent): Record<string, unknown> {
  const { type, candidate, ...rest } = event as EngineEvent & Record<string, unknown>;
  void type;
  void candidate;
  return rest as Record<string, unknown>;
}
