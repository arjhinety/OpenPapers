import { describe, expect, it } from 'vitest';
import { mapOpenAlexWork, OpenAlexProvider } from '../src/providers/openalex.js';

describe('OpenAlex provider mapping', () => {
  it('maps scholarly metadata and preserves all authors and OA links', () => {
    const work = mapOpenAlexWork({ id:'https://openalex.org/W1', doi:'https://doi.org/10.1000/Test', title:'A Distillation Paper', publication_year:2025, cited_by_count:42, authorships:[{author:{display_name:'Alice Smith',orcid:'https://orcid.org/1'}},{author:{display_name:'Bob Jones'}}], primary_location:{source:{display_name:'ML Journal'}}, best_oa_location:{landing_page_url:'https://example.org/paper',pdf_url:'https://example.org/paper.pdf'} });
    expect(work?.doi).toBe('10.1000/test');
    expect(work?.authors.map(a => a.name)).toEqual(['Alice Smith','Bob Jones']);
    expect(work?.openAlexId).toBe('https://openalex.org/W1');
    expect(work?.canonicalUrl).toBe('https://example.org/paper');
    expect(work?.citationCount).toBe(42);
    expect(work?.pdfUrl).toContain('.pdf');
  });
  it('preserves author IDs and deduplicated OpenAlex topics', () => {
    const work = mapOpenAlexWork({id:'https://openalex.org/W1', title:'Topic paper', authorships:[{author:{id:'https://openalex.org/A1',display_name:'Ada Lovelace'}}], topics:[{display_name:'Representation Learning'},{display_name:'Representation Learning'}]});
    expect(work?.authorIds).toEqual(['https://openalex.org/A1']);
    expect(work?.topics).toEqual(['Representation Learning']);
  });
});

describe('OpenAlex graph provider', () => {
  it('retrieves referenced works and works citing a parent', async () => {
    const child={id:'https://openalex.org/W2',title:'Referenced',publication_year:2024,authorships:[]};
    const provider=new OpenAlexProvider(async (input) => { const value=String(input); const body=value.includes('filter=cites') ? {results:[child]} : value.includes('W2') ? child : {referenced_works:['https://openalex.org/W2']}; return new Response(JSON.stringify(body),{status:200}); });
    expect((await provider.getReferences('https://openalex.org/W1',1))[0]?.title).toBe('Referenced');
    expect((await provider.getCitations('https://openalex.org/W1',1))[0]?.openAlexId).toBe('https://openalex.org/W2');
  });
});

describe('OpenAlex authentication', () => {
  it('sends OPENALEX_API_KEY as api_key on every request type', async () => {
    const previous = { key: process.env.OPENALEX_API_KEY, email: process.env.OPENALEX_EMAIL };
    process.env.OPENALEX_API_KEY = 'test-key'; delete process.env.OPENALEX_EMAIL;
    const seen: string[] = [];
    const child = {id:'https://openalex.org/W2',title:'Referenced',publication_year:2024,authorships:[]};
    const provider = new OpenAlexProvider(async (input) => { const value=String(input); seen.push(value); const body=value.includes('filter=cites') || value.includes('search=') ? {results:[child]} : value.includes('W2') ? child : {referenced_works:['https://openalex.org/W2']}; return new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}}); });
    try {
      await provider.search('lora', 1);
      await provider.getReferences('https://openalex.org/W1', 1);
      await provider.getCitations('https://openalex.org/W1', 1);
      expect(seen.length).toBeGreaterThanOrEqual(4);
      for (const url of seen) expect(new URL(url).searchParams.get('api_key')).toBe('test-key');
      expect(seen.some(url => new URL(url).searchParams.has('mailto'))).toBe(false);
    } finally {
      if (previous.key === undefined) delete process.env.OPENALEX_API_KEY; else process.env.OPENALEX_API_KEY = previous.key;
      if (previous.email !== undefined) process.env.OPENALEX_EMAIL = previous.email;
    }
  });
});
