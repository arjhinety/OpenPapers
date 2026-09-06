# Release checklist

Use this checklist for a release candidate. Mark items only after running them against the current checkout and record environment-dependent evidence in the release notes.

## Automated gates

- [x] `npm ci --no-audit --no-fund`
- [x] `npm run lint`
- [x] `npm run architecture-check`
- [x] `npm run build`
- [x] `npm test`
- [x] `npm run check`
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

Latest verification: Compose configuration/build/start passed; all three services became healthy; GROBID returned `true`; MCP initialize, `tools/list` (36 tools), adversarial search/lookup, and create/list collection read-after-write passed; the application ran as `uid=1000(node)`; `/app/data` was writable; pgvector was present; and the 30-run benchmark completed with HTTP 200 responses. Benchmark medians were initialize 21.83 ms, `tools/list` 16.22 ms, and `tools/call` 13.02 ms.

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
- [x] Version metadata is consistent between `package.json` and `package-lock.json` (`0.1.0`, Apache-2.0, Node.js >=22.5).
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
