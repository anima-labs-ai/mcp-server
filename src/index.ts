#!/usr/bin/env bun
/// <reference types="bun" />
import { createMcpHttpServer, type DomainFactories, type HttpTransportServer } from "./transport/http.js";
import { loadConfig } from "./shared/index.js";
import { makeAuthenticator } from "./auth.js";
import { buildAgentServer } from "./tools/agent/factory.js";
import { buildCardsServer } from "./tools/cards/factory.js";
import { buildEmailServer } from "./tools/email/factory.js";
import { buildPhoneServer } from "./tools/phone/factory.js";
import { buildPlatformServer } from "./tools/platform/factory.js";
import { buildVaultServer } from "./tools/vault/factory.js";

export type UnifiedServerHandle = HttpTransportServer;

export async function buildUnifiedServer(opts: { port?: number } = {}): Promise<UnifiedServerHandle> {
  const config = loadConfig();
  const authenticate = makeAuthenticator(config.apiUrl);

  const factories: DomainFactories = {
    "/agent":    (ctx) => buildAgentServer(ctx.client),
    "/cards":    (ctx) => buildCardsServer(ctx.client),
    "/email":    (ctx) => buildEmailServer(ctx.client),
    "/phone":    (ctx) => buildPhoneServer(ctx.client),
    "/platform": (ctx) => buildPlatformServer(ctx.client),
    "/vault":    (ctx) => buildVaultServer(ctx.client),
  };

  const mcpBaseUrl = process.env.MCP_BASE_URL ?? "https://mcp.useanima.sh";
  const authServerUrl = process.env.CONSOLE_URL ?? "https://console.useanima.sh";

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
    console.error("Domains: /agent, /cards, /email, /phone, /platform, /vault");
  });

  const shutdown = async () => { await handle.close(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

if (import.meta.main) main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
