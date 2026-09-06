import { writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.DOCKER_E2E_PORT ?? '18787';
const ENDPOINT = `http://127.0.0.1:${PORT}/mcp`;
const COMMIT = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
process.env.MCP_ENDPOINT = ENDPOINT;
process.env.MCP_BENCHMARK_RUNS = process.env.MCP_BENCHMARK_RUNS ?? '10';

const steps = [];
const record = (name, status, detail) => { steps.push({ name, status, detail }); console.error(`[${status}] ${name} ${detail ?? ''}`); };
const sh = (name, command, args, timeoutMs = 600000) => {
  try { const output = execFileSync(command, args, { cwd: root, encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'] }); record(name, 'PASS', output.split('\n').slice(-3).join(' | ').slice(0, 200)); return output; }
  catch (error) { record(name, 'FAIL', String(error).slice(0, 300)); throw error; }
};

const compose = (...args) => ['compose', ...args];
async function mcpCall(body, timeoutMs = 60000) {
  const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'accept': 'application/json, text/event-stream', 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  const text = await response.text();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
  const dataLines = text.startsWith('event:') || text.startsWith('data:') ? text.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trim()) : [text];
  return JSON.parse(dataLines[dataLines.length - 1] ?? '{}');
}

let exitCode = 0;
try {
  const overridePath = join(root, '.cache', 'docker-e2e-override.yml');
  writeFileSync(overridePath, ['services:', '  openpapers:', '    environment:', '      OPENPAPERS_FIXTURE_PROVIDERS: "1"', `      HTTP_PORT: "${PORT}"`, '    ports: !override', `      - "127.0.0.1:${PORT}:${PORT}"`].join('\n') + '\n');
  sh('compose up --build --wait', 'docker', compose('-f', 'docker-compose.yml', '-f', '.cache/docker-e2e-override.yml', 'up', '-d', '--build', '--wait'));

  let up = false; let lastError;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try { const response = await fetch(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(3000) }); up = true; break; } catch (error) { lastError = error; await new Promise(resolve => setTimeout(resolve, 2000)); }
  }
  if (!up) throw lastError ?? new Error('MCP endpoint never became reachable');
  record('endpoint reachable', 'PASS');

  const tools = await mcpCall({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'docker-e2e', version: '0' } } });
  const toolCount = (await mcpCall({ jsonrpc: '2.0', id: 2, method: 'tools/list' })).result?.tools?.length;
  if (toolCount !== 37) throw new Error(`expected 37 tools, got ${toolCount}`);
  record('mcp initialize + tools/list', 'PASS', `${toolCount} tools, server ${tools.result?.serverInfo?.version}`);

  const search = await mcpCall({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'search_papers', arguments: { query: 'LoRA low rank adaptation', limit: 10 } } });
  if (search.result?.isError) throw new Error(`search_papers failed over docker: ${search.result?.content?.[0]?.text}`);
  const paperId = search.result?.structuredContent?.data?.[0]?.paperId;
  if (!paperId) throw new Error('search_papers returned no data over docker');
  record('tools/call search_papers (fixture providers)', 'PASS', `top work ${paperId}`);

  const created = await mcpCall({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'create_collection', arguments: { name: 'docker-e2e-persist' } } });
  const collectionId = created.result?.structuredContent?.collection?.id;
  if (!collectionId) throw new Error('create_collection failed over docker');
  record('persistence: create_collection', 'PASS', collectionId);

  sh('persistence: restart app container', 'docker', compose('restart', 'openpapers'), 180000);
  let persisted = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const listed = await mcpCall({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'list_collections', arguments: {} } }, 15000);
      persisted = (listed.result?.structuredContent?.collections ?? []).some(item => item.id === collectionId);
      if (persisted) break;
    } catch { /* container still restarting */ }
  }
  if (!persisted) throw new Error('collection did not survive container restart');
  record('persistence: collection survives restart', 'PASS');

  const grobid = await fetch('http://127.0.0.1:8070/api/isalive', { signal: AbortSignal.timeout(10000) }).then(r => r.text()).catch(() => 'unreachable');
  if (grobid.trim() !== 'true') throw new Error(`GROBID isalive returned ${grobid.slice(0, 50)}`);
  record('GROBID isalive', 'PASS');

  sh('adversarial MCP smoke', 'node', ['scripts/adversarial-mcp-smoke.mjs'], 120000);
  const benchmark = sh('30-run MCP benchmark', 'node', ['scripts/mcp-benchmark.mjs'], 180000);
  const benchmarkLines = benchmark.split('\n').filter(line => line.startsWith('{"name"')).map(line => JSON.parse(line)).map(entry => `${entry.name} median ${entry.median_ms}ms`).join(', ');
  record('benchmark medians', 'PASS', benchmarkLines);
} catch (error) {
  exitCode = 1;
  record('docker e2e', 'FAIL', String(error).slice(0, 300));
} finally {
  try { execFileSync('docker', compose('down', '-v'), { cwd: root, encoding: 'utf8', timeout: 180000, stdio: 'ignore' }); record('compose down -v', 'PASS'); } catch { record('compose down -v', 'FAIL'); }
  rmSync(join(root, '.cache', 'docker-e2e-override.yml'), { force: true });
}

const result = { schemaVersion: 'openpapers.docker-e2e.v1', kind: 'runtime-docker-e2e', commit: COMMIT, timestamp: new Date().toISOString(), fixtureMode: true, steps, passed: exitCode === 0 };
const output = join(root, 'evals/results', `docker-e2e-${COMMIT.slice(0, 12)}.json`);
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, passed: result.passed, steps: steps.map(step => `${step.name}:${step.status}`) }, null, 2));
process.exit(exitCode);
