# Test plan and quality gates

This document defines what the OpenPapers test program covers, what each gate proves, and which recorded evidence backs every public claim a release makes. Evidence files are committed under `evals/results/` with their producing commit and timestamp; tests run deterministically and credential-free unless marked live.

## Test levels

| Level | Gate | Command | What it proves |
|---|---|---|---|
| L0 Static | types, architecture, tool inventory | `npm run lint`, `npm run architecture-check` | Type safety, MCP↛provider layering, exactly the registered tool surface |
| L1 Offline integration | full Vitest suite | `npm run check` | Unit and service-level behavior: identity reconciliation, ranking, extraction, storage, transports (in-process), adversarial flows |
| L2 Process E2E (offline) | spawned-server suites | `npm run test:e2e` | The real `dist/mcp/server.js` process over stdio and HTTP: handshake, 37-tool surface, tool calls, error paths, graceful shutdown, port release; SQLite persistence across close/reopen |
| L3 Live providers | recorded reliability eval | `npm run test:live` (scheduled CI + manual) | Real arXiv/Crossref/OpenAlex/Semantic Scholar behavior: live recall, identity correctness, transparent failure surfacing |
| L4 Runtime | container lifecycle | `npm run test:docker` | Compose stack up/wait, 37 tools over a real socket, persistence across container restart, GROBID health, adversarial smoke, latency benchmark |

## Tool coverage

All 37 registered MCP tools have behavioral tests at the handler boundary (`tests/tools-matrix.test.ts`, 31 cases) including documented failure paths (`get_paper` NOT_FOUND, `import_research_pack` rejection, `verify_claim` absence, `vector_search` without a retriever). Registration, schema, and naming are asserted by `tests/mcp-contracts.test.ts` and `scripts/verify-architecture.mjs`.

## 1.0 acceptance gates

- `npm run check` green on Node 22 and 24 (L0+L1).
- `npm run test:e2e` green (L2): stdio, HTTP, SQLite restart.
- `npm run test:docker` green with the persistence step passing (L4); evidence in `evals/results/docker-e2e-*.json`.
- Live thresholds met (L3) in the recorded result: title-exact Recall@10 ≥ 0.9, identity correctness ≥ 0.95, zero-result-with-no-reported-failure = 0. Evidence: `evals/results/live-search-reliability-*.json`.

## Claims matrix

| Public claim | Evidence (committed) | Scope and honest limits |
|---|---|---|
| Ranking and identity work deterministically offline | `evals/results/baseline-v1-*.json`: Recall@10 0.856, MRR 0.773 over 44 queries; identity accuracy 1.0 over 119 cases, false merge/split 0; `evals/results/retrieval-holdout-*.json`: Recall@1/5/10 1.0 (5 frozen queries, never used for tuning) | Fixture corpus; numbers are not comparable across datasets |
| Search finds known works reliably | `evals/results/live-search-reliability-*.json`: title-exact Recall@10 1.0 (16 cases), identifier resolution 1.0 (8 cases: arXiv id, URL, DOI, doi.org URL forms) | 30-case run from one network region at one timestamp; fuzzy discovery Recall@10 0.5 is recorded as discovery quality, not a guarantee (see [limitations](limitations.md)) |
| Identity is never fabricated | Live identity correctness 1.0; `tests/identifier-probe.test.ts`; citation-integrity validation in the tool boundary; `tests/adversarial/full-flow.test.ts` | Heuristic extraction remains derived evidence, not verification |
| Provider failures are surfaced, never silent | Live `zeroResultWithNoFailureReportedRate` 0; `evals/results/provider-degradation-*.json` (offline injected outages); per-case `providerFailures` in every live result row | Failure contents depend on provider responses; anonymous access degrades more than keyed access |
| Every tool behaves per contract | `tests/tools-matrix.test.ts` (37/37) + `tests/mcp-contracts.test.ts` | Exercised with fixture providers over an in-memory database |
| The server runs as a real process | `tests/e2e/stdio.e2e.test.ts`, `tests/e2e/http.e2e.test.ts` (handshake, tools/list, tool calls, invalid-tool errors, shutdown, port release) | Fixture-provider mode for determinism; live providers exercised at L3 |
| Data survives restarts | `tests/e2e/sqlite-restart.test.ts`; `scripts/postgres-integration.mjs` (`serviceRoundTrip`); docker-e2e persistence step | SQLite default path and PostgreSQL path both covered |
| The container stack is deployable and healthy | `evals/results/docker-e2e-*.json`: compose up --wait, 37 tools over HTTP, collection survives `compose restart`, GROBID isalive, adversarial smoke, benchmark medians | Control-plane benchmark numbers are not provider/PDF throughput |
| Extraction is measured, honestly | `evals/results/v5-scoped-fact-baseline-*.json` F1 0.875 (LOPO 0.889); `evals/results/research-tasks-baseline-v1-*.json`: locator accuracy 1.0, fabricated-answer rate 0.067; `evals/results/real-source-v4-development-*.json`: answer correctness 0.889, fabricated 0 | Fact precision against exhaustive gold is low (0.134 on v4 dev) and recorded as such |

## Known unmeasured areas

- Live ranking beyond top-10, across regions, providers outage patterns, and long time spans (mitigated, not eliminated, by the scheduled CI live eval).
- Live GROBID parse fidelity (health-gated only; PyMuPDF path is measured at 0.923 parse success on the real corpus).
- Semantic embedding retrieval quality: the bundled fallback is a deterministic token-hash retriever, not a semantic embedder.
- Provider quota behavior under sustained load with API keys.

## Offline fixture mode

`OPENPAPERS_FIXTURE_PROVIDERS=1` replaces every provider (scholarly, GitHub, Hugging Face) and the paper acquirer with deterministic offline fixtures (`src/testing/fixtures.ts`). It exists for the L2 process suites and doubles as an offline demo mode; it is not a data source and never represents live provider behavior.
