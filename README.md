# imap-mcp-mail-bridge

Performance-first remote MCP server for IMAP mailboxes. The worker incrementally syncs IMAP into Postgres and the server provides fast read-only MCP tools backed by Postgres FTS and Redis caches.

## Components

- `packages/server`: Streamable HTTP-style MCP endpoint, protected resource metadata, auth/rate limit.
- `packages/worker`: Incremental IMAP sync using UID checkpoints.
- `packages/db`: Migrations + query primitives used by server and worker.

## MCP tools (MVP)

- `mail_list_folders`
- `mail_search`
- `mail_get`
- Resource: `mail://raw/<id>` via `resources/read`

## Local setup

1. Copy `.env.example` to `.env` and fill values.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run DB migrations:
   ```bash
   npm run db:migrate
   ```
4. Start server and worker (separate shells):
   ```bash
   npm run dev:server
   npm run dev:worker
   ```

## Deploy with Dokploy + Traefik

Use `docker-compose.yml` and ensure both external networks exist:

- `dokploy-network` (ingress/Traefik)
- `dokploy-shared` (shared Redis/Postgres)

Deploy Compose stack in Dokploy. Configure routing for `server` service to expose `/mcp`, `/.well-known/oauth-protected-resource`, and `/healthz`.

## Security defaults

- Every MCP request requires bearer token validation.
- OAuth Protected Resource Metadata endpoint is exposed at `/.well-known/oauth-protected-resource`.
- Request rate limiting is per account in Redis.
- IMAP sync is account-scoped and DB queries enforce account boundaries.
- Message outputs are bounded: search limit <= 20, snippets <= 280 chars, preview <= 4KB.

## Notes / non-goals (MVP)

- No SMTP send/drafts.
- No full attachment blob storage.
- Threading is best-effort (`thread_key`) from headers.
