import { BlockList, isIP } from 'node:net';

/**
 * Destinations a connector may never reach: loopback, private, link-local (incl. cloud metadata 169.254.169.254),
 * carrier-grade NAT, documentation, benchmarking, multicast and reserved ranges, for IPv4 and IPv6.
 */
const blocked = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
  ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of [
  ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(net, prefix, 'ipv6');

/** IPv6 forms that embed an IPv4 address the packet may actually reach. */
function embeddedIPv4(v6: string): string | null {
  const lower = v6.toLowerCase();
  const mapped = /^::ffff:(?:0:)?(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mapped) return mapped[1]!;
  const hexMapped = /^::ffff:(?:0:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  const nat64 = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  const sixToFour = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/.exec(lower);
  const m = hexMapped ?? nat64 ?? sixToFour;
  if (!m) return null;
  const hi = parseInt(m[1]!, 16); const lo = parseInt(m[2]!, 16);
  return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
}

export function isBlockedAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return blocked.check(address, 'ipv4');
  if (family === 6) {
    const v4 = embeddedIPv4(address);
    if (v4) return blocked.check(v4, 'ipv4');
    return blocked.check(address, 'ipv6');
  }
  return true; // not an IP at all: refuse rather than guess
}
