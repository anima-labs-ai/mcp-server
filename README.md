# @anima-labs/mcp-server

Unified MCP server for the Anima platform. Exposes six domain endpoints:

- `/agent` — agent tools
- `/email` — Gmail/SMTP email tools
- `/phone` — Telnyx voice + SMS tools
- `/platform` — messaging, spam, webhooks, pods, agent orchestration
- `/vault` — credential vault, OAuth connections, Connect Links
- `/extension` — browser extension connect (headless / Puppeteer)

Run:
```
bun run src/index.ts
```

Replaces five separate packages (`mcp-agent`, `mcp-email`, `mcp-phone`, `mcp-platform`, `mcp-vault`) and the `mcp-core` shared library.
