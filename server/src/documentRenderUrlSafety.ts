import net, { type LookupFunction } from 'node:net';

const blockedIpv6Ranges = new net.BlockList();
([
  ['::', 128],
  ['::1', 128],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
  ['2001:db8::', 32],
] as Array<[string, number]>).forEach(([address, prefix]) => blockedIpv6Ranges.addSubnet(address, prefix, 'ipv6'));

function ipv4ToNumber(address: string): number {
  return address
    .split('.')
    .reduce((acc, item) => (acc << 8) + Number(item), 0) >>> 0;
}

function isIpv4InRange(address: string, base: string, bits: number): boolean {
  const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
  return (ipv4ToNumber(address) & mask) === (ipv4ToNumber(base) & mask);
}

export function isBlockedIpAddress(address: string): boolean {
  const family = net.isIP(address);
  if (family === 4) {
    return [
      ['0.0.0.0', 8],
      ['10.0.0.0', 8],
      ['100.64.0.0', 10],
      ['127.0.0.0', 8],
      ['169.254.0.0', 16],
      ['172.16.0.0', 12],
      ['192.0.0.0', 24],
      ['192.0.2.0', 24],
      ['192.168.0.0', 16],
      ['198.18.0.0', 15],
      ['198.51.100.0', 24],
      ['203.0.113.0', 24],
      ['224.0.0.0', 4],
      ['240.0.0.0', 4],
    ].some(([base, bits]) => isIpv4InRange(address, String(base), Number(bits)));
  }

  if (family === 6) {
    const normalized = address.toLowerCase();
    const mapped = normalized.match(/^(?:::ffff:|0:0:0:0:0:ffff:)([0-9a-f:.]+)$/i);
    if (mapped?.[1]) {
      if (net.isIP(mapped[1]) === 4) return isBlockedIpAddress(mapped[1]);
      const parts = mapped[1].split(':');
      if (parts.length === 2 && parts.every((part) => /^[0-9a-f]{1,4}$/i.test(part))) {
        const [first, second] = parts.map((part) => Number.parseInt(part, 16));
        return isBlockedIpAddress(`${(first >> 8) & 0xff}.${first & 0xff}.${(second >> 8) & 0xff}.${second & 0xff}`);
      }
      return true;
    }
    return blockedIpv6Ranges.check(address, 'ipv6');
  }

  return true;
}

export function createFixedLookup(expectedHostname: string, addresses: Array<{ address: string; family: number }>): LookupFunction {
  const expected = expectedHostname.toLowerCase().replace(/\.$/, '');
  return ((hostname: string, options: unknown, callback?: unknown) => {
    const cb = typeof options === 'function' ? options : callback;
    if (typeof cb !== 'function') return;
    if (hostname.toLowerCase().replace(/\.$/, '') !== expected) { cb(new Error('模板链接域名与校验域名不一致。')); return; }

    const lookupOptions = typeof options === 'object' && options !== null ? options as { all?: boolean; family?: number } : {};
    const candidates = lookupOptions.family
      ? addresses.filter((item) => item.family === lookupOptions.family)
      : addresses;
    const selected = candidates.length > 0 ? candidates : addresses;

    if (lookupOptions.all) {
      cb(null, selected);
      return;
    }

    const first = selected[0];
    cb(null, first.address, first.family);
  }) as LookupFunction;
}
