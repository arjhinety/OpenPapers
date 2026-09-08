import { describe, expect, it } from 'vitest';
import { ResearchService, classifyGraphRelationship, explainRanking } from '../src/research/service.js';
import { ResearchDb } from '../src/database/db.js';
import type { ResearchWork } from '../src/models/research.js';
import type { PaperExtractor } from '../src/extraction/extractor.js';

describe('provenance-first recipe behavior', () => {
  it('exposes token-overlap ranking diagnostics for related wording', () => {
    const work: ResearchWork = {paperId:'ranked',title:'Speculative Heads for Decoding',authors:[],abstract:'',publicationStatus:'unknown',bibtex:'',sourceProviders:[],versions:[]};
    const diagnostics=explainRanking(work,'speculative decoding');
    expect(diagnostics.titleTokenOverlap).toBe(1);
    expect(diagnostics.score).toBeGreaterThan(0);
  });
  it('classifies chronology-supported graph candidates conservatively', async () => {
    const root: ResearchWork = {paperId:'root',title:'Root',authors:[],year:2024,publicationStatus:'unknown',bibtex:'',sourceProviders:['semantic_scholar'],versions:[]};
    const prior: ResearchWork = {...root,paperId:'prior',title:'Prior',year:2020};
    const later: ResearchWork = {...root,paperId:'later',title:'Later',year:2025};
    expect(classifyGraphRelationship(root,prior,'reference')).toBe('FOUNDATIONAL_CANDIDATE');
    expect(classifyGraphRelationship(root,later,'citation')).toBe('FOLLOW_UP_CANDIDATE');
    expect(classifyGraphRelationship(root,later,'related')).toBe('UNKNOWN');
  });
  it('never guesses missing training parameters', async () => {
    const work: ResearchWork = { paperId:'work_recipe', title:'Recipe Paper', authors:[], publicationStatus:'preprint', bibtex:'', sourceProviders:['test'], versions:[] };
    const service = new ResearchService(new ResearchDb(':memory:'));
    const response = service.recipe(work);
    expect(response.data.learning_rate).toEqual({value:null,status:'NOT_REPORTED'});
    expect(response.data.missing_information.length).toBeGreaterThan(0);
    expect(response.evidence[0]?.evidenceType).toBe('UNVERIFIED');
  });
  it('returns evidence-backed Semantic Scholar graph items', async () => {
    const work: ResearchWork = { paperId:'work_graph', title:'Graph Paper', authors:[], publicationStatus:'preprint', bibtex:'', sourceProviders:['semantic_scholar'], versions:[] };
    const service = new ResearchService(undefined, undefined, undefined, undefined, { getReferences: async () => [work], getCitations: async () => [], getRelated: async () => [], resolveAuthor: async () => undefined } as never);
    const result = await service.graph('S2-root', 'reference', 10);
    expect(result.data[0]?.relation).toBe('reference');
    expect(result.data[0]?.source).toBe('semantic_scholar');
    expect(result.data[0]?.relationshipBasis).toBe('PROVIDER_EXPLICIT');
    expect(result.data[0]?.evidence.sourceId).toBe(work.paperId);
    expect(result.references[0]?.paperId).toBe(work.paperId);
    expect(await service.db.getGraphEdges('S2-root')).toEqual([expect.objectContaining({targetPaperId:work.paperId,relation:'reference',provider:'semantic_scholar',evidenceId:result.evidence[0]?.evidenceId})]);
  });
  it('resolves unseen arXiv identifiers through the provider and persists them', async () => {
    const db=new ResearchDb(':memory:'); const work:ResearchWork={paperId:'resolved',title:'Resolved',authors:[],arxivId:'2501.00001',publicationStatus:'preprint',bibtex:'',sourceProviders:['arxiv'],versions:[]};
    const arxiv={search:async()=>[],searchById:async(id:string)=>{expect(id).toBe('2501.00001');return [work];}};
    const service=new ResearchService(db,arxiv as any,{search:async()=>[],getByDoi:async()=>undefined} as any,{search:async()=>[]} as any,{search:async()=>[]} as any);
    await expect(service.getPaper('arXiv:2501.00001v2')).resolves.toEqual(work); await expect(db.getWork('2501.00001')).resolves.toEqual(work); await db.close();
  });
  it('routes graph calls through the stored Semantic Scholar identifier', async () => {
    const db=new ResearchDb(':memory:'); await db.upsertWork({paperId:'canonical-root',title:'Root',authors:[],semanticScholarId:'S2-root',publicationStatus:'unknown',bibtex:'',sourceProviders:['test'],versions:[]});
    let requested:string|undefined; const semantic={getReferences:async(id:string)=>{requested=id;return [];},getCitations:async()=>[],getRelated:async()=>[],resolveAuthor:async()=>undefined};
    await new ResearchService(db,undefined,undefined,undefined,semantic as any).graphAll('canonical-root','reference'); expect(requested).toBe('S2-root'); await db.close();
  });
  it('resolves graph nodes to existing DOI lineage identities', async () => {
    const db = new ResearchDb(':memory:');
    const existing: ResearchWork = { paperId:'canonical_work', title:'Canonical', authors:[], doi:'10.1000/canonical', publicationStatus:'unknown', bibtex:'', sourceProviders:['crossref'], versions:[] };
    await db.upsertWork(existing);
    const graphWork = {...existing, paperId:'semantic_work', sourceProviders:['semantic_scholar']};
    const service = new ResearchService(db, undefined, undefined, undefined, { getReferences: async () => [graphWork], getCitations: async () => [], getRelated: async () => [], resolveAuthor: async () => undefined } as never);
    await service.graph('root', 'reference');
    expect((await service.db.getGraphEdges('root'))[0]?.targetPaperId).toBe('canonical_work');
  });
  it('merges Semantic Scholar and OpenAlex graph candidates when a root has an OpenAlex identity', async () => {
    const db = new ResearchDb(':memory:');
    await db.upsertWork({paperId:'root',title:'Root',authors:[],openAlexId:'https://openalex.org/W1',publicationStatus:'unknown',bibtex:'',sourceProviders:['openalex'],versions:[]});
    const semanticWork: ResearchWork = {paperId:'semantic_child',title:'Semantic Child',authors:[],publicationStatus:'unknown',bibtex:'',sourceProviders:['semantic_scholar'],versions:[]};
    const openAlexWork: ResearchWork = {paperId:'openalex_child',title:'OpenAlex Child',authors:[],openAlexId:'https://openalex.org/W2',publicationStatus:'unknown',bibtex:'',sourceProviders:['openalex'],versions:[]};
    const provider={getReferences:async()=>[semanticWork],getCitations:async()=>[],getRelated:async()=>[],resolveAuthor:async()=>undefined} as never;
    const openalex={getReferences:async()=>[openAlexWork],getCitations:async()=>[],getRelated:async()=>[]} as never;
    const service=new ResearchService(db,undefined,undefined,openalex,provider);
    const result=await service.graphAll('root','reference');
    expect(result.data.map(item=>item.source)).toEqual(['semantic_scholar','openalex']);
    expect(result.transparency.sourcesSearched).toEqual(['semantic_scholar','openalex']);
  });
  it('reports metadata conflicts when providers merge one graph node', async () => {
    const db = new ResearchDb(':memory:');
    await db.upsertWork({paperId:'root',title:'Root',authors:[],openAlexId:'https://openalex.org/W1',publicationStatus:'unknown',bibtex:'',sourceProviders:['openalex'],versions:[]});
    const semanticWork: ResearchWork = {paperId:'semantic_same',title:'Canonical Title',doi:'10.1000/example',authors:[],year:2022,publicationStatus:'unknown',bibtex:'',sourceProviders:['semantic_scholar'],versions:[]};
    const openAlexWork: ResearchWork = {paperId:'openalex_same',title:'Conflicting Title',doi:'10.1000/example',authors:[],year:2023,openAlexId:'https://openalex.org/W2',publicationStatus:'unknown',bibtex:'',sourceProviders:['openalex'],versions:[]};
    const provider={getReferences:async()=>[semanticWork],getCitations:async()=>[],getRelated:async()=>[],resolveAuthor:async()=>undefined} as never;
    const openalex={getReferences:async()=>[openAlexWork],getCitations:async()=>[],getRelated:async()=>[]} as never;
    const result=await new ResearchService(db,undefined,undefined,openalex,provider).graphAll('root','reference');
    expect(result.transparency.conflicts?.map(conflict=>conflict.field)).toEqual(expect.arrayContaining(['title','year']));
  });
  it('dispatches acquired PDFs to the configured PDF parser', async () => {
    const pdf = new Uint8Array([37,80,68,70,45]);
    const acquirer = {acquire:async()=>({url:'https://example.com/paper.pdf',contentType:'application/pdf',bytes:pdf.byteLength,body:pdf})} as never;
    const parser = {process:async()=>({format:'pdf' as const,url:'https://example.com/paper.pdf',sections:[],references:[],warnings:[]})} as never;
    const document = await new ResearchService(new ResearchDb(':memory:'),undefined,undefined,undefined,undefined,acquirer,parser).readPaper('https://example.com/paper.pdf');
    expect(document.format).toBe('pdf');
  });
  it('reuses an unchanged parsed document without invoking the parser again', async () => {
    const body = new Uint8Array([37,80,68,70,45]);
    let calls = 0;
    const acquirer = {acquire:async()=>({url:'https://example.com/cached.pdf',contentType:'application/pdf',bytes:body.byteLength,body})} as never;
    const parser = {process:async()=>{ calls += 1; return {format:'pdf' as const,url:'https://example.com/cached.pdf',sections:[],references:[],warnings:[]}; }} as never;
    const service = new ResearchService(new ResearchDb(':memory:'),undefined,undefined,undefined,undefined,acquirer,parser);
    await service.readPaper('https://example.com/cached.pdf');
    await service.readPaper('https://example.com/cached.pdf');
    expect(calls).toBe(1);
  });
  it('extracts heuristic facts from an acquired HTML paper', async () => {
    const body = new TextEncoder().encode('<html><body><h1>Method</h1><p>We train a model.</p></body></html>');
    const acquirer = {acquire:async()=>({url:'https://example.com/facts.html',contentType:'text/html',bytes:body.byteLength,body})} as never;
    const facts = await new ResearchService(new ResearchDb(':memory:'),undefined,undefined,undefined,undefined,acquirer).extractPaperFacts('https://example.com/facts.html');
    expect(facts).toMatchObject([{kind:'methodology',text:'We train a model.',sourceUrl:'https://example.com/facts.html',confidence:'heuristic'}]);
  });
  it('persists extracted claims through the service boundary', async () => {
    const body = new TextEncoder().encode('<html><body><h1>Loss</h1><p>Uses KL divergence.</p></body></html>');
    const acquirer = {acquire:async()=>({url:'https://example.com/claims.html',contentType:'text/html',bytes:body.byteLength,body})} as never;
    const db = new ResearchDb(':memory:');
    const result = await new ResearchService(db,undefined,undefined,undefined,undefined,acquirer).extractPaperClaims('https://example.com/claims.html');
    expect(result.claims).toMatchObject([{kind:'loss',statement:'Uses KL divergence.',evidenceType:'DERIVED'}]);
    expect(await db.getClaims()).toHaveLength(1);
    expect(await db.getEvidenceForPaper(result.claims[0]!.claimId)).toEqual([result.claims[0]!.evidence]);
  });
  it('runs an injected provider-independent extractor after parsing', async () => {
    const body = new TextEncoder().encode('<html><body><h1>Method</h1><p>We train a model.</p></body></html>');
    const acquirer = {acquire:async()=>({url:'https://example.com/custom.html',contentType:'text/html',bytes:body.byteLength,body})} as never;
    const extractor: PaperExtractor<string> = {name:'test',extract:async document=>document.sections[0]?.heading ?? 'missing'};
    const value = await new ResearchService(new ResearchDb(':memory:'),undefined,undefined,undefined,undefined,acquirer).extractWith('https://example.com/custom.html',extractor);
    expect(value).toBe('Method');
  });
  it('projects explicit paper parameters into a partial training recipe', async () => {
    const body = new TextEncoder().encode('<html><body><h1>Training Details</h1><p>We use AdamW with learning rate 2e-5, batch size 32, and train for 3 epochs.</p></body></html>');
    const acquirer = {acquire:async()=>({url:'https://example.com/recipe.html',contentType:'text/html',bytes:body.byteLength,body})} as never;
    const recipe = await new ResearchService(new ResearchDb(':memory:'),undefined,undefined,undefined,undefined,acquirer).recipeFromPaper('https://example.com/recipe.html');
    expect(recipe.data.learning_rate).toMatchObject({value:0.00002,status:'REPORTED'});
    expect(recipe.data.batch_size).toMatchObject({value:32,status:'REPORTED'});
    expect(recipe.data.epochs).toMatchObject({value:3,status:'REPORTED'});
    expect(recipe.data.weight_decay).toEqual({value:null,status:'NOT_REPORTED'});
  });
});