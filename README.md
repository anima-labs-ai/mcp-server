# @anima-labs/mcp-server

The **hosted** MCP server behind `https://mcp.useanima.sh` — the recommended way to connect AI assistants to Anima. It exposes the full tool surface (66 tools today) over streamable HTTP with `Authorization: Bearer <ak_… or mk_…>`.

This package is deliberately **not published to npm**: it is the deployed gateway. For a local/stdio server use [`@anima-labs/mcp`](https://github.com/anima-labs-ai/mcp) (published, 53 core tools) — same platform, same auth. Client setup for both lives in the [MCP docs](https://docs.useanima.sh/mcp-servers), or run `anima setup-mcp`.

## Endpoints

One gateway, scoped mounts. `/mcp` carries everything; the per-domain mounts serve tailored connections with a smaller tool count:

- `/mcp` — all tools (recommended)
- `/agent` — agent lifecycle (create/get/list/update/delete)
- `/email` — Anima agent mailboxes: inbox create/get/list/update/delete, send/reply/forward, threads, drafts, attachments, custom domains (`agents.useanima.sh` addresses or your own domain — no Gmail/SMTP relay involved)
- `/phone` — phone number provisioning, SMS threads, voice calls + transcripts/recordings (Telnyx-backed)
- `/platform` — account/usage overviews and webhook management
- `/vault` — encrypted credential vault: CRUD, search, TOTP, server-side use, credential requests, OAuth connections, Connect Links
- `/extension` — browser extension connect (headless / Puppeteer)

## Run locally (development)

```
bun run src/index.ts
```

Environment: `ANIMA_API_URL` (defaults to a local dev API at `http://127.0.0.1:3100`; the production deployment sets it to the live API), `MCP_BASE_URL`, `PORT`.

## Deploy production (`mcp.useanima.sh`)

Preferred path is GitHub Actions: run **Deploy MCP Server** (`.github/workflows/deploy.yml`) via `workflow_dispatch`.

Required repository secrets (for Workload Identity Federation / OIDC):

- `GCP_WORKLOAD_IDENTITY_PROVIDER` (format: `projects/<number>/locations/global/workloadIdentityPools/<pool>/providers/<provider>`)
- `GCP_SERVICE_ACCOUNT_EMAIL` (deployer service account in `anima-labs`)

Workflow behavior:

- Builds and pushes `us-central1-docker.pkg.dev/anima-labs/anima/mcp-server:<tag>`
- Deploys Cloud Run service `mcp-server` in `us-central1`
- Prints `GET /health` response so you can confirm `startedAt` changed

Manual fallback (same image/deploy settings) remains:

```bash
./deploy.sh <tag>
```

## History

Replaces five separate packages (`mcp-agent`, `mcp-email`, `mcp-phone`, `mcp-platform`, `mcp-vault`) and the `mcp-core` shared library.
