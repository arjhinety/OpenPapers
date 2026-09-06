import { createHash } from 'node:crypto';
import type { Author, Evidence, EvidenceType, Identifier, Locator, ResearchWork, SourceQuality } from '../models/research.js';

const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/i;
const MODERN_ARXIV_PATTERN = /^\d{4}\.\d{4,5}(?:v\d+)?$/i;
const LEGACY_ARXIV_PATTERN = /^(?:cond-mat|hep-th|hep-ph|hep-ex|astro-ph|gr-qc|nucl-th|nucl-ex|math|nlin|cs|q-bio|q-fin|quant-ph|physics|stat)\/\d{7}(?:v\d+)?$/i;

export function normalizeDoi(value: string): string {
  const normalized = value.trim()
    .replace(/^https?:\/\/(?:www\.)?(?:doi\.org|dx\.doi\.org)\//i, '')
    .replace(/^doi:\s*/i, '')
    .replace(/[.,;:]+$/, '')
    .toLowerCase();
  if (!isValidDoi(normalized)) throw new Error(`invalid DOI: ${value}`);
  return normalized;
}
export function isValidDoi(value: string): boolean { return DOI_PATTERN.test(value.trim()); }
export function normalizeArxivId(value: string): string {
  let normalized = value.trim().replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '').replace(/\.pdf$/i, '').replace(/^arxiv:/i, '');
  normalized = normalized.replace(/^https?:\/\/export\.arxiv\.org\/api\/query\?id_list=/i, '').split(',')[0] ?? normalized;
  normalized = normalized.replace(/v\d+$/i, '');
  if (!MODERN_ARXIV_PATTERN.test(normalized) && !LEGACY_ARXIV_PATTERN.test(normalized)) throw new Error(`invalid arXiv identifier: ${value}`);
  return normalized.toLowerCase();
}
export function normalizeAuthorName(name: string): string { return name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\p{L}\p{N} ]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase(); }
export function author(name: string, orcid?: string): Author { return orcid ? { name, normalizedName: normalizeAuthorName(name), orcid } : { name, normalizedName: normalizeAuthorName(name) }; }
export function paperId(title: string, authors: Author[], doi?: string, arxiv?: string): string { const key = doi ? `doi:${normalizeDoi(doi)}` : arxiv ? `arxiv:${normalizeArxivId(arxiv)}` : `${title}|${authors.map(a => a.normalizedName).join('|')}`; return `work_${createHash('sha256').update(key.toLowerCase()).digest('hex').slice(0, 16)}`; }
export function citationText(title: string, authors: Author[], year?: number, locator?: Locator): string { const names = authors.length <= 3 ? authors.map(a => a.name).join(', ') : `${authors[0]?.name ?? 'Unknown'} et al.`; const loc = locator ? [locator.section && `§${locator.section}`, locator.page && `p. ${locator.page}`, locator.table && locator.table].filter(Boolean).join(', ') : ''; return `[${names}${year ? `, ${year}` : ''}${loc ? `, ${loc}` : ''}]`; }
export function makeEvidence(sourceId: string, work: ResearchWork, evidence: string, evidenceType: EvidenceType = 'DIRECT', sourceQuality: SourceQuality = 'A', locator?: Locator): Evidence { const evidenceId = `ev_${createHash('sha256').update(`${sourceId}:${evidence}:${JSON.stringify(locator ?? {})}`).digest('hex').slice(0, 16)}`; const identifiers: Identifier = {}; if (work.doi) identifiers.doi = work.doi; if (work.arxivId) identifiers.arxiv = work.arxivId; if (work.semanticScholarId) identifiers.semanticScholar = work.semanticScholarId; if (work.openAlexId) identifiers.openAlex = work.openAlexId; return { evidenceId, sourceId, authors: work.authors, title: work.title, ...(work.year !== undefined ? { year: work.year } : {}), identifiers, ...(locator ? { locator } : {}), evidenceType, sourceQuality, evidence, citationText: citationText(work.title, work.authors, work.year, locator) }; }
export function bibtex(work: ResearchWork): string { const key = `${work.authors[0]?.normalizedName.split(' ')[0] ?? 'unknown'}${work.year ?? 'nd'}${work.paperId.slice(-6)}`; return `@article{${key},\n  title = {${work.title}},\n  author = {${work.authors.map(a => a.name).join(' and ')}},\n  year = {${work.year ?? ''}}${work.doi ? `,\n  doi = {${work.doi}}` : ''}${work.arxivId ? `,\n  eprint = {${work.arxivId}}` : ''}\n}`; }
