# Release checklist

Use this checklist for a release candidate. Mark items only after running them against the current checkout and record environment-dependent evidence in the release notes.

> **Current checkout status:** this document contains historical gate records for older commits. They are not evidence for the current HEAD. Before release, record `git rev-parse HEAD`, rerun every gate below, and attach artifacts whose filenames include that commit.
>
> **Latest clean release verification:** `npm run test:docker`, `npm run test:postgres`, and the frozen v5 holdout passed at the current release candidate. Artifacts are generated under `evals/results/` with the exact HEAD.
>
> **Evidence is committed, not ignored.** The 1.0.0 release commit added `evals/results/*.json` to `.gitignore` to keep the release tree clean. That silently withheld every subsequent artifact — 44 files, including the reruns this checklist cites — and contradicted [the test plan](docs/testing.md), whose claims matrix is headed "Evidence (committed)". The ignore rule is now scoped to `evals/results/scratch/`; put throwaway runs there and commit everything else. Artifacts whose anchor commit predates the 1.0.0 history squash are preserved by `evidence/<commit>` tags.

## Automated gates

- [x] `npm ci --no-audit --no-fund`
- [x] `npm run lint`
- [x] `npm run architecture-check`
- [x] `npm run build`
- [x] `npm test`
- [x] `npm run check`
- [x] `npm run test:e2e`
- [x] `npm run test:coverage`
- [x] `npm run test:package`
- [x] `npm run test:postgres`
- [x] `npm run test:docker`
- [x] `git diff --check`

## Documentation and security

- [x] README, provider documentation, configuration examples, and limitations match the implementation.
- [x] `.env.example` contains placeholders only.
- [x] No credentials, authorization headers, downloaded research data, or private repository content are present.
- [x] External provider failures and provenance behavior remain documented.
- [x] Direct dependency license metadata and upstream attribution documentation reviewed.
- [x] Apache-2.0 is selected and `LICENSE.md` is present; review third-party notices separately.

## Runtime gates

When Docker is available:

```sh
docker compose config -q
docker compose up -d --build --wait
docker compose ps
curl http://127.0.0.1:8070/api/isalive
node scripts/adversarial-mcp-smoke.mjs
MCP_BENCHMARK_RUNS=30 node scripts/mcp-benchmark.mjs
docker compose down
```

Verify MCP initialization, `tools/list`, at least one bounded `tools/call`, PostgreSQL/pgvector readiness, GROBID readiness, non-root application execution, and persistent data behavior. Control-plane benchmark results do not represent provider, PDF, GROBID, PostgreSQL, or model throughput.

Current verification: Compose configuration/build/start passed; all three services became healthy; GROBID returned `true`; MCP initialize, `tools/list` (37 tools), adversarial search/lookup, and create/list collection read-after-write passed; the application ran as `uid=1000(node)`; `/app/data` was writable; pgvector was present; and the 30-run benchmark completed with HTTP 200 responses.

- [x] Compose configuration and image build
- [x] PostgreSQL and GROBID health checks
- [x] MCP initialization, tool inventory, and bounded calls
- [x] Non-root runtime and writable persistent data path
- [x] PostgreSQL/pgvector extension and application read-after-write
- [x] 30-run MCP control-plane benchmark

## Data and migrations

- [x] SQLite migration tests pass and the migration ledger is idempotent.
- [x] PostgreSQL/pgvector schema and read-after-write behavior are verified for the Compose deployment.
- [x] ResearchPack import/export remains versioned, bounded, and deterministic.
- [x] Claims and evidence retain source provenance; unavailable values are not guessed.

## Publication state

- [x] Changelog is updated for the current unreleased baseline.
- [x] Version metadata is consistent across `package.json`, `package-lock.json`, `server.json`, `src/mcp/server.ts`, and the `CHANGELOG.md` head entry (`1.0.0`, Apache-2.0, Node.js >=22.5); enforced by `scripts/check-versions.mjs` in `npm run check`.
- [x] Git working tree is clean after the release checklist update and commit.

## 1.0.0 release verification (2026-09-05)

Re-run against the merged release candidate at commit `972a15f7268b50d0fa8b308841257cdecb24728d`:

- [x] `npm run check` (TypeScript check, architecture rules, production build, Vitest): 62 test files, 217 tests passed.
- [x] Release evaluations recorded in `evals/results/*-972a15f7268b*.json`; summary in `CHANGELOG.md`. Retrieval ranking matches the accepted R-001 state exactly; the holdout split was not used for tuning.
- [x] Runtime gates re-verified with Docker Compose: all three services healthy; GROBID `/api/isalive` returned `true`; MCP initialize, `tools/list` (37 tools), adversarial search/lookup, and create/list collection read-after-write passed; the 30-run benchmark completed with HTTP 200 responses. Medians: initialize 8.01 ms, `tools/list` 8.81 ms, `tools/call` 6.92 ms.
- [x] Version metadata consistent between `package.json` and `package-lock.json` (`1.0.0`, Apache-2.0, Node.js >=22.5).

## 1.0.0 QA program gates (2026-09-05)

Added by the [test plan](docs/testing.md); re-run against the final verified commit:

- [x] `npm run test:e2e`: 37-tool behavioral matrix plus spawned-process suites (stdio handshake through tool calls and invalid-tool errors; HTTP socket with origin validation and shutdown port release; SQLite close/reopen persistence).
- [x] `npm run test:docker`: compose stack with fixture providers, 37 tools over a real socket, collection survives `compose restart` (PostgreSQL), GROBID isalive, adversarial smoke, benchmark; evidence in `evals/results/docker-e2e-*.json`.
- [x] `npm run test:live` thresholds met: title-exact Recall@10 1.0 (16 cases), identifier resolution 1.0 (8 cases), identity correctness 1.0, zero-result-with-no-reported-failure 0; evidence in `evals/results/live-search-reliability-*.json`. Fuzzy discovery 0.5 recorded and scoped as discovery quality.
- [x] `npm run test:coverage` produces a v8 coverage report; `scripts/postgres-integration.mjs` includes the service-level round-trip (`serviceRoundTrip`).
- [x] Identifier-shaped queries probe arXiv/Crossref natively (`tests/identifier-probe.test.ts`); arXiv-minted DOIs (`10.48550/arXiv.*`) route to the arXiv probe rather than Crossref.

## 1.0.0 final release-candidate verification (2026-09-06)

Executed after the release-integrity pass (clean history, version alignment, holdout expansion, PDF fidelity gold set, metric-semantics documentation). All gates were run against commit `02c9ae4cf29fb4053ef4878a46954dfcee7c4e7a`; the release commit containing this checklist and the recorded evidence is its immediate successor. The delta between the two commits contains no shipped source changes: documentation, recorded evidence, the new `scripts/package-e2e.mjs` distribution gate, and a `.gitignore` entry. `npm run check` was additionally re-run at the release commit itself.

- [x] `npm run verify` (version-consistency gate, TypeScript check, architecture rules, production build, Vitest): 67 test files, 257 tests passed; versions consistent across 7 locations.
- [x] `npm run test:coverage`: v8 coverage report produced (67 files, 257 tests).
- [x] `npm run test:postgres`: rollback, identity migration, reconnect, vector search, and service-level round-trip passed (the service-level stores now initialize explicitly; this check previously failed on CI).
- [x] `npm run test:docker`: full compose E2E passed with evidence in `evals/results/docker-e2e-02c9ae4cf29f.json` (12/12 steps including collection survival across container restart and 30-run benchmark).
- [x] `npm run test:live` (strict): thresholds met — title-exact Recall@10 1.0, identifier resolution 1.0, identity correctness 1.0, zero silent failures; fuzzy discovery 0.5 recorded (out of the 1.0 contract per [limitations](docs/limitations.md)); evidence in `evals/results/live-search-reliability-02c9ae4cf29f.json`.
- [x] `npm run eval:real-v5-holdout`: frozen 20-case/40-task holdout — answer correctness 1.0, fact recall 1.0, fabricated answers 0, support-status accuracy 0.975 (single disclosed miss: `v5-rwkv-task-1`); evidence in `evals/results/real-source-v5-holdout-*.json`.
- [x] `npm run eval:pdf-gold`: PDF parsing fidelity over the frozen 26-paper `pdf-gold-v1` set; evidence in `evals/results/pdf-gold-fidelity-*.json`.
- [x] `npm run test:package`: pristine tarball install (`openpapers-1.0.0.tgz`), spawned installed binary over stdio, version match, 37 tools, search + collection + persistence across restart — passed for both the SQLite and PostgreSQL backends.
- [x] `npm pack --dry-run` and `npm audit --audit-level=high`: tarball builds; 0 vulnerabilities.
- [x] Version metadata consistent across `package.json`, `package-lock.json`, `server.json`, `src/mcp/server.ts`, and the `CHANGELOG.md` head (`1.0.0`), enforced by `scripts/check-versions.mjs`.
- [x] No GitHub release or npm publication existed before this freeze; the `v1.0.0` tag is created at the release commit at publication time.

## Post-release evidence audit (2026-09-12)

An audit of the shipped 1.0.0 tree found the release's own provenance chain broken in two ways, plus one gate that could not detect a meaningless run. No shipped source defect was found: `npm run check` is green (68 files / 273 tests) and the four discarded pre-release commits (`86d5d74bd798`, `e0dc8cadf997`, `eb7a024ea0d6`, `80e161773c6a`) were verified content-identical to `HEAD` apart from the README and the recall chart, so the history squash lost no work.

- [x] **Evidence was being withheld.** `.gitignore` was narrowed from `evals/results/*.json` to `evals/results/scratch/`, and the 44 previously-ignored artifacts are committed.
- [x] **Evidence anchors were unreachable.** 6 of 56 distinct commit pointers embedded in committed artifact filenames — including `02c9ae4cf29f` (live + docker), `9bd428b28017` (PDF gold), `685893d668e8` (v5 holdout), `bdc13787e834` (docker) — were dangling after the squash and absent from `origin`, so no clone could resolve them. Default gc would have pruned them around 2026-09-20. All 11 affected commits now carry pushed `evidence/<commit>` annotated tags.
- [x] **The live gate accepted an invalid run.** `evals/results/live-search-reliability-80e161773c6a.json` (2026-09-08, recorded at the commit titled *"docs: finalize release gate record"*) reported all thresholds met while every one of its 30 cases hit a provider failure (46 total) under sustained arXiv HTTP 429. All 8 identifier cases failed, giving identifier resolution **0.0** against 1.0 on 2026-09-06; live Recall@10 fell 0.9 → 0.6 and fuzzy 0.5 → 0.333. This is environmental, not a code regression — every failing case records `arXiv request failed: 429` — but nothing flagged the run as non-informative, and the numbers were never committed or recorded here. `run-live-search-reliability.mjs` now gates `identifierResolutionRate` (≥ 0.9) and checks run validity first, exiting `2` with `LIVE RUN INVALID` when more than half the cases hit provider failures. Artifact schema is now `openpapers.live-search-reliability.v2`. Replaying both recorded runs through the new logic: 2026-09-06 → exit 0; 2026-09-08 → exit 2.
- [x] **Repository identity had drifted.** The remote is `arjhinety/OpenPapers`, but `package.json` (`repository`, `homepage`, `bugs`, `mcpName`) and `server.json` (`name`, `repository.url`) still named `arrogance231`, leaving `mcpName` in an `io.github.<owner>` namespace that no longer matched repository ownership. All are now `arjhinety`; `scripts/check-versions.mjs` enforces identity consistency across package metadata, the server manifest, and README links so it cannot drift again.
- [x] **The recall chart hardcoded its numbers** while its footer cited `evals/results/baseline-v1` as the source. `scripts/plot-retrieval-recall.py` now derives Recall@1/5/10 and the query count from the newest baseline artifact by commit date, stamps the artifact name and commit into the footer, and labels its scope as the offline fixture corpus rather than presenting a bare 85.6%.
