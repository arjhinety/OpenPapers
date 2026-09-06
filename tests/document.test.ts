import { describe, expect, it } from 'vitest';
import { chunkDocument, detectDocumentFormat, parseDocument, parseGrobidTei, searchDocument } from '../src/ingestion/document.js';
import { CommandPdfFallback, GrobidClient, PdfParserChain } from '../src/ingestion/pdf.js';

const html = new TextEncoder().encode('<html><head><title>Paper</title><script>ignore()</script></head><body><h1>Introduction</h1><p>First paragraph.</p><h2>Method</h2><p>Details <a href="https://example.com/ref">reference</a>.</p><h2>References</h2><p>[1] A cited work.</p></body></html>');

describe('structured document parsing', () => {
  it('parses GROBID TEI sections and bibliographic references', () => {
    const parsed = parseGrobidTei('https://example.com/paper.pdf', '<TEI><teiHeader><fileDesc><titleStmt><title>GROBID Paper</title></titleStmt></fileDesc></teiHeader><text><body><pb n="3" xml:id="page_3"/><div><head>Introduction</head><p>Text <ref type="bibr" target="#b1">[1]</ref>.</p><formula> x = y + 1 </formula><figure><figDesc>System overview.</figDesc></figure><table><head>Results</head><row><cell>A</cell><cell>B</cell></row></table><div><head>Nested</head><p>Nested text.</p></div></div><div type="appendix"><head>Appendix A</head><p>Supplementary details.</p></div></body><back><div type="references"><listBibl><biblStruct xml:id="b1"><analytic><title>Referenced Work</title><author><persName><surname>Doe</surname></persName></author></analytic><monogr><imprint><date when="2024"/></imprint></monogr><idno type="DOI">10.1234/example</idno></biblStruct></listBibl></div></back></text></TEI>');
    expect(parsed).toMatchObject({format:'pdf',title:'GROBID Paper'});
    expect(parsed.sections).toEqual(expect.arrayContaining([{level:1,heading:'Introduction',text:'Text [1].',page:3,pageId:'page_3'},{level:2,heading:'Nested',text:'Nested text.',page:3,pageId:'page_3'}]));
    expect(parsed.references).toMatchObject([{text:'Referenced Work',id:'b1',title:'Referenced Work',authors:['Doe'],year:2024,doi:'10.1234/example'}]);
    expect(parsed.equations).toEqual(['x = y + 1']);
    expect(parsed.figures).toEqual([{caption:'System overview.',page:3,pageId:'page_3'}]);
    expect(parsed.tables).toEqual([{caption:'Results',text:'Results A B',page:3,pageId:'page_3',rows:[['A','B']]}]);
    expect(parsed.appendices).toEqual([{level:1,heading:'Appendix A',text:'Supplementary details.',page:3,pageId:'page_3',isAppendix:true}]);
    expect(parsed.tables?.[0]?.rows).toEqual([['A','B']]);
    expect(parsed.citations).toEqual([{target:'b1',text:'[1]',sectionHeading:'Introduction',page:3,pageId:'page_3'}]);
    expect(searchDocument(parsed, 'x = y', 5)).toMatchObject([{kind:'equation',text:'x = y + 1',page:3,pageId:'page_3'}]);
    expect(searchDocument(parsed, 'Referenced Work', 5)).toMatchObject([{kind:'reference',referenceId:'b1',text:'Referenced Work'}]);
  });

  it('does not promote table captions to document sections', () => {
    const parsed = parseGrobidTei('https://example.com/table.pdf', '<TEI><text><body><div><head>Experiments</head><p>Results.</p><table><head>Results</head><row><cell>A</cell></row></table></div></body></text></TEI>');
    expect(parsed.sections.map(section => section.heading)).toEqual(['Experiments']);
    expect(parsed.tables?.[0]?.caption).toBe('Results');
  });

  it('reports citation targets that have no extracted bibliography record', () => {
    const parsed = parseGrobidTei('https://example.com/missing.pdf', '<TEI><text><body><div><head>Methods</head><p>See <ref type="bibr" target="#missing">[9]</ref>.</p></div></body><back><listBibl/></back></text></TEI>');
    expect(parsed.citations).toEqual([{target:'missing',text:'[9]',sectionHeading:'Methods'}]);
    expect(parsed.warnings).toEqual(['unresolved citation target: missing']);
  });

  it('accepts namespace-qualified TEI tags emitted by GROBID deployments', () => {
    const parsed = parseGrobidTei('https://example.com/namespaced.pdf', '<tei:TEI xmlns:tei="http://www.tei-c.org/ns/1.0"><tei:teiHeader><tei:fileDesc><tei:titleStmt><tei:title>Namespaced</tei:title></tei:titleStmt></tei:fileDesc></tei:teiHeader><tei:text><tei:body><tei:div><tei:head>Method</tei:head><tei:p>Namespace-safe text.</tei:p></tei:div></tei:body></tei:text></tei:TEI>');
    expect(parsed).toMatchObject({title:'Namespaced',sections:[{heading:'Method',text:'Namespace-safe text.'}]});
  });

  it('extracts ordered Unicode, multi-part, and consortium authors from the document header', () => {
    const parsed = parseGrobidTei('https://example.com/authors.pdf', '<TEI><teiHeader><fileDesc><titleStmt><title>Authors</title></titleStmt><sourceDesc><biblStruct><analytic><author><persName><forename>Zoë</forename><forename type="middle">L.</forename><surname>Nguyen-Smith</surname></persName></author><author><persName><surname>山田</surname><forename>太郎</forename></persName></author><author><orgName>Open Research Consortium</orgName></author></analytic></biblStruct></sourceDesc></fileDesc></teiHeader><text><body/></text></TEI>');
    expect(parsed.authors).toEqual(['Zoë L. Nguyen-Smith', '太郎 山田', 'Open Research Consortium']);
  });

  it('posts PDF bytes to GROBID and returns parsed TEI', async () => {
    let request: Request | undefined;
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => { request = new Request(input, init); return new Response('<TEI><teiHeader><fileDesc><titleStmt><title>Result</title></titleStmt></fileDesc></teiHeader><text><body><div><head>Body</head><p>Content.</p></div></body></text></TEI>', {status:200, headers:{'content-type':'application/xml'}}); };
    const parsed = await new GrobidClient('http://grobid:8070', fetcher).process(new TextEncoder().encode('%PDF-1.7'), 'paper.pdf');
    expect(parsed.title).toBe('Result');
    expect(request?.url).toBe('http://grobid:8070/api/processFulltextDocument');
    expect(request?.method).toBe('POST');
  });

  it('enforces the GROBID TEI limit while reading the response stream', async () => {
    const chunks = [new TextEncoder().encode('<TEI><text>'), new TextEncoder().encode('x'.repeat(20)), new TextEncoder().encode('</text></TEI>')]; let cancelled = false; let index = 0;
    const fetcher = async () => new Response(new ReadableStream({pull(controller) { const chunk=chunks[index++]; if(chunk) controller.enqueue(chunk); else controller.close(); }, cancel() { cancelled=true; }}), {status:200, headers:{'content-type':'application/xml','content-length':'1'}});
    await expect(new GrobidClient('http://grobid:8070', fetcher, 20).process(new Uint8Array([1]), 'paper.pdf')).rejects.toThrow('GROBID response size limit');
    expect(cancelled).toBe(true);
  });
  it('uses configured fallbacks after GROBID failure and preserves a warning', async () => {
    const fallback = {name:'pymupdf', extract:async () => ({format:'pdf' as const,url:'file.pdf',sections:[],references:[],warnings:[]})};
    const chain = new PdfParserChain({process:async () => { throw new Error('offline'); }}, [fallback]);
    await expect(chain.process(new Uint8Array([37,80,68,70]), 'file.pdf')).resolves.toMatchObject({format:'pdf',warnings:['GROBID unavailable: Error: offline']});
  });
  it('rejects malformed fallback parser output', async () => {
    const fallback = new CommandPdfFallback('pymupdf','python','script.py', async () => ({stdout:'{"format":"html"}',stderr:''}));
    await expect(fallback.extract(new Uint8Array([37,80,68,70]), 'paper.pdf')).rejects.toThrow('invalid PDF parser output');
  });
  it('rejects fallback output with malformed section elements', async () => {
    const fallback = new CommandPdfFallback('pymupdf','python','script',async()=>({stdout:JSON.stringify({sections:[null],references:[],warnings:[]}),stderr:''}));
    await expect(fallback.extract(new Uint8Array([1]),'paper.pdf')).rejects.toThrow(/invalid PDF parser output/);
  });
  it('creates stable source-located chunks and searches them', () => {
    const parsed = parseDocument({url:'https://example.com/paper.html',contentType:'text/html',bytes:html.byteLength,body:html});
    const chunks = chunkDocument(parsed, 20);
    expect(chunks.every(chunk => chunk.url === parsed.url && chunk.ordinal >= 0)).toBe(true);
    expect(searchDocument(parsed, 'details', 5)).toMatchObject([{sectionHeading:'Method',text:'Details reference.'}]);
  });
  it('detects HTML from content type or markup and extracts sections', () => {
    expect(detectDocumentFormat('text/html', html)).toBe('html');
    expect(detectDocumentFormat('application/octet-stream', html)).toBe('html');
    expect(parseDocument({url:'https://example.com/paper',contentType:'text/html',bytes:html.byteLength,body:html})).toMatchObject({format:'html',title:'Paper',sections:[{level:1,heading:'Introduction',text:'First paragraph.'},{level:2,heading:'Method',text:'Details reference.'},{level:2,heading:'References',text:'[1] A cited work.'}]});
  });

  it('detects PDF bytes and refuses to claim they were parsed', () => {
    const pdf = new TextEncoder().encode('%PDF-1.7\n');
    expect(detectDocumentFormat('application/octet-stream', pdf)).toBe('pdf');
    expect(() => parseDocument({url:'https://example.com/paper.pdf',contentType:'application/pdf',bytes:pdf.byteLength,body:pdf})).toThrow('PDF parsing is not available');
  });

  it('rejects unknown binary formats explicitly', () => {
    const binary = new Uint8Array([0, 1, 2, 3]);
    expect(detectDocumentFormat('application/octet-stream', binary)).toBe('unknown');
    expect(() => parseDocument({url:'https://example.com/paper',contentType:'application/octet-stream',bytes:4,body:binary})).toThrow('unsupported document format');
  });
});
