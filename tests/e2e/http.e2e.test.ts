import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createTcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');

function findFreePort(): Promise<number> {
  return new Promise(resolve => {
    const server = createTcpServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function parseMcpBody(text: string): any {
  if (!text.startsWith('event:') && !text.startsWith('data:')) return JSON.parse(text);
  const dataLines = text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim());
  return JSON.parse(dataLines[dataLines.length - 1] ?? '{}');
}

async function post(port: number, sessionId: string | undefined, body: unknown, origin?: string): Promise<{ status: number; sessionId?: string; json: any }> {
  const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'accept': 'application/json, text/event-stream',
      'content-type': 'application/json',
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify(body),
  });
  const headerSessionId = response.headers.get('mcp-session-id') ?? undefined;
  const text = await response.text();
  let json: any = {};
  try { json = parseMcpBody(text); } catch { json = {}; }
  return { status: response.status, sessionId: headerSessionId, json };
}

describe('HTTP process end-to-end', () => {
  it('serves a real socket, validates origins, and releases the port on shutdown', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'openpapers-http-e2e-'));
    const port = await findFreePort();
    const child: ChildProcess = spawn(process.execPath, [join(root, 'dist', 'mcp', 'server.js')], {
      env: { ...process.env, MCP_TRANSPORT: 'http', HTTP_HOST: '127.0.0.1', HTTP_PORT: String(port), OPENPAPERS_FIXTURE_PROVIDERS: '1', RESEARCH_DB_PATH: join(workDir, 'research.sqlite') },
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let lastError: unknown;
    let up = false;
    for (let attempt = 0; attempt < 50 && !up; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 200));
      try { await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', headers: { 'accept': 'application/json', 'content-type': 'application/json' }, body: '{}' }); up = true; } catch (error) { lastError = error; }
    }
    if (!up) throw lastError ?? new Error('server did not start');

    const initialized = await post(port, undefined, { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openpapers-e2e', version: '0.0.0' } } });
    expect(initialized.status).toBe(200);
    expect(initialized.json?.result?.serverInfo?.version).toBe('1.0.0');
    const sessionId = initialized.sessionId;

    await post(port, sessionId, { jsonrpc: '2.0', method: 'notifications/initialized' });

    const tools = await post(port, sessionId, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    expect(tools.status).toBe(200);
    expect(tools.json?.result?.tools).toHaveLength(37);

    const search = await post(port, sessionId, { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_papers', arguments: { query: 'LoRA low rank adaptation', limit: 10 } } });
    expect(search.status).toBe(200);
    expect(search.json?.result?.isError).toBeFalsy();
    expect(search.json?.result?.structuredContent?.data?.length).toBeGreaterThan(0);

    const forged = await post(port, sessionId, { jsonrpc: '2.0', id: 4, method: 'tools/list' }, 'https://evil.example');
    expect(forged.status).toBeGreaterThanOrEqual(400);
    expect(forged.status).toBeLessThan(500);

    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    child.kill('SIGTERM');
    const exit = await Promise.race([exited, new Promise<{ code: null; signal: null }>(resolve => setTimeout(() => resolve({ code: null, signal: null }), 10000))]);
    expect(exit.code !== null || exit.signal !== null).toBe(true);

    let portReleased = false;
    for (let attempt = 0; attempt < 10 && !portReleased; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 300));
      try { await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST', body: '{}' }); } catch (error: any) {
        const code = error?.code ?? error?.cause?.code;
        portReleased = typeof code === 'string' && code !== 'UND_ERR_CONNECT_TIMEOUT' ? true : portReleased || code === 'ECONNREFUSED';
        if (code === 'ECONNREFUSED' || code === 'ECONNRESET' || code === 'UND_ERR_SOCKET') portReleased = true;
      }
    }
    expect(portReleased).toBe(true);

    rmSync(workDir, { recursive: true, force: true });
  }, 60000);
});
