# Etherfind — Feasibility Verification & Staged Plan

## Part 1: Feasibility verdict

**The idea works.** Every core mechanism is technically proven. Summary of the research (2026):

### 1.1 Passive L2 discovery — ✅ proven concept

- ARP/IPv4 frames are received at the Ethernet layer by a packet-capture library
  regardless of whether the host has an IP on the device's subnet. This is exactly
  how Wireshark works today — Etherfind merely automates the same capture.
- Caveat handled by design: NIC must be opened in promiscuous mode (libpcap/Npcap
  default) so unicast ARP for unconfigured IPs is not hardware-filtered.
- The unplug/replug workflow maximizes the chance of gratuitous ARP / link-up
  announcements from embedded stacks — no technical risk, purely a UX device.
- Hard limit (confirmed): there is no L2 query that makes a *silent* static-IP
  device reveal its address. Fully silent devices require active discovery later —
  keep the `DiscoveryStrategy` provider interface open (out of v0.1 scope).

### 1.2 Packet capture options — decision made

| Option | Status | Verdict |
|---|---|---|
| `cap` (mscdex, libpcap/Npcap native addon) | Last release 2019, NAN-based, compiles from source | Risky: unmaintained; `npx` users need a C++ toolchain. Keep as optional accelerated backend. |
| `@netkitty/capture` (2025) | Modern, host-process isolation, but **no prebuilt binaries** — compiles at install time | Same `npx` toolchain problem. |
| **Subprocess capture**: Linux `tcpdump -U -w -`, Windows Wireshark's `dumpcap` → stdout, parsed in pure JS (`@cto.af/pcap-ng-parser` / `@netkitty/pcap-core`) | Both binaries are prebuilt and widely present. Wireshark installs bundle Npcap on Windows (matching the brief's assumption). Zero compile step → clean `npx` UX | **Primary v0.1 backend.** |
| Pure JS pcap stream parsing | `@cto.af/pcap-ng-parser` (maintained, streams from stdin, reads tcpdump output), `pcap-parser`, `@netkitty/pcap-core` | Use for decoding capture streams; ARP/Ethernet/IPv4 decoders implemented in-house (simple, fully unit-testable). |

**Decision:** capture behind a `PacketSource` interface with three implementations:
`TcpdumpDumpcapSource` (primary), `LibpcapNativeSource` (optional, later), and
`SimulatedSource` (dev/tests). Core logic never knows which one is active.

### 1.3 Windows temporary IP without breaking DHCP — ✅ solved, exact recipe found

Critical finding — **do NOT use `New-NetIPAddress`**: Microsoft docs state it
*"automatically disables DHCP"* on DHCP-configured interfaces.

The safe, documented recipe (Windows 8+, and the brief says research before using
netsh — this is the researched answer):

```text
1. Snapshot: Get-NetAdapter / Get-NetIPInterface (DHCP state) / Get-NetIPAddress
2. netsh int ipv4 set interface "Ethernet 2" dhcpstaticipcoexistence=enabled
   (record previous value; allows static + DHCP coexistence)
3. netsh int ipv4 add address "Ethernet 2" 192.168.5.254/24
   store=active skipassource=true
   - store=active   → address is non-persistent (gone on reboot) — safety net
   - skipassource   → not used as source for outbound traffic, not DNS-registered
4. Cleanup: netsh int ipv4 delete address "Ethernet 2" 192.168.5.254
   + restore previous dhcpstaticipcoexistence value
```

Elevation: Node process stays unprivileged; a tiny PowerShell helper script is
launched via `Start-Process -Verb RunAs` → single UAC prompt. Arguments passed
strictly validated (IP + interface index/alias from our own enumeration).

### 1.4 Linux privileges — ✅ solved

- Capture needs `CAP_NET_RAW`; address config needs `CAP_NET_ADMIN`.
- `ip addr add` is additive and never disturbs existing addresses/DHCP.
- Privilege model (narrowest operation only):
  1. Preferred: short `sudo` invocation of a bundled validated helper script
     performing exactly `ip addr add` / `ip addr del` (Node app never runs as root).
  2. If NetworkManager manages the interface, offer `nmcli`/polkit path (no sudo).
  3. Guidance for power users: `sudo setcap cap_net_raw+ep` on the capture helper
     or run tcpdump via sudo with a scoped sudoers entry.
- Detect `EACCES`/`EPERM` and emit actionable messages (never silently fail).

### 1.5 Remaining components — low risk

- **Interface enumeration**: Linux `/sys/class/net/*` + `uevent` (driver, type,
  virtual detection, carrier) + `os.networkInterfaces()`; Windows
  `Get-NetAdapter` (friendly name, MAC, media state, virtual/physical, PnP ID).
  No privileges needed for enumeration on either platform.
- **Link down/up detection**: poll `/sys/class/net/X/carrier` (Linux) and
  `Get-NetAdapter` `MediaConnectState` (Windows) at 200–500 ms; netlink/WMI
  eventing is a later optimization.
- **Reachability check**: OS `ping` + watch capture for ARP reply; routing is
  automatic once the connected `/24` address exists.
- **Name availability**: nothing published as `etherfind` on npm found
  (verify with `npm view etherfind` at publish time). Name even honors the
  historical SunOS `etherfind` tool that tcpdump replaced.

### 1.6 Risks & mitigations

| Risk | Mitigation |
|---|---|
| tcpdump/dumpcap not installed | Detect and print exact install instructions; optional native-addon backend later; document Npcap install URL |
| Npcap installed with "admins only" restriction | Detect failure and show actionable message (re-run elevated / reinstall Npcap option) |
| Device stays silent | Replug workflow + timeout menu (keep listening / replug / power-cycle / advanced later) |
| Subnet mask unknown | Model `/24` as explicit `AssumedPrefixLength` in the data model; suggest, never assert |
| Capture subprocess dies mid-session | Restart with backoff; on repeated failure fall to error state with guidance |
| Crash leaves temp address | `store=active` (Windows) self-heals on reboot; Linux address persists — write a session journal to `~/.cache/etherfind/` enabling a `--cleanup` recovery command later |

---

## Part 2: Staged implementation plan

### Stage 0 — Feasibility spikes (1–2 days, done before/superset of scaffolding)

Goal: prove the two riskiest platform mechanics on real OSes; write short ADRs.

- [ ] Spike A (Linux): `tcpdump -U -n -i <if> '(arp or ip)' -w -` piped into Node,
      parse classic pcap stream, extract ARP sender IP/MAC. Confirm works without
      root when tcpdump has filecaps (default on many distros) else via sudo.
- [ ] Spike B (Windows): on a DHCP-enabled interface run the `dhcpstaticipcoexistence`
      recipe above; verify DHCP lease survives, second address present, `store=active`
      semantics, clean `delete address` restoration.
- [ ] Spike C: `dumpcap -i <if> -w -` piped to Node (pcapng stream) on Windows.
- [ ] Write `docs/decisions/` ADRs: capture architecture, Windows config recipe,
      Linux privilege model, `/24` assumption modeling.

### Stage 1 — Project scaffold + simulated mode foundation

- [ ] npm workspaces monorepo: `packages/core`, `packages/cli` (single-repo start,
      split later only if needed; CLI imports core via workspace path).
- [ ] TypeScript strict, NodeNext **ESM**, `tsup`/`tsdown` build, `vitest`,
      biome/eslint, `engines.node >= 20`.
- [ ] Domain models: `NetworkInterfaceInfo`, `MacAddress`, `Ipv4Address`,
      `DeviceCandidate`, `DiscoverySource`, `PrefixLengthAssumption`.
- [ ] `DiscoveryState` state machine (`WAITING_FOR_DISCONNECT → WAITING_FOR_LINK →
      LISTENING → DEVICE_FOUND → CONFIGURING → VERIFYING → CONNECTED → CLEANUP`),
      pure TS, event-emitting, zero UI/I/O dependencies, fully unit-tested.
- [ ] `SimulatedSource` + `SimulatedLinkMonitor` + `SimulatedNetworkConfig` driving
      the full happy path (`pnpm dev --simulate`).

### Stage 2 — Platform layer: interfaces & link monitoring

- [ ] `interfaces/` port: `enumerate(): InterfaceInfo[]`, `watchLink(): LinkMonitor`.
- [ ] Linux impl: `/sys/class/net`, uevent, carrier/operstate, MAC, addresses.
- [ ] Windows impl: `Get-NetAdapter` JSON parsing (`ConvertTo-Json -Compress` to
      avoid CLI parsing fragility), mapping to same model.
- [ ] Filtering: hide virtual adapters (Docker/Hyper-V/VMware/Tailscale/VPN/loopback)
      and Wi-Fi by default; `--all-interfaces` flag; classify physical/USB.
- [ ] Unit tests with fixture files of `/sys` trees and PowerShell JSON dumps.

### Stage 3 — Capture & passive discovery core

- [ ] `PacketSource` interface (`open/close/onPacket`), `TcpdumpSource` (Linux),
      `DumpcapSource` (Windows), detection + actionable errors (Npcap missing,
      libpcap missing, EPERM → privilege guidance).
- [ ] Pure decoders: Ethernet → ARP (request/gratuitous/reply), IPv4 src,
      DHCP DISCOVER/REQUEST options, mDNS (UDP 5353, A record answers), NDP summary.
- [ ] `DeviceObserver`: aggregates packets per (MAC, IP), deduplicates, excludes
      host's own addresses/MAC, ranks by source confidence
      (gratuitous ARP > ARP reply > ARP request > IPv4 src > DHCP > mDNS),
      emits `DeviceFound` with `DiscoverySource` provenance.
- [ ] Timeout behaviors: 10 s no-traffic menu (keep listening / replug / power-cycle;
      advanced discovery reserved for future strategies).
- [ ] Tests: golden packet fixtures (crafted byte arrays), host-packet exclusion,
      confidence ranking, cancellation.

### Stage 4 — Reachability & suggested local address

- [ ] `Reachability` port: does the host have any address/route covering the
      device subnet? (Linux netlink/procfs or `ip route get`; Windows
      `Get-NetRoute`/`Find-NetRoute`).
- [ ] `suggestLocalAddress(device, existingIfaceIps)`: same subnet, avoid device IP,
      network/broadcast, existing host IPs, and common defaults (.1, .254 collision
      aware); returns `{ ip, prefix, assumed: true }` with `/24` default.
- [ ] Tests: subnet math, device-IP avoidance, already-reachable case.

### Stage 5 — Network configuration & privilege model

- [ ] `NetworkConfig` port: `snapshot(iface)`, `addAddress()`, `removeAddress()`,
      `restore(snapshot)`; only ever touches the single selected interface.
- [ ] Linux impl: `ip addr add/del` via narrow sudo helper script (bundled, arg-validated,
      no shell string interpolation); optional nmcli path when NM manages iface.
- [ ] Windows impl: the Stage-0-verified netsh recipe; snapshot via
      `Get-NetIPInterface`/`Get-NetIPAddress`; UAC-elevated PowerShell helper;
      DHCP state never modified.
- [ ] `ElevationService`: non-elevated by default; prompts once
      ("Administrator permission is required to temporarily configure Ethernet 2");
      maps privilege failures to clear messages.
- [ ] `CleanupManager`: tracks *exact* mutations (interface GUID/index, added
      address, coexistence flag previous value); restores on success, Ctrl+C,
      SIGINT/SIGTERM, workflow restart, SIGHUP; journal file for crash recovery;
      `--cleanup` flag to replay journal. Never removes anything not recorded.
- [ ] Tests with mocked executors: cleanup on all paths, failed-elevation path,
      restoration of coexistence flag, no-cross-interface guarantee.

### Stage 6 — CLI + Ink TUI

- [ ] `packages/cli`: arg parsing (tiny hand-rolled or `commander`-minimal):
      `--interface`, `--listen` (skip replug), `--no-configure`, `--debug`,
      `--json`, `--all-interfaces`, `--simulate`.
- [ ] Ink UI: interface selector (keyboard nav), guided replug flow, spinners,
      status icons, discovery result card, configure confirmation, reachability
      result, ready screen (copy IP, open http), restore progress. Renders *only*
      from core state machine events — no logic in components.
- [ ] `--json` machine mode: state events as NDJSON on stdout, no Ink.
- [ ] `--debug`: capture/packet diagnostics to stderr or file, clean default output.

### Stage 7 — End-to-end verification & connectivity checks

- [ ] After config: ARP probe (watch capture for ARP reply after our own ARP
      request) + system `ping` with short timeout; TCP connect probe hook.
- [ ] Full simulated E2E test: link down → up → ARP → found → configure →
      reachable → cleanup; assert journal empty and snapshot restored.
- [ ] Manual test matrix doc: Linux (NM-managed and not), Windows 10/11 (DHCP and
      static primary), USB Ethernet adapters.

### Stage 8 — Packaging, publish, polish

- [ ] `bin` entry `etherfind`, `files` allowlist, optional `optionalDependencies`
      split if a native backend is added later.
- [ ] CI: GitHub Actions matrix (ubuntu + windows), lint/typecheck/test,
      package smoke test (`npm pack` + `npx` install simulation).
- [ ] README with requirements (Npcap link, libpcap), troubleshooting table,
      safety explanation (what gets modified and restored).
- [ ] `npm view etherfind` → publish `@latest`, tag v0.1.

### Out of scope for v0.1 (per brief)

Desktop GUI/tray, active discovery strategies (plugin interface reserved via
`DiscoveryStrategy`), device/vendor memory (schema field reserved in journal),
wider scanning, `etherfind` desktop packaging.
