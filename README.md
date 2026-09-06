<p align="center">
  <img src="assets/openpapers-icon.png" alt="OpenPapers icon" width="180">
</p>

<h1 align="center">OpenPapers</h1>

<p align="center">
  Provenance-first scholarly research infrastructure for Model Context Protocol clients.
</p>

<p align="center">
  <a href="https://github.com/arrogance231/openpapers/actions/workflows/ci.yml"><img src="https://github.com/arrogance231/openpapers/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
  <a href="LICENSE.md"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="Apache-2.0 license"></a>
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/node-%3E%3D22.5-339933.svg" alt="Node.js 22.5 or newer"></a>
</p>

OpenPapers is a Model Context Protocol (MCP) server for scholarly retrieval, paper ingestion, and reproducible research workflows. It preserves source identities, evidence, uncertainty, and provider failures instead of presenting generated output as verified research.

## What OpenPapers does

OpenPapers combines scholarly and developer sources through replaceable provider adapters. It treats downloaded papers and repository content as untrusted data and never executes them.

- Searches arXiv, Crossref, OpenAlex, and Semantic Scholar
- Preserves DOI, arXiv, OpenAlex, and Semantic Scholar identities during reconciliation
- Discovers citations, references, related papers, authors, repositories, models, and datasets
- Acquires bounded HTML and PDF content, with GROBID parsing and optional local fallbacks
- Extracts source-located facts, claims, conflicts, training parameters, and reproducibility reports
- Inspects revision-pinned GitHub configuration files without executing repository code
- Stores research in SQLite with full-text search (FTS5) or PostgreSQL with pgvector
- Manages collections, portable ResearchPacks, refresh operations, and vector retrieval
- Serves MCP over stdio or stateless Streamable HTTP

## Research deployment: first-level server for OpenGrad

OpenPapers serves as the first-level research server for [OpenGrad](https://github.com/arrogance231/OpenGrad), a provenance-first empirical study of tool-use post-training in small open-weight language models.

OpenGrad deliberately does not pre-download a fixed paper corpus: which papers matter only becomes clear once dataset materialization, training, and evaluation are underway. Instead of speculative bulk acquisition, OpenGrad queries OpenPapers on demand for search, bounded retrieval, and fact or training-parameter extraction, then records each result's source identity, revision, and locator in its verified bibliography before the evidence is used.

This keeps the OpenGrad repository small, avoids downloading papers that may never be needed, and still satisfies OpenGrad's provenance rules: every claim traces to a primary source with an explicit locator and uncertainty status. OpenGrad remains fully reproducible without OpenPapers; see [OpenGrad's boundary documentation](https://github.com/arrogance231/OpenGrad/blob/master/docs/research/OPENPAPERS.md).

## Supported sources

OpenPapers uses each provider for a defined part of the research workflow:

| Source | Role | Authentication |
| --- | --- | --- |
| [arXiv](https://arxiv.org/) | Preprint search and metadata | Not required |
| [Crossref](https://www.crossref.org/) | DOI and bibliographic metadata | Not required |
| [OpenAlex](https://openalex.org/) | Open scholarly metadata and citation relationships | Not required |
| [Semantic Scholar](https://www.semanticscholar.org/) | Paper metadata, authors, references, citations, and recommendations | Optional API key |
| [GitHub](https://github.com/) | Repository discovery, revisions, contents, and implementation evidence | Optional token; anonymous access is rate-limited |
| [Hugging Face](https://huggingface.co/) | Model and dataset discovery, cards, revisions, and paper links | Optional token |

Provider selection depends on the identifier, query, and available metadata. No provider is authoritative for every field.

## Choose a runtime

Choose a local Node.js installation or the complete Docker Compose stack:

- **Local runtime**: Node.js 22.5 or newer and npm
- **Container runtime**: Docker Engine with Compose support
- **Optional PDF parsing**: GROBID, PyMuPDF, or Docling
- **Optional persistent vector search**: PostgreSQL with pgvector

The container image uses Node.js 24. Docker Compose supplies PostgreSQL, pgvector, and GROBID.

## Install locally

Install the locked dependencies and compile the TypeScript source:

```sh
git clone https://github.com/arrogance231/openpapers.git
cd openpapers
npm ci
npm run build
```

Copy `.env.example` to `.env` if you want persistent SQLite storage or optional provider credentials:

```sh
cp .env.example .env
```

The example configuration stores SQLite data at `./data/research.sqlite`. OpenPapers otherwise uses an in-memory SQLite database when `RESEARCH_DB_PATH` is unset.

## Connect an MCP client

Use stdio for a local MCP client. The following `.vscode/mcp.json` example assumes the repository is your open VS Code workspace:

```json
{
  "servers": {
    "openpapers": {
      "type": "stdio",
      "command": "node",
      "args": ["./dist/mcp/server.js"]
    }
  }
}
```

Other MCP clients use the same command and script path, but their configuration keys may differ. Build the project before the client starts the server.

You can also run the stdio server directly for transport diagnostics:

```sh
npm start
```

## Run Streamable HTTP

Set `MCP_TRANSPORT=http` in `.env`, then start the server:

```sh
npm start
```

The default endpoint is `http://127.0.0.1:8787/mcp`. Keep it on loopback unless a trusted reverse proxy supplies authentication and Transport Layer Security (TLS).

To run the complete container stack instead, use:

```sh
docker compose up --build --wait
```

Docker Compose starts OpenPapers at `http://127.0.0.1:8787/mcp`, PostgreSQL with pgvector, and GROBID. Stop the stack with `docker compose down`; the named volumes remain available.

See [the installation guide](docs/installation.md) for deployment choices and [the configuration reference](docs/configuration.md) for every environment variable.

## MCP tools

OpenPapers registers 37 bounded tools. The inventory below matches the current server registration:

- **Retrieval**: `search_papers`, `get_paper`, `get_bibtex`, `research_method`, `research_topic`
- **Graphs**: `get_references`, `get_citations`, `get_related_papers`, `resolve_author`
- **Documents and extraction**: `read_paper`, `search_within_paper`, `extract_paper_facts`, `extract_paper_claims`, `extract_training_parameters`
- **Verification and reproducibility**: `extract_training_recipe`, `extract_training_recipe_from_url`, `build_research_report`, `compare_paper_to_code`, `compare_papers`, `compare_methods`, `verify_claim`, `reconstruct_research`
- **Developer ecosystem**: `find_implementations`, `find_models`, `find_datasets`, `find_repository_configs`, `get_repository_config`
- **Research library**: `create_collection`, `list_collections`, `add_paper_to_collection`, `remove_paper_from_collection`, `delete_collection`, `export_research_pack`, `import_research_pack`, `refresh_collection`, `refresh_paper`, `vector_search`

Tool inputs use bounded Zod schemas. Responses include readable MCP content and structured data where the contract supports it. Follow the [usage guide](docs/usage.md) for a representative research workflow.

## How OpenPapers is structured

Requests pass from an MCP transport through tool modules and the research service. Provider adapters handle external APIs, while storage and retrieval components preserve local results.

```text
MCP transport -> tool modules -> ResearchService -> provider adapters
                                      |                 |
                                      v                 v
                              storage/retrieval     external APIs
```

Read the [architecture](docs/architecture.md), [provider](docs/providers.md), and [extension](docs/extending.md) guides for implementation details.

## Provenance and trust boundaries

Material claims include evidence records when source data is available. Records can contain source IDs, authors, titles, persistent identifiers, quality labels, evidence types, and locators.

OpenPapers keeps provider failures, conflicts, unavailable values, and heuristic derivations explicit. Generated summaries are not academic sources. Verify them against the cited records.

The project does not execute downloaded documents or discovered repositories. Read the [security policy](SECURITY.md), [reproducibility guide](docs/reproducibility.md), and [known limitations](docs/limitations.md) before exposing the HTTP transport or relying on extracted results.

## Development and testing

Run the complete credential-free validation suite with one command:

```sh
npm run check
```

The command runs the TypeScript check, architecture rules, production build, and Vitest suite. You can also run each stage separately:

```sh
npm run lint
npm run architecture-check
npm run build
npm test
```

Live provider, Docker, GROBID, and model workflow checks remain separate from credential-free tests. Contributors should read [CONTRIBUTING.md](CONTRIBUTING.md) and the [release checklist](RELEASE_CHECKLIST.md).

## Find more documentation

The documentation index groups guides by task and audience:

- [Documentation index](docs/README.md)
- [Installation](docs/installation.md)
- [Configuration reference](docs/configuration.md)
- [Usage and MCP tools](docs/usage.md)
- [Architecture](docs/architecture.md)
- [Provider integrations](docs/providers.md)
- [Provenance and reproducibility](docs/reproducibility.md)
- [Known limitations](docs/limitations.md)
- [Roadmap](docs/roadmap.md)
- [Release and deployment](docs/release.md)

## Project status and roadmap

Version `1.0.0` is the current release baseline. The project prioritizes provenance and citation verification before automatic citation output.

Quality is gated by a five-level test program (static, offline integration, spawned-process end-to-end, live-provider evaluation, container runtime) with a claims matrix mapping every public claim to recorded evidence; see [the test plan](docs/testing.md). Reliability claims are scoped by [known limitations](docs/limitations.md): live search is measured — exact-title Recall@10 1.0 and identifier resolution 1.0 over the recorded 30-case run, with fuzzy discovery at 0.5 — not guaranteed.

The [changelog](CHANGELOG.md) records completed work. The [roadmap](docs/roadmap.md) describes citation metadata, source-aware citation output, and deferred retrieval improvements.

## License and acknowledgements

OpenPapers is licensed under the [Apache License, Version 2.0](LICENSE.md). This license covers the project's source code only.

Papers, abstracts, metadata, API responses, datasets, model weights, model cards, and GitHub repositories retain their own licenses and service terms. [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) lists the external projects and services used by OpenPapers.

## Cite this project

OpenPapers does not maintain an automatic `CITATIONS.md` file. A formal citation record will be added after the project has a stable public authorship and release identity.

Do not cite generated research responses as original sources. Cite the papers, datasets, and provider records referenced by each response.
