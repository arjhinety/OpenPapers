import { createHash } from 'node:crypto';
import type { Locator, Evidence, EvidenceType } from '../models/research.js';
import type { PaperFact } from './heuristic.js';

export interface PaperClaim { claimId: string; claimKey: string; kind: PaperFact['kind']; statement: string; sourceUrl: string; locator: Locator; confidence: PaperFact['confidence']; evidenceType: EvidenceType; evidence: Evidence; }
export interface ClaimConflict { claimKey: string; selectedClaimId: string; alternateClaimId: string; selectedStatement: string; alternateStatement: string; }
export interface ClaimReconciliation { claims: PaperClaim[]; conflicts: ClaimConflict[]; }

const normalize = (value: string): string => value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function extractPaperClaims(facts: PaperFact[]): PaperClaim[] {
  return facts.map(fact => {
    const anchor = fact.locator.section ?? fact.locator.equation ?? fact.kind;
    const claimKey = `${fact.kind}|${normalize(fact.sourceUrl)}|${normalize(anchor)}`;
    const seed = `${claimKey}|${fact.sourceUrl}|${JSON.stringify(fact.locator)}|${fact.text}`;
    const claimId = `claim-${createHash('sha256').update(seed).digest('hex')}`;
    const evidence: Evidence = {evidenceId:`evidence-${claimId.slice(6)}`,sourceId:fact.sourceUrl,authors:[],title:`Extracted ${fact.kind} claim`,identifiers:{},locator:fact.locator,evidenceType:'DERIVED',sourceQuality:'C',evidence:fact.text,citationText:`${fact.sourceUrl}${fact.locator.section ? `#${fact.locator.section}` : ''}`};
    return {claimId,claimKey,kind:fact.kind,statement:fact.text,sourceUrl:fact.sourceUrl,locator:fact.locator,confidence:fact.confidence,evidenceType:'DERIVED',evidence};
  });
}

export function reconcileClaims(existing: PaperClaim[], incoming: PaperClaim[]): ClaimReconciliation {
  const claims = [...existing];
  const conflicts: ClaimConflict[] = [];
  for (const claim of incoming) {
    const sameKey = claims.filter(candidate => candidate.claimKey === claim.claimKey);
    const duplicate = sameKey.find(candidate => normalize(candidate.statement) === normalize(claim.statement));
    if (duplicate) continue;
    const selected = sameKey[0];
    if (selected) conflicts.push({claimKey:claim.claimKey,selectedClaimId:selected.claimId,alternateClaimId:claim.claimId,selectedStatement:selected.statement,alternateStatement:claim.statement});
    claims.push(claim);
  }
  return {claims,conflicts};
}
