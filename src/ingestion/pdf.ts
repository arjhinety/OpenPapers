import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseGrobidTei, type ParsedDocument } from './document.js';

const runFile = promisify(execFile);
export interface PdfParser { process(body: Uint8Array, filename?: string): Promise<ParsedDocument>; }
export interface PdfFallback { name: 'pymupdf' | 'docling'; extract(body: Uint8Array, filename?: string): Promise<ParsedDocument>; }
type PdfCommandRunner = (command: string, args: string[], options: {maxBuffer: number; windowsHide: boolean; timeout: number}) => Promise<{stdout: string; stderr: string}>;

export class GrobidClient implements PdfParser {
  constructor(private readonly baseUrl = process.env.GROBID_URL ?? 'http://127.0.0.1:8070', private readonly fetcher: typeof fetch = fetch, private readonly maxTeiBytes = 25 * 1024 * 1024, private readonly timeoutMs = 120_000) {}
  async process(body: Uint8Array, filename = 'paper.pdf'): Promise<ParsedDocument> {
    const form = new FormData();
    const pdfBytes = new Uint8Array(body.byteLength); pdfBytes.set(body);
    form.append('input', new Blob([pdfBytes], {type:'application/pdf'}), filename);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetcher(`${this.baseUrl.replace(/\/$/, '')}/api/processFulltextDocument`, {method:'POST', body:form, signal:controller.signal});
      if (!response.ok) throw new Error(`GROBID request failed: ${response.status}`);
    if (!response.body) throw new Error('GROBID response has no body');
    const reader=response.body.getReader();
    const chunks:Uint8Array[]=[]; let total=0;
    try {
      while(true){
        const next=await reader.read();
        if(next.done)break;
        const chunk=next.value;
        total+=chunk.byteLength;
        if(total>this.maxTeiBytes){await reader.cancel('GROBID response size limit');throw new Error('GROBID response size limit');}
        chunks.push(chunk);
      }
    } finally { reader.releaseLock(); }
    const tei=new TextDecoder().decode(Buffer.concat(chunks));
    return parseGrobidTei(filename, tei);
     } finally { clearTimeout(timeout); }
  }
}

export class CommandPdfFallback implements PdfFallback {
  constructor(public readonly name: 'pymupdf' | 'docling', private readonly command: string, private readonly script: string, private readonly runner: PdfCommandRunner = (command, args, options) => runFile(command, args, options), private readonly timeoutMs = 120_000) {}
  async extract(body: Uint8Array, filename = 'paper.pdf'): Promise<ParsedDocument> {
    const directory = await mkdtemp(join(tmpdir(), 'openpapers-pdf-'));
    const path = join(directory, filename.replace(/[^A-Za-z0-9._-]/g, '_'));
    try {
      await writeFile(path, body);
      const result = await this.runner(this.command, [this.script, path], {maxBuffer:25 * 1024 * 1024, windowsHide:true, timeout:this.timeoutMs});
      let parsed: Omit<ParsedDocument, 'url' | 'format'>;
      try { parsed = JSON.parse(result.stdout) as Omit<ParsedDocument, 'url' | 'format'>; } catch { throw new Error('invalid PDF parser output: malformed JSON'); }
      if (!parsed || !Array.isArray(parsed.sections) || !Array.isArray(parsed.references) || !Array.isArray(parsed.warnings) || !parsed.sections.every(section => Boolean(section) && typeof section === 'object' && typeof (section as {text?:unknown}).text === 'string' && typeof (section as {heading?:unknown}).heading === 'string') || !parsed.references.every(reference => Boolean(reference) && typeof reference === 'object' && typeof (reference as {text?:unknown}).text === 'string') || !parsed.warnings.every(warning => typeof warning === 'string')) throw new Error('invalid PDF parser output: malformed fields');
      return {format:'pdf',url:filename,...parsed,parser:{name:this.name}};
    } finally { await rm(directory, {recursive:true,force:true}); }
  }
}

export function createConfiguredPdfFallbacks(): PdfFallback[] {
  const command = process.env.PYTHON_COMMAND ?? 'python';
  const configured = (process.env.PDF_FALLBACKS ?? '').split(',').map(value => value.trim().toLowerCase()).filter(Boolean);
  const fallbacks: PdfFallback[] = [];
  if (configured.includes('pymupdf')) fallbacks.push(new CommandPdfFallback('pymupdf', command, process.env.PYMUPDF_SCRIPT ?? 'scripts/parse_pymupdf.py'));
  if (configured.includes('docling')) fallbacks.push(new CommandPdfFallback('docling', command, process.env.DOCLING_SCRIPT ?? 'scripts/parse_docling.py'));
  return fallbacks;
}

export class PdfParserChain implements PdfParser {
  constructor(private readonly primary: PdfParser = new GrobidClient(), private readonly fallbacks: PdfFallback[] = createConfiguredPdfFallbacks()) {}
  async process(body: Uint8Array, filename = 'paper.pdf'): Promise<ParsedDocument> {
    const warnings: string[] = [];
    try { return await this.primary.process(body, filename); } catch (error) { warnings.push(`GROBID unavailable: ${String(error)}`); }
    for (const fallback of this.fallbacks) {
      try { const parsed = await fallback.extract(body, filename); return {...parsed, parser:{name:fallback.name}, warnings:[...warnings, ...parsed.warnings]}; }
      catch (error) { warnings.push(`${fallback.name} unavailable: ${String(error)}`); }
    }
    throw new Error(`PDF parsing failed: ${warnings.join('; ')}`);
  }
}
