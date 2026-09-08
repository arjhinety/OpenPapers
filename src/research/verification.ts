import type { Evidence, ResearchResponse } from '../models/research.js';

export type CitationSupportStatus='SUPPORTED'|'PARTIALLY_SUPPORTED'|'UNSUPPORTED'|'CONTRADICTED'|'UNKNOWN';
export interface CitationSupportResult { status:CitationSupportStatus; basis:'EXACT_TEXT'|'PARTIAL_TEXT'|'NEGATION_HEURISTIC'|'NO_TEXT_OVERLAP'; }

/** Validates the machine contract before a response is exposed to an agent. */
export function validateCitationIntegrity<T>(response: ResearchResponse<T>): CitationIntegrityResult {
  const errors: string[] = [];
  const evidence = response.evidence ?? [];
  const ids = new Set<string>();
  for (const item of evidence) {
    validateEvidence(item, ids, errors);
  }
  const references = new Set(response.references.map(reference => reference.paperId));
  for (const item of evidence) {
    if (!references.has(item.sourceId) && item.sourceId !== 'local') errors.push(`evidence ${item.evidenceId} references missing source ${item.sourceId}`);
    const reference = response.references.find(candidate => candidate.paperId === item.sourceId);
    if (reference && normalizeText(reference.title) !== normalizeText(item.title)) errors.push(`evidence ${item.evidenceId} title does not match source ${item.sourceId}`);
    if (reference && item.authors.length > 0 && reference.authors.length > 0 && !item.authors.some(author => reference.authors.some(candidate => candidate.normalizedName === author.normalizedName))) errors.push(`evidence ${item.evidenceId} authors do not match source ${item.sourceId}`);
  }
  const dataText = JSON.stringify(response.data ?? '');
  const hasClaimLikeData = /claim|method|loss|objective|temperature|optimizer|dataset|benchmark|result|training/i.test(dataText);
  const hasCitedSummary = evidence.some(item => response.summary.includes(item.citationText));
  if (hasClaimLikeData && evidence.length === 0) errors.push('factual research data has no evidence records');
  if (hasClaimLikeData && evidence.length > 0 && !hasCitedSummary) errors.push('factual research data has no human-readable citation in summary');
  return { valid: errors.length === 0, errors };
}

export interface CitationIntegrityResult { valid: boolean; errors: string[]; }

export function classifyEvidenceSupport(claim:string,evidence:Evidence):CitationSupportResult {
  const claimText=claim.normalize('NFKD').toLowerCase(); const evidenceText=evidence.evidence.normalize('NFKD').toLowerCase();
  const claimTokens=new Set(claimText.match(/[\p{L}\p{N}]+/gu)??[]); const evidenceTokens=new Set(evidenceText.match(/[\p{L}\p{N}]+/gu)??[]);
  const overlap=[...claimTokens].filter(token=>evidenceTokens.has(token)).length;
  if(/\b(?:does not|do not|not|without|fails to)\s+(?:use|support|contain|report|show)/.test(evidenceText))return {status:'CONTRADICTED',basis:'NEGATION_HEURISTIC'};
  if(overlap===0)return {status:'UNKNOWN',basis:'NO_TEXT_OVERLAP'};
  if(overlap===claimTokens.size)return {status:'SUPPORTED',basis:'EXACT_TEXT'};
  if(overlap/claimTokens.size>=0.5)return {status:'PARTIALLY_SUPPORTED',basis:'PARTIAL_TEXT'};
  return {status:'UNSUPPORTED',basis:'NO_TEXT_OVERLAP'};
}

function normalizeText(value: string): string { return value.normalize('NFKD').replace(/[^\p{L}\p{N}]+/gu, '').toLowerCase(); }

function validateEvidence(item: Evidence, ids: Set<string>, errors: string[]): void {
  if (!item.evidenceId) errors.push('evidence record has no evidenceId');
  if (ids.has(item.evidenceId)) errors.push(`duplicate evidenceId ${item.evidenceId}`);
  ids.add(item.evidenceId);
  if (!item.sourceId) errors.push(`evidence ${item.evidenceId} has no sourceId`);
  if (!item.title) errors.push(`evidence ${item.evidenceId} has no source title`);
  if (!item.citationText) errors.push(`evidence ${item.evidenceId} has no citationText`);
  if (item.locator?.page !== undefined && (!Number.isInteger(item.locator.page) || item.locator.page < 1)) errors.push(`evidence ${item.evidenceId} has invalid page locator`);
}
