# Etherfind GUI — Spec 1: Shell, Sidecar Bridge and Wizard Parity

Status: approved design, ready for implementation planning
Date: 2026-09-07

## 1. Context

Etherfind is a working CLI that finds the IP address of an Ethernet device
plugged directly into your computer. `DiscoveryEngine` (`packages/core/src/engine.ts`)
is already UI-independent: it emits a typed `EngineEvent` stream and takes
injected callbacks for the two decisions a human must make. The Ink TUI is one
consumer of that surface; a GUI is a second.

The goal is a desktop application for Linux and Windows, built with Tauri.

## 2. Scope

The full ambition is a **monitoring console**: continuous observation, a live
list of every candidate on the wire, cross-session history, and a per-device
evidence log. That is more than one spec's worth of work, and two of those
pieces require changes to the engine rather than only new UI. It is therefore
decomposed into four sub-projects, each with its own spec, plan and
implementation cycle:

1. **Shell, sidecar bridge and wizard parity** — this spec.
2. **Live console** — long-lived observation mode in core, all-candidates event
   surface, live device table, user-chosen target.
3. **History** — discoveries persisted across sessions, searchable, re-target.
4. **Evidence log** — per-device packet evidence and export.

### In scope for this spec

- Tauri application shell for Linux and Windows.
- A compiled Node sidecar exposing `@etherfind/core` over a bidirectional
  stdio protocol.
- Feature parity with the CLI wizard: interface selection, guided replug,
  passive discovery, reachability, consented temporary-address configuration,
  verification, cleanup.
- A Linux privilege model that works without a TTY.
- Installers for both platforms, produced by CI.

### Explicitly out of scope

- Continuous/background monitoring, system tray, notifications, autostart.
  Capture runs only while the window is open and a run is active.
- Watching several interfaces concurrently.
- Multi-candidate selection, history, evidence log (specs 2–4).
- Code signing and notarization (see §12).
- macOS.
- Any change to the published npm `etherfind` CLI's behaviour or interface.

## 3. Architecture

### 3.1 Packages

```
packages/
  core/           unchanged except §5
  cli/            unchanged except §5.1
  sidecar/        Node agent wrapping DiscoveryEngine; owns the protocol
  gui/            Tauri application
    src/          Vue 3 + Vite frontend
    src-tauri/    Rust
```

`packages/sidecar` owns the protocol types and is the only package the GUI
frontend depends on for them.

### 3.2 Processes at runtime

1. **Tauri main (Rust)** — window, sidecar lifecycle, IPC relay. It is
   deliberately a dumb pipe: it parses no packets, decodes no protocols and
   makes no network decisions. Nothing in the tested TypeScript logic gains a
   second, divergent Rust implementation.
2. **Sidecar** — `packages/sidecar` compiled by `bun build --compile` into
   `src-tauri/binaries/etherfind-sidecar-<target-triple>` and registered as a
   Tauri `externalBin`. The Bun runtime is embedded, so **the end user does not
   need Node installed**. Runs `DiscoveryEngine` against the real platform
   services.
3. **tcpdump / dumpcap** — spawned by the sidecar. Unchanged.
4. **Transient elevated helper** — `pkexec` (Linux) or `Start-Process -Verb
   RunAs` (Windows), only for the temporary-address operation and the one-time
   Linux capture grant.

Rationale for the sidecar over a Rust port of core: the valuable and
safety-critical logic (pcap parsing, ARP/DHCP/mDNS decoders, the
`dhcpstaticipcoexistence` recipe, the cleanup journal) is tested TypeScript. A
Rust port would not let us delete it — the npm CLI still needs it — so it would
create two permanent implementations of the code path that misconfigures a
user's NIC when it diverges. The stdio protocol is the abstraction: if binary
size ever justifies it, the sidecar can be reimplemented in Rust without the
frontend changing.

## 4. The sidecar protocol

Newline-delimited JSON in both directions over the sidecar's stdin/stdout.
stderr is a plain-text debug log channel, surfaced in the UI's diagnostics
panel and never parsed.

The current `--json` CLI mode is one-way and auto-confirms configuration. The
GUI needs request/reply because `selectInterface` and `confirmConfigure` must
round-trip to a human.

### 4.1 Frames, UI → sidecar

```ts
type Command =
  | { cmd: "list-interfaces"; id: number; all?: boolean }
  | { cmd: "start"; id: number; params: StartParams }
  | { cmd: "reply"; requestId: string; value: unknown }
  | { cmd: "skip-replug" }
  | { cmd: "confirm-disconnected" }
  | { cmd: "keep-listening" }
  | { cmd: "restart" }
  | { cmd: "shutdown"; id: number }
  | { cmd: "cleanup"; id: number }
  | { cmd: "grant-capture-permission"; id: number }; // Linux only, §5.3

type StartParams = {
  interfaceName: string;
  skipReplug?: boolean;
  noConfigure?: boolean;
  listeningTimeoutSeconds?: number;
};
```

### 4.2 Frames, sidecar → UI

```ts
type Outbound =
  | { kind: "hello" }                                  // sidecar booted
  | { kind: "event"; event: EngineEvent }              // verbatim, see below
  | { kind: "request"; requestId: string; request: PendingRequest }
  | { kind: "reply"; id: number; ok: true; result: unknown }
  | { kind: "reply"; id: number; ok: false; error: string }
  | { kind: "log"; line: string }
  | { kind: "fatal"; message: string };

type PendingRequest =
  | { type: "confirm-configure"; suggestion: ReachabilityResult };
```

Two naming notes, both deliberate. The boot frame is `hello`, not `ready`,
because `EngineEvent` already has a `ready` variant and the two would otherwise
appear at different nesting levels with the same name.

`confirm-configure` is the *only* request type. The engine also supports a
`selectInterface` callback, but the GUI enumerates through `list-interfaces`
before starting a run and always passes an explicit `interfaceName` to `start`,
so that callback is never invoked. Supporting both mechanisms would mean two
paths to the same outcome; the sidecar registers only `confirmConfigure`.

The load-bearing decision: **`event` frames carry `EngineEvent` verbatim**, and
the frontend imports that type from `@etherfind/core`. Protocol drift between
core and UI becomes a TypeScript compile error rather than a runtime surprise.
`EngineEvent` is already a serializable discriminated union, so no mapping layer
is needed or wanted.

### 4.3 Transport in Rust

Rust spawns the sidecar with `app.shell().sidecar("etherfind-sidecar")`, reads
stdout line by line, and re-emits each frame to the webview with
`app.emit("etherfind://frame", frame)`. A single `#[tauri::command]`,
`send_command(json: String)`, writes a line to the sidecar's stdin. The frontend
never spawns anything itself, so no `shell:allow-spawn` capability is granted to
the webview.

Rust treats frames as opaque JSON. Its only parsing responsibility is line
framing and detecting `cleanup-done` during shutdown (§6).

## 5. Required changes to existing packages

### 5.1 Move `createRealServices` into core

It currently lives in `packages/cli/src/services.ts`. Both the CLI and the
sidecar need it, so it moves to `packages/core/src/platform/real-services.ts`,
is exported from the core index, and the CLI imports it from there. Behaviour
is unchanged; this is a move, not a rewrite. `ServiceOverrides` gains an
`elevator` selection path used by §5.2.

### 5.2 `PkexecElevator` — Linux GUI elevation

`SudoElevator` (`packages/core/src/platform/elevation.ts:36`) spawns
`sudo --` with `stdio: ["inherit", ...]`, relying on a TTY for the password
prompt. A Tauri app launched from a desktop icon has no TTY, so `sudo` fails
with *"no tty present and no askpass program specified"*. This path cannot be
reused in the GUI.

Add `PkexecElevator implements Elevator`, spawning `pkexec -- <argv>` with
`stdio: ["ignore", "pipe", "pipe"]`. polkit renders a graphical authentication
dialog. Exit code 126 means the user dismissed the dialog and 127 means
authorization failed; both map onto the existing "elevation declined" handling
rather than a hard error.

`SudoElevator` is unchanged and remains what the CLI uses. Selection is by
consumer, not by platform detection: the CLI keeps sudo, the sidecar requests
pkexec. If `pkexec` is absent from `PATH`, the sidecar reports it as a
capability error with installation guidance rather than silently falling back
to a sudo call that cannot prompt.

### 5.3 Linux capture permission

`TCPDUMP_BACKEND` (`packages/core/src/capture/subprocess-source.ts:44`) invokes
`tcpdump` with no elevation. That works today only because the user either
`setcap`'d it or ran the CLI under `sudo`; there is no `sudo etherfind-gui`
equivalent.

The GUI attempts capture unprivileged first. `SubprocessPacketSource` already
classifies the failure as `CaptureError` of kind `no-permission` with guidance,
so the UI has everything it needs to offer a one-time remedy: a **Grant capture
permission** action that runs

```
setcap cap_net_raw,cap_net_admin+eip <resolved path to tcpdump>
```

via `pkexec`, then retries. The change is persistent and system-wide, so the
consent dialog states plainly what it does, which binary it affects, and that
it survives until the user reverses it. The app never performs it without an
explicit click.

Windows needs none of this: Npcap grants capture rights to unprivileged
processes, and `UacElevator` already shows the UAC dialog identically whether
its parent is a terminal or a GUI.

### 5.4 Sidecar `--simulate`

The sidecar accepts `--simulate`, wiring `SimulatedPlatform` instead of the
real services. This lets the GUI be developed, demoed and CI-tested with no
hardware, no capture privileges and no network mutation.

## 6. Lifecycle and cleanup safety

This is the safety-critical path: the sidecar may be holding a temporary IP
address on a real NIC.

- **Normal quit.** Rust intercepts `WindowEvent::CloseRequested`, calls
  `api.prevent_close()`, sends `{"cmd":"shutdown"}`, and waits for the
  `cleanup-done` event or a 5-second timeout before closing. This maps onto
  `engine.shutdown()`, which already restores configuration. During the wait the
  UI shows a blocking "restoring network configuration" state.
- **Timeout or sidecar death mid-shutdown.** The window closes anyway — a hung
  sidecar must not trap the user — but the app records the failure so the next
  launch reports it, and the crash journal remains the backstop.
- **Sidecar exits unexpectedly while running.** Rust surfaces the exit code and
  the stderr tail to the UI, which shows an error state with a Restart action.
- **App killed or crashes.** The existing crash journal covers it.
  `DiscoveryEngine.run()` already restores leftovers at startup; the GUI
  surfaces that as an explicit "leftover configuration from a previous session
  was removed" notice rather than doing it silently, and offers a manual
  cleanup action equivalent to `etherfind --cleanup`.
- **Sidecar orphans.** Rust kills the sidecar on app exit so `tcpdump` or
  `dumpcap` cannot outlive the window.

## 7. User interface

### 7.1 Stack

- **Vue 3** (`<script setup>`, TypeScript) + **Vite**.
- **Tailwind CSS v4** via the `@tailwindcss/vite` plugin (no
  `tailwind.config.js`; configuration is CSS-first).
- **shadcn-vue**, `style: "new-york"`, `baseColor: "neutral"`,
  `cssVariables: true`, Reka UI primitives, `lucide` icons. Components are
  copied into `src/components/ui`, so there is no UI-kit runtime dependency and
  Tailwind compiles away what is unused.
- **Geist** (Vercel's typeface), self-hosted from the npm package. A desktop
  app must not depend on a font CDN, and must render correctly offline.

### 7.2 Visual direction

Vercel-style: neutral greys, high contrast text, hairline borders rather than
shadows, tight radii (`--radius: 0.625rem`), generous whitespace, monospace for
all network values (IP, MAC, interface names). Motion is minimal and confined to
state transitions.

**Dark is the default theme.** Light is available as an explicit user override
and must stay fully supported — both are already expressed as shadcn `neutral`
CSS variables, so supporting both costs nothing — but dark is what the app opens
in and what design work is verified against first. The app does not follow
`prefers-color-scheme` on first run; it opens dark regardless, and remembers the
user's override afterwards.

Colour is reserved for meaning, not decoration. There is no brand accent: green
means link-up or success, amber means *your network is currently modified*, red
means failure. This keeps the amber status strip (§7.4) unmistakable.

### 7.3 Layout

Chosen after building five HTML mockups of the same six states
(`.scratch/gui-mockups/`, throwaway). The structure is a synthesis of three of
them, driven by the requirement that this shell must grow into specs 2–4 without
being restructured:

- **Interface rail** (left, persistent). Lists adapters with link-state dots and
  either their address or driver. Always visible and switchable, with the
  `--all-interfaces` and `--no-configure` toggles pinned at its foot.
- **Timeline** (centre). The run renders as five vertical stages — interface,
  link, discovery, reachability, verification. Finished stages collapse to a
  one-line summary with a check; the current stage expands and holds that step's
  controls; future stages are dimmed. This makes the run legible *after the
  fact*, matching the CLI's transcript, and is where spec 2's live candidate
  table and spec 4's evidence log attach.
- **Event log drawer** (right, closed by default). Streams the raw
  `EngineEvent`s with timestamps. We already emit every one of these, so the
  drawer is nearly free, and it is exactly what is wanted when a capture finds
  nothing. It opens automatically when a run fails and is otherwise on demand.
  This subsumes the `--debug` parity item from §7.6.

A centred single-card wizard was rejected: it reads best for a one-shot task but
has nowhere to put a live device table or history, and its device-found state
already overflows a 1180×760 window.

### 7.4 Stage content

The seven states below are stages of the timeline (§7.3), not separate screens.
Only the active stage is expanded at any time.

1. **Interface.** The rail is populated by `list-interfaces`, which the sidecar
   answers from `InterfaceService.enumerate()` and `selectEthernetInterfaces()`
   directly — no engine involved, because this runs before any run starts. Two
   toggles sit at the foot of the rail:
   - include Wi-Fi and virtual adapters (equivalent to `--all-interfaces`);
   - **discover only, never modify my network** (equivalent to
     `--no-configure`), which suppresses the consent stage entirely rather
     than showing it and refusing.
2. **Guided replug.** "Disconnect the cable" → "Connect it now", driven by
   `link-state` events, with a "Skip, just listen" action.
3. **Listening.** Progress and elapsed time. On `listening-timeout`, offer
   "Keep listening" and "Start over".
4. **Device found.** IP, MAC, hostname, and the discovery source rendered via
   `DISCOVERY_SOURCE_LABEL` with its confidence.
5. **Consent to configure.** Triggered by the `confirm-configure` request. States
   the suggested address and prefix, that the `/24` is an assumption, exactly
   what will change on the system, that it is non-persistent, and that it will
   be reverted on exit. This stage is the consent record; it is never
   auto-advanced.
6. **Ready.** The device with a clickable `http://<ip>` opened in the system
   browser via `tauri-plugin-opener`, and copy actions for IP and MAC.
7. **Error / permission guidance.** Rendered from `CaptureError.kind` and
   `guidance`, replacing the failed stage in place. The Linux capture grant of
   §5.3 lives here, and the event-log drawer opens itself alongside it.

**Persistent status strip**, present in every state: selected interface,
current phase, and — non-negotiably — whether a temporary address is currently
held, with an always-reachable "Stop and clean up" action. The user must never
have to wonder whether this application has modified their network.

### 7.5 State

A pure reducer, `applyEvent(state, EngineEvent): State`, in `src/state/`, with
no Vue imports, unit-tested directly. A thin Pinia store wraps it, subscribes to
`etherfind://frame`, and holds pending requests. This mirrors the state shape
already proven by the Ink `App.tsx`.

### 7.6 CLI parity checklist

"Wizard parity" in §2 means specifically this, so it can be verified rather
than asserted:

| CLI option | GUI equivalent |
|---|---|
| `-i, --interface` | Interface rail (§7.3) |
| `--listen` | "Skip, just listen" on the replug stage |
| `--no-configure` | "Discover only" toggle on the rail |
| `--all-interfaces` | "Include Wi-Fi and virtual adapters" toggle |
| `--cleanup` | Startup leftover notice + manual cleanup action (§6) |
| `--simulate` | Sidecar flag, development and CI only; not user-facing |
| `--debug` | Event-log drawer, plus the sidecar's stderr (§7.3) |
| `--json` | Not applicable |
| `-h`, `-v` | Not applicable |

## 8. Error handling

Classification already done in core drives the UI:

- `CaptureError` kind `not-found` on Windows → Npcap missing, link to
  npcap.com. On Linux → the `apt install tcpdump` / `dnf install tcpdump`
  command.
- Kind `no-permission` on Linux → the capture grant action (§5.3). On Windows →
  Npcap installed without the "restrict to administrators" option unchecked;
  show the reinstall guidance.
- Elevation declined — `UacElevator` already detects the cancelled case, and
  `PkexecElevator` maps exit 126/127 — becomes "continuing without a temporary
  address", falling through to the device-found-but-not-reachable state. It is
  not an error.
- **Cleanup failure gets the loudest treatment in the application**: a
  persistent banner naming the exact address and interface left configured, the
  retry action, and the `etherfind --cleanup` command as a fallback.

## 9. Testing

- **Sidecar integration test (highest value).** Drives the real sidecar over
  real pipes against `SimulatedPlatform` and asserts the entire NDJSON
  conversation, including a `confirm-configure` request/reply round trip and a
  clean `shutdown`. This covers the bridge end to end, everything except pixels.
- **Protocol codec tests.** Round-trip every `Command` and `Outbound` variant;
  assert malformed and partial lines are rejected without crashing the reader.
- **Reducer tests.** `applyEvent` over recorded event sequences, including the
  timeout, declined-configuration and cleanup-failure paths, and the stage
  statuses the timeline (§7.3) derives from them.
- **Rust unit test.** Line framing across chunk boundaries.
- **Existing core and CLI suites** must stay green; §5.1 is a move and §5.2 is
  additive, so neither should require test changes beyond the import path.
- **CI end-to-end.** `--simulate` run of the packaged sidecar on both Ubuntu and
  Windows, mirroring the existing "Simulated end-to-end run" job.
- **Manual smoke** on Windows 11 (dev machine) and Ubuntu 24.04
  (`ananords-dev`) with real hardware, covering: capture permission denied then
  granted, elevation declined, and quit-while-configured.

## 10. Packaging

- **Windows**: NSIS installer and MSI, target `x86_64-pc-windows-msvc`.
- **Linux**: `.deb` and AppImage, target `x86_64-unknown-linux-gnu`.
- Sidecar built with `bun build --compile --target=bun-linux-x64` /
  `bun-windows-x64`, output named with the Rust target triple as Tauri's
  `externalBin` requires.
- Linux CI runner needs `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`, `libxdo-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`, `patchelf`,
  `build-essential`.
- `.github/workflows/ci.yml` gains a `gui` job on the existing
  ubuntu/windows matrix building sidecar + `tauri build`.
- `.github/workflows/release.yml` attaches the installers to the GitHub
  Release created by the existing tag trigger, alongside the npm publish.

## 11. Risks

- **Bun compatibility is the main unknown.** The sidecar spawns `tcpdump`,
  `dumpcap`, `powershell.exe` and `pkexec` via `node:child_process` and consumes
  a binary stdout stream. Bun's Node compatibility is good but this must be
  proven before anything is built on it. **The implementation plan opens with a
  spike**: compile the *existing* CLI with `bun build --compile` and run
  `--simulate --json` plus one real capture on each OS. If Bun fails, fall back
  to Node SEA (~10 MB larger, must build natively per OS — CI already has both
  runners, so the cost is size only).
- **Tauri v2 sidecar naming** is strict about the target-triple suffix; a
  mismatch fails only at bundle time. The CI `gui` job catches it.
- **AppImage and capture permissions** interact: `setcap` applies to the system
  `tcpdump`, not to anything inside the AppImage, so the grant works
  identically across bundle formats. Verify on the Ubuntu box regardless.

## 12. Known limitations, accepted

- **Unsigned binaries.** Windows will show a SmartScreen warning on first run
  and the AppImage is unsigned. Accepted for initial releases; signing is a
  later, separate concern.
- Dark theme is the default and gets design attention first; light is supported
  but verified second.
- x86-64 only. No ARM builds for either platform.
- No macOS.
