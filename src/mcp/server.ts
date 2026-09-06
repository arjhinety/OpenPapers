import { createServer as createHttpServer } from 'node:http';

import { McpServer, createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { toNodeHandler, localhostHostValidation, localhostOriginValidation } from '@modelcontextprotocol/node';
import { ResearchService } from '../research/service.js';
import { PostgresResearchStore } from '../database/postgres.js';
import { HashEmbeddingProvider, PostgresVectorRetriever } from '../retrieval/vector.js';
import { registerTools } from './tools.js';
import { createShutdownController } from './lifecycle.js';
import { createFixtureProviders, type FixtureProviders } from '../testing/fixtures.js';

export function createMcpServer(research = new ResearchService(), ecosystemDeps?: Parameters<typeof registerTools>[2]): McpServer {
  const server = new McpServer({ name: 'OpenPapers', version: '1.0.0' });
  registerTools(server, research, ecosystemDeps);
  return server;
}

export function createHttpHandler(research = new ResearchService(), ecosystemDeps?: Parameters<typeof registerTools>[2]) {
  return createMcpHandler(() => createMcpServer(research, ecosystemDeps), { responseMode: 'json' });
}

async function main(): Promise<void> {
  const postgres = process.env.DATABASE_BACKEND === 'postgres' ? PostgresResearchStore.fromConfig() : undefined;
  const fixture = process.env.OPENPAPERS_FIXTURE_PROVIDERS === '1' ? createFixtureProviders() : undefined;
  if (fixture) console.error('OpenPapers fixture-provider mode: all providers are served from deterministic offline fixtures.');
  const research = new ResearchService(postgres ?? undefined, fixture?.arxiv as any, fixture?.crossref as any, fixture?.openalex as any, fixture?.semanticScholar as any, fixture?.acquirer as any);
  if(postgres) research.setVectorRetriever(new PostgresVectorRetriever(postgres,new HashEmbeddingProvider()));
  if (research.db instanceof PostgresResearchStore) await research.db.initialize();
  if (fixture) {
    const ecosystemDeps = { github: fixture.github as any, huggingface: fixture.huggingface as any };
    if (process.env.MCP_TRANSPORT === 'http') {
      await runHttp(research, ecosystemDeps);
    } else {
      await serveStdio(() => createMcpServer(research, ecosystemDeps));
      console.error('OpenPapers stdio server running');
    }
    return;
  }
  const mode = process.env.MCP_TRANSPORT ?? 'stdio';
  if (mode === 'http') {
    await runHttp(research);
  } else {
    await serveStdio(() => createMcpServer(research));
    console.error('OpenPapers stdio server running');
  }
}

async function runHttp(research: ResearchService, ecosystemDeps?: Parameters<typeof registerTools>[2]): Promise<void> {
    const handler = createHttpHandler(research, ecosystemDeps);
    const nodeHandler = toNodeHandler(handler);
    const host = process.env.HTTP_HOST ?? '127.0.0.1';
    const port = Number(process.env.HTTP_PORT ?? 8787);
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();
    const http = createHttpServer((req, res) => {
      if (req.url !== '/mcp' && req.url !== '/mcp/') { res.writeHead(404); res.end('Not found'); return; }
      if (!validateHost(req, res) || !validateOrigin(req, res)) return;
      void nodeHandler(req as any, res);
    });
    http.listen(port, host, () => console.error(`OpenPapers HTTP listening on http://${host}:${port}/mcp`));
    const closeHttp = () => new Promise<void>((resolve, reject) => { http.close(error => error ? reject(error) : resolve()); });
    const shutdown = createShutdownController([closeHttp, () => handler.close(), () => research.flushStorage(), () => research.db.close?.()]);
    process.once('SIGINT', () => void shutdown()); process.once('SIGTERM', () => void shutdown());
}

if (process.argv[1]?.replaceAll('\\', '/').endsWith('/mcp/server.js') || process.argv[1]?.replaceAll('\\', '/').endsWith('/mcp/server.ts')) void main();
