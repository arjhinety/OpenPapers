import type { TrainingRecipe, Locator, Evidence } from '../models/research.js';
import type { ConfigField } from './config-extraction.js';

export interface ReproducibilityConflict { field:string; paperValue:string; codeValue:string; paperSources:string[]; codeSource:{url:string;commitSha?:string;locator:Locator}; }
export interface ReproducibilityMatch { field:string; value:string; paperSources:string[]; codeSource:{url:string;commitSha?:string;locator:Locator}; }
export interface ReproducibilityComparison { conflicts:ReproducibilityConflict[]; matches:ReproducibilityMatch[]; unavailable:string[]; evidence:Evidence[]; }

const recipeFields: Array<keyof TrainingRecipe> = ['learning_rate','batch_size','epochs','weight_decay','temperature','gradient_accumulation'];
type ReportedValue = { value: unknown; sources: string[] };
function isReportedValue(value: unknown): value is ReportedValue { return typeof value==='object' && value!==null && 'value' in value && 'sources' in value && Array.isArray(value.sources); }
export function compareRecipeToConfig(recipe:TrainingRecipe, fields:ConfigField[], source:{url:string;commitSha?:string}):ReproducibilityComparison {
  const conflicts:ReproducibilityConflict[]=[]; const matches:ReproducibilityMatch[]=[]; const unavailable:string[]=[]; const evidence:Evidence[]=[];
  for (const field of recipeFields) {
    const reported=recipe[field]; const code=fields.find(item=>item.name===field||item.name.split('.').at(-1)===field);
    if (!code) { unavailable.push(String(field)); continue; }
    if (!isReportedValue(reported)) { unavailable.push(String(field)); continue; }
    const paperValue=String(reported.value); const codeValue=code.value.trim(); const codeSource={url:source.url,...(source.commitSha ? {commitSha:source.commitSha} : {}),locator:{repositoryPath:code.name,repositoryLineStart:code.lineStart,repositoryLineEnd:code.lineEnd, ...(source.commitSha ? {commitSha:source.commitSha} : {})}};
    const paperSource=reported.sources[0] ?? 'paper-source-unavailable';
    evidence.push({evidenceId:`repro-paper-${field}`,sourceId:paperSource,authors:[],title:`Paper-reported ${field}`,identifiers:{},evidenceType:'DIRECT',sourceQuality:'A',evidence:paperValue,citationText:paperSource});
    evidence.push({evidenceId:`repro-code-${field}`,sourceId:source.url,authors:[],title:`Code-configured ${field}`,identifiers:{},locator:codeSource.locator,evidenceType:'CODE_VERIFIED',sourceQuality:'C',evidence:codeValue,citationText:source.url});
    if (Number.isFinite(Number(reported.value)) && Number.isFinite(Number(codeValue)) && Number(reported.value)===Number(codeValue)) matches.push({field:String(field),value:paperValue,paperSources:reported.sources,codeSource});
    else if (paperValue===codeValue) matches.push({field:String(field),value:paperValue,paperSources:reported.sources,codeSource});
    else conflicts.push({field:String(field),paperValue,codeValue,paperSources:reported.sources,codeSource});
  }
  return {conflicts,matches,unavailable,evidence};
}
