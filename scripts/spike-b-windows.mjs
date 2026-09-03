#!/usr/bin/env node
// Spike B — verify the Windows temporary-address recipe on a live NIC.
//
// This is the only Windows path that still needs real-hardware proof (see
// PLAN.md, "Remaining steps"). Run it from an ELEVATED PowerShell:
//
//   node scripts/spike-b-windows.mjs "Ethernet 2"
//
// What it checks, in order:
//   1. Snapshot: DHCP state + every IPv4 address on the NIC.
//   2. netsh: dhcpstaticipcoexistence=enabled, then
//      add address <ip>/<prefix> store=active skipassource=true.
//   3. Verify: address present with SkipAsSource=True, DHCP still Enabled.
//   4. Remove the address, restore coexistence=disabled.
//   5. Verify: address gone, DHCP still Enabled, address list identical to
//      the snapshot (nothing else was touched).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const nic = process.argv[2];
if (!nic) {
  console.error('Usage: node scripts/spike-b-windows.mjs "<interface alias>" [ip/prefix]');
  console.error('Example: node scripts/spike-b-windows.mjs "Ethernet 2" 172.31.199.254/24');
  process.exit(2);
}
const [ip = "172.31.199.254", prefix = "24"] = (process.argv[3] ?? "172.31.199.254/24").split("/");

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function ps(script) {
  const { stdout } = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    script,
  ]);
  return stdout.trim();
}

async function isElevated() {
  try {
    await run("net", ["session"]);
    return true;
  } catch {
    return false;
  }
}

const psQuote = (s) => s.replaceAll("'", "''");

async function main() {
  if (!(await isElevated())) {
    console.error("Not elevated. Open an elevated PowerShell and re-run this script.");
    process.exit(2);
  }
  if (!process.platform.startsWith("win")) {
    console.error("Windows only.");
    process.exit(2);
  }

  console.log(`Spike B: temporary address on "${nic}" as ${ip}/${prefix}\n`);

  // 1. Snapshot
  const dhcpBefore = await ps(
    `(Get-NetIPInterface -InterfaceAlias '${psQuote(nic)}' -AddressFamily IPv4).Dhcp`,
  );
  const addressesBefore = await ps(
    `Get-NetIPAddress -InterfaceAlias '${psQuote(nic)}' -AddressFamily IPv4 | Sort-Object IPAddress | Select-Object -ExpandProperty IPAddress`,
  );
  console.log(
    `  snapshot: DHCP=${dhcpBefore || "<none>"}, addresses: ${(addressesBefore || "").split(/\r?\n/).join(", ") || "<none>"}\n`,
  );

  // 2. Apply the recipe
  await run("netsh", [
    "interface",
    "ipv4",
    "set",
    "interface",
    `interface=${nic}`,
    "dhcpstaticipcoexistence=enabled",
  ]);
  await run("netsh", [
    "interface",
    "ipv4",
    "add",
    "address",
    `name=${nic}`,
    `address=${ip}/${prefix}`,
    "store=active",
    "skipassource=true",
  ]);
  console.log("  applied: coexistence=enabled, add address store=active skipassource=true\n");

  // 3. Verify after add
  const addr = await ps(
    `Get-NetIPAddress -InterfaceAlias '${psQuote(nic)}' -AddressFamily IPv4 -IPAddress ${ip} | Select-Object SkipAsSource, Store | ConvertTo-Json -Compress`,
  );
  let skipAsSource = null;
  let store = null;
  try {
    const parsed = JSON.parse(addr || "{}");
    skipAsSource = parsed.SkipAsSource;
    store = parsed.Store;
  } catch {
    // Address lookup failed; checks below will flag it.
  }
  check("address present after add", skipAsSource !== null);
  check("SkipAsSource=True", skipAsSource === true, `got ${skipAsSource}`);
  check(
    "store is ActiveStore (non-persistent)",
    store === null || store === 0 || /active/i.test(String(store)),
    `got ${store}`,
  );
  const dhcpAfterAdd = await ps(
    `(Get-NetIPInterface -InterfaceAlias '${psQuote(nic)}' -AddressFamily IPv4).Dhcp`,
  );
  check(
    "DHCP still Enabled after add",
    dhcpAfterAdd.toLowerCase() === "enabled",
    `got ${dhcpAfterAdd}`,
  );

  // 4. Remove and restore
  await run("netsh", [
    "interface",
    "ipv4",
    "delete",
    "address",
    `name=${nic}`,
    `address=${ip}`,
    "store=active",
  ]);
  await run("netsh", [
    "interface",
    "ipv4",
    "set",
    "interface",
    `interface=${nic}`,
    "dhcpstaticipcoexistence=disabled",
  ]);
  console.log("\n  restored: delete address + coexistence=disabled\n");

  // 5. Verify after restore
  const afterList = await ps(
    `Get-NetIPAddress -InterfaceAlias '${psQuote(nic)}' -AddressFamily IPv4 | Sort-Object IPAddress | Select-Object -ExpandProperty IPAddress`,
  );
  const addrGone = !(afterList || "").split(/\r?\n/).includes(ip);
  check("address removed", addrGone);
  const dhcpAfterRemove = await ps(
    `(Get-NetIPInterface -InterfaceAlias '${psQuote(nic)}' -AddressFamily IPv4).Dhcp`,
  );
  check(
    "DHCP still Enabled after remove",
    dhcpAfterRemove.toLowerCase() === "enabled",
    `got ${dhcpAfterRemove}`,
  );
  const normalize = (s) =>
    (s || "")
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean)
      .sort()
      .join(",");
  check("address list identical to snapshot", normalize(addressesBefore) === normalize(afterList));

  console.log(
    failures === 0 ? "\nSPIKE B: ALL CHECKS PASSED" : `\nSPIKE B: ${failures} CHECK(S) FAILED`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(`spike-b failed: ${error.message}`);
  console.error("If the add failed mid-way, remove the address manually:");
  console.error(`  netsh interface ipv4 delete address name="${nic}" address=${ip} store=active`);
  process.exit(1);
});
