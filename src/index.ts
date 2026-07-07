#!/usr/bin/env bun
/// <reference types="bun" />
import { createMcpHttpServer, type DomainFactories, type HttpTransportServer } from "./transport/http.js";
import { loadConfig } from "./shared/index.js";
import { makeAuthenticator } from "./auth.js";
import { buildAgentServer } from "./tools/agent/factory.js";
import { buildEmailServer } from "./tools/email/factory.js";
import { buildPhoneServer } from "./tools/phone/factory.js";
import { buildPlatformServer } from "./tools/platform/factory.js";
import { buildVaultServer } from "./tools/vault/factory.js";
import { buildExtensionServer } from "./tools/extension/factory.js";
import { buildAllToolsServer } from "./tools/all/factory.js";

export type UnifiedServerHandle = HttpTransportServer;

export async function buildUnifiedServer(opts: { port?: number } = {}): Promise<UnifiedServerHandle> {
  const config = loadConfig();
  const authenticate = makeAuthenticator(config.apiUrl);

  const factories: DomainFactories = {
    // Unified endpoint — all tools across every domain. This is the default
    // URL for install docs and new user connections.
    "/mcp":      (ctx) => buildAllToolsServer(ctx.client),
    // Per-domain endpoints for scoped / tailored connections.
    "/agent":    (ctx) => buildAgentServer(ctx.client),
    "/email":    (ctx) => buildEmailServer(ctx.client),
    "/phone":    (ctx) => buildPhoneServer(ctx.client),
    "/platform": (ctx) => buildPlatformServer(ctx.client),
    "/vault":    (ctx) => buildVaultServer(ctx.client),
    "/extension":(ctx) => buildExtensionServer(ctx.client),
  };

  const mcpBaseUrl = process.env.MCP_BASE_URL ?? "https://mcp.useanima.sh";
  // OAuth authorization server. The MCP server points clients here via
  // /.well-known/oauth-protected-resource — Claude Desktop / Cursor etc.
  // discover the issuer from this URL and run their PKCE flow against it.
  // Was `console.useanima.sh` (legacy stub OAuth surface). Now points at
  // `connect.useanima.sh` which serves the real Anima Connect OAuth 2.1
  // endpoints. CONSOLE_URL kept as a backward-compat fallback for one
  // release; CONNECT_URL is the canonical env var going forward.
  const authServerUrl =
    process.env.CONNECT_URL ??
    process.env.CONSOLE_URL ??
    "https://connect.useanima.sh";

  return createMcpHttpServer(factories, {
    port: opts.port ?? config.httpPort,
    oauth: { mcpBaseUrl, authServerUrl },
    authenticate,
  });
}

async function main() {
  const handle = await buildUnifiedServer();
  const config = loadConfig();
  handle.httpServer.listen(config.httpPort, () => {
    const addr = handle.httpServer.address();
    const port = typeof addr === "object" && addr ? addr.port : config.httpPort;
    console.error(`Anima MCP server running on http://localhost:${port}`);
    console.error("Domains: /mcp (all), /agent, /email, /phone, /platform, /vault, /extension");
  });

  const shutdown = async () => { await handle.close(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.main) main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
