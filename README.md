# @anima-labs/mcp-server

Unified MCP server for the Anima platform. Exposes six domain endpoints:

- `/agent` — agent, organization, identity, registry, A2A tools
- `/cards` — virtual debit card tools (with x402 payment support)
- `/email` — Gmail/SMTP email tools
- `/phone` — Telnyx voice + SMS tools
- `/platform` — messaging, spam, webhooks, pods, agent orchestration
- `/vault` — credential vault, OAuth connections, Connect Links

Run:
```
bun run src/index.ts
```

Replaces six separate packages (`mcp-agent`, `mcp-cards`, `mcp-email`, `mcp-phone`, `mcp-platform`, `mcp-vault`) and the `mcp-core` shared library.
