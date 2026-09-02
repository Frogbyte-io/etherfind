# @etherfind/core

UI-free engine behind [`etherfind`](https://www.npmjs.com/package/etherfind):
passive discovery of directly-connected Ethernet devices.

This package contains the domain models, the discovery state machine, the
packet decoders (Ethernet/ARP/IPv4/DHCP/mDNS/NDP), the pcap and pcapng stream
parsers, the capture abstraction (`tcpdump` on Linux, `dumpcap`+Npcap on
Windows, plus a simulated source), reachability and local-address suggestion,
and the network configuration layer with snapshot/restore and the privilege
model.

It has no dependency on any UI, so a desktop GUI or another frontend can reuse
it. The CLI/TUI frontend lives in the `etherfind` package.

```ts
import { DiscoveryEngine } from "@etherfind/core";

const engine = new DiscoveryEngine(services, options, callbacks);
engine.onEvent((event) => console.log(event));
const result = await engine.run();
```

Interfaces are ports: `PacketSource`, `InterfaceService`, `LinkMonitor`,
`NetworkConfigService` and `Elevator` all have injectable implementations, so
the core is testable without hardware or privileges.

Full documentation: https://github.com/frogbyte-io/etherfind

## License

MIT
