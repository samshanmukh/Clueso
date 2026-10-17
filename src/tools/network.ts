import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList();
globalV6.addSubnet('2000::', 3, 'ipv6');

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6');
}

export async function validatePublicUrl(input: string, options: { allowLocalhost?: boolean; resolveDns?: boolean } = {}): Promise<URL> {
  const url = new URL(input);
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only HTTP(S) URLs without embedded credentials are allowed.');
  const localhost = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  if (localhost && options.allowLocalhost) return url;
  if (!hostname.includes('.') && !isIP(hostname)) throw new Error('Private or non-public hostnames are not allowed.');
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') || hostname.endsWith('.internal')) throw new Error('Private or non-public hostnames are not allowed.');
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error('Private or non-public network addresses are not allowed.');
  } else if (options.resolveDns !== false) {
    const addresses = await lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some((r) => !isPublicAddress(r.address))) throw new Error('Hostname resolves to a private or non-public address.');
  }
  return url;
}

export function assertAllowedHost(url: URL, allowedHosts: string[]): void {
  if (!allowedHosts.some((host) => url.hostname.toLowerCase() === host.toLowerCase())) throw new Error('URL host is outside the approved reference host list.');
}
