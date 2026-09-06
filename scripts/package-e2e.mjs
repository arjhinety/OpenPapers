import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

// Distribution validation: prove the published tarball (not src/) works for a
// real consumer. Packs the package, installs it into a pristine directory,
// spawns the installed binary over stdio, and exercises the MCP surface plus
// persistence. With DATABASE_URL/DATABASE_BACKEND=postgres set, a second pass
// validates the PostgreSQL backend from the installed package.

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

const packOut = execFileSync('npm', ['pack', '--pack-destination', root], { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' });
const tarballName = packOut.trim().split('\n').pop().trim();
const tarball = join(root, tarballName);
console.log(`packed: ${tarballName}`);

const expectedVersion = JSON.parse(execFileSync('node', ['-e', 'console.log(JSON.stringify(require("./package.json").version))'], { cwd: root, encoding: 'utf8' }));

async function runPass({ name, env }) {
  const installDir = mkdtempSync(join(tmpdir(), `openpapers-package-e2e-${name}-`));
  try {
    writeFileSync(join(installDir, 'package.json'), JSON.stringify({ name: 'package-e2e-consumer', version: '1.0.0', private: true }, null, 2));
    execFileSync('npm', ['install', tarball, '--no-audit', '--no-fund'], { cwd: installDir, encoding: 'utf8', shell: process.platform === 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    const binPath = join(installDir, 'node_modules', 'openpapers', 'dist', 'mcp', 'server.js');
    if (!existsSync(binPath)) throw new Error('installed package is missing dist/mcp/server.js');
    const dbPath = join(installDir, `research-${name}.sqlite`);
    const child = spawn(process.execPath, [binPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env, RESEARCH_DB_PATH: dbPath },
    });
    const pending = new Map();
    let nextId = 1;
    const reader = createInterface({ input: child.stdout });
    reader.on('line', line => {
      let message; try { message = JSON.parse(line); } catch { return; }
      if (message?.id !== undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
    });
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    const call = (method, params) => new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); }, 60_000);
      pending.set(id, message => { clearTimeout(timer); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    });
    const notify = method => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method }) + '\n');

    const initialized = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'package-e2e', version: '1.0.0' } });
    if (initialized.error) throw new Error(`initialize failed: ${JSON.stringify(initialized.error)}`);
    const serverVersion = initialized.result?.serverInfo?.version;
    if (serverVersion !== expectedVersion) throw new Error(`server version ${serverVersion} != package version ${expectedVersion}`);
    notify('notifications/initialized');

    const tools = await call('tools/list', {});
    const toolCount = tools.result?.tools?.length;
    if (toolCount !== 37) throw new Error(`tools/list returned ${toolCount}, expected 37`);

    const search = await call('tools/call', { name: 'search_papers', arguments: { query: 'QLoRA quantized finetuning', limit: 5 } });
    if (search.result?.isError) throw new Error(`search_papers failed: ${JSON.stringify(search.result)}`);
    const paperId = search.result?.structuredContent?.data?.[0]?.paperId;
    if (typeof paperId !== 'string' || !paperId) throw new Error('search returned no paperId');

    const collection = await call('tools/call', { name: 'create_collection', arguments: { name: `package-e2e-${name}` } });
    if (collection.result?.isError) throw new Error(`create_collection failed: ${JSON.stringify(collection.result)}`);
    const collectionId = collection.result?.structuredContent?.collection?.id;
    if (typeof collectionId !== 'string') throw new Error(`create_collection returned no id: ${JSON.stringify(collection.result?.structuredContent)}`);
    const added = await call('tools/call', { name: 'add_paper_to_collection', arguments: { collection_id: collectionId, paper_id: paperId } });
    if (added.result?.isError) throw new Error(`add_paper_to_collection failed: ${JSON.stringify(added.result)}`);

    child.kill();
    await new Promise(resolve => child.on('exit', resolve));

    // Reopen against the same persisted store and verify read-after-restart.
    const child2 = spawn(process.execPath, [binPath], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env, RESEARCH_DB_PATH: dbPath } });
    const pending2 = new Map();
    let nextId2 = 1;
    const reader2 = createInterface({ input: child2.stdout });
    reader2.on('line', line => { let m; try { m = JSON.parse(line); } catch { return; } if (m?.id !== undefined && pending2.has(m.id)) { pending2.get(m.id)(m); pending2.delete(m.id); } });
    const call2 = (method, params) => new Promise((resolve, reject) => {
      const id = nextId2++;
      const timer = setTimeout(() => { pending2.delete(id); reject(new Error(`timeout waiting for ${method} (reconnect)`)); }, 60_000);
      pending2.set(id, m => { clearTimeout(timer); resolve(m); });
      child2.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) }) + '\n');
    });
    await call2('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'package-e2e', version: '1.0.0' } });
    const list = await call2('tools/call', { name: 'list_collections', arguments: {} });
    const found = JSON.stringify(list.result ?? {}).includes(`package-e2e-${name}`);
    child2.kill();
    await new Promise(resolve => child2.on('exit', resolve));
    if (!found) throw new Error(`collection did not survive restart (stderr: ${stderr.slice(0, 400)})`);
    return { name, serverVersion, toolCount, paperId: Boolean(paperId), persisted: true };
  } finally {
    rmSync(installDir, { recursive: true, force: true });
  }
}

const results = [await runPass({ name: 'sqlite', env: { OPENPAPERS_FIXTURE_PROVIDERS: '1' } })];
if (process.env.DATABASE_URL && process.env.DATABASE_BACKEND === 'postgres') {
  results.push(await runPass({ name: 'postgres', env: { OPENPAPERS_FIXTURE_PROVIDERS: '1', DATABASE_URL: process.env.DATABASE_URL, DATABASE_BACKEND: 'postgres' } }));
}
try { rmSync(tarball, { force: true }); } catch { /* leave the tarball if deletion is blocked */ }
console.log(JSON.stringify({ status: 'passed', tarball: tarballName, passes: results }, null, 2));
