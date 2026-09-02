#!/usr/bin/env node
import {
  CleanupManager,
  type EngineOptions,
  type EngineServices,
  SimulatedPlatform,
} from "@etherfind/core";
import { runJsonMode } from "./json-mode.js";
import { createRealServices } from "./services.js";

type CliArgs = {
  interfaceName?: string;
  listen: boolean;
  noConfigure: boolean;
  debug: boolean;
  json: boolean;
  allInterfaces: boolean;
  simulate: boolean;
  cleanup: boolean;
  help: boolean;
  version: boolean;
};

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    listen: false,
    noConfigure: false,
    debug: false,
    json: false,
    allInterfaces: false,
    simulate: false,
    cleanup: false,
    help: false,
    version: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--interface":
      case "-i": {
        const value = argv[++i];
        if (!value) throw new Error("--interface requires a value");
        args.interfaceName = value;
        break;
      }
      case "--listen":
        args.listen = true;
        break;
      case "--no-configure":
        args.noConfigure = true;
        break;
      case "--debug":
        args.debug = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--all-interfaces":
        args.allInterfaces = true;
        break;
      case "--simulate":
        args.simulate = true;
        break;
      case "--cleanup":
        args.cleanup = true;
        break;
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      default:
        throw new Error(`Unknown option: ${arg}`);
    }
  }
  return args;
}

const HELP = `Etherfind — find the IP address of a directly connected Ethernet device.

Usage:
  npx etherfind [options]

Options:
  -i, --interface <name>  Use a specific interface (e.g. eth0, "Ethernet 2")
  --listen                Skip the unplug/replug guidance and listen immediately
  --no-configure          Discover only; never modify network configuration
  --json                  Machine-readable NDJSON output (no TUI)
  --all-interfaces        Include Wi-Fi and virtual adapters
  --cleanup               Remove temporary addresses left by a previous session
  --simulate              Simulated device: try the full workflow without hardware
  --debug                 Show diagnostic output on stderr
  -h, --help              Show this help
  -v, --version           Show version

Workflow:
  1. Pick your Ethernet adapter
  2. Unplug the device, press Enter, plug it back in
  3. Etherfind reads ARP/IPv4 traffic to learn the device's static IP
  4. Optionally add a matching temporary address to your computer
  5. On exit, everything Etherfind changed is restored
`;

async function main(): Promise<number> {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${HELP}`);
    return 2;
  }
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (args.version) {
    const { createRequire } = await import("node:module");
    const require = createRequire(import.meta.url);
    process.stdout.write(`${require("../package.json").version as string}\n`);
    return 0;
  }

  // Cleanup-only mode: restore anything a crashed session left behind.
  if (args.cleanup) {
    const services = createRealServices({
      onDebug: args.debug ? (l) => process.stderr.write(`[debug] ${l}\n`) : undefined,
    });
    if (!services.networkConfig) {
      process.stderr.write("No network configuration backend available on this platform.\n");
      return 1;
    }
    const manager = new CleanupManager({ service: services.networkConfig });
    const leftovers = await manager.loadJournal();
    if (leftovers.length === 0) {
      process.stdout.write("Nothing to clean up.\n");
      return 0;
    }
    for (const change of leftovers) {
      process.stdout.write(
        `Removing ${change.ip}/${change.prefix} from ${change.interfaceName}…\n`,
      );
    }
    await manager.restore((message) => process.stdout.write(`${message}\n`));
    process.stdout.write("Cleanup complete.\n");
    return 0;
  }

  const services: EngineServices = args.simulate
    ? createSimulatedServices()
    : createRealServices({
        onDebug: args.debug ? (l) => process.stderr.write(`[debug] ${l}\n`) : undefined,
      });

  const options: EngineOptions = {
    interfaceName: args.interfaceName,
    skipReplug: args.listen,
    noConfigure: args.noConfigure,
    listenOnly: args.listen,
    journalPath: undefined,
  };

  if (args.json) {
    const final = await runJsonMode({ services, options });
    return final.ok ? 0 : 1;
  }

  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    process.stderr.write(
      "Etherfind's interactive UI needs a terminal (TTY).\nUse --json for machine-readable output, or run it in a terminal directly.\n",
    );
    return 2;
  }

  const { render } = await import("ink");
  const React = await import("react");
  const { App } = await import("./tui/App.js");
  const instance = render(
    React.createElement(App, { services, options, debug: args.debug, onFinished: () => {} }),
    {
      exitOnCtrlC: false,
      patchConsole: true,
    },
  );
  await instance.waitUntilExit();
  return 0;
}

/** Simulated wiring for `--simulate`: full workflow without hardware. */
function createSimulatedServices(): EngineServices {
  const platform = new SimulatedPlatform();
  const original = platform.services();

  // Scripted scenario:
  //   waiting-for-disconnect → auto-unplug after 1.2 s
  //   waiting-for-link       → auto-plug after another 1.5 s
  //   listening              → device announces via gratuitous ARP 0.5 s later
  const wrappedSource: EngineServices["packetSourceFactory"] = (info) => {
    const inner = original.packetSourceFactory(info);
    return {
      get descriptor() {
        return inner.descriptor;
      },
      start: async (handlers) => {
        await inner.start(handlers);
      },
      stop: () => inner.stop(),
    };
  };

  return {
    ...original,
    packetSourceFactory: wrappedSource,
    linkMonitorFactory: (info) => {
      const monitor = original.linkMonitorFactory?.(info) ?? platform.monitor;
      let scripted = false;
      const runScript = () => {
        if (scripted) return;
        scripted = true;
        setTimeout(() => platform.unplug(), 1200);
        setTimeout(() => platform.plugInDevice(500), 2700);
      };
      return {
        interfaceName: monitor.interfaceName,
        start: () => {
          void monitor.start();
          runScript();
        },
        current: () => monitor.current(),
        subscribe: monitor.subscribe.bind(monitor),
        dispose: () => monitor.dispose(),
      };
    },
  };
}

process.on("unhandledRejection", (reason) => {
  if (process.env.ETHERFIND_DEBUG === "1") {
    process.stderr.write(`[unhandledRejection] ${String(reason)}\n`);
  }
});

process.exitCode = await main();
