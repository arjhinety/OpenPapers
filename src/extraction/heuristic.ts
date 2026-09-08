import type { ParsedDocument } from '../ingestion/document.js';
import type { Locator } from '../models/research.js';

export type PaperFactKind = 'methodology' | 'loss' | 'dataset' | 'benchmark' | 'training_stage' | 'hyperparameter' | 'limitation' | 'equation';
export interface PaperFact { kind: PaperFactKind; text: string; sourceUrl: string; locator: Locator; confidence: 'heuristic'; }

const headingKinds: Array<[PaperFactKind, RegExp]> = [
  ['methodology', /method|approach|architecture|model|framework|implementation/i],
  ['loss', /loss|objective|optimization/i],
  ['dataset', /dataset|data set|corpus|benchmark data/i],
  ['benchmark', /benchmark|evaluation|experiment|result/i],
  ['training_stage', /training|fine[- ]?tun|pre[- ]?train|distill/i],
  ['hyperparameter', /hyperparameter|configuration|setup/i],
  ['limitation', /limitation|caveat|future work|failure mode/i],
];

export function extractPaperFacts(document: ParsedDocument): PaperFact[] {
  const facts: PaperFact[] = [];
  for (const section of document.sections) {
    if (!section.text) continue;
    const matched = headingKinds.filter(([, pattern]) => pattern.test(section.heading)).map(([kind]) => kind);
    for (const kind of matched) facts.push({kind,text:section.text,sourceUrl:document.url,locator:{section:section.heading,...(section.page === undefined ? {} : {page:section.page}),...(section.pageId === undefined ? {} : {pageId:section.pageId})},confidence:'heuristic'});
  }
  for (const [index, equation] of (document.equations ?? []).entries()) { const location=document.equationMetadata?.[index]; facts.push({kind:'equation',text:equation,sourceUrl:document.url,locator:{equation:`equation-${index}`,...(location?.page===undefined?{}:{page:location.page}),...(location?.pageId===undefined?{}:{pageId:location.pageId})},confidence:'heuristic'}); }
  return facts;
}
