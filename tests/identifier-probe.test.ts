import { describe, expect, it } from 'vitest';
import { ResearchDb } from '../src/database/db.js';
import { ResearchService } from '../src/research/service.js';
import { makeWork } from './helpers.js';

const arxivWork = makeWork({ title: 'LoRA: Low-Rank Adaptation of Large Language Models', arxivId: '2106.09685', doi: '10.48550/arxiv.2106.09685' });


function serviceWith(overrides: { arxiv?: any; crossref?: any }): ResearchService {
  const arxiv = { search: async () => [], searchById: async () => undefined, ...overrides.arxiv };
  const crossref = { search: async () => [], getByDoi: async () => undefined, ...overrides.crossref };
  return new ResearchService(new ResearchDb(':memory:'), arxiv as any, crossref as any, { search: async () => [] } as any, { search: async () => [] } as any);
}

describe('identifier-shaped query probing', () => {
  it('probes arXiv ids and ranks the confirmed target first', async () => {
    let probedWith: string | undefined;
    const service = serviceWith({ arxiv: { searchById: async (id: string) => { probedWith = id; return [arxivWork]; } } });
    const response = await service.search('arXiv:2106.09685', 10);
    expect(probedWith).toBe('2106.09685');
    expect(response.data[0]?.paperId).toBe(arxivWork.paperId);
    expect(response.data[0]?.arxivId).toBe('2106.09685');
  });

  it('probes bare arXiv id strings and arXiv URLs', async () => {
    let calls = 0;
    const service = serviceWith({ arxiv: { searchById: async () => { calls += 1; return [arxivWork]; } } });
    await service.search('2106.09685', 10);
    await service.search('https://arxiv.org/abs/2106.09685', 10);
    expect(calls).toBe(2);
  });

  it('probes non-arXiv DOI strings through Crossref and ranks the target first', async () => {
    let probedDoi: string | undefined;
    const crossrefWork = makeWork({ title: 'A Curated Non-ArXiv Work', doi: '10.1000/curated-paper' });
    const service = serviceWith({ crossref: { getByDoi: async (doi: string) => { probedDoi = doi; return crossrefWork; } } });
    const response = await service.search('https://doi.org/10.1000/curated-paper', 10);
    expect((probedDoi ?? '').toLowerCase()).toBe('10.1000/curated-paper');
    expect(response.data[0]?.paperId).toBe(crossrefWork.paperId);
    expect(response.transparency.providerFailures ?? []).toEqual([]);
  });

  it('routes arXiv-minted DOIs (10.48550/arXiv.*) to the arXiv probe, not Crossref', async () => {
    let arxivProbe: string | undefined; let crossrefProbed = false;
    const service = serviceWith({
      arxiv: { searchById: async (id: string) => { arxivProbe = id; return [arxivWork]; } },
      crossref: { getByDoi: async () => { crossrefProbed = true; return undefined; } },
    });
    const response = await service.search('https://doi.org/10.48550/arXiv.2106.09685', 10);
    expect(arxivProbe).toBe('2106.09685');
    expect(crossrefProbed).toBe(false);
    expect(response.data[0]?.paperId).toBe(arxivWork.paperId);
  });

  it('surfaces probe failures transparently without breaking the search', async () => {
    const service = serviceWith({ arxiv: { searchById: async () => { throw new Error('probe down'); } } });
    const response = await service.search('2106.09685', 10);
    expect(response.data).toEqual([]);
    expect(response.transparency.providerFailures?.some(failure => failure.startsWith('arxiv_id_probe:'))).toBe(true);
  });

  it('does not probe ordinary keyword queries', async () => {
    let probed = false;
    const service = serviceWith({ arxiv: { searchById: async () => { probed = true; return []; } } });
    await service.search('low rank adaptation of large language models', 10);
    expect(probed).toBe(false);
  });
});

