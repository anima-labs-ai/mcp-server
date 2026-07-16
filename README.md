# @anima-labs/mcp-server

The **hosted** MCP server behind `https://mcp.useanima.sh` — the recommended way to connect AI assistants to Anima. It exposes the full tool surface (65 tools today) over streamable HTTP with `Authorization: Bearer <ak_… or mk_…>`.

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

## History

Replaces five separate packages (`mcp-agent`, `mcp-email`, `mcp-phone`, `mcp-platform`, `mcp-vault`) and the `mcp-core` shared library.
