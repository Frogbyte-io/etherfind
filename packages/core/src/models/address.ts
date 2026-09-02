export type MacAddress = string;

const MAC_OCTETS = 6;

export function isValidMac(value: string): boolean {
  return /^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$/.test(value);
}

export function normalizeMac(value: string): MacAddress {
  return value.toLowerCase();
}

export function macToBytes(value: MacAddress): Uint8Array {
  const parts = value.split(":");
  const out = new Uint8Array(MAC_OCTETS);
  for (let i = 0; i < MAC_OCTETS; i++) {
    const part = parts[i];
    out[i] = part === undefined ? 0 : Number.parseInt(part, 16);
  }
  return out;
}

export function bytesToMac(bytes: Uint8Array, offset = 0): MacAddress {
  const parts: string[] = [];
  for (let i = 0; i < MAC_OCTETS; i++) {
    const b = bytes[offset + i] ?? 0;
    parts.push(b.toString(16).padStart(2, "0"));
  }
  return parts.join(":");
}

export type Ipv4Address = string;

export const IPV4_OCTETS = 4;

export function isValidIpv4(value: string): boolean {
  const parts = value.split(".");
  if (parts.length !== IPV4_OCTETS) return false;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return false;
    const n = Number.parseInt(part, 10);
    if (n > 255) return false;
    // No leading zeros ("01")
    if (part.length > 1 && part.startsWith("0")) return false;
  }
  return true;
}

export function ipv4ToBytes(ip: Ipv4Address): Uint8Array {
  const out = new Uint8Array(IPV4_OCTETS);
  const parts = ip.split(".");
  for (let i = 0; i < IPV4_OCTETS; i++) {
    out[i] = Number.parseInt(parts[i] ?? "0", 10) & 0xff;
  }
  return out;
}

export function bytesToIpv4(bytes: Uint8Array, offset = 0): Ipv4Address {
  const parts: string[] = [];
  for (let i = 0; i < IPV4_OCTETS; i++) {
    const b = bytes[offset + i] ?? 0;
    parts.push(String(b));
  }
  return parts.join(".");
}

export function ipv4ToUint32(ip: Ipv4Address): number {
  const b = ipv4ToBytes(ip);
  return (((b[0] ?? 0) << 24) | ((b[1] ?? 0) << 16) | ((b[2] ?? 0) << 8) | (b[3] ?? 0)) >>> 0;
}

export function uint32ToIpv4(value: number): Ipv4Address {
  const v = value >>> 0;
  return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff].join(".");
}

export type PrefixLength = number;

export function prefixToMaskUint32(prefix: PrefixLength): number {
  if (prefix <= 0) return 0;
  if (prefix >= 32) return 0xffffffff;
  return (0xffffffff << (32 - prefix)) >>> 0;
}

export function networkOf(ip: Ipv4Address, prefix: PrefixLength): Ipv4Address {
  return uint32ToIpv4(ipv4ToUint32(ip) & prefixToMaskUint32(prefix));
}

export function broadcastOf(ip: Ipv4Address, prefix: PrefixLength): Ipv4Address {
  return uint32ToIpv4(
    (ipv4ToUint32(ip) & prefixToMaskUint32(prefix)) | (~prefixToMaskUint32(prefix) >>> 0),
  );
}

export function sameSubnet(a: Ipv4Address, b: Ipv4Address, prefix: PrefixLength): boolean {
  const mask = prefixToMaskUint32(prefix);
  return (ipv4ToUint32(a) & mask) === (ipv4ToUint32(b) & mask);
}

export function isPrivateIpv4(ip: Ipv4Address): boolean {
  if (!isValidIpv4(ip)) return false;
  const a = Number.parseInt(ip.split(".")[0] ?? "0", 10);
  const b = Number.parseInt(ip.split(".")[1] ?? "0", 10);
  if (a === 10) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 169 && b === 254) return true;
  return false;
}
