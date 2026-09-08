import { isIP } from 'node:net';

export interface AcquiredDocument { url: string; contentType: string; bytes: number; body: Uint8Array; }
export interface AcquisitionOptions { maxBytes?: number; timeoutMs?: number; maxRedirects?: number; }

function assertSafeUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('invalid URL'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('unsupported protocol');
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const ipVersion = isIP(host);
  const mappedIpv4 = ipVersion === 6 ? mappedIPv4Address(host) : undefined;
  const ipv4 = mappedIpv4 ?? (ipVersion === 4 ? host : undefined);
  const unsafeIpv4 = Boolean(ipv4 && (ipv4 === '0.0.0.0' || ipv4.startsWith('127.') || ipv4.startsWith('10.') || ipv4.startsWith('169.254.') || ipv4.startsWith('192.168.') || /^172\.(1[6-9]|2\d|3[01])\./.test(ipv4) || ipv4.startsWith('100.64.')));
  const unsafeIpv6 = ipVersion === 6 && (host === '::1' || host === '::' || host.startsWith('fc') || host.startsWith('fd') || host.startsWith('fe80:'));
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || unsafeIpv4 || unsafeIpv6) throw new Error('unsafe host');
  return url;
}
function mappedIPv4Address(host:string):string|undefined { const match=host.match(/^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i); if(!match)return undefined; const value=match.slice(1).map(part=>Number.parseInt(part!,16)); return value.every(part=>Number.isInteger(part)&&part>=0&&part<=0xffff) ? `${value[0]!>>8}.${value[0]!&255}.${value[1]!>>8}.${value[1]!&255}` : undefined; }

export class PaperAcquirer {
  constructor(private readonly fetcher: typeof fetch = fetch, private readonly options: AcquisitionOptions = {}) {}
  async acquire(input: string): Promise<AcquiredDocument> {
    const maxBytes = this.options.maxBytes ?? 25 * 1024 * 1024;
    const timeoutMs = this.options.timeoutMs ?? 30_000;
    const maxRedirects = this.options.maxRedirects ?? 3;
    let url = assertSafeUrl(input);
    for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetcher(url, {redirect:'manual', signal:controller.signal});
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location');
          if (!location) throw new Error('redirect missing location');
          if (redirect === maxRedirects) throw new Error('redirect limit');
          url = assertSafeUrl(new URL(location, url).toString());
          continue;
        }
        if (!response.ok) throw new Error(`acquisition failed: ${response.status}`);
        const declared = Number(response.headers.get('content-length') ?? 0);
        if (declared > maxBytes) throw new Error('size limit');
        const chunks: Uint8Array[] = [];
        let total = 0;
        if (response.body) {
          const reader = response.body.getReader();
          while (true) {
            const next = await reader.read();
            if (next.done) break;
            total += next.value.byteLength;
            if (total > maxBytes) { await reader.cancel(); throw new Error('size limit'); }
            chunks.push(next.value);
          }
        } else {
          const buffer = new Uint8Array(await response.arrayBuffer());
          total = buffer.byteLength;
          if (total > maxBytes) throw new Error('size limit');
          chunks.push(buffer);
        }
        const body = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
        const contentType = response.headers.get('content-type')?.split(';',1)[0]?.trim() ?? 'application/octet-stream';
        const encoding = response.headers.get('content-encoding')?.toLowerCase() ?? '';
        const archiveMagic = (body[0] === 0x50 && body[1] === 0x4b && body[2] === 0x03 && body[3] === 0x04) || (body[0] === 0x1f && body[1] === 0x8b) || (body[0] === 0x42 && body[1] === 0x5a && body[2] === 0x68);
        if (/zip|gzip|x-gzip|compress|tar|7z|rar/.test(`${contentType} ${encoding}`) || archiveMagic) throw new Error('archive or compressed content unsupported');
        return {url:url.toString(), contentType, bytes:total, body};
      } finally { clearTimeout(timeout); }
    }
    throw new Error('redirect limit');
  }
}
