import { describe, expect, it } from 'vitest';
import { discoverCandidateEvidence, extractResearchFacts, validateCandidateEvidence } from '../../src/research/facts.js';

const documentFor = (text: string, heading = 'Experiments') => ({
  format: 'pdf' as const, url: 'https://example.test/paper.pdf',
  sections: [{ level: 1, heading, text, page: 4 }], references: [], warnings: [],
});

describe('adversarial fact candidate validation', () => {
  it('keeps our objective while rejecting a cited related-work objective', () => {
    const candidates = discoverCandidateEvidence(documentFor('Smith et al. use contrastive learning. We train our model with contrastive learning.'));
    const accepted = validateCandidateEvidence(candidates);
    expect(accepted).toHaveLength(1);
    expect(accepted[0]).toMatchObject({ experimentalRole: 'ours', assertionStatus: 'asserted', trigger: 'contrastive learning' });
  });

  it('rejects future, negated, and conditional formulations', () => {
    const candidates = discoverCandidateEvidence(documentFor([
      'Future work will evaluate a multimodal model.',
      'We do not use a multimodal model.',
      'If resources permit, we could evaluate a multimodal model.',
      'We evaluate a multimodal model.',
    ].join(' ')));
    expect(candidates.map(candidate => candidate.assertionStatus)).toEqual(['future', 'negated', 'conditional', 'asserted']);
    expect(extractResearchFacts(documentFor(candidates.map(candidate => candidate.rawText).join(' '))).filter(fact => fact.predicate === 'model.formulation')).toHaveLength(1);
  });

  it('does not treat background MoE discussion as the paper architecture', () => {
    const facts = extractResearchFacts(documentFor('A prominent example is the mixture-of-experts architecture. We propose a sparse mixture-of-experts router for our model.'));
    expect(facts.filter(fact => fact.predicate === 'architecture.moe')).toHaveLength(1);
    expect(facts[0]?.experimentalRole).toBe('ours');
  });

  it('preserves separate repeated candidates before reconciliation', () => {
    const candidates = discoverCandidateEvidence(documentFor('We use zero-shot evaluation and also report few-shot evaluation.'));
    expect(candidates.filter(candidate => candidate.candidatePredicate === 'evaluation.regime')).toHaveLength(2);
  });

  it('never promotes a reference section into paper evidence', () => {
    const candidates = discoverCandidateEvidence(documentFor('Direct Preference Optimization is described here.', 'References'));
    expect(validateCandidateEvidence(candidates)).toEqual([]);
  });
});
