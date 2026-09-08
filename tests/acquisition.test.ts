import { describe, expect, it } from 'vitest';
import { PaperAcquirer } from '../src/ingestion/acquisition.js';

describe('bounded paper acquisition', () => {
  it('rejects unsafe local targets before fetching', async () => {
    const fetcher = async () => { throw new Error('must not fetch'); };
    await expect(new PaperAcquirer(fetcher).acquire('http://127.0.0.1/paper')).rejects.toThrow('unsafe host');
    await expect(new PaperAcquirer(fetcher).acquire('http://169.254.169.254/latest/meta-data')).rejects.toThrow('unsafe host');
    await expect(new PaperAcquirer(fetcher).acquire('http://[::ffff:127.0.0.1]/paper')).rejects.toThrow('unsafe host');
    await expect(new PaperAcquirer(fetcher).acquire('http://[::7f00:1]/paper')).rejects.toThrow('unsafe host');
    await expect(new PaperAcquirer(fetcher).acquire('http://[::c0a8:101]/paper')).rejects.toThrow('unsafe host');
  });

  it('rejects declared bodies over the configured limit', async () => {
    const fetcher = async () => new Response('small', {status:200, headers:{'content-length':'100'}});
    await expect(new PaperAcquirer(fetcher, {maxBytes:10}).acquire('https://example.com/paper')).rejects.toThrow('size limit');
  });

  it('validates redirects and returns bounded document bytes', async () => {
    let calls = 0;
    const fetcher = async (input: RequestInfo | URL) => {
      calls += 1;
      return calls === 1 ? new Response(null, {status:302, headers:{location:'https://example.com/final'}}) : new Response('paper text', {status:200, headers:{'content-type':'text/plain'}});
    };
    const document = await new PaperAcquirer(fetcher).acquire('https://example.com/start');
    expect(document).toMatchObject({url:'https://example.com/final', contentType:'text/plain', bytes:10});
    expect(new TextDecoder().decode(document.body)).toBe('paper text');
    expect(calls).toBe(2);
  });

  it('rejects redirects to unsafe hosts', async () => {
    const fetcher = async () => new Response(null, {status:302, headers:{location:'http://localhost/private'}});
    await expect(new PaperAcquirer(fetcher).acquire('https://example.com/start')).rejects.toThrow('unsafe host');
  });
  it('rejects archive and compressed payloads before parsing', async () => {
    const fetcher = async () => new Response(new Uint8Array([0x50,0x4b,0x03,0x04]), {status:200,headers:{'content-type':'application/zip'}});
    await expect(new PaperAcquirer(fetcher).acquire('https://example.com/paper')).rejects.toThrow('archive or compressed content unsupported');
  });
});
