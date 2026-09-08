import { readFileSync, writeFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { extractResearchFacts } from '../dist/research/facts.js';
const run = promisify(execFile);
const dataset = JSON.parse(readFileSync('evals/datasets/research-real-v5.json', 'utf8'));
const rows = [
  ...JSON.parse(readFileSync('evals/results/real-source-v5-acquisition-development.json', 'utf8')).rows,
  ...JSON.parse(readFileSync('evals/results/real-source-v5-acquisition-holdout.json', 'utf8')).rows,
];
const out = [];
for (const item of dataset.cases) {
  const artifact = rows.find(r => r.caseId === item.caseId);
  if (artifact?.status !== 'ACQUIRED') { out.push({ caseId: item.caseId, error: 'not acquired' }); continue; }
  const { stdout } = await run(process.env.PYTHON_COMMAND ?? 'python', ['scripts/parse_pymupdf.py', artifact.path], { maxBuffer: 25 * 1024 * 1024, timeout: 120000 });
  const parsed = { ...JSON.parse(stdout), format: 'pdf', url: item.source.pdfUrl };
  const facts = extractResearchFacts(parsed);
  out.push({
    caseId: item.caseId,
    sectionCount: parsed.sections?.length ?? 0,
    candidates: facts.map(f => ({ predicate: f.predicate, value: f.value, section: f.locator?.section, page: f.locator?.page ?? null, rawEvidence: f.rawEvidence.slice(0, 300) })),
  });
  console.error(item.caseId, facts.length, 'facts');
}
writeFileSync('evals/results/v5-candidate-probe.json', JSON.stringify(out, null, 1) + '\n');
console.log('probe written');
