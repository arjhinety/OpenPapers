import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// PDF parsing fidelity evaluation against the frozen pdf-gold-v1 set.
// Gold title/authors/abstract come from versioned arXiv abstract pages and are
// independent of both parsers under comparison. This measures what the shipped
// parsers actually extract; it is a fidelity measurement, not a tuning gate.

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const grobidUrl = process.env.GROBID_URL ?? 'http://127.0.0.1:8070';
const dataset = JSON.parse(readFileSync(join(root, 'evals/datasets/research-real-v5.json'), 'utf8'));
const gold = JSON.parse(readFileSync(join(root, 'evals/datasets/pdf-gold-v1.json'), 'utf8'));
const acquisitions = [
  ...JSON.parse(readFileSync(join(root, 'evals/results/real-source-v5-acquisition-development.json'), 'utf8')).rows,
  ...JSON.parse(readFileSync(join(root, 'evals/results/real-source-v5-acquisition-holdout.json'), 'utf8')).rows,
];

const STOP = new Set(['a','an','the','of','in','on','for','and','or','to','with','by','from','as','at','is','are','was','were','be','been','that','this','these','those','we','our','it','its','their','his','her','not','but','using','based']);
const words = text => (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter(w => w.length > 2 && !STOP.has(w));
const f1 = (a, b) => { const A = new Set(a), B = new Set(b); if (!A.size || !B.size) return 0; const inter = [...A].filter(x => B.has(x)).length; return 2 * inter / (A.size + B.size); };
const surname = name => { const parts = name.trim().split(/\s+/); return parts[parts.length - 1].replace(/[^A-Za-z-]/g, '').toLowerCase(); };

async function grobidHeader(pdfPath) {
  const form = new FormData();
  form.append('input', new Blob([readFileSync(pdfPath)]), 'paper.pdf');
  const response = await fetch(`${grobidUrl}/api/processHeaderDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`GROBID header HTTP ${response.status}`);
  return response.text();
}
async function grobidFullText(pdfPath) {
  const form = new FormData();
  form.append('input', new Blob([readFileSync(pdfPath)]), 'paper.pdf');
  const response = await fetch(`${grobidUrl}/api/processFulltextDocument`, { method: 'POST', body: form, signal: AbortSignal.timeout(300_000) });
  if (!response.ok) throw new Error(`GROBID fulltext HTTP ${response.status}`);
  return response.text();
}
const tagText = (tei, tag) => {
  const match = tei.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`));
  return match ? match[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() : '';
};

const rows = [];
for (const item of dataset.cases) {
  const goldRow = gold.rows.find(r => r.caseId === item.caseId);
  const artifact = acquisitions.find(r => r.caseId === item.caseId);
  if (!goldRow || artifact?.status !== 'ACQUIRED') { rows.push({ caseId: item.caseId, error: 'missing artifact or gold' }); continue; }
  const started = Date.now();
  let headerError = null, fullTextError = null, teiHeader = '', teiFull = '', pymupdf = null;
  try { teiHeader = await grobidHeader(artifact.path); } catch (error) { headerError = String(error); }
  try { teiFull = await grobidFullText(artifact.path); } catch (error) { fullTextError = String(error); }
  try { pymupdf = JSON.parse(execFileSync(process.env.PYTHON_COMMAND ?? 'python', ['scripts/parse_pymupdf.py', artifact.path], { maxBuffer: 25 * 1024 * 1024, timeout: 120000 }).toString()); } catch (error) { pymupdf = { error: String(error) }; }

  const grobidTitle = tagText(teiHeader, 'title');
  const grobidSurnames = [...teiHeader.matchAll(/<persName>[\s\S]*?<surname>([\s\S]*?)<\/surname>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim().toLowerCase());
  const grobidAbstract = tagText(teiHeader, 'abstract');
  
  const grobidSectionHeadings = [...teiFull.matchAll(/<head[^>]*>([\s\S]*?)<\/head>/g)].map(m => m[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase()).filter(h => h && h.length < 120);

  const goldSurnames = goldRow.authors.map(surname).filter(Boolean);
  const grobidSurnameSet = new Set(grobidSurnames);
  const authorRecall = goldSurnames.length ? goldSurnames.filter(s => grobidSurnameSet.has(s)).length / goldSurnames.length : null;
  const authorPrecision = grobidSurnames.length ? [...grobidSurnameSet].filter(s => new Set(goldSurnames).has(s)).length / grobidSurnameSet.size : null;
  const grobidBiblioCount = (teiFull.match(/<bibl\b/g) ?? []).length;
  const firstPageText = pymupdf?.pages?.[0]?.text ?? '';
  const pymupdfAbstractRecall = (() => { const goldWords = words(goldRow.abstract); if (!goldWords.length) return null; const pageWords = new Set(words(firstPageText)); return goldWords.filter(w => pageWords.has(w)).length / goldWords.length; })();
  const pymupdfHeadings = (pymupdf?.sections ?? []).map(s => String(s.heading).toLowerCase());
  const headingSet = new Set([...grobidSectionHeadings.map(h => h.replace(/^\d+(\.\d+)*\s+/, '')), ...pymupdfHeadings.map(h => h.replace(/^\d+(\.\d+)*\s+/, ''))]);
  const headingOverlap = headingSet.size ? [...grobidSectionHeadings].filter(h => pymupdfHeadings.some(p => p.includes(h) || h.includes(p))).length / headingSet.size : null;

  rows.push({
    caseId: item.caseId,
    grobid: {
      titleExact: grobidTitle.toLowerCase() === goldRow.title.toLowerCase(),
      titleTokenF1: f1(words(grobidTitle), words(goldRow.title)),
      authorRecall, authorPrecision,
      abstractTokenF1: f1(words(grobidAbstract), words(goldRow.abstract)),
      referenceCount: grobidBiblioCount,
      sectionCount: grobidSectionHeadings.length,
      headerError, fullTextError,
    },
    pymupdf: {
      titleExact: false, titleTokenF1: 0,
      titleAttempted: false,
      abstractFirstPageTokenRecall: pymupdfAbstractRecall,
      authorExtracted: false,
      pageCount: pymupdf?.pages?.length ?? null,
      sectionCount: pymupdfHeadings.length,
      sectionHeadingOverlapWithGrobid: headingOverlap,
      error: pymupdf?.error ?? null,
    },
    goldPageCountIndependent: null,
    latencyMs: Date.now() - started,
  });
  console.error(item.caseId, 'done', `${Date.now() - started}ms`);
}

const numeric = (key, parser) => rows.filter(r => typeof r[parser]?.[key.split('.')[1] ?? key] === 'number').map(r => r[parser][key.split('.')[1] ?? key]);
const mean = values => values.length ? values.reduce((s, x) => s + x, 0) / values.length : null;
const aggregate = parser => ({
  titleExactRate: rows.filter(r => r[parser]?.titleExact).length / rows.length,
  meanTitleTokenF1: mean(rows.map(r => r[parser]?.titleTokenF1).filter(v => typeof v === 'number')),
  meanAuthorRecall: mean(rows.map(r => r[parser]?.authorRecall).filter(v => typeof v === 'number')),
  meanAuthorPrecision: mean(rows.map(r => r[parser]?.authorPrecision).filter(v => typeof v === 'number')),
  meanAbstractTokenF1: mean(rows.map(r => r[parser]?.abstractTokenF1).filter(v => typeof v === 'number')),
  meanAbstractFirstPageTokenRecall: mean(rows.map(r => r[parser]?.abstractFirstPageTokenRecall).filter(v => typeof v === 'number')),
  meanSectionHeadingOverlapWithGrobid: parser === 'pymupdf' ? mean(rows.map(r => r[parser]?.sectionHeadingOverlapWithGrobid).filter(v => typeof v === 'number')) : undefined,
  errors: rows.filter(r => r[parser]?.headerError || r[parser]?.fullTextError || r[parser]?.error).length,
});

const result = {
  schemaVersion: 'openpapers.pdf-gold-fidelity.v1',
  commit: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  goldSet: gold.version,
  paperCount: rows.length,
  grobidUrl,
  notes: [
    'Gold title/authors/abstract come from versioned arXiv abstract pages (independent of both parsers).',
    'The shipped PyMuPDF pipeline (scripts/parse_pymupdf.py) does not attempt title or author extraction (titleAttempted/authorExtracted=false); its title metrics are recorded as 0, not as extraction failures.',
    'Abstract is scored as token-F1 against gold for GROBID, and as first-page token coverage for the PyMuPDF pipeline because the shipped parser does not segment the abstract.',
    'Section headings and reference counts are descriptive cross-parser statistics, not gold-scored.',
  ],
  aggregate: { grobid: aggregate('grobid'), pymupdf: aggregate('pymupdf') },
  rows,
};
const out = join(root, 'evals/results', `pdf-gold-fidelity-${result.commit.slice(0, 12)}.json`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(result, null, 1) + '\n');
console.log(JSON.stringify({ output: out, paperCount: result.paperCount, aggregate: result.aggregate }, null, 2));
