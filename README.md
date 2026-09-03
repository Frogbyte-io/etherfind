# Etherfind

Find the IP address of an Ethernet device that is directly connected to your computer — no router, no switch, no idea what subnet it is on.

```bash
npx etherfind
```

```text
Etherfind

Interface
  Ethernet 2

● Waiting for cable...
  Connect the Ethernet cable now.

✔ Link detected
● Listening for device...

✔ Device found

  IP   192.168.5.100
  MAC  38:2a:8c:12:34:56
  Source gratuitous ARP

? Add 192.168.5.254/24 temporarily?
  > Yes

✔ Network configured
✔ Device reachable

  http://192.168.5.100

Press Enter to finish
```

## How it works

1. **Pick an interface** — physical Ethernet adapters are listed with driver
   info and link state; Wi-Fi and virtual adapters (Docker, Hyper-V, VMware,
   Tailscale, VPN tunnels) are hidden by default.
2. **Unplug / replug** — you are guided to disconnect and reconnect the device.
   Link-up maximizes the chance the device sends ARP, gratuitous ARP, DHCP,
   IPv4 or mDNS traffic. (You can skip this with `s` or `--listen`.)
3. **Passive discovery** — Etherfind captures packets at Layer 2 with
   tcpdump (Linux) or dumpcap + Npcap (Windows). Your computer does **not**
   need an address on the device's subnet. ARP and ordinary IPv4 packets are
   the strongest evidence; the discovery source is always shown.
4. **Reachability** — if your computer already has a route to the device's
   subnet, connectivity is verified directly. Otherwise Etherfind suggests a
   temporary local address (default `/24`, clearly marked as an assumption)
   and never the device's own address.
5. **Temporary configuration** — with your explicit confirmation (and
   platform elevation for exactly this one operation), a secondary address is
   added:
   - **Linux**: `ip addr add ...` via a short `sudo` call — purely additive,
     DHCP and existing addresses untouched.
   - **Windows**: `netsh ... dhcpstaticipcoexistence=enabled` +
     `add address ... store=active skipassource=true` — DHCP stays enabled,
     the address is non-persistent and never used as outbound source.
     (`New-NetIPAddress` is deliberately avoided because it disables DHCP.)
6. **Cleanup** — on exit, Ctrl+C, or workflow restart, only the configuration
   Etherfind created is removed and recorded state is restored. A crash
   journal enables `etherfind --cleanup` recovery.

## Privileges

Etherfind itself runs unprivileged. Only the smallest operation is elevated:

- Packet capture needs `CAP_NET_RAW` (Linux) or Npcap (Windows).
- Adding the temporary address needs `CAP_NET_ADMIN` (sudo, one narrow call)
  or a UAC prompt (Windows).

If capture fails due to permissions, the error explains exactly what to do.

## CLI options

```text
npx etherfind [options]

  -i, --interface <name>  Use a specific interface (eth0, "Ethernet 2", ...)
  --listen                Skip the unplug/replug guidance and listen right away
  --no-configure          Discover only; never modify network configuration
  --json                  Machine-readable NDJSON events + final summary
  --all-interfaces        Include Wi-Fi and virtual adapters
  --cleanup               Remove temporary addresses left by a crashed session
  --simulate              Full workflow against a simulated device (no hardware)
  --debug                 Diagnostics on stderr
  -h, --help              Show help
  -v, --version           Show version
```

### Scriptable mode

```bash
$ npx etherfind --interface eth0 --json
{"event":"device-found","candidate":{"ip":"192.168.5.100","mac":"38:2a:8c:12:34:56","source":"arp-request"}}
...
{"event":"final","ok":true,"device":{"ip":"192.168.5.100","mac":"38:2a:8c:12:34:56"},"discovery":{"method":"gratuitous-arp"},"reachable":true,"viaTemporaryAddress":true}
```

## Requirements

- Node.js 20+
- **Linux**: `tcpdump` (or install it: `apt install tcpdump` / `dnf install tcpdump`)
- **Windows**: [Npcap](https://npcap.com) (Wireshark installs it by default) —
  Etherfind uses Wireshark's `dumpcap` for capture
- `sudo` rights (Linux) or administrator approval (Windows) only for the
  optional temporary address configuration

## Development

```bash
npm install
npm run build          # typecheck + build core and cli
npm test               # unit tests (no hardware needed)
npm run dev -- --simulate   # run the TUI against a simulated device
```

Architecture: `@etherfind/core` is a UI-free library (models, discovery state
machine, packet decoders, capture abstraction, reachability, network
configuration with snapshot/restore, privilege model). `etherfind` is a thin
Ink/React TUI + CLI frontend over it, so a desktop GUI can reuse the same
core later. See `PLAN.md` for the design decisions and staged plan.

Published packaging: the `etherfind` npm package is **fully self-contained**
(`@etherfind/core`, ink and react are bundled at build time via esbuild and
it has zero runtime dependencies), so `npx etherfind` works with no npm org
and no other packages. The core library stays a workspace package for
development and future GUI reuse (`packages/core` is marked private — it is
not published).

## Safety

- Only the interface you selected is ever touched.
- Configuration is snapshot before / restore after; only Etherfind-created
  changes are removed (tracked by exact session state, not IP matching).
- Windows changes are `store=active` (non-persistent) and DHCP is never
  disabled.
- All external commands are spawned with argv arrays, never a shell; inputs
  are validated.

## License

MIT
