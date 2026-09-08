import { readFileSync, writeFileSync } from 'node:fs';

// Builds the frozen PDF fidelity gold set (evals/datasets/pdf-gold-v1.json).
// Gold metadata comes from the versioned arXiv abstract page for the exact
// pinned version of each paper, so it is independent of both PDF parsers
// under comparison (GROBID and the shipped PyMuPDF pipeline).

const dataset = JSON.parse(readFileSync('evals/datasets/research-real-v5.json', 'utf8'));
const rows = [];
for (const item of dataset.cases) {
  const { arxivId, arxivVersion, absUrl } = item.source;
  const url = `${absUrl}`;
  const html = await (await fetch(url, { signal: AbortSignal.timeout(30_000) })).text();
  const title = html.match(/<h1 class="title mathjax">[\s\S]*?<span class="descriptor">Title:<\/span>([\s\S]*?)<\/h1>/)?.[1]?.replace(/\s+/g, ' ').trim();
  const authorsBlock = html.match(/<div class="authors">([\s\S]*?)<\/div>/)?.[1] ?? '';
  const authors = [...authorsBlock.matchAll(/<a href="[^"]*"[^>]*>([^<]+)<\/a>/g)].map(m => m[1].replace(/\s+/g, ' ').trim());
  const abstract = html.match(/<blockquote class="abstract mathjax">[\s\S]*?<span class="descriptor">Abstract:<\/span>([\s\S]*?)<\/blockquote>/)?.[1]?.replace(/\s+/g, ' ').trim();
  const dateline = html.match(/<div class="dateline">([\s\S]*?)<\/div>/)?.[1]?.replace(/\s+/g, ' ').trim();
  if (!title || !abstract || !authors.length) throw new Error(`incomplete gold metadata for ${item.caseId} (${title ? 'title ok' : 'NO TITLE'}, ${authors.length} authors, ${abstract ? 'abstract ok' : 'NO ABSTRACT'})`);
  rows.push({ caseId: item.caseId, arxivId, arxivVersion, url, title, authors, abstract, dateline });
  console.error(item.caseId, 'ok', authors.length, 'authors');
}
const gold = {
  version: 'pdf-gold-v1',
  status: 'frozen',
  annotationPolicy: 'Gold title/author/abstract metadata scraped from the versioned arXiv abstract page for each pinned paper version; independent of both parsers under comparison. Page counts come from the PDF structure itself (fitz page_count).',
  rows
};
writeFileSync('evals/datasets/pdf-gold-v1.json', JSON.stringify(gold, null, 1) + '\n');
console.log('gold written:', rows.length, 'papers');
