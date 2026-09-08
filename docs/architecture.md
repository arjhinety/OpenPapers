# OpenPapers architecture and roadmap

## Current vertical slice

The MCP v2 `McpServer` factory registers typed tools. `serveStdio` serves local MCP clients. `createMcpHandler` plus `toNodeHandler` provides stateless Streamable HTTP. ResearchService executes bounded provider calls, reconciles DOI/arXiv identity before metadata fallback, merges source versions, ranks deterministically, persists metadata in SQLite FTS5, and creates citation-linked evidence.

## Phase plan

### Phase 1 — Citation policy and integrity foundation (complete)
- Adopt `OpenPapers` naming everywhere.
- Add citation-integrity data types and validator: factual output must reference existing evidence IDs, sources, authors, and claimed locators.
- Add tests for unsupported claims, missing evidence, and valid cited responses.
- No external API keys required; use deterministic fixtures.
- Acceptance: citation objects preserve source metadata and locators; MCP responses are rejected when evidence is absent, unresolved, metadata-mismatched, or not cited in the human-readable summary.

### Phase 2 — Reliable retrieval infrastructure
- Add shared in-memory response caching with TTL and concurrent request deduplication, with authorization/cache-control safety.
- Add FIFO process-wide cumulative rate limiting, bounded retries for 429/5xx and transient network failures, and numeric/HTTP-date `Retry-After` handling.
- Add provider failure telemetry and expose reliability counters in research transparency.
- Acceptance: Phase 2 reliability infrastructure is complete for current external providers; durable cache backends and richer per-provider latency histograms remain future optimizations.
- Add year/author/venue/topic filtering and query transparency.

### Phase 3 — OpenAlex and ecosystem discovery
- Add OpenAlex scholarly metadata, author IDs, and topic enrichment.
- Add static GitHub adapter with evidence-graded attribution classification and commit SHAs.
- Add Hugging Face models, datasets, cards, revisions, and paper links with local scholarly reconciliation.
- Add revision-pinned repository config discovery and conservative scalar/section parameter extraction without executing repository code.
- Acceptance: Phase 3 ecosystem discovery is complete; deeper paper ingestion, citation graphs, and execution-backed reproducibility remain later phases.

### Phase 4 — Semantic Scholar and citation graph (complete)
- Add Semantic Scholar after API-key approval, with paper lookup, references, citations, related works, author resolution, and caching.
- Implemented: typed Semantic Scholar references/citations/recommendations/author endpoints, provider mapping, shared reliability integration, service graph responses, MCP graph tools, and deterministic fixture coverage.
- Implemented: graph nodes/evidence are persisted through the existing SQLite boundary, graph edges are deduplicated by source/target/relation/provider, and duplicate-work metadata disagreements are exposed as structured transparency conflicts.
- Implemented: graph nodes carrying a known DOI or arXiv identifier resolve to an existing canonical SQLite work identity before edge persistence, preventing provider-specific duplicate nodes.
- Implemented: OpenAlex references and reverse-citation edges are retrieved through `referenced_works` and `filter=cites:` and merged with Semantic Scholar candidates when an OpenAlex root identity is available; partial provider failures remain explicit.
- Implemented: graph edges persist a conservative relationship class (`FOUNDATIONAL_CANDIDATE`, `FOLLOW_UP_CANDIDATE`, `DIRECT`, or `UNKNOWN`) with a migration for existing SQLite databases; labels are candidates, not unsupported causal claims.
- Implemented: combine Semantic Scholar/OpenAlex graph data with DOI/arXiv/publication-lineage reconciliation.
- Implemented: conservative foundational/follow-up candidate labels and edge-level conflict-aware graph provenance.
- Phase 4 acceptance: deterministic graph, persistence, provenance, and failure-transparency coverage is complete; live provider smoke checks are optional and environment-dependent.

### Phase 5 — Structured paper ingestion
- Implemented first slice: `PaperAcquirer` provides bounded byte-preserving HTTP acquisition with HTTP(S)-only validation, private/local host rejection, redirect revalidation and limits, timeout cancellation, declared-size checks, and streamed body limits.
- Implemented second slice: format detection recognizes HTML/PDF/unknown content; dependency-free HTML parsing extracts the document title, heading-based sections, normalized paragraph text, and reference links. PDF parsing is provided by the GROBID-first parser chain; unknown binary inputs fail explicitly.
- Implemented third slice: `GrobidClient` posts bounded PDF bytes to GROBID’s `/api/processFulltextDocument` endpoint and parses returned TEI; `PdfParserChain` optionally falls back to configured PyMuPDF and Docling command adapters while preserving warnings and parser provenance.
- Implemented fourth slice: the TEI parser tracks page-break number/ID metadata, nested division depth, page-aware sections, and page-aware search chunks.
- Implemented fifth slice: GROBID TEI extraction preserves equations, figure captions, table captions/content, and appendix sections in typed fields.
- Implemented sixth slice: bibliography records preserve source identifiers and normalized metadata; figure/table records inherit page locators from the nearest preceding TEI page break.
- Implemented seventh slice: tables preserve row/cell structure and body `<ref>` elements become explicit citation links to bibliography IDs with section/page provenance.
- Implemented eighth slice: parsed rich elements are indexed as typed search chunks, allowing element-aware queries across sections, equations, figures, tables, and references.
- Implemented ninth slice: in-text citation targets are checked against bibliography IDs and unresolved targets remain explicit parser warnings rather than being silently discarded.
- Implemented tenth slice: parsed documents are persisted by URL/content hash; unchanged inputs reuse parsed output, while changed inputs are reparsed.
- Implemented eleventh slice: archive/compressed acquisition is rejected before parsing, body streaming remains under timeout, and fallback subprocess outputs are bounded, timed, injected for tests, and schema-validated.
- Implemented: bounded PDF/HTML acquisition with SSRF, size, timeout, redirect, archive/compression, and path protections.
- Parse page boundaries, section hierarchy, paragraphs, equations, tables, figure captions, appendices, and references (GROBID-backed fields implemented; deeper layout fidelity remains dependent on TEI content).
- Implemented: bounded `read_paper` MCP acquisition/parsing and `search_within_paper`; matches carry stable URL, section heading/level, page number/ID when supplied by GROBID, chunk ordinal, and chunk ID provenance.

### Phase 6 — Evidence-backed extraction — COMPLETE
- Completed graph relationship refinement using explicit provider lineage metadata and deterministic/in-process verification. Live HTTP graph behavior remains an environment-dependent release gate and is not asserted by the credential-free suite.
- Implemented first slice: deterministic section-heading and structured-equation extraction is exposed through `ResearchService.extractPaperFacts` and the bounded `extract_paper_facts` MCP tool. Results are explicitly heuristic and carry URL/section/page locators.
- Implemented second slice: heuristic facts normalize into stable derived claims; SQLite persists claims and conflict records, and `extract_paper_claims` exposes the reconciled result through MCP.
- Implemented third slice: explicit training parameter extraction recognizes labeled numeric and optimizer values without inferring unlabeled numbers, and exposes section/page provenance through `extract_training_parameters`.
- Implemented fourth slice: graph classification accepts explicit provider relation metadata, rejects contradictory metadata, and exposes `relationshipBasis` in graph responses.
- Implemented fifth slice: added the provider-independent async `PaperExtractor<T>` contract, deterministic implementation, and injectable service execution seam.
- Implemented sixth slice: claims now carry full persisted `Evidence` records, explicit parameters project into typed partial recipes, and live HTTP MCP initialization/tool discovery/graph failure transparency were verified.
- Completed deterministic heuristic extraction for methodology, losses, equations, datasets, training stages, hyperparameters, benchmarks, and limitations.
- Completed claim/evidence persistence and conflict detection.
- Completed the optional provider-independent extractor interface; an LLM implementation remains an external integration choice, not a Phase 6 backlog item.

### Phase 7 — Research tools — COMPLETE
- Implemented `get_references`, `get_citations`, `get_related_papers`, `research_method`, `find_implementations`, `get_repository_config`, `find_datasets`, and `find_models`. `research_method` reuses bounded multi-provider search while preserving evidence, conflicts, and provider failures.
- Implemented `compare_papers`, `compare_methods`, and `verify_claim` with bounded inputs, direct metadata/search evidence, explicit overlap/difference reporting, conservative claim verification, and `UNKNOWN` benchmark comparability when aligned benchmark evidence is absent. The complete public Phase 7 tool inventory is covered by a registration regression test.
- Extended ecosystem MCP responses with formal evidence records for GitHub implementation searches, Hugging Face models/datasets, and repository configuration discovery/reads, retaining revision, commit, blob, path, and URL provenance while keeping implementation status conservative.
- Strengthened `verify_claim` to inspect persisted claim conflicts, return `CONTRADICTED` when applicable, and expose both sides' deduplicated evidence; claims without independent verification remain `UNKNOWN`.
- Made `compare_methods` provider-independent by matching overlap first on normalized DOI, then arXiv ID, then canonical title/author metadata rather than provider-local paper IDs.
- Added MCP boundary regressions for `compare_papers` and `verify_claim`, including citation-integrity validation, structured comparison evidence, status, and conflict serialization.

### Phase 8 — Reproducibility and reports
- Phase 8 is complete for the implemented deterministic scope: training-recipe extraction, paper-vs-code conflict reporting, research reports, reproducibility/implementation modes, timelines, and separated facts/recommendations.
- Metadata-backed generated responses use the shared citation-integrity gate; URL-based heuristic extraction responses use the extraction-specific evidence contract because author metadata is unavailable and must not be fabricated.
- Training recipes now project deterministic methodology, loss/objective, dataset, and explicit parameter facts from one parsed document, preserving derived evidence and leaving absent fields `NOT_REPORTED`.
- Added bounded `build_research_report` service/MCP support with `literature_review`, `implementation`, and `reproducibility` modes; cited facts, recommendations, and year-sorted paper timelines are separate fields.
- Added deterministic paper-versus-code reproducibility comparison for explicit numeric recipe fields, preserving paper source URLs and revision-pinned code line locators; absent values remain unavailable rather than conflicts.

### Phase 9 — Library and release engineering (complete)
- Implemented local library, collections, ResearchPacks, refresh/remove tools, migrations, PostgreSQL/pgvector adapter, vector-retrieval interface, Docker hardening, and release documentation.
- Implemented real-paper integration fixtures and end-to-end Qwen/tool-calling workflow tests.
- Phase 9 is complete: SQLite-backed named collections with deterministic IDs, idempotent paper membership, service validation, bounded MCP collection operations, provider-aware refresh, deterministic ResearchPack export/import, schema migration tracking, hardened Docker runtime ownership/health gating, PostgreSQL/pgvector persistence, a deterministic injectable vector-retrieval interface, real-paper fixtures, Qwen workflow coverage, and release/deployment documentation.

### Phase 10 — Maintainability, modularity, and contributor audit (complete)
- Review every current subsystem: domain models, provider adapters, rate limiting, caching boundaries, persistence, research orchestration, citation validation, MCP transports, and tool modules.
- Identify oversized modules, duplicated policy, hidden coupling, unclear public contracts, and provider-specific behavior leaking into shared layers.
- Define and document stable extension interfaces for providers, fetchers, storage backends, extractors, ranking strategies, provenance validators, and MCP tool modules.
- Split or refactor modules where doing so improves independent testing, contributor ownership, failure isolation, or future replacement; avoid abstraction without a concrete seam.
- Add contract tests and fixture conventions for provider and tool-module contributors.
- Add dependency-direction checks so transports depend on application services, application services depend on domain contracts, and providers do not depend on MCP handlers.
- Audit public MCP tool schemas for naming consistency, bounded inputs, backward compatibility, structured errors, and provenance completeness.
- Improve contributor ergonomics: subsystem map, examples, local live-test instructions, debugging guidance, issue templates, and focused contribution tasks.
- Review CI for deterministic tests, optional credential-free integration tests, lint/build/test gates, and security checks.
- Produce a maintainability report with prioritized follow-up issues and a documented decision log for intentional non-modular areas.
- Implemented `npm run architecture-check`, which audits dependency direction and the complete public MCP registration inventory. Added the maintainability report in `docs/maintainability.md`, contributor extension guidance, and CI coverage for the architecture gate.
- Phase 10 acceptance: provider and MCP registration seams are documented and checked; new providers/tools can be fixture-tested and registered without transport changes. Remaining modularity items are explicitly recorded as non-blocking optimizations in the maintainability report.

## Deferred roadmap items

### Retrieval identity and exact-title ranking

- Improve title-query retrieval for canonical works such as `Attention Is All You Need` so an exact-title request preferentially returns the identifier-resolved 2017 arXiv record rather than same-title or misleading metadata records.
- Add provider-native identifier expansion/probing for exact scholarly identifiers when title search does not return a canonical match.
- Add deterministic ranking signals for exact normalized title, canonical identifier agreement, publication-year consistency, author overlap, and provider confidence; keep conflicting records visible instead of silently replacing them.
- Add live and fixture regressions for title-only, punctuation/case variants, same-title conflicting records, missing-provider results, and fallback lookup through `1706.03762`.
- Acceptance: title search either ranks the canonical record first when available or clearly reports that canonical identity was not resolved; identifier fallback finds the record; evidence, references, URLs, and transparency remain internally consistent; provider failures remain explicit.

## Phase 1 implementation scope

Phase 1 deliberately does not require external provider credentials. It establishes the invariant that makes later retrieval and extraction safe: no material research assertion leaves the service without resolvable evidence. The machine-enforced boundary is the citation-integrity validator.
