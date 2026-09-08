# Distribution

## Local installation

```sh
npm ci
npm run build
npm start
```

The package exposes the `openpapers` executable. For a packed-install smoke test:

```sh
npm pack
mkdir /tmp/openpapers-smoke && cd /tmp/openpapers-smoke
npm init -y
npm install /path/to/openpapers-1.0.0.tgz
npm exec -- openpapers
```

The executable uses stdio by default and exits when its MCP client closes stdin.

For HTTP transport, shutdown is idempotent. The server stops accepting new connections through Node's `http.close()`, waits for active HTTP work to drain, then closes the MCP handler and storage. Cleanup steps are attempted in order; a cleanup error is returned after later cleanup has been attempted. A forced process termination is outside this guarantee.

## HTTP and Docker

```sh
MCP_TRANSPORT=http HTTP_HOST=127.0.0.1 HTTP_PORT=8787 npm start
docker compose config -q
docker compose up --build --wait
```

Compose configures PostgreSQL/pgvector, GROBID, HTTP transport, and local-only credentials. Use a trusted TLS/authentication reverse proxy before exposing HTTP beyond localhost. Do not commit production credentials.

## MCP client configuration

For a local stdio client, invoke `openpapers` from the installed package. For HTTP clients, use `http://127.0.0.1:8787/mcp` only in a trusted local environment. The server validates Host and Origin headers.

## Environment variables

See `.env.example` and `docs/configuration.md` for SQLite/PostgreSQL selection, database paths, provider credentials, GROBID, and optional parser fallbacks.

## Release process

Publishing is intentionally not automated from this repository. `prepack` builds TypeScript before packaging, and `files` limits the artifact to compiled runtime files, public documentation, license, changelog, and configuration example. Run `npm pack` and the packed-install smoke test before a versioned release.

## MCP Registry preparation

`server.json` follows the current preview registry schema published by the MCP Registry repository. The npm ownership marker `mcpName` is present in `package.json` and matches the server name. Registry publication is intentionally not performed here: the package must first be published to npm and registry authentication requires an operator account. The authoritative workflow is the [MCP Registry TypeScript quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx).

## Known limitations

Live provider checks, PostgreSQL restart/persistence checks, and GROBID extraction are separate from deterministic CI. A passing Compose configuration check does not prove service readiness or end-to-end protocol behavior.
