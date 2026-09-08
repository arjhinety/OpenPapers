import { describe, expect, it } from 'vitest';
import { extractPaperClaims, reconcileClaims } from '../src/extraction/claims.js';
import type { PaperFact } from '../src/extraction/heuristic.js';

describe('paper claims', () => {
  it('normalizes heuristic facts into stable source-backed claims', () => {
    const facts: PaperFact[] = [{kind:'loss',text:'The objective uses KL divergence.',sourceUrl:'https://example.com/paper',locator:{section:'Loss'},confidence:'heuristic'}];
    const claims = extractPaperClaims(facts);
    expect(claims).toMatchObject([{claimKey:'loss|https example com paper|loss',statement:'The objective uses KL divergence.',sourceUrl:'https://example.com/paper',evidenceType:'DERIVED'}]);
    expect(claims[0]?.claimId).toMatch(/^claim-[a-f0-9]{64}$/);
  });
  it('retains conflicting statements for the same claim key', () => {
    const a = extractPaperClaims([{kind:'loss',text:'Uses cross entropy.',sourceUrl:'a',locator:{section:'Loss'},confidence:'heuristic'}])[0]!;
    const b = extractPaperClaims([{kind:'loss',text:'Uses only squared error.',sourceUrl:'a',locator:{section:'Loss'},confidence:'heuristic'}])[0]!;
    const result = reconcileClaims([a], [b]);
    expect(result.claims).toHaveLength(2);
    expect(result.conflicts).toMatchObject([{claimKey:a.claimKey,selectedClaimId:a.claimId,alternateClaimId:b.claimId}]);
  });
  it('does not reconcile same-kind claims from unrelated sources', () => {
    const a = extractPaperClaims([{kind:'loss',text:'Uses cross entropy.',sourceUrl:'a',locator:{section:'Loss'},confidence:'heuristic'}])[0]!;
    const b = extractPaperClaims([{kind:'loss',text:'Uses only squared error.',sourceUrl:'b',locator:{section:'Loss'},confidence:'heuristic'}])[0]!;
    expect(reconcileClaims([a],[b]).conflicts).toEqual([]);
  });
});
