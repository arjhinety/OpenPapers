import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ResearchDb } from '../../src/database/db.js';
import { ResearchService } from '../../src/research/service.js';
import { createFixtureProviders, FIXTURE_WORK_LIST } from '../../src/testing/fixtures.js';

describe('SQLite default-path persistence across restarts', () => {
  it('persists works, collections, and packs through a close/reopen cycle', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'openpapers-restart-e2e-'));
    const dbPath = join(workDir, 'research.sqlite');
    const fixture = createFixtureProviders();

    const first = new ResearchService(new ResearchDb(dbPath), fixture.arxiv as any, fixture.crossref as any, fixture.openalex as any, fixture.semanticScholar as any, fixture.acquirer as any);
    const search = await first.search('LoRA low rank adaptation', 10);
    expect(search.data.length).toBeGreaterThan(0);
    const paperId = search.data[0]!.paperId;
    const collection = await first.createCollection('restart-persistence');
    await first.addToCollection(collection.id, paperId);
    await first.flushStorage();
    await first.db.close?.();
    expect(statSync(dbPath).size).toBeGreaterThan(0);

    const second = new ResearchService(new ResearchDb(dbPath), fixture.arxiv as any, fixture.crossref as any, fixture.openalex as any, fixture.semanticScholar as any, fixture.acquirer as any);
    expect(second.db.schemaVersion()).toBeGreaterThanOrEqual(1);

    const persisted = await second.getPaper(paperId);
    expect(persisted?.title).toBe(search.data[0]!.title);

    const collections = await second.listCollections();
    const restored = collections.find(item => item.name === 'restart-persistence');
    expect(restored).toBeTruthy();
    expect(restored!.paperIds).toContain(paperId);

    const pack = await second.buildResearchPack(restored!.id);
    expect(pack.papers.map(paper => paper.paperId)).toContain(paperId);

    for (const work of FIXTURE_WORK_LIST) {
      if (work.paperId === paperId) continue;
      await second.db.upsertWork(work);
    }
    const refreshedSearch = await second.db.getWork(paperId);
    expect(refreshedSearch).toBeTruthy();

    await second.db.close?.();
    rmSync(workDir, { recursive: true, force: true });
  }, 30000);
});
