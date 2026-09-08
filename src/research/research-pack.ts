import type { Evidence, ResearchWork } from '../models/research.js';

export interface ResearchPack {
  format:'openpapers.research-pack.v1';
  collection:{id:string;name:string};
  papers:ResearchWork[];
  evidence:Array<{paperId:string;evidence:Evidence}>;
}

export function validateResearchPack(value: unknown): asserts value is ResearchPack {
  if (!value || typeof value !== 'object') throw new Error('invalid ResearchPack structure');
  const pack = value as Partial<ResearchPack>;
  if (pack.format !== 'openpapers.research-pack.v1' || !pack.collection || typeof pack.collection.name !== 'string' || !pack.collection.name.trim() || !Array.isArray(pack.papers) || !Array.isArray(pack.evidence)) throw new Error('invalid ResearchPack structure');
  const paperIds = new Set<string>();
  for (const paper of pack.papers) {
    if (!paper || typeof paper !== 'object' || typeof paper.paperId !== 'string' || !paper.paperId || paperIds.has(paper.paperId) || typeof paper.title !== 'string' || !paper.title.trim() || !Array.isArray(paper.authors) || !Array.isArray(paper.sourceProviders) || !Array.isArray(paper.versions) || typeof paper.bibtex !== 'string') throw new Error('invalid ResearchPack paper');
    paperIds.add(paper.paperId);
  }
  const evidenceIds = new Set<string>();
  for (const item of pack.evidence) {
    const evidence = item?.evidence;
    if (!item || typeof item.paperId !== 'string' || !paperIds.has(item.paperId) || !evidence || typeof evidence !== 'object' || typeof evidence.evidenceId !== 'string' || !evidence.evidenceId || evidenceIds.has(evidence.evidenceId) || typeof evidence.sourceId !== 'string' || typeof evidence.title !== 'string' || !Array.isArray(evidence.authors) || !evidence.identifiers || typeof evidence.evidence !== 'string' || typeof evidence.citationText !== 'string') throw new Error('invalid ResearchPack evidence');
    evidenceIds.add(evidence.evidenceId);
  }
}
