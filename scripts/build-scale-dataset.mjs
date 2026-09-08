import { writeFileSync, readFileSync } from 'node:fs';

// Builds the research-scale-v1 corpus (>=100 arXiv papers) by querying the
// arXiv API per category. This is a scale experiment dataset, not a frozen
// benchmark: there is no hand-annotated gold. Candidate-fact precision is
// estimated by manual audit of a sample; see run-scale-experiment.mjs.

const existing = new Set([
  ...JSON.parse(readFileSync('evals/datasets/research-real-v5.json', 'utf8')).cases.map(c => c.source.arxivId),
]);
for (const v of ['v1', 'v2', 'v3', 'v4']) {
  for (const id of JSON.parse(readFileSync(`evals/datasets/research-real-${v}.json`, 'utf8')).cases.map(c => c.source.arxivId)) existing.add(id);
}

// [category query, count, sortOrder] — mix of in-domain (predicate-bearing) and
// out-of-domain (refusal-probe) areas, recent and older papers.
const plan = [
  ['cat:cs.LG', 16, 'descending'],
  ['cat:cs.CL', 12, 'descending'],
  ['cat:cs.CV', 8, 'descending'],
  ['cat:cs.DC', 8, 'descending'],
  ['cat:cs.IR', 6, 'descending'],
  ['cat:stat.ML', 5, 'descending'],
  ['cat:cs.LG', 10, 'ascending'],
  ['cat:cs.CL', 5, 'ascending'],
  ['cat:q-bio.QM', 6, 'descending'],
  ['cat:q-bio.NC', 3, 'descending'],
  ['cat:astro-ph.IM', 5, 'descending'],
  ['cat:physics.comp-ph', 4, 'descending'],
  ['cat:math.DS', 4, 'descending'],
  ['cat:econ.GN', 4, 'descending'],
  ['cat:cs.CY', 4, 'descending'],
];

async function fetchCategory(query, count, order, taken) {
  const url = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(query)}&sortBy=submittedDate&sortOrder=${order}&max_results=${count + 30}`;
  const xml = await (await fetch(url, { signal: AbortSignal.timeout(60_000) })).text();
  const out = [];
  for (const entry of xml.match(/<entry>[\s\S]*?<\/entry>/g) ?? []) {
    const rawId = entry.match(/<id>http:\/\/arxiv.org\/abs\/([^<]+)<\/id>/)?.[1];
    const id = rawId?.replace(/v\d+$/, '');
    const title = entry.match(/<title>([\s\S]*?)<\/title>/)?.[1];
    const published = entry.match(/<published>([^<]+)<\/published>/)?.[1];
    if (!id || !title) continue;
    if (existing.has(id) || taken.has(id)) continue;
    taken.add(id);
    out.push({ arxivId: id, title: title.replace(/\s+/g, ' ').trim(), published, category: query.replace('cat:', '') });
    if (out.length >= count) break;
  }
  return out;
}

const taken = new Set();
const papers = [];
for (const [query, count, order] of plan) {
  const batch = await fetchCategory(query, count, order, taken);
  papers.push(...batch);
  console.error(`${query} ${order}: ${batch.length}`);
  await new Promise(r => setTimeout(r, 3500));
}
console.error(`total selected: ${papers.length}`);
if (papers.length < 100) throw new Error(`only ${papers.length} papers selected`);

const dataset = {
  version: 'research-scale-v1',
  status: 'scale-experiment-no-gold',
  annotationPolicy: 'Scale experiment corpus auto-selected from the arXiv API across in-domain (cs.LG/CL/CV/DC/IR, stat.ML) and out-of-domain (q-bio, astro-ph, physics.comp-ph, math.DS, econ.GN, cs.CY) categories, recent and older halves. No hand-annotated gold: this dataset measures pipeline yield, identity resolution, answer/refusal behavior, and latency at scale. Candidate-fact precision is estimated by manual audit of a fixed random sample; results are not comparable to the hand-annotated research-real-v1..v5 benchmarks.',
  splitPolicy: { development: 'all cases (experiment run, not a frozen benchmark)', holdout: 'none', holdoutInfluencedTuning: false },
  cases: papers.map(p => ({
    caseId: `scale-${p.arxivId.replace(/[./]/g, '-')}`,
    split: 'development',
    title: p.title,
    category: p.category,
    published: p.published,
    source: {
      arxivId: p.arxivId,
      arxivVersion: '1',
      absUrl: `https://arxiv.org/abs/${p.arxivId}`,
      pdfUrl: `https://arxiv.org/pdf/${p.arxivId}`,
      paperRevisionDate: null, repositoryUrl: null, repositoryCommitSha: null, repositoryCommitDate: null,
      paperSha256: null, paperSha256Status: 'PENDING_ACQUISITION',
      artifactPolicy: 'cache_only_no_redistribution', temporalAlignment: 'UNKNOWN',
    },
    annotationScope: { sections: [], predicates: [], completeness: 'not_applicable_auto_generated' },
    facts: [], tasks: [],
  })),
};
writeFileSync('evals/datasets/research-scale-v1.json', JSON.stringify(dataset, null, 1) + '\n');
console.log('dataset written:', dataset.cases.length, 'cases');
