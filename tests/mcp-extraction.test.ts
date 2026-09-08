import { describe, expect, it, vi } from 'vitest';
import { registerTools } from '../src/mcp/tools.js';

function capture() {
  const handlers = new Map<string, (args: any) => Promise<any>>();
  const server = { registerTool(name: string, _config: unknown, handler: (args: any) => Promise<any>) { handlers.set(name, handler); } };
  return { server, handlers };
}

describe('MCP extraction evidence boundary', () => {
  it('registers the Phase 6 extraction tools', () => {
    const {server, handlers} = capture();
    registerTools(server as any, {extractPaperClaims:vi.fn(),extractPaperFacts:vi.fn(),extractCanonicalPaperFacts:vi.fn().mockResolvedValue({facts:[],diagnostics:{accepted:0,rejections:[]}}),extractTrainingParameters:vi.fn(),recipeFromPaper:vi.fn()} as any);
    expect([...handlers.keys()]).toEqual(expect.arrayContaining(['extract_paper_facts','extract_paper_claims','extract_training_parameters','extract_training_recipe_from_url']));
  });

  it('returns claim evidence and citation text at the MCP boundary', async () => {
    const {server, handlers} = capture();
    const claim = {claimId:'claim-a',claimKey:'loss|loss',kind:'loss',statement:'Uses KL.',sourceUrl:'https://example.com/paper',locator:{section:'Loss'},confidence:'heuristic',evidenceType:'DERIVED',evidence:{evidenceId:'evidence-a',sourceId:'https://example.com/paper',authors:[],title:'Loss claim',identifiers:{},locator:{section:'Loss'},evidenceType:'DERIVED',sourceQuality:'C',evidence:'Uses KL.',citationText:'https://example.com/paper#Loss'}};
    registerTools(server as any, {extractPaperClaims:vi.fn().mockResolvedValue({claims:[claim],conflicts:[]}),extractPaperFacts:vi.fn(),extractCanonicalPaperFacts:vi.fn().mockResolvedValue({facts:[],diagnostics:{accepted:0,rejections:[]}}),extractTrainingParameters:vi.fn(),recipeFromPaper:vi.fn()} as any);
    const response = await handlers.get('extract_paper_claims')!({url:claim.sourceUrl});
    expect(response.structuredContent.evidence).toEqual([claim.evidence]);
    expect(response.content[0].text).toContain(claim.evidence.citationText);
  });

  it('returns evidence for heuristic facts and explicit parameters', async () => {
    const {server, handlers} = capture();
    const locator = {section:'Training'};
    registerTools(server as any, {
      extractPaperClaims:vi.fn(),
      extractCanonicalPaperFacts:vi.fn().mockResolvedValue({facts:[],diagnostics:{accepted:0,rejections:[]}}),
      extractPaperFacts:vi.fn().mockResolvedValue([{kind:'methodology',text:'Uses supervised training.',sourceUrl:'https://example.com/paper',locator,confidence:'heuristic'}]),
      extractTrainingParameters:vi.fn().mockResolvedValue([{name:'batch_size',value:'32',sourceUrl:'https://example.com/paper',locator,confidence:'explicit'}]),
      recipeFromPaper:vi.fn()
    } as any);
    const facts = await handlers.get('extract_paper_facts')!({url:'https://example.com/paper'});
    const parameters = await handlers.get('extract_training_parameters')!({url:'https://example.com/paper'});
    expect(facts.structuredContent.evidence[0].evidence).toBe('Uses supervised training.');
    expect(facts.content[0].text).toContain('https://example.com/paper#Training');
    expect(parameters.structuredContent.evidence[0].evidence).toBe('32');
    expect(parameters.content[0].text).toContain('https://example.com/paper#Training');
  });

  it('validates lookup provenance using the handler summary', async () => {
    const {server, handlers} = capture();
    const paper = {paperId:'paper-1',title:'A verified paper',authors:[{name:'Author',normalizedName:'author'}],bibtex:'@article{paper}',sourceProviders:['fixture'],versions:[]};
    registerTools(server as any, {getPaper:vi.fn().mockResolvedValue(paper)} as any);
    const response = await handlers.get('get_paper')!({paper_id:'paper-1'});
    expect(response.isError).not.toBe(true);
    expect(response.structuredContent.data).toEqual(paper);
    expect(response.content[0].text).toContain('A verified paper');
  });
});
