import { describe, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(fileURLToPath(import.meta.url), '..', '..', '..');

type JsonRpcMessage = { id?: number; result?: any; error?: { code: number; message: string } };

class StdioMcpClient {
  private child: ChildProcess;
  private pending = new Map<number, { resolve: (message: JsonRpcMessage) => void; reject: (error: Error) => void }>();
  private nextId = 1;

  private constructor(child: ChildProcess) {
    this.child = child;
    const lines = createInterface({ input: child.stdout! });
    lines.on('line', line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      let message: JsonRpcMessage;
      try { message = JSON.parse(trimmed); } catch { return; }
      if (typeof message.id === 'number' && this.pending.has(message.id)) {
        const waiter = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        waiter.resolve(message);
      }
    });
  }

  static start(env: Record<string, string>): StdioMcpClient {
    const child = spawn(process.execPath, [join(root, 'dist', 'mcp', 'server.js')], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    return new StdioMcpClient(child);
  }

  call(method: string, params: Record<string, unknown>, timeoutMs = 20000): Promise<JsonRpcMessage> {
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`timeout waiting for response to ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve: message => { clearTimeout(timer); resolve(message); }, reject });
      this.child.stdin!.write(payload);
    });
  }

  notify(method: string, params: Record<string, unknown> = {}): void {
    this.child.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  stderrText(): string {
    return this.child.stderr?.read()?.toString() ?? '';
  }

  async close(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ code: null, signal: null }), 8000);
      this.child.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
      this.child.kill();
    });
  }
}

describe('stdio process end-to-end', () => {
  let workDir: string;

  it('boots the real server, completes an MCP session, and serves the tool surface offline', async () => {
    workDir = mkdtempSync(join(tmpdir(), 'openpapers-stdio-e2e-'));
    const dbPath = join(workDir, 'research.sqlite');
    const client = StdioMcpClient.start({ OPENPAPERS_FIXTURE_PROVIDERS: '1', RESEARCH_DB_PATH: dbPath });

    const initialized = await client.call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'openpapers-e2e', version: '0.0.0' } });
    expect(initialized.result?.serverInfo?.name).toBe('OpenPapers');
    expect(initialized.result?.serverInfo?.version).toBe('1.0.0');
    client.notify('notifications/initialized');

    const tools = await client.call('tools/list', {});
    expect(tools.result?.tools).toHaveLength(37);

    const search = await client.call('tools/call', { name: 'search_papers', arguments: { query: 'QLoRA quantized finetuning', limit: 10 } });
    expect(search.result?.isError).toBeFalsy();
    const paperId = search.result?.structuredContent?.data?.[0]?.paperId;
    expect(typeof paperId).toBe('string');

    const collection = await client.call('tools/call', { name: 'create_collection', arguments: { name: 'e2e-stdio' } });
    const collectionId = collection.result?.structuredContent?.collection?.id;
    expect(typeof collectionId).toBe('string');

    await client.call('tools/call', { name: 'add_paper_to_collection', arguments: { collection_id: collectionId, paper_id: paperId } });
    const packResponse = await client.call('tools/call', { name: 'export_research_pack', arguments: { collection_id: collectionId } });
    const pack = packResponse.result?.structuredContent;
    expect(pack?.papers).toHaveLength(1);

    const imported = await client.call('tools/call', { name: 'import_research_pack', arguments: { pack_json: JSON.stringify({ ...pack, collection: { ...pack.collection, name: 'imported-e2e-stdio' } }) } });
    expect(imported.result?.structuredContent?.collection?.paperIds).toHaveLength(1);

    const bibtex = await client.call('tools/call', { name: 'get_bibtex', arguments: { paper_id: paperId } });
    expect(bibtex.result?.structuredContent?.bibtex).toContain('@article');

    const refreshed = await client.call('tools/call', { name: 'refresh_paper', arguments: { paper_id: paperId } });
    expect(refreshed.result?.structuredContent?.status).toBe('REFRESHED');

    const unknownTool = await client.call('tools/call', { name: 'no_such_tool', arguments: {} });
    expect(unknownTool.error !== undefined || unknownTool.result?.isError === true).toBe(true);

    expect(statSync(dbPath).size).toBeGreaterThan(0);

    const exit = await client.close();
    expect(exit.code !== null || exit.signal !== null).toBe(true);
    rmSync(workDir, { recursive: true, force: true });
  }, 60000);
});
