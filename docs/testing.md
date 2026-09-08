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
| Extraction is measured, honestly | Scoped canonical fact benchmark: `evals/results/v5-scoped-fact-baseline-*.json` F1 0.875 (precision 0.778, recall 1.0; LOPO F1 0.889); `evals/results/research-tasks-baseline-v1-*.json`: locator accuracy 1.0, fabricated-answer rate 0.067; real-source task evaluation `evals/results/real-source-v4-development-*.json`: answer correctness 0.889, fabricated 0; `evals/results/real-source-v5-holdout-*.json` (frozen 20-case holdout): answer correctness 1.0 over 40 tasks, fact recall 1.0, fabricated 0 | These are *task-level* and *scoped canonical fact* metrics — see [metric semantics](#metric-semantics). Cross-predicate exhaustive candidate-fact precision is much lower (0.134 on v4 dev; 0.563 on the v5 holdout) because the extraction layer is deliberately high-recall and emits candidate facts; it is recorded, not hidden |
| PDF parsing fidelity is measured, not just health-checked | `evals/results/pdf-gold-fidelity-*.json` over the frozen `pdf-gold-v1` set (26 real papers, gold from versioned arXiv metadata): GROBID title token F1 0.976 (exact 0.885), author recall 0.774 / precision 0.825, abstract token F1 0.957, zero request errors; shipped PyMuPDF pipeline abstract first-page coverage 0.943 | Gold measures header fields only; section headings and reference counts are cross-parser descriptive statistics. The PyMuPDF path does not attempt title/author extraction and is recorded as such, not scored as failure |
| Generalizes to unseen real papers across domains | `evals/results/real-source-v5-holdout-*.json`: 20 frozen holdout cases (ML, systems, biology, medicine, physics, social science; obscure/recent/old; with/without repositories), 40 tasks: answer correctness 1.0, evidence source accuracy 1.0 (substantive tasks), fabricated answers 0 | Out-of-domain cases probe the refusal path and correctly return UNKNOWN; holdout was not used for tuning; one support-status miss (v5-rwkv-task-1) is disclosed in the result and in the claims below |

## Metric semantics

Two precision numbers appear in the evidence and measure different layers. Both are correct; they are not contradictory.

- **Scoped canonical fact benchmark** (`v5-scoped-fact-baseline-*`, F1 0.875): scores extraction+normalization against a scoped gold — the canonical `predicate: value` facts a paper states within the annotated predicate scope. Precision 0.778 asks: of the facts the extractor emits in scope, how many are canonical?
- **Cross-predicate exhaustive candidate-fact precision** (`real-source-*` `factMetrics.precision`: 0.134 on v4 dev, 0.563 on the v5 holdout): scores *every distinct* `predicate: value` candidate the extractor emits, across all predicates, against the paper's full fact inventory. The extraction layer is deliberately high-recall — it emits many candidates (including mentions in related-work and reference titles that pass validation) so answer assembly has material to work with. Over-emitted candidates count against this precision even when final answers are unaffected.

This is why final-answer metrics stay high (answer correctness 1.0 on the v5 holdout, fabricated answers 0) while exhaustive candidate precision is moderate: the answer-assembly and evidence-selection layers consume the candidate pool and are measured separately. When citing OpenPapers extraction quality, use the metric that matches the layer being discussed and name it explicitly.

## Scale experiment (post-release, not a release claim)

`evals/results/scale-experiment-*.json` runs the full real-source pipeline (acquire → parse → extract → answer/refuse) over 100 arXiv papers auto-sampled across 15 categories (in-domain and out-of-domain, 1997–2026). With no hand-annotated gold, it measures pipeline behavior, not accuracy. The committed pre-hardening run recorded 99/100 acquired, 0 parse failures, 158/158 refusal probes returning UNKNOWN with 0 fabricated answers, and a manual seeded 25-candidate audit precision estimate of 0.28 (Wilson 95% CI 0.14–0.48). Post-hardening runs must be compared as separate artifacts with their commit and environment; this experiment is not comparable to hand-annotated benchmarks and does not alter the 1.0.0 claim without review.

## Known unmeasured areas

- Live ranking beyond top-10, across regions, providers outage patterns, and long time spans (mitigated, not eliminated, by the scheduled CI live eval).
- Semantic embedding retrieval quality: the bundled fallback is a deterministic token-hash retriever, not a semantic embedder, and no embedding backend has been benchmarked (see [limitations](limitations.md)).
- GROBID fidelity beyond the header fields scored in `pdf-gold-fidelity-*`: table/equation/caption structure is not gold-scored, and fidelity is measured on arXiv-style papers only.
- Provider quota behavior under sustained load with API keys.

## Offline fixture mode

`OPENPAPERS_FIXTURE_PROVIDERS=1` replaces every provider (scholarly, GitHub, Hugging Face) and the paper acquirer with deterministic offline fixtures (`src/testing/fixtures.ts`). It exists for the L2 process suites and doubles as an offline demo mode; it is not a data source and never represents live provider behavior.
