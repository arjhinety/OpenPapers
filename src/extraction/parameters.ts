import type { ParsedDocument } from '../ingestion/document.js';
import type { Locator } from '../models/research.js';

export interface TrainingParameter { name: 'learning_rate' | 'batch_size' | 'epochs' | 'optimizer' | 'weight_decay' | 'temperature' | 'gradient_accumulation'; value: string; sourceUrl: string; locator: Locator; confidence: 'explicit'; }

type Rule = [TrainingParameter['name'], RegExp];
const rules: Rule[] = [
  ['learning_rate', /(?:learning\s*rate|lr)\s*(?:is|was|of|=|:)?\s*([0-9]+(?:\.[0-9]+)?(?:e[-+]?\d+)?)/i],
  ['batch_size', /batch\s*size\s*(?:is|was|of|=|:)?\s*(\d+)/i],
  ['epochs', /(?:(?:number\s+of\s+)?epochs?\s*(?:of|=|:)?\s*(\d+)|(\d+)\s*epochs?)/i],
  ['optimizer', /(?:optimizer\s*(?:is|was|of|=|:)?|use|using|was)\s*(AdamW|Adam|SGD|Adafactor|Lion)\b/i],
  ['weight_decay', /weight\s*decay\s*(?:of|=|:)?\s*([0-9]+(?:\.[0-9]+)?(?:e[-+]?\d+)?)/i],
  ['temperature', /temperature\s*(?:of|=|:)?\s*([0-9]+(?:\.[0-9]+)?)/i],
  ['gradient_accumulation', /gradient\s*accumulation(?:\s*steps?)?\s*(?:of|=|:)?\s*(\d+)/i],
];

export function extractTrainingParameters(document: ParsedDocument): TrainingParameter[] {
  const output: TrainingParameter[] = [];
  for (const section of document.sections) {
    if (/^(?:references?|bibliography|related work|baselines?|ablations?)$/i.test(section.heading.trim())) continue;
    for (const sentence of section.text.split(/(?<=[.!?])\s+/)) {
      if (/\b(?:do|does|did)\s+not\b|\bwithout\b|\bnever\b|\b(?:baseline|ablation|prior|previous|related)\s+(?:model|configuration|work|run|system)?/i.test(sentence)) continue;
      for (const [name, pattern] of rules) {
        const match = sentence.match(pattern);
        if (!match) continue;
        const value = match[1] ?? match[2];
        if (!value) continue;
        output.push({name,value,sourceUrl:document.url,locator:{section:section.heading,...(section.page === undefined ? {} : {page:section.page}),...(section.pageId === undefined ? {} : {pageId:section.pageId})},confidence:'explicit'});
      }
    }
  }
  return output;
}
