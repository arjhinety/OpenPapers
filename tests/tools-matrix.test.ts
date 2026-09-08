import { beforeAll, describe, expect, it } from 'vitest';
import { ResearchDb } from '../src/database/db.js';
import { ResearchService } from '../src/research/service.js';
import { createFixtureProviders, FIXTURE_COMMIT_SHA, FIXTURE_PAPER_URL, FIXTURE_WORKS, FIXTURE_WORK_LIST } from '../src/testing/fixtures.js';
import { captureTools, ok, type ToolRegistration } from './helpers.js';

const EXPECTED_TOOLS = [
  'search_papers', 'get_paper', 'get_bibtex', 'research_method', 'research_topic',
  'get_references', 'get_citations', 'get_related_papers', 'resolve_author',
  'read_paper', 'search_within_paper', 'extract_paper_facts', 'extract_paper_claims', 'extract_training_parameters',
  'extract_training_recipe', 'extract_training_recipe_from_url', 'build_research_report', 'compare_paper_to_code', 'compare_papers', 'compare_methods', 'verify_claim', 'reconstruct_research',
  'find_implementations', 'find_models', 'find_datasets', 'find_repository_configs', 'get_repository_config',
  'create_collection', 'list_collections', 'add_paper_to_collection', 'remove_paper_from_collection', 'delete_collection', 'export_research_pack', 'import_research_pack', 'refresh_collection', 'refresh_paper', 'vector_search',
];

let handlers: Record<string, ToolRegistration['handler']>;
let service: ResearchService;
let collectionId: string;
let importedCollectionId: string;

beforeAll(async () => {
  const fixture = createFixtureProviders();
  service = new ResearchService(new ResearchDb(':memory:'), fixture.arxiv as any, fixture.crossref as any, fixture.openalex as any, fixture.semanticScholar as any, fixture.acquirer as any);
  for (const work of FIXTURE_WORK_LIST) await service.db.upsertWork(work);
  ({ handlers } = captureTools(service, { github: fixture.github as any, huggingface: fixture.huggingface as any }));
});

describe('37-tool behavioral matrix', () => {
  it('exposes exactly the registered tool surface', () => {
    expect(Object.keys(handlers).sort()).toEqual([...EXPECTED_TOOLS].sort());
  });

  it('search_papers returns ranked works with evidence and transparency', async () => {
    const data = ok(await handlers.search_papers({ query: 'parameter efficient fine tuning', limit: 10 })) as any;
    expect(data.data.length).toBeGreaterThan(0);
    expect(data.evidence.length).toBeGreaterThan(0);
    expect(data.transparency.providerFailures).toEqual([]);
    expect(data.transparency.sourcesSearched).toContain('arxiv');
  });

  it('get_paper resolves a seeded work and reports NOT_FOUND honestly', async () => {
    const data = ok(await handlers.get_paper({ paper_id: FIXTURE_WORKS.qlora.paperId })) as any;
    expect(data.data.title).toBe(FIXTURE_WORKS.qlora.title);
    const missing = await handlers.get_paper({ paper_id: 'work_does_not_exist' });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('NOT_FOUND');
  });

  it('get_bibtex returns canonical BibTeX', async () => {
    const data = ok(await handlers.get_bibtex({ paper_id: FIXTURE_WORKS.lora.paperId })) as any;
    expect(String(data.bibtex)).toContain('@article');
  });

  it('research_method searches a named method', async () => {
    const data = ok(await handlers.research_method({ method: 'LoRA', limit: 10 })) as any;
    expect(data.data.some((work: any) => work.title.includes('LoRA'))).toBe(true);
  });

  it('research_topic labels synthesis as retrieval, not assertion', async () => {
    const data = ok(await handlers.research_topic({ topic: 'quantized finetuning', limit: 10 })) as any;
    expect(String(data.synthesis)).toContain('retrieval result');
  });

  it('get_references returns provenance-bearing graph items', async () => {
    const data = ok(await handlers.get_references({ paper_id: FIXTURE_WORKS.attention.paperId, limit: 20 })) as any;
    expect(data.data.length).toBeGreaterThan(0);
    expect(data.evidence.length).toBeGreaterThan(0);
  });

  it('get_citations returns citing works', async () => {
    const data = ok(await handlers.get_citations({ paper_id: FIXTURE_WORKS.attention.paperId, limit: 20 })) as any;
    expect(data.data.length).toBeGreaterThanOrEqual(2);
  });

  it('get_related_papers returns recommendations', async () => {
    const data = ok(await handlers.get_related_papers({ paper_id: FIXTURE_WORKS.qlora.paperId, limit: 20 })) as any;
    expect(data.data.length).toBe(5);
  });

  it('resolve_author resolves a fixture profile and rejects unknown ids', async () => {
    const data = ok(await handlers.resolve_author({ author_id: 'author-vaswani' })) as any;
    expect(data.author.name).toBe('Ashish Vaswani');
    const missing = await handlers.resolve_author({ author_id: 'author-nobody' });
    expect(missing.isError).toBe(true);
  });

  it('read_paper parses the fixture document', async () => {
    const data = ok(await handlers.read_paper({ url: FIXTURE_PAPER_URL })) as any;
    expect(data.sections.length).toBeGreaterThanOrEqual(3);
    expect(data.warnings).toEqual([]);
  });

  it('search_within_paper returns source-located matches', async () => {
    const data = ok(await handlers.search_within_paper({ url: FIXTURE_PAPER_URL, query: 'self-attention', limit: 10 })) as any;
    expect(Array.isArray(data.matches)).toBe(true);
  });

  it('extract_paper_facts returns source-located facts', async () => {
    const data = ok(await handlers.extract_paper_facts({ url: FIXTURE_PAPER_URL })) as any;
    expect(Array.isArray(data.facts)).toBe(true);
    expect(data.evidence.length).toBe(data.facts.length);
  });

  it('extract_paper_claims persists claims with conflicts reported', async () => {
    const data = ok(await handlers.extract_paper_claims({ url: FIXTURE_PAPER_URL })) as any;
    expect(Array.isArray(data.claims)).toBe(true);
    expect(Array.isArray(data.conflicts)).toBe(true);
  });

  it('extract_training_parameters returns explicit labeled values only', async () => {
    const data = ok(await handlers.extract_training_parameters({ url: FIXTURE_PAPER_URL })) as any;
    expect(Array.isArray(data.parameters)).toBe(true);
  });

  it('extract_training_recipe refuses to guess and marks absence explicitly', async () => {
    const data = ok(await handlers.extract_training_recipe({ paper_id: FIXTURE_WORKS.bert.paperId })) as any;
    expect(data.data.missing_information.length).toBeGreaterThan(0);
  });

  it('extract_training_recipe_from_url populates recipe from the fixture paper', async () => {
    const data = ok(await handlers.extract_training_recipe_from_url({ url: FIXTURE_PAPER_URL })) as any;
    expect(data.data).toBeTruthy();
    expect(Array.isArray(data.data.sources)).toBe(true);
  });

  it('build_research_report separates facts and recommendations', async () => {
    const data = ok(await handlers.build_research_report({ query: 'LoRA finetuning', mode: 'literature_review', limit: 15 })) as any;
    expect(Array.isArray(data.data.facts)).toBe(true);
    expect(Array.isArray(data.data.recommendations)).toBe(true);
  });

  it('compare_paper_to_code reports conflicts, matches, and unavailable fields', async () => {
    const data = ok(await handlers.compare_paper_to_code({
      recipe: { 'learning_rate': { value: 0.00002, sources: ['paper:2.2'] }, 'batch_size': { value: 512, sources: ['paper:2.2'] } },
      fields: [{ name: 'learning_rate', value: '0.00002', lineStart: 2, lineEnd: 2 }, { name: 'batch_size', value: '256', lineStart: 3, lineEnd: 3 }],
      source_url: 'https://github.com/fixture/qlora-implementation/blob/main/config.yaml',
      commit_sha: FIXTURE_COMMIT_SHA,
    })) as any;
    expect(data.data.conflicts.length).toBe(1);
    expect(data.data.matches.length).toBe(1);
  });

  it('compare_papers diffs verified local metadata', async () => {
    const data = ok(await handlers.compare_papers({ left_paper_id: FIXTURE_WORKS.lora.paperId, right_paper_id: FIXTURE_WORKS.qlora.paperId })) as any;
    expect(Array.isArray(data.data.differences)).toBe(true);
  });

  it('compare_methods reports verified overlap without benchmark equivalence', async () => {
    const data = ok(await handlers.compare_methods({ left_method: 'LoRA', right_method: 'Low-Rank Adaptation of Large Language Models', limit: 10 })) as any;
    expect(data.data.overlap.length).toBeGreaterThanOrEqual(1);
    expect(data.data.benchmarkComparability).toBe('UNKNOWN');
  });

  it('verify_claim reports NOT_FOUND for absent claims', async () => {
    const missing = await handlers.verify_claim({ claim_id: 'claim_absent' });
    expect(missing.isError).toBe(true);
  });

  it('reconstruct_research extracts facts and answers from the fixture paper', async () => {
    const data = ok(await handlers.reconstruct_research({
      paper_url: FIXTURE_PAPER_URL,
      question: 'Which optimizer was used?',
      fields: ['optimization.optimizer', 'training.batch_size'],
    })) as any;
    expect(typeof data.factCount).toBe('number');
    expect(data.question).toBe('Which optimizer was used?');
  });

  it('find_implementations keeps implementation status UNKNOWN', async () => {
    const data = ok(await handlers.find_implementations({ method: 'QLoRA', limit: 10 })) as any;
    expect(data.data[0].implementationStatus).toBe('UNKNOWN');
    expect(data.linkAssessments.length).toBe(0);
    expect(data.implementationStatusPolicy).toContain('UNKNOWN');
  });

  it('find_models returns revision-pinned hub items with paper links', async () => {
    const data = ok(await handlers.find_models({ query: 'QLoRA quantized', limit: 10 })) as any;
    expect(data.data[0].id).toBe('fixture/qlora-4bit');
    expect(data.data[0].sha).toBeTruthy();
  });

  it('find_datasets returns dataset items', async () => {
    const data = ok(await handlers.find_datasets({ query: 'finetuning', limit: 10 })) as any;
    expect(data.data[0].kind).toBe('dataset');
  });

  it('find_repository_configs lists bounded configuration files', async () => {
    const data = ok(await handlers.find_repository_configs({ owner: 'fixture', repo: 'qlora-implementation', ref: 'main' })) as any;
    expect(data.data[0].path).toBe('config.yaml');
    expect(data.data[0].commitSha).toBe(FIXTURE_COMMIT_SHA);
  });

  it('get_repository_config reads static config and extracts fields', async () => {
    const data = ok(await handlers.get_repository_config({ owner: 'fixture', repo: 'qlora-implementation', path: 'config.yaml', ref: 'main' })) as any;
    expect(data.fields.some((field: any) => field.name === 'learning_rate')).toBe(true);
  });

  it('collections flow: create, add, list, export, import, refresh, remove, delete', async () => {
    const created = ok(await handlers.create_collection({ name: 'matrix-collection' })) as any;
    collectionId = created.collection.id;

    await handlers.add_paper_to_collection({ collection_id: collectionId, paper_id: FIXTURE_WORKS.qlora.paperId });
    const listed = ok(await handlers.list_collections({})) as any;
    expect(listed.collections.some((item: any) => item.id === collectionId)).toBe(true);

    const pack = ok(await handlers.export_research_pack({ collection_id: collectionId })) as any;
    expect(pack.papers.length).toBe(1);
    expect(pack.format).toBe('openpapers.research-pack.v1');

    const imported = ok(await handlers.import_research_pack({ pack_json: JSON.stringify({ ...pack, collection: { ...pack.collection, name: 'imported-matrix' } }) })) as any;
    importedCollectionId = imported.collection.id;
    expect(imported.collection.paperIds.length).toBe(1);

    const invalid = await handlers.import_research_pack({ pack_json: '{"format":"nope"}' });
    expect(invalid.isError).toBe(true);

    const refreshed = ok(await handlers.refresh_collection({ collection_id: collectionId })) as any;
    expect(refreshed.outcomes[0].status).toBe('REFRESHED');

    await handlers.remove_paper_from_collection({ collection_id: collectionId, paper_id: FIXTURE_WORKS.qlora.paperId });
    await handlers.delete_collection({ collection_id: collectionId });
    const afterDelete = ok(await handlers.list_collections({})) as any;
    expect(afterDelete.collections.some((item: any) => item.id === collectionId)).toBe(false);
    expect(afterDelete.collections.some((item: any) => item.id === importedCollectionId)).toBe(true);
  });

  it('refresh_paper refreshes through a provider-native identifier', async () => {
    const data = ok(await handlers.refresh_paper({ paper_id: FIXTURE_WORKS.qlora.paperId })) as any;
    expect(data.status).toBe('REFRESHED');
    expect(data.provider).toBe('semantic_scholar');
  });

  it('vector_search reports honest unavailability without a configured retriever', async () => {
    const missing = await handlers.vector_search({ query: 'attention', limit: 10 });
    expect(missing.isError).toBe(true);
    expect(missing.content[0].text).toContain('not configured');
  });
});
