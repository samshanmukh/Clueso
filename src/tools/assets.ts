import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { validatePublicUrl, assertAllowedHost } from './network.ts';
import type { Fetch } from '../http.ts';

export async function fetchAsset(input: string, options: {
  allowedHosts: string[];
  artifactRoot: string;
  fetch?: Fetch;
  allowLocalhost?: boolean;
  resolveDns?: boolean;
  maxBytes?: number;
  timeoutMs?: number;
}) {
  const fetcher = options.fetch ?? globalThis.fetch;
  let current = input;
  const redirects: string[] = [];
  const signal = AbortSignal.timeout(options.timeoutMs ?? 15_000);
  for (let i = 0; i <= 4; i++) {
    const url = await validatePublicUrl(current, options);
    if (url.protocol !== 'https:' && !options.allowLocalhost) throw new Error('Reference asset downloads require HTTPS.');
    assertAllowedHost(url, options.allowedHosts);
    const response = await fetcher(url, { redirect: 'manual', signal, headers: { Accept: 'image/svg+xml,image/png,image/jpeg,image/webp' } });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location) throw new Error('Asset redirect has no Location header.');
      redirects.push(url.href);
      current = new URL(location, url).href;
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`Asset request failed (HTTP ${response.status}).`); }
    const contentType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    const extensions: Record<string, string> = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
    const extension = extensions[contentType];
    if (!extension) { await response.body?.cancel(); throw new Error('Asset endpoint did not return a supported image content type.'); }
    const limit = options.maxBytes ?? 5 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Asset exceeds the download size limit.'); }
    if (!response.body) throw new Error('Asset response was empty.');
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit) throw new Error('Asset exceeds the download size limit.');
        chunks.push(value);
      }
    } finally { await reader.cancel(); }
    const bytes = Buffer.concat(chunks);
    const validMagic = extension === 'svg' ? /<svg[\s>]/i.test(bytes.toString('utf8', 0, Math.min(size, 4096)))
      : extension === 'png' ? bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : extension === 'jpg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
      : bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
    if (!validMagic) throw new Error('Asset bytes do not match the declared image type.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const directory = join(options.artifactRoot, 'references');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, `${sha256}.${extension}`);
    await writeFile(path, bytes, { mode: 0o600 });
    const record = { sourceUrl: input, finalUrl: url.href, redirects, retrievedAt: new Date().toISOString(), sha256, contentType, sizeBytes: size, path, authorityStatus: 'unreviewed' as const };
    await writeFile(join(directory, `${sha256}.json`), JSON.stringify(record, null, 2), { mode: 0o600 });
    return record;
  }
  throw new Error('Asset redirect limit exceeded.');
}
