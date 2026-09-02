# etherfind

Find the IP address of an Ethernet device that is directly connected to your
computer — no router, no switch, no idea what subnet it is on.

```bash
npx etherfind
```

Etherfind captures ARP/IPv4/DHCP/mDNS traffic at Layer 2, so it can read the
device's address even though your computer has no address on that subnet. It
then offers to add a matching temporary address, and removes it again on exit.

```text
✔ Device found

  IP   192.168.5.100
  MAC  38:2a:8c:12:34:56
  Source gratuitous ARP

? Add 192.168.5.254/24 temporarily?
  > Yes

✔ Network configured
✔ Device reachable
```

## Options

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

## Requirements

- Node.js 20+
- **Linux**: `tcpdump` (`apt install tcpdump` / `dnf install tcpdump`)
- **Windows**: [Npcap](https://npcap.com) — Wireshark installs it by default;
  Etherfind uses Wireshark's `dumpcap` for capture
- `sudo` rights (Linux) or administrator approval (Windows) are needed only for
  the optional temporary address, never for discovery itself

## Safety

- Only the interface you selected is ever touched.
- Configuration is snapshot before and restored after; only Etherfind-created
  changes are removed.
- Windows changes use `store=active` (non-persistent) and never disable DHCP —
  `New-NetIPAddress` is deliberately avoided because it does.
- External commands are spawned with argv arrays, never a shell.

Full documentation: https://github.com/frogbyte-io/etherfind

## License

MIT
