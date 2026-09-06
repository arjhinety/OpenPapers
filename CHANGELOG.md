# Changelog

## 1.0.0 - 2026-09-05

First stable release. Consolidates the parallel research lines (v4 candidate-evidence audit and repository evidence pipeline; v5 production fact extraction) into one codebase, with the full credential-free suite green and release evaluations re-run and recorded at the release commit.

- Added the production fact extraction pipeline (`src/extraction/facts.ts`) with candidate validation diagnostics and a rejection-reason taxonomy.
- Added real-PDF fact extraction and evidence span recovery (v5.3 / v5.3.1) with recorded evaluation checkpoints.
- Added the `reconstruct_research` MCP tool (37 bounded tools total).
- Added explicit ordered SQLite migrations with legacy upgrade coverage.
- Added shared storage contracts and an injected Postgres query boundary.
- Added a bounded paper-style HTML fixture covering parsing, extraction, claims, parameters, recipes, and persistence.
- Added deterministic model-style MCP workflow tests.
- Added `scripts/mcp-benchmark.mjs` for repeatable MCP control-plane latency measurements.
- Added `RELEASE_CHECKLIST.md` with automated, runtime, provenance, and benchmark gates.
- Documented the first research deployment: OpenPapers acts as OpenGrad's first-level research server, providing just-in-time bounded scholarly retrieval instead of speculative bulk paper downloads.
- Release evaluations recorded at the release commit (`evals/results/*-972a15f7268b*.json`): retrieval Recall@1 0.420 / Recall@5 0.750 / Recall@10 0.856 / MRR 0.773 over 44 queries with identity accuracy 1.0 over 119 cases (false merge 0, false split 0); frozen retrieval holdout Recall@1/5/10 1.0 (5 queries); v5 scoped fact baseline precision 0.778 / recall 1.0 / F1 0.875 (LOPO F1 0.889); 15-task end-to-end research benchmark with locator accuracy 1.0, conflict detection precision/recall 1.0, and fabricated-answer rate 0.067; real-source v4 development split answer correctness 0.889 with locator accuracy 1.0 and fabricated-answer rate 0; real-PDF development corpus parse success 0.923 (PyMuPDF).
- Runtime gates re-verified: Compose stack healthy (PostgreSQL/pgvector, GROBID alive, non-root application), adversarial MCP smoke passed (37 tools), and a 30-run control-plane benchmark completed with HTTP 200 responses (medians: initialize 8.01 ms, tools/list 8.81 ms, tools/call 6.92 ms).
- Full QA program per [docs/testing.md](docs/testing.md): 37-tool behavioral matrix; spawned-process end-to-end suites over stdio and HTTP; SQLite close/reopen persistence; automated Docker runtime gate with container-restart persistence (`scripts/docker-e2e.mjs`); live-provider reliability evaluation (30 recorded gold cases: title-exact Recall@10 1.0, identifier resolution 1.0, identity correctness 1.0, zero silent failures; fuzzy discovery 0.5 recorded and scoped); identifier-shaped query probing with arXiv-minted DOI routing; scheduled live-provider CI job; coverage reporting; and Postgres service-level round-trip integration.

## 0.1.0

The 0.1.0 baseline includes provenance-first paper acquisition, structured reading, GROBID PDF extraction, claims and evidence, ecosystem/reproducibility research tools, collections, ResearchPacks, refresh, vector retrieval seams, and Docker HTTP deployment.
