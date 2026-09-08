import { describe, expect, it } from 'vitest';
import { classifyEvidenceSupport, validateCitationIntegrity } from '../src/research/verification.js';
import type { Evidence, ResearchResponse } from '../src/models/research.js';

describe('citation integrity', () => {
  it('classifies support conservatively and exposes the heuristic basis', () => {
    const base: Evidence = { evidenceId:'support', sourceId:'paper', authors:[], title:'Paper', identifiers:{}, evidenceType:'DIRECT', sourceQuality:'A', evidence:'The method uses DPO for preference optimization.', citationText:'[Paper]' };
    expect(classifyEvidenceSupport('uses DPO',base).status).toBe('SUPPORTED');
    expect(classifyEvidenceSupport('uses DPO and RLHF',base).status).toBe('PARTIALLY_SUPPORTED');
    expect(classifyEvidenceSupport('PPO algorithm',base).status).toBe('UNKNOWN');
    expect(classifyEvidenceSupport('uses DPO',{...base,evidence:'The method does not use DPO.'}).status).toBe('CONTRADICTED');
    expect(classifyEvidenceSupport('uses PPO algorithm now',{...base,evidence:'The method uses DPO.'}).status).toBe('UNSUPPORTED');
  });
  const evidence: Evidence = { evidenceId:'ev_1', sourceId:'paper_1', authors:[{name:'A Author', normalizedName:'a author'}], title:'Paper', year:2025, identifiers:{arxiv:'2501.00001'}, locator:{page:3, section:'2'}, evidenceType:'DIRECT', sourceQuality:'A', evidence:'The authors use KL divergence.', citationText:'[A Author, 2025, §2, p. 3]' };
  it('accepts a response whose factual claim references existing evidence', () => {
    const response: ResearchResponse<{claims:string[]}> = { summary:'The authors use KL divergence [A Author, 2025, §2, p. 3].', data:{claims:['KL divergence']}, evidence:[evidence], references:[{paperId:'paper_1',title:'Paper',authors:evidence.authors,year:2025,arxivId:'2501.00001',publicationStatus:'preprint',bibtex:'',sourceProviders:['test'],versions:[]}], transparency:{expandedQueries:[],sourcesSearched:['test'],candidates:1,retrievedAt:new Date().toISOString(),rankingRationale:[]} };
    expect(validateCitationIntegrity(response)).toEqual({valid:true, errors:[]});
  });
  it('rejects factual claims when evidence is absent or unresolved', () => {
    const response = { summary:'The authors use temperature 2.', data:{claim:'temperature 2'}, evidence:[], references:[], transparency:{expandedQueries:[],sourcesSearched:[],candidates:0,retrievedAt:'',rankingRationale:[]} } as unknown as ResearchResponse<unknown>;
    const result = validateCitationIntegrity(response);
    expect(result.valid).toBe(false);
    expect(result.errors.some(e => e.includes('evidence'))).toBe(true);
  });
  it('rejects evidence whose source metadata does not match the referenced work', () => {
    const response = { summary:'A claim [A Author, 2025].', data:{claim:'x'}, evidence:[evidence], references:[{paperId:'paper_1',title:'Different paper',authors:evidence.authors,year:2025,publicationStatus:'preprint',bibtex:'',sourceProviders:['test'],versions:[] }], transparency:{expandedQueries:[],sourcesSearched:[],candidates:1,retrievedAt:'',rankingRationale:[]} } as unknown as ResearchResponse<unknown>;
    expect(validateCitationIntegrity(response).valid).toBe(false);
  });
  it('requires the summary citation to match an evidence citation', () => {
    const response = { summary:'A claim [Someone Else, 2025].', data:{claim:'x'}, evidence:[evidence], references:[{paperId:'paper_1',title:'Paper',authors:evidence.authors,year:2025,publicationStatus:'preprint',bibtex:'',sourceProviders:['test'],versions:[] }], transparency:{expandedQueries:[],sourcesSearched:[],candidates:1,retrievedAt:'',rankingRationale:[]} } as unknown as ResearchResponse<unknown>;
    expect(validateCitationIntegrity(response).valid).toBe(false);
  });
  it('rejects duplicate evidence identifiers and invalid page locators', () => {
    const duplicate = {...evidence};
    const invalidLocator = {...evidence, evidenceId:'ev_2', locator:{page:0}};
    const response = { summary:'A claim [A Author, 2025].', data:{claim:'x'}, evidence:[duplicate, {...duplicate}, invalidLocator], references:[{paperId:'paper_1',title:'Paper',authors:evidence.authors,year:2025,publicationStatus:'preprint',bibtex:'',sourceProviders:['test'],versions:[]}], transparency:{expandedQueries:[],sourcesSearched:[],candidates:1,retrievedAt:'',rankingRationale:[]} } as unknown as ResearchResponse<unknown>;
    const result = validateCitationIntegrity(response);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(expect.arrayContaining(['duplicate evidenceId ev_1', 'evidence ev_2 has invalid page locator']));
  });
  it('accepts authorless evidence when its source exists', () => {
    const response = { summary:'A claim [A Author, 2025, §2, p. 3].', data:{claim:'x'}, evidence:[{...evidence, authors:[]}], references:[{paperId:'paper_1',title:'Paper',authors:evidence.authors,year:2025,publicationStatus:'preprint',bibtex:'',sourceProviders:['test'],versions:[]}], transparency:{expandedQueries:[],sourcesSearched:[],candidates:1,retrievedAt:'',rankingRationale:[]} } as unknown as ResearchResponse<unknown>;
    const result = validateCitationIntegrity(response);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });
});
