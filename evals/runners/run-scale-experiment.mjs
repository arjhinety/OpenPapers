import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ResearchDb } from '../../dist/database/db.js';
import { ResearchService } from '../../dist/research/service.js';
import { extractResearchFacts } from '../../dist/research/facts.js';
import { interpretResearchQuery } from '../../dist/research/query-intent.js';
import { assembleFactAnswer } from '../../dist/research/answer-assembly.js';

// Scale experiment over research-scale-v1 (100 real arXiv papers). No
// hand-annotated gold exists for this corpus, so:
//  - task gold is auto-generated from extracted candidates and measures
//    pipeline self-consistency (answer assembly agrees with the candidate
//    layer), not accuracy;
//  - candidate-fact precision is estimated by manual audit of a fixed random
//    sample (auditSample, seeded shuffle) exported alongside the results;
//  - refusal probes (predicates with no extracted facts) measure the
//    fabricated-answer path; out-of-domain papers should yield zero facts.
// Results are not comparable to the hand-annotated research-real-v1..v5
// benchmarks.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const dataset = JSON.parse(readFileSync(join(root, 'evals/datasets/research-scale-v1.json'), 'utf8'));
const acquisition = JSON.parse(readFileSync(join(root, 'evals/results/real-source-scale-acquisition-all.json'), 'utf8'));
const acquired = new Map(acquisition.rows.map(r => [r.caseId, r]));

const IN_DOMAIN = new Set(['cs.LG', 'cs.CL', 'cs.CV', 'cs.DC', 'cs.IR', 'stat.ML']);
const QUERY_TEMPLATES = {
  'training.objective': 'Which training objective does the paper use?',
  'training.stage': 'Which training stage is described?',
  'training.preference_method': 'Which preference optimization method does the paper apply?',
  'training.algorithm': 'Which reinforcement learning algorithm is used?',
  'architecture.attention': 'Which attention mechanism is used?',
  'architecture.recurrence': 'Which recurrence mechanism carries information?',
  'architecture.formulation': 'Which formulation is used?',
  'model.formulation': 'Which model formulation is described?',
  'architecture.moe': 'Which sparse expert architecture is used?',
  'architecture.operator': 'Which operator does the architecture use?',
  'evaluation.regime': 'Which evaluation regime is reported?',
  'evaluation.method': 'Which evaluation method is used?',
  'system.parallelism': 'Which parallelism strategy is used?',
  'system.zero_stage': 'Which partitioned state is sharded?',
  'model.component': 'Which bridge module is used?',
  'retrieval.component': 'Which retrieval component supplies evidence?',
  'retrieval.retriever': 'Which retriever architecture is used?',
  'retrieval.interaction': 'Which retrieval interaction is used?',
  'reasoning.trace_type': 'Which reasoning trace element is reported?',
  'data.training_dataset': 'Which training dataset was used?',
  'optimization.optimizer': 'Which optimizer does the paper use?',
};
const PROBE_PREDICATES = ['optimization.optimizer', 'data.training_dataset'];

// Deterministic sample for the manual precision audit.
function seededSample(items, size, seed = 20260906) {
  const arr = [...items];
  let state = seed;
  const rand = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
  for (let i = arr.length - 1; i > 0; i--) { const j = Math.floor(rand() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr.slice(0, size);
}

const db = new ResearchDb(':memory:');
const service = new ResearchService(db);
const rows = [];
const auditCandidates = [];
let parseFailures = 0, identityResolved = 0, identityAttempts = 0;

for (const item of dataset.cases) {
  const artifact = acquired.get(item.caseId);
  const row = { caseId: item.caseId, category: item.category, inDomain: IN_DOMAIN.has(item.category), artifactStatus: artifact?.status ?? 'NOT_ACQUIRED', parseError: null, factCount: 0, tasks: [], resolveWork: null, resolveFailures: [], latencyMs: 0 };
  const started = Date.now();
  let facts = [];
  if (artifact?.status === 'ACQUIRED') {
    try {
      const stdout = execFileSync(process.env.PYTHON_COMMAND ?? 'python', ['scripts/parse_pymupdf.py', artifact.path], { maxBuffer: 25 * 1024 * 1024, timeout: 120000 }).toString();
      const parsed = { ...JSON.parse(stdout), format: 'pdf', url: item.source.pdfUrl };
      facts = extractResearchFacts(parsed);
    } catch (error) { row.parseError = String(error).slice(0, 300); parseFailures += 1; }
  }
  row.factCount = facts.length;
  for (const fact of facts) auditCandidates.push({ caseId: item.caseId, category: item.category, predicate: fact.predicate, value: fact.value, section: fact.locator?.section ?? null, page: fact.locator?.page ?? null, rawEvidence: fact.rawEvidence.slice(0, 400) });

  identityAttempts += 1;
  try {
    const resolution = await service.resolveKnownWork(item.source.arxivId);
    row.resolveWork = resolution.data?.[0]?.paperId ?? null;
    row.resolveFailures = resolution.transparency?.providerFailures ?? [];
    if (row.resolveWork) identityResolved += 1;
  } catch (error) { row.resolveFailures = [String(error).slice(0, 200)]; }

  // Auto-generated tasks: SUPPORTED per single-value predicate, one
  // CONFLICTING task for the first multi-value predicate, refusal probes for
  // empty predicates. Capped at 4 tasks per paper.
  const byPredicate = new Map();
  for (const fact of facts) { if (!byPredicate.has(fact.predicate)) byPredicate.set(fact.predicate, new Map()); const k = JSON.stringify(fact.value); byPredicate.get(fact.predicate).set(k, fact.value); }
  let taskCount = 0;
  let conflictUsed = false;
  for (const [predicate, values] of byPredicate) {
    if (taskCount >= 4) break;
    const distinct = [...values.values()];
    const taskId = `${item.caseId}-${predicate}`;
    if (distinct.length === 1) {
      row.tasks.push({ taskId, predicate, query: QUERY_TEMPLATES[predicate] ?? `Which ${predicate} is reported?`, expectedStatus: 'SUPPORTED', expectedAnswer: { [predicate]: distinct[0] }, actualStatus: null, actualAnswer: null, answerCorrect: null });
      taskCount += 1;
    } else if (!conflictUsed) {
      conflictUsed = true;
      row.tasks.push({ taskId, predicate, query: QUERY_TEMPLATES[predicate] ?? `Which ${predicate} is reported?`, expectedStatus: 'CONFLICTING', expectedAnswer: { [predicate]: distinct[0] }, actualStatus: null, actualAnswer: null, answerCorrect: null, note: 'multiple distinct candidates extracted' });
      taskCount += 1;
    }
  }
  for (const probe of PROBE_PREDICATES) {
    if (taskCount >= 4 || byPredicate.has(probe)) continue;
    row.tasks.push({ taskId: `${item.caseId}-probe-${probe}`, predicate: probe, query: QUERY_TEMPLATES[probe], expectedStatus: 'UNKNOWN', expectedAnswer: {}, actualStatus: null, actualAnswer: null, answerCorrect: null });
    taskCount += 1;
  }
  for (const task of row.tasks) {
    const intent = interpretResearchQuery(task.query, [task.predicate]);
    const assembled = assembleFactAnswer(intent, facts);
    task.actualStatus = assembled.status === 'SUPPORTED' ? 'SUPPORTED' : assembled.status === 'CONFLICTING' ? 'CONFLICTING' : Object.keys(assembled.answer).length ? 'PARTIALLY_SUPPORTED' : 'UNKNOWN';
    task.actualAnswer = assembled.answer;
    task.answerCorrect = JSON.stringify(assembled.answer) === JSON.stringify(task.expectedAnswer) && task.actualStatus === task.expectedStatus;
  }
  row.latencyMs = Date.now() - started;
  rows.push(row);
  await new Promise(r => setTimeout(r, 1200)); // be polite to the live arXiv API
}
await db.close();

const acquiredRows = rows.filter(r => r.artifactStatus === 'ACQUIRED');
const parsedRows = acquiredRows.filter(r => !r.parseError);
const allTasks = rows.flatMap(r => r.tasks.map(t => ({ ...t, caseId: r.caseId, category: r.category, inDomain: r.inDomain })));
const boolRate = (arr, key) => arr.length ? arr.filter(t => t[key] === true).length / arr.length : null;
const substantive = allTasks.filter(t => t.expectedStatus !== 'UNKNOWN');
const outOfDomain = rows.filter(r => !r.inDomain && r.artifactStatus === 'ACQUIRED' && !r.parseError);
const oodRefusalCorrect = outOfDomain.filter(r => r.factCount === 0).length;
const median = values => { const s = [...values].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

const result = {
  schemaVersion: 'openpapers.scale-experiment.v1',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  dataset: dataset.version,
  notes: [
    'No hand-annotated gold: task gold is auto-generated from extracted candidates, so answer correctness measures pipeline self-consistency, not accuracy.',
    'Candidate-fact precision is estimated by the manual audit of the seeded 25-candidate sample in auditSample (audit verdict recorded separately in evals/results/scale-experiment-audit.json).',
    'Out-of-domain categories should yield zero extracted facts; refusal probes must return UNKNOWN with an empty answer.',
    'Not comparable to hand-annotated research-real-v1..v5 benchmarks.',
  ],
  aggregate: {
    papersSelected: dataset.cases.length,
    acquired: acquiredRows.length,
    parseFailures,
    identityResolutionRate: identityAttempts ? identityResolved / identityAttempts : null,
    papersWithExtractedFacts: parsedRows.filter(r => r.factCount > 0).length,
    meanFactsPerParsedPaper: parsedRows.length ? parsedRows.reduce((s, r) => s + r.factCount, 0) / parsedRows.length : null,
    medianPipelineLatencyMs: median(rows.map(r => r.latencyMs)),
    tasksGenerated: allTasks.length,
    answerAgreementRate: boolRate(allTasks, 'answerCorrect'),
    supportStatusAccuracy: boolRate(allTasks, 'answerCorrect'), // same combined criterion; kept for schema parity
    refusalProbeCount: allTasks.filter(t => t.expectedStatus === 'UNKNOWN').length,
    refusalProbeCorrect: allTasks.filter(t => t.expectedStatus === 'UNKNOWN' && t.actualStatus === 'UNKNOWN' && Object.keys(t.actualAnswer).length === 0).length,
    fabricatedAnswers: allTasks.filter(t => ['UNKNOWN'].includes(t.expectedStatus) && Object.keys(t.actualAnswer).length > 0).length,
    outOfDomainPapers: outOfDomain.length,
    outOfDomainZeroFactRate: outOfDomain.length ? oodRefusalCorrect / outOfDomain.length : null,
    perCategory: Object.fromEntries([...new Set(rows.map(r => r.category))].map(c => { const rs = rows.filter(r => r.category === c); return [c, { papers: rs.length, meanFacts: Math.round(100 * rs.reduce((s, r) => s + r.factCount, 0) / rs.length) / 100, papersWithFacts: rs.filter(r => r.factCount > 0).length }]; })),
  },
  auditSample: seededSample(auditCandidates, 25),
  auditCandidatePoolSize: auditCandidates.length,
  rows,
};
const out = join(root, 'evals/results', `scale-experiment-${result.commit.slice(0, 12)}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ output: out, aggregate: result.aggregate }, null, 2));
