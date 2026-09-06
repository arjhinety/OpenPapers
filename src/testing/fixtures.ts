import { author, paperId } from '../research/citations.js';
import type { ResearchWork } from '../models/research.js';

/**
 * Deterministic offline fixtures for tests and demo deployments.
 * No module under src/providers is imported: the objects below structurally
 * satisfy the provider surfaces that ResearchService and the ecosystem tools
 * consume, so OPENPAPERS_FIXTURE_PROVIDERS=1 never touches the network.
 */

export const FIXTURE_PAPER_URL = 'https://fixture.openpapers.local/attention';

const base = {
  attention: { title: 'Attention Is All You Need', arxiv: '1706.03762', year: 2017, authors: ['Ashish Vaswani', 'Noam Shazeer'], abstract: 'Transformer architecture relying entirely on self-attention to compute representations of its input and output.' },
  bert: { title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', arxiv: '1810.04805', year: 2018, authors: ['Jacob Devlin', 'Ming-Wei Chang'], abstract: 'Bidirectional transformer pretraining for language understanding.' },
  lora: { title: 'LoRA: Low-Rank Adaptation of Large Language Models', arxiv: '2106.09685', year: 2021, authors: ['Edward Hu'], abstract: 'Low rank adaptation for parameter efficient fine tuning of large language models.' },
  qlora: { title: 'QLoRA: Efficient Finetuning of Quantized LLMs', arxiv: '2305.14314', year: 2023, authors: ['Tim Dettmers'], abstract: 'Quantized language model fine tuning with low rank adapters and memory efficient backprop.' },
  toolformer: { title: 'Toolformer: Language Models Can Teach Themselves to Use Tools', arxiv: '2302.04761', year: 2023, authors: ['Timo Schick'], abstract: 'Language models can teach themselves to use external tools via self-supervised annotation.' },
  dpo: { title: 'Direct Preference Optimization: Your Language Model is Secretly a Reward Model', arxiv: '2305.18290', year: 2023, authors: ['Rafael Rafailov'], abstract: 'Direct preference optimization for language model alignment without an explicit reward model.' },
} as const;

export type FixtureWorkKey = keyof typeof base;

const build = (key: FixtureWorkKey): ResearchWork => {
  const item = base[key];
  const authors = item.authors.map(name => author(name));
  return {
    paperId: paperId(item.title, authors, `10.48550/arxiv.${item.arxiv}`, item.arxiv),
    title: item.title,
    authors,
    year: item.year,
    doi: `10.48550/arxiv.${item.arxiv}`,
    arxivId: item.arxiv,
    semanticScholarId: `s2-${item.arxiv.replaceAll('.', '')}`,
    openAlexId: `openalex-${item.arxiv.replaceAll('.', '')}`,
    citationCount: key === 'attention' ? 100000 : key === 'bert' ? 80000 : 900,
    publicationStatus: 'preprint',
    bibtex: `@article{fixture${item.year}${key},\n  title = {${item.title}},\n  year = {${item.year}}\n}`,
    sourceProviders: ['fixture'],
    versions: [],
    abstract: item.abstract,
    canonicalUrl: `https://arxiv.org/abs/${item.arxiv}`,
  };
};

export const FIXTURE_WORKS: Record<FixtureWorkKey, ResearchWork> = {
  attention: build('attention'), bert: build('bert'), lora: build('lora'),
  qlora: build('qlora'), toolformer: build('toolformer'), dpo: build('dpo'),
};

export const FIXTURE_WORK_LIST: ResearchWork[] = Object.values(FIXTURE_WORKS);

const normalizeArxiv = (value: string): string => value.replace(/^arXiv:/i, '').replace(/v\d+$/i, '').trim();
const normalizeDoi = (value: string): string => value.replace(/^https?:\/\/(?:www\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '').toLowerCase().trim();
const tokens = (value: string): Set<string> => new Set(value.toLowerCase().split(/[^a-z0-9]+/).filter(token => token.length > 2));
const overlap = (queryTokens: Set<string>, text: string): number => { let hits = 0; for (const token of tokens(text)) if (queryTokens.has(token)) hits += 1; return hits; };

const searchCore = (works: ResearchWork[], query: string, limit: number): ResearchWork[] => {
  const queryTokens = tokens(query);
  return works
    .map(work => ({ work, score: overlap(queryTokens, `${work.title} ${work.abstract ?? ''}`) }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.work.title.localeCompare(b.work.title))
    .slice(0, limit)
    .map(entry => entry.work);
};

const byWorkId = (id: string): ResearchWork | undefined =>
  FIXTURE_WORK_LIST.find(work => work.paperId === id || work.semanticScholarId === id || work.openAlexId === id || normalizeArxiv(work.arxivId ?? '') === normalizeArxiv(id) || normalizeDoi(work.doi ?? '') === normalizeDoi(id));

const referencesOf: Partial<Record<FixtureWorkKey, FixtureWorkKey[]>> = {
  attention: ['bert'], qlora: ['lora', 'attention'], toolformer: ['bert'], dpo: ['attention'],
};
const keyOf = (work: ResearchWork): FixtureWorkKey | undefined => (Object.keys(FIXTURE_WORKS) as FixtureWorkKey[]).find(key => FIXTURE_WORKS[key].paperId === work.paperId);

export interface FixtureProviders {
  arxiv: { search(query: string, limit?: number): Promise<ResearchWork[]>; searchById(arxivId: string): Promise<ResearchWork | undefined> };
  crossref: { search(query: string, limit?: number): Promise<ResearchWork[]> };
  openalex: { search(query: string, limit?: number): Promise<ResearchWork[]>; getReferences(id: string, limit?: number): Promise<ResearchWork[]>; getCitations(id: string, limit?: number): Promise<ResearchWork[]> };
  semanticScholar: { search(query: string, limit?: number): Promise<ResearchWork[]>; getPaper(id: string): Promise<ResearchWork | undefined>; getReferences(id: string, limit?: number): Promise<ResearchWork[]>; getCitations(id: string, limit?: number): Promise<ResearchWork[]>; getRelated(id: string, limit?: number): Promise<ResearchWork[]>; resolveAuthor(id: string): Promise<{ authorId: string; name: string; aliases?: string[]; papers?: { paperId: string }[] } | undefined> };
  github: { searchRepositories(query: string, limit?: number): Promise<Record<string, unknown>[]>; resolveRevision(owner: string, repo: string, ref: string): Promise<string>; listContents(owner: string, repo: string, path: string, ref?: string): Promise<Record<string, unknown>[]>; getContent(owner: string, repo: string, path: string, ref?: string): Promise<Record<string, unknown> | undefined> };
  huggingface: { searchModels(query: string, limit?: number): Promise<Record<string, unknown>[]>; searchDatasets(query: string, limit?: number): Promise<Record<string, unknown>[]> };
  acquirer: { acquire(url: string): Promise<{ url: string; contentType: string; bytes: number; body: Uint8Array }> };
}

export const FIXTURE_COMMIT_SHA = 'a'.repeat(40);

export const FIXTURE_HTML = [
  '<!doctype html><html><head><title>Attention Is All You Need</title></head><body>',
  '<h1>Attention Is All You Need</h1>',
  '<h2>Abstract</h2><p>The Transformer architecture relies entirely on self-attention to compute representations of its input and output.</p>',
  '<h2>Training Details</h2>',
  '<p>Optimizer: AdamW. Learning rate 2e-5. Batch size 256. Precision bf16. Training epochs 10.</p>',
  '<h2>Appendix A</h2><p>Warmup steps 4000. Weight decay 0.01. Gradient clipping 1.0.</p>',
  '</body></html>',
].join('\n');

export function createFixtureProviders(): FixtureProviders {
  const arxivView = (work: ResearchWork): ResearchWork => ({ ...work, sourceProviders: ['arxiv'] });
  const crossrefView = (work: ResearchWork): ResearchWork => { const { arxivId: _arxivId, ...rest } = work; return { ...rest, sourceProviders: ['crossref'] }; };
  const openalexView = (work: ResearchWork): ResearchWork => { const { arxivId: _a, semanticScholarId: _s, ...rest } = work; return { ...rest, sourceProviders: ['openalex'] }; };
  const s2View = (work: ResearchWork): ResearchWork => ({ ...work, sourceProviders: ['semantic_scholar'] });

  const graph = (id: string, relation: 'references' | 'citations' | 'related'): ResearchWork[] => {
    const work = byWorkId(id);
    if (!work) return [];
    const key = keyOf(work);
    if (relation === 'related') return FIXTURE_WORK_LIST.filter(item => item.paperId !== work.paperId);
    if (!key) return [];
    if (relation === 'references') return (referencesOf[key] ?? []).map(name => arxivView(FIXTURE_WORKS[name]));
    return FIXTURE_WORK_LIST.filter(item => { const itemKey = keyOf(item); return itemKey !== undefined && (referencesOf[itemKey] ?? []).includes(key); }).map(item => arxivView(item));
  };

  const encoded = (text: string) => Buffer.from(text, 'utf8').toString('base64');
  const configText = 'optimizer: AdamW\nlearning_rate: 0.00002\nbatch_size: 256\nprecision: bf16\n';

  return {
    arxiv: {
      search: async (query, limit = 10) => searchCore(FIXTURE_WORK_LIST, query, limit).map(arxivView),
      searchById: async (arxivId) => {
        const normalized = normalizeArxiv(arxivId);
        const match = FIXTURE_WORK_LIST.find(work => normalizeArxiv(work.arxivId ?? '') === normalized);
        return match ? arxivView(match) : undefined;
      },
    },
    crossref: { search: async (query, limit = 10) => searchCore(FIXTURE_WORK_LIST, query, limit).map(crossrefView) },
    openalex: {
      search: async (query, limit = 10) => searchCore(FIXTURE_WORK_LIST, query, limit).map(openalexView),
      getReferences: async (id, limit = 20) => graph(id, 'references').slice(0, limit),
      getCitations: async (id, limit = 20) => graph(id, 'citations').slice(0, limit),
    },
    semanticScholar: {
      search: async (query, limit = 10) => searchCore(FIXTURE_WORK_LIST, query, limit).map(s2View),
      getPaper: async (id) => { const work = byWorkId(id); return work ? s2View(work) : undefined; },
      getReferences: async (id, limit = 20) => graph(id, 'references').slice(0, limit),
      getCitations: async (id, limit = 20) => graph(id, 'citations').slice(0, limit),
      getRelated: async (id, limit = 20) => graph(id, 'related').slice(0, limit),
      resolveAuthor: async (id) => id.toLowerCase().includes('vaswani')
        ? { authorId: id, name: 'Ashish Vaswani', aliases: ['A. Vaswani'], papers: [{ paperId: FIXTURE_WORKS.attention.paperId }] }
        : undefined,
    },
    github: {
      searchRepositories: async (query, limit = 10) => {
        const repositories = [{
          fullName: 'fixture/qlora-implementation', owner: 'fixture', name: 'qlora-implementation',
          htmlUrl: 'https://github.com/fixture/qlora-implementation', defaultBranch: 'main',
          implementationStatus: 'UNKNOWN', topics: ['qlora', 'finetuning'], stargazersCount: 3,
        }];
        const queryTokens = tokens(query);
        return repositories.filter(entry => overlap(queryTokens, `${entry.fullName} ${entry.topics.join(' ')}`) > 0).slice(0, limit);
      },
      resolveRevision: async () => FIXTURE_COMMIT_SHA,
      listContents: async (owner, repo) => [{
        name: 'config.yaml', path: 'config.yaml', type: 'file', sha: 'blobsha-config',
        htmlUrl: `https://github.com/${owner}/${repo}/blob/main/config.yaml`,
      }],
      getContent: async (owner, repo, path, ref) => ({
        repository: `${owner}/${repo}`, path, sha: 'blobsha-config',
        htmlUrl: `https://github.com/${owner}/${repo}/blob/${ref ?? 'main'}/${path}`,
        downloadUrl: `https://raw.githubusercontent.com/${owner}/${repo}/${ref ?? 'main'}/${path}`,
        encoding: 'base64', content: encoded(configText), source: 'github',
      }),
    },
    huggingface: {
      searchModels: async (query, limit = 10) => tokens(query).has('qlora') || query.toLowerCase().includes('quantized')
        ? [{ id: 'fixture/qlora-4bit', kind: 'model', sha: 'abc123def', url: 'https://huggingface.co/fixture/qlora-4bit', pipelineTag: 'text-generation', tags: ['qlora'], lastModified: '2026-01-01', paperLinks: [{ value: FIXTURE_WORKS.qlora.arxivId, url: `https://arxiv.org/abs/${FIXTURE_WORKS.qlora.arxivId}`, source: 'arxiv' }] }].slice(0, limit)
        : [],
      searchDatasets: async (query, limit = 10) => tokens(query).has('finetuning')
        ? [{ id: 'fixture/finetuning-mix', kind: 'dataset', sha: 'def456abc', url: 'https://huggingface.co/datasets/fixture/finetuning-mix', tags: ['finetuning'], lastModified: '2026-01-01', paperLinks: [] }].slice(0, limit)
        : [],
    },
    acquirer: {
      acquire: async (url) => {
        if (url === FIXTURE_PAPER_URL) {
          const body = new TextEncoder().encode(FIXTURE_HTML);
          return { url, contentType: 'text/html; charset=utf-8', bytes: body.byteLength, body };
        }
        throw new Error(`fixture acquirer: url not in fixture corpus: ${url}`);
      },
    },
  };
}
