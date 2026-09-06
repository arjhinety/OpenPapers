import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchDb } from '../../dist/database/db.js';
import { ResearchService } from '../../dist/research/service.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const strict = process.argv.includes('--strict');
const dataset = JSON.parse(readFileSync(join(root, 'evals/datasets/live-search-v1.json'), 'utf8'));
const THROTTLE_MS = 1100;
const LIMIT = 10;

const normalizeArxiv = value => String(value ?? '').replace(/^arXiv:/i, '').replace(/^https?:\/\/(?:www\.)?arxiv\.org\/(?:abs|pdf)\//i, '').replace(/\.pdf$/i, '').replace(/v\d+$/i, '').trim();
const normalizeDoi = value => String(value ?? '').replace(/^https?:\/\/(?:www\.)?(?:doi\.org|dx\.doi\.org)\//i, '').replace(/^doi:\s*/i, '').toLowerCase().replace(/arxiv/i, 'arxiv').trim();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const median = values => { const sorted = [...values].sort((a, b) => a - b); return sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2; };

const service = new ResearchService(new ResearchDb(':memory:'));
const rows = [];
for (const [index, testCase] of dataset.cases.entries()) {
  const startedAt = Date.now();
  const response = await service.search(testCase.query, LIMIT);
  const latencyMs = Date.now() - startedAt;
  const works = response.data ?? [];
  const failures = response.transparency?.providerFailures ?? [];
  const goldArxiv = normalizeArxiv(testCase.goldArxiv);
  const goldDoi = normalizeDoi(testCase.goldDoi);
  let goldRank = 0;
  for (const [rank, work] of works.entries()) {
    const workArxiv = normalizeArxiv(work.arxivId);
    const workDoi = normalizeDoi(work.doi);
    if ((workArxiv && workArxiv === goldArxiv) || (workDoi && workDoi === goldDoi)) { goldRank = rank + 1; break; }
  }
  const zeroResultSuspicion = works.length === 0 && failures.length === 0 && (response.transparency?.candidates ?? 0) === 0;
  rows.push({
    caseId: testCase.caseId, mode: testCase.mode, query: testCase.query, goldWork: testCase.goldWork,
    returned: works.length, candidates: response.transparency?.candidates ?? 0,
    goldRank, foundInTop10: goldRank > 0, identityCorrect: goldRank > 0,
    providerFailures: failures, sourcesSearched: response.transparency?.sourcesSearched ?? [],
    latencyMs, zeroResultSuspicion,
  });
  process.stderr.write(`[${index + 1}/${dataset.cases.length}] ${testCase.caseId} rank=${goldRank} latency=${latencyMs}ms failures=${failures.length}\n`);
  if (index < dataset.cases.length - 1) await sleep(THROTTLE_MS);
}

const rate = (rows_, predicate) => rows_.filter(predicate).length / (rows_.length || 1);
const byMode = mode => rows.filter(row => row.mode === mode);
const aggregate = {
  cases: rows.length,
  liveRecallAt10: rate(rows, row => row.foundInTop10),
  titleExactRecallAt10: rate(byMode('title-exact'), row => row.foundInTop10),
  titleFuzzyRecallAt10: rate(byMode('title-fuzzy'), row => row.foundInTop10),
  identifierResolutionRate: rate(byMode('identifier'), row => row.foundInTop10),
  identityCorrectRate: rate(rows.filter(row => row.foundInTop10), row => row.identityCorrect),
  zeroResultWithNoFailureReportedRate: rate(rows, row => row.zeroResultSuspicion),
  casesWithProviderFailures: rows.filter(row => row.providerFailures.length > 0).length,
  totalProviderFailures: rows.reduce((sum, row) => sum + row.providerFailures.length, 0),
  medianLatencyMs: Math.round(median(rows.map(row => row.latencyMs))),
  maxLatencyMs: Math.max(...rows.map(row => row.latencyMs)),
};

const thresholds = { titleExactRecallAt10: 0.9, identityCorrectRate: 0.95, zeroResultWithNoFailureReportedRate: 0 };
const thresholdsMet = {
  titleExactRecallAt10: aggregate.titleExactRecallAt10 >= thresholds.titleExactRecallAt10,
  identityCorrectRate: aggregate.identityCorrectRate >= thresholds.identityCorrectRate,
  zeroResultWithNoFailureReportedRate: aggregate.zeroResultWithNoFailureReportedRate <= thresholds.zeroResultWithNoFailureReportedRate,
};

const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const result = {
  schemaVersion: 'openpapers.live-search-reliability.v1',
  kind: 'live-provider',
  commit,
  timestamp: new Date().toISOString(),
  workingTreeDirty: execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim().length > 0,
  configuration: { providerMode: 'live', liveProviders: ['arxiv', 'crossref', 'openalex', 'semantic_scholar'], limit: LIMIT, throttleMs: THROTTLE_MS, networkRegion: 'single-region residential network' },
  dataset: { version: dataset.version, cases: dataset.cases.length, matchRule: dataset.protocol.matchRule },
  thresholds, thresholdsMet, aggregate, cases: rows,
  limitations: 'Measured from one network region with anonymous provider access on one timestamp. Ranking metrics describe the top-10 of this run, not a guarantee; see docs/limitations.md.',
};

const output = join(root, 'evals/results', `live-search-reliability-${commit.slice(0, 12)}.json`);
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ output, aggregate, thresholdsMet }, null, 2));
if (strict && !Object.values(thresholdsMet).every(Boolean)) { console.error('LIVE THRESHOLDS NOT MET'); process.exit(1); }
