import net from "node:net";

const V4_DENY = [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const;

const V6_DENY = [
  ["2001::", 32], ["2001:2::", 48], ["2001:10::", 28], ["2001:20::", 28],
  ["2001:db8::", 32], ["2002::", 16], ["3fff::", 20],
  ["::", 96], ["::1", 128], ["::ffff:0:0", 96], ["64:ff9b::", 96],
  ["64:ff9b:1::", 48], ["fe80::", 10], ["fc00::", 7], ["ff00::", 8],
] as const;

export function ipv4Bytes(address: string): Uint8Array {
  if (net.isIP(address) !== 4) throw new Error("invalid IPv4 address");
  return Uint8Array.from(address.split(".").map(Number));
}

export function ipv6Bytes(address: string): Uint8Array {
  if (net.isIP(address) !== 6) throw new Error("invalid IPv6 address");
  let value = address.toLowerCase();
  const lastColon = value.lastIndexOf(":");
  const tail = value.slice(lastColon + 1);
  if (tail.includes(".")) {
    const bytes = ipv4Bytes(tail);
    value = `${value.slice(0, lastColon)}:${((bytes[0] << 8) | bytes[1]).toString(16)}:${((bytes[2] << 8) | bytes[3]).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) throw new Error("invalid IPv6 address");
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeros = 8 - left.length - right.length;
  if (zeros < 0 || (halves.length === 1 && zeros !== 0)) throw new Error("invalid IPv6 address");
  const words = [...left, ...Array(zeros).fill("0"), ...right].map((part) => Number.parseInt(part, 16));
  const bytes = new Uint8Array(16);
  words.forEach((word, index) => {
    bytes[index * 2] = word >>> 8;
    bytes[index * 2 + 1] = word & 0xff;
  });
  return bytes;
}

function prefixMatch(value: Uint8Array, network: Uint8Array, bits: number): boolean {
  const full = Math.floor(bits / 8);
  for (let i = 0; i < full; i++) if (value[i] !== network[i]) return false;
  const remaining = bits % 8;
  if (remaining === 0) return true;
  const mask = (0xff << (8 - remaining)) & 0xff;
  return (value[full] & mask) === (network[full] & mask);
}

function inV4Cidr(value: Uint8Array, network: string, bits: number): boolean {
  return prefixMatch(value, ipv4Bytes(network), bits);
}

function inV6Cidr(value: Uint8Array, network: string, bits: number): boolean {
  return prefixMatch(value, ipv6Bytes(network), bits);
}

export function isPermittedDestination(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    const bytes = ipv4Bytes(address);
    return !V4_DENY.some(([network, bits]) => inV4Cidr(bytes, network, bits));
  }
  if (family !== 6) return false;
  if (address.includes(".")) {
    const embedded = address.slice(address.lastIndexOf(":") + 1);
    if (!isPermittedDestination(embedded)) return false;
  }
  const bytes = ipv6Bytes(address);
  // Only globally routable unicast space is eligible, then the fixed
  // special-purpose exclusions are applied conservatively.
  if (!inV6Cidr(bytes, "2000::", 3)) return false;
  return !V6_DENY.some(([network, bits]) => inV6Cidr(bytes, network, bits));
}

/** Whole-set validation prevents a public+private rebinding answer set. */
export function selectPermittedAddress(addresses: readonly string[]): string | null {
  if (addresses.length === 0 || addresses.some((address) => !isPermittedDestination(address))) return null;
  return addresses[0];
}
