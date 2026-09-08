# OpenPapers release and deployment

## Local verification

Use Node.js 22.5 or newer. Node.js 24 is used by the container image:

```sh
npm ci
npm run check
npm run test:e2e
npm run test:coverage
npm run test:package
npm run build
npm test
```

The local CLI default database is `./data/research.sqlite`. Set `RESEARCH_DB_PATH` to use another SQLite path. The Docker Compose deployment uses PostgreSQL with the pgvector extension by setting `DATABASE_BACKEND=postgres` and `DATABASE_URL`; its data is stored in the `postgres-data` volume.

## MCP server

The built server starts with:

```sh
node --env-file-if-exists=.env dist/mcp/server.js
```

HTTP mode is opt-in through `MCP_TRANSPORT=http`, `HTTP_HOST`, and `HTTP_PORT`. Keep HTTP bound to loopback unless a trusted reverse proxy supplies authentication and TLS.

## Docker

```sh
docker compose up --build
```

OpenPapers runs as the non-root `node` user. The Compose deployment uses PostgreSQL/pgvector in `postgres-data`; the standalone local CLI uses SQLite. PostgreSQL and GROBID health are checked before OpenPapers starts. Container startup and end-to-end checks are separate from the credential-free unit suite.

## ResearchPacks

ResearchPacks use `openpapers.research-pack.v1`. They contain collection metadata, paper metadata, and evidence entries associated with their paper IDs. Imports are bounded at the MCP boundary, validate the declared format and required fields, upsert paper metadata, and never execute pack contents.

## Upgrade and rollback

Back up the SQLite file before upgrades. The schema migration ledger is append-only; upgrades must be idempotent. To roll back application code, restore the prior application version and database backup together. Do not manually delete migration records.

## Optional integrations

GROBID, provider APIs, Docker, and model/tool-calling workflows are optional integration scopes. A passing deterministic test suite does not constitute live provider, container, or model verification. The Compose PostgreSQL backend is verified separately with live MCP persistence and pgvector extension checks.
