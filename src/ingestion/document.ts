import type { AcquiredDocument } from './acquisition.js';

export type DocumentFormat = 'html' | 'pdf' | 'unknown';
export interface DocumentSection { level: number; heading: string; text: string; page?: number; pageId?: string; isAppendix?: boolean; }
export interface DocumentReference { text: string; href?: string; id?: string; title?: string; authors?: string[]; year?: number; doi?: string; url?: string; }
export interface DocumentFigure { caption: string; page?: number; pageId?: string; }
export interface DocumentTable { caption: string; text: string; rows?: string[][]; page?: number; pageId?: string; }
export interface DocumentCitation { target: string; text: string; sectionHeading: string; page?: number; pageId?: string; }
export interface DocumentEquation { text: string; page?: number; pageId?: string; }
export interface ParsedDocument { format: 'html' | 'pdf'; url: string; title?: string; authors?: string[]; parser?: {name:string;version?:string}; sections: DocumentSection[]; references: DocumentReference[]; warnings: string[]; equations?: string[]; equationMetadata?: DocumentEquation[]; figures?: DocumentFigure[]; tables?: DocumentTable[]; appendices?: DocumentSection[]; citations?: DocumentCitation[]; }

const decodeEntities = (value: string): string => value.replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'");
const textOf = (value: string): string => decodeEntities(value.replace(/<!--.*?-->/gs, '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+([.,!?;:])/g, '$1').replace(/\s+/g, ' ').trim());

export function detectDocumentFormat(contentType: string | undefined, body: Uint8Array): DocumentFormat {
  const type = contentType?.toLowerCase().split(';', 1)[0]?.trim();
  if (type === 'application/pdf' || new TextDecoder().decode(body.slice(0, 5)) === '%PDF-') return 'pdf';
  if (type === 'text/html' || type === 'application/xhtml+xml') return 'html';
  const prefix = new TextDecoder().decode(body.slice(0, 512)).trimStart().toLowerCase();
  return prefix.startsWith('<!doctype html') || prefix.startsWith('<html') || /<(head|body|article|h[1-6])\b/.test(prefix) ? 'html' : 'unknown';
}

export function parseDocument(document: AcquiredDocument): ParsedDocument {
  const format = detectDocumentFormat(document.contentType, document.body);
  if (format === 'pdf') throw new Error('PDF parsing is not available');
  if (format !== 'html') throw new Error('unsupported document format');
  const source = new TextDecoder().decode(document.body);
  const titleMatch = source.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const sections: DocumentSection[] = [];
  const references: DocumentReference[] = [];
  let current: DocumentSection | undefined;
  const blockPattern = /<(h[1-6]|p|li)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  for (const match of source.matchAll(blockPattern)) {
    const tag = match[1]!.toLowerCase();
    const raw = match[3]!;
    const text = textOf(raw);
    if (!text) continue;
    if (tag.startsWith('h')) {
      current = {level:Number(tag.slice(1)), heading:text, text:''};
      sections.push(current);
      continue;
    }
    if (!current) { current = {level:0, heading:'', text:''}; sections.push(current); }
    current.text = current.text ? `${current.text} ${text}` : text;
    const href = raw.match(/<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/i)?.[1];
    if (/^references?$/i.test(current.heading) || /^\[\d+\]/.test(text)) references.push({text, ...(href ? {href} : {})});
  }
  return {format:'html',url:document.url,parser:{name:'openpapers-html'},...(titleMatch ? {title:textOf(titleMatch[1]!)} : {}),sections,references,warnings:[]};
}


export function parseGrobidTei(url: string, tei: string): ParsedDocument {
  if (!/<(?:[A-Za-z_][\w.-]*:)?TEI\b/i.test(tei) || !/<(?:[A-Za-z_][\w.-]*:)?body\b/i.test(tei)) throw new Error('invalid GROBID response: TEI body is missing');
  const normalizedTei = tei.replace(/<(\/?)(?:tei|ns\d+):/gi, '<$1');
  const titleMatch = normalizedTei.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const textStart = normalizedTei.indexOf('<text');
  const header = normalizedTei.match(/<teiHeader\b[^>]*>([\s\S]*?)<\/teiHeader>/i)?.[1] ?? (textStart >= 0 ? normalizedTei.slice(0, textStart) : '');
  const authors = [...header.matchAll(/<author\b[^>]*>([\s\S]*?)<\/author>/gi)].map(match => {
    const content = match[1] ?? '';
    const organization = content.match(/<(?:orgName|orgname)\b[^>]*>([\s\S]*?)<\/(?:orgName|orgname)>/i)?.[1];
    if (organization) return textOf(organization);
    const given = [...content.matchAll(/<(?:forename|firstname)\b[^>]*>([\s\S]*?)<\/(?:forename|firstname)>/gi)].map(item => textOf(item[1]!));
    const middle = [...content.matchAll(/<middlename\b[^>]*>([\s\S]*?)<\/middlename>/gi)].map(item => textOf(item[1]!));
    const family = [...content.matchAll(/<(?:surname|lastname)\b[^>]*>([\s\S]*?)<\/(?:surname|lastname)>/gi)].map(item => textOf(item[1]!));
    return [...given, ...middle, ...family].filter(Boolean).join(' ');
  }).filter(Boolean);
  const body = normalizedTei.match(/<body\b[^>]*>([\s\S]*?)<\/body>/i)?.[1] ?? '';
  const sections: DocumentSection[] = [];
  const sectionByDepth = new Map<number, DocumentSection>();
  const appendixDepths = new Set<number>();
  let depth = 0;
  let page: number | undefined;
  let pageId: string | undefined;
  const tokenPattern = /<pb\b([^>]*)\/?\s*>|<div\b[^>]*>|<\/div\s*>|<head\b[^>]*>([\s\S]*?)<\/head\s*>|<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi;
  const structuralBody = body.replace(/<table\b[^>]*>[\s\S]*?<\/table\s*>/gi, '');
  for (const match of structuralBody.matchAll(tokenPattern)) {
    const token = match[0]!;
    if (/^<pb\b/i.test(token)) {
      const attrs = match[1] ?? '';
      const number = attrs.match(/\bn\s*=\s*["'](\d+)["']/i)?.[1];
      const identifier = attrs.match(/\b(?:xml:)?id\s*=\s*["']([^"']+)["']/i)?.[1];
      page = number ? Number(number) : undefined;
      pageId = identifier;
    } else if (/^<div\b/i.test(token)) {
      depth += 1;
      if (/\btype\s*=\s*["'](?:appendix|annex)["']/i.test(token)) appendixDepths.add(depth);
    } else if (/^<\/div/i.test(token)) {
      appendixDepths.delete(depth);
      sectionByDepth.delete(depth);
      depth = Math.max(0, depth - 1);
    } else if (match[2] !== undefined) {
      const heading = textOf(match[2]);
      const level = Math.max(1, depth);
      const isAppendix = [...appendixDepths].some(value => value <= level);
      const section: DocumentSection = {level,heading,text:'',...(page === undefined ? {} : {page}),...(pageId === undefined ? {} : {pageId}),...(isAppendix ? {isAppendix:true} : {})};
      sections.push(section);
      sectionByDepth.set(level, section);
    } else if (match[3] !== undefined) {
      const text = textOf(match[3]);
      if (!text) continue;
      const section = sectionByDepth.get(Math.max(1, depth));
      if (section) section.text = section.text ? `${section.text} ${text}` : text;
      else sections.push({level:0,heading:'',text,...(page === undefined ? {} : {page}),...(pageId === undefined ? {} : {pageId})});
    }
  }
  const pageAt = (position: number): {page?: number; pageId?: string} => {
    let current: {page?: number; pageId?: string} = {};
    for (const marker of body.matchAll(/<pb\b([^>]*)\/?\s*>/gi)) {
      if ((marker.index ?? 0) > position) break;
      const attrs = marker[1] ?? '';
      const number = attrs.match(/\bn\s*=\s*["'](\d+)["']/i)?.[1];
      const identifier = attrs.match(/\b(?:xml:)?id\s*=\s*["']([^"']+)["']/i)?.[1];
      current = {...(number ? {page:Number(number)} : {}),...(identifier ? {pageId:identifier} : {})};
    }
    return current;
  };
  const equationMetadata = [...body.matchAll(/<(?:formula|equation)\b[^>]*>([\s\S]*?)<\/(?:formula|equation)>/gi)].map(match => ({text:textOf(match[1]!),...pageAt(match.index ?? 0)})).filter(equation => equation.text);
  const equations = equationMetadata.map(equation => equation.text);
  const figures = [...body.matchAll(/<figure\b[^>]*>[\s\S]*?<figDesc\b[^>]*>([\s\S]*?)<\/figDesc>[\s\S]*?<\/figure>/gi)].map(match => ({caption:textOf(match[1]!),...pageAt(match.index ?? 0)})).filter(figure => figure.caption);
  const tables = [...body.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)].map(match => { const content = match[1]!; const caption = textOf(content.match(/<head\b[^>]*>([\s\S]*?)<\/head>/i)?.[1] ?? ''); const rows = [...content.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)].map(row => [...row[1]!.matchAll(/<cell\b[^>]*>([\s\S]*?)<\/cell>/gi)].map(cell => textOf(cell[1]!))); return {caption,text:textOf(content),...(rows.length ? {rows} : {}),...pageAt(match.index ?? 0)}; }).filter(table => table.caption || table.text);
  const citations = [...body.matchAll(/<ref\b([^>]*)>([\s\S]*?)<\/ref>/gi)].map(match => { const target = match[1]!.match(/\btarget\s*=\s*["']#?([^"']+)["']/i)?.[1]; const text = textOf(match[2]!); const position = match.index ?? 0; const headingMatches = [...body.slice(0, position).matchAll(/<head\b[^>]*>([\s\S]*?)<\/head\s*>/gi)]; return target && text ? {target,text,sectionHeading:headingMatches.length ? textOf(headingMatches.at(-1)![1]!) : '',...pageAt(position)} : undefined; }).filter((citation): citation is NonNullable<typeof citation> => Boolean(citation));
  const references: DocumentReference[] = [];
  for (const match of tei.matchAll(/<biblStruct\b([^>]*)>([\s\S]*?)<\/biblStruct>/gi)) {
    const attrs = match[1] ?? '';
    const content = match[2]!;
    const title = content.match(/<analytic\b[^>]*>[\s\S]*?<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? content.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    const authors = [...content.matchAll(/<surname\b[^>]*>([\s\S]*?)<\/surname>/gi)].map(author => textOf(author[1]!));
    const yearValue = content.match(/<date\b[^>]*\bwhen\s*=\s*["'](\d{4})["']/i)?.[1];
    const doiRaw = content.match(/<idno\b[^>]*\btype\s*=\s*["']doi["'][^>]*>([\s\S]*?)<\/idno>/i)?.[1];
    const url = content.match(/<idno\b[^>]*\btype\s*=\s*["'](?:url|uri)["'][^>]*>([\s\S]*?)<\/idno>/i)?.[1];
    const id = attrs.match(/\b(?:xml:)?id\s*=\s*["']([^"']+)["']/i)?.[1];
    const reference: DocumentReference = {text:textOf(title ?? content),...(id ? {id} : {}),...(title ? {title:textOf(title)} : {}),...(authors.length ? {authors} : {}),...(yearValue ? {year:Number(yearValue)} : {}),...(doiRaw ? {doi:textOf(doiRaw)} : {}),...(url ? {url:textOf(url)} : {})};
    references.push(reference);
  }
  const appendices = sections.filter(section => section.isAppendix);
  const referenceIds = new Set(references.map(reference => reference.id).filter((id): id is string => Boolean(id)));
  const warnings = [...new Set(citations.filter(citation => !referenceIds.has(citation.target)).map(citation => `unresolved citation target: ${citation.target}`))];
  return {format:'pdf',url,parser:{name:'grobid'},...(titleMatch ? {title:textOf(titleMatch[1]!)} : {}),...(authors.length ? {authors} : {}),sections,references,warnings,equations,equationMetadata,figures,tables,appendices,citations};
}

export interface DocumentChunk { chunkId: string; url: string; format: 'html' | 'pdf'; ordinal: number; kind: 'section' | 'equation' | 'figure' | 'table' | 'reference'; sectionHeading: string; sectionLevel: number; text: string; referenceId?: string; page?: number; pageId?: string; }

export function chunkDocument(document: ParsedDocument, maxChars = 2000): DocumentChunk[] {
  if (!Number.isInteger(maxChars) || maxChars < 1) throw new Error('maxChars must be a positive integer');
  const chunks: DocumentChunk[] = [];
  const push = (kind: DocumentChunk['kind'], text: string, sectionHeading = '', sectionLevel = 0, extra: Partial<DocumentChunk> = {}) => {
    if (!text) return;
    chunks.push({chunkId:`${document.url}#${kind}-${chunks.length}`,url:document.url,format:document.format,ordinal:chunks.length,kind,sectionHeading,sectionLevel,text,...extra});
  };
  for (const [sectionIndex, section] of document.sections.entries()) {
    const words = section.text.split(/\s+/).filter(Boolean);
    let text = '';
    const save = () => { if (text) { push('section',text,section.heading,section.level,{...(section.page === undefined ? {} : {page:section.page}),...(section.pageId === undefined ? {} : {pageId:section.pageId})}); text=''; } };
    for (const word of words) { if (text && text.length + word.length + 1 > maxChars) save(); text = text ? `${text} ${word}` : word; }
    save();
    void sectionIndex;
  }
  const location = document.sections.find(section => section.page !== undefined || section.pageId !== undefined);
  const page = location?.page === undefined ? {} : {page:location.page};
  const pageId = location?.pageId === undefined ? {} : {pageId:location.pageId};
  const equations = document.equationMetadata ?? (document.equations ?? []).map(text => ({text,...page,...pageId}));
  for (const equation of equations) push('equation',equation.text,'',0,{...(equation.page === undefined ? {} : {page:equation.page}),...(equation.pageId === undefined ? {} : {pageId:equation.pageId})});
  for (const figure of document.figures ?? []) push('figure',figure.caption,'',0,{...(figure.page === undefined ? {} : {page:figure.page}),...(figure.pageId === undefined ? {} : {pageId:figure.pageId})});
  for (const table of document.tables ?? []) push('table',table.text,table.caption,0,{...(table.page === undefined ? {} : {page:table.page}),...(table.pageId === undefined ? {} : {pageId:table.pageId})});
  for (const reference of document.references) push('reference',reference.text,'References',0,{...(reference.id ? {referenceId:reference.id} : {})});
  return chunks;
}

export function searchDocument(document: ParsedDocument, query: string, limit = 10): DocumentChunk[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) throw new Error('query must not be empty');
  if (!Number.isInteger(limit) || limit < 1) throw new Error('limit must be a positive integer');
  return chunkDocument(document).filter(chunk => `${chunk.sectionHeading} ${chunk.text}`.toLowerCase().includes(normalized)).sort((a,b) => Number(`${b.sectionHeading} ${b.text}`.toLowerCase().includes(normalized)) - Number(`${a.sectionHeading} ${a.text}`.toLowerCase().includes(normalized)) || a.ordinal-b.ordinal).slice(0,limit);
}
