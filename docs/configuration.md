# Configuration

All variables are optional for the default SQLite/stdio workflow. Values belong in a local `.env`, never in source control.

| Variable | Default | Purpose |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | Set to `http` for Streamable HTTP. |
| `HTTP_HOST` | `127.0.0.1` | HTTP bind address. |
| `HTTP_PORT` | `8787` | HTTP port. |
| `RESEARCH_DB_PATH` | `:memory:` in library code; `./data/research.sqlite` in `.env.example` | SQLite database path. |
| `DATABASE_BACKEND` | SQLite | Set to `postgres` to select PostgreSQL. |
| `DATABASE_URL` | unset | PostgreSQL connection string; required when `DATABASE_BACKEND=postgres`. |
| `RESEARCH_CACHE_PATH` | unset | Enables the optional durable SQLite response cache. |
| `RESEARCH_CACHE_TTL_MS` | `30000` when durable caching is enabled | Durable cache TTL. |
| `SEMANTIC_SCHOLAR_API_KEY` | unset | Optional Semantic Scholar API key. |
| `GITHUB_TOKEN` | unset | Optional GitHub token for higher-volume access. |
| `HF_TOKEN` | unset | Optional Hugging Face token for authenticated access. |
| `GROBID_URL` | `http://127.0.0.1:8070` | GROBID service URL. Compose overrides this to the service hostname. |
| `PDF_FALLBACKS` | unset | Comma-separated `pymupdf,docling` opt-in fallbacks. |
| `PYTHON_COMMAND` | `python` | Python executable for PDF fallback adapters. |
| `PYMUPDF_SCRIPT` | `scripts/parse_pymupdf.py` | PyMuPDF adapter path. |
| `DOCLING_SCRIPT` | `scripts/parse_docling.py` | Docling adapter path. |
| `OPENPAPERS_FIXTURE_PROVIDERS` | unset | Set to `1` to replace every provider and the paper acquirer with deterministic offline fixtures (`src/testing/fixtures.ts`). Intended for end-to-end tests and offline demos; never represents live provider behavior. |
| `OPENALEX_EMAIL` | unset | OpenAlex polite-pool contact address appended as the `mailto` query parameter. |

`OPENALEX_EMAIL` is read by the OpenAlex adapter at request time; include it in `.env` for the polite pool.

## Credentials

All provider credentials are optional. They improve access or rate limits for specific integrations; they are not required by deterministic tests. Do not place credentials in MCP arguments, logs, fixtures, benchmark output, or committed files. Rotate a credential immediately if it is exposed.
