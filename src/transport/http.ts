// mcp-server/src/transport/http.ts
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createSessionRegistry, type SessionRegistry, type SessionRegistryOptions } from "../shared/session-registry.js";
import { createMcpRateLimiter, type McpRateLimiter, type McpRateLimiterOptions } from "../shared/rate-limiter.js";
import { createCircuitBreaker, CircuitOpenError, type CircuitBreaker, type CircuitBreakerOptions } from "../shared/circuit-breaker.js";
import { createMcpMetrics, type McpMetrics } from "../shared/metrics.js";
import { ANIMA_ICON_PNG_BASE64 } from "../shared/config.js";

const ICON_PNG_BUFFER = Buffer.from(ANIMA_ICON_PNG_BASE64, "base64");

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, Authorization, mcp-session-id, Last-Event-ID, mcp-protocol-version",
  "Access-Control-Expose-Headers": "mcp-session-id, mcp-protocol-version",
};

export function jsonError(res: ServerResponse, status: number, message: string) {
  res.writeHead(status, { ...CORS_HEADERS, "Content-Type": "application/json" });
  res.end(JSON.stringify({ error: message }));
}

export function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

export function parseBearerToken(req: IncomingMessage): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const match = header.match(/^Bearer\s+(\S+)$/i);
  return match?.[1];
}

interface McpSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  path: string;
  apiKeyId?: string;
  orgId?: string;
}

export interface McpAuthContext {
  apiKeyId: string;
  orgId: string;
}

export interface McpAuthError {
  status: number;
  message: string;
}

export interface OAuthDiscovery {
  mcpBaseUrl: string;
  authServerUrl: string;
}

export type DomainFactories = Record<string, () => McpServer>;

export interface HttpTransportOptions {
  port?: number;
  onShutdown?: () => void;
  authenticate?: (req: IncomingMessage, path: string) => Promise<McpAuthContext | undefined>;
  sessionRegistry?: SessionRegistryOptions;
  rateLimiter?: McpRateLimiterOptions;
  circuitBreaker?: CircuitBreakerOptions;
  oauth?: OAuthDiscovery;
}

export interface HttpTransportServer {
  httpServer: Server;
  sessions: Map<string, McpSession>;
  registry: SessionRegistry;
  rateLimiter: McpRateLimiter;
  circuitBreaker: CircuitBreaker;
  metrics: McpMetrics;
  close: () => Promise<void>;
}

export function createMcpHttpServer(
  factories: DomainFactories,
  options?: HttpTransportOptions,
): HttpTransportServer {
  const sessions = new Map<string, McpSession>();
  const port = options?.port ?? 0;
  const startedAt = Date.now();

  const registry = createSessionRegistry(options?.sessionRegistry);
  const rateLimiter = createMcpRateLimiter(options?.rateLimiter);
  const circuitBreaker = createCircuitBreaker(options?.circuitBreaker);
  const metrics = createMcpMetrics();

  registry.startSweep(async (sessionId: string) => {
    const session = sessions.get(sessionId);
    if (!session) return;
    await session.transport.close();
    // onclose may have already fired synchronously and removed the entry.
    // Only do second-pass cleanup if it didn't.
    if (sessions.has(sessionId)) {
      await session.server.close();
      sessions.delete(sessionId);
      metrics.sessionClosed();
    }
  });

  function setRateLimitHeaders(res: ServerResponse, remaining: number, limit: number, retryAfterMs?: number): void {
    res.setHeader("X-RateLimit-Limit", limit);
    res.setHeader("X-RateLimit-Remaining", remaining);
    if (retryAfterMs !== undefined) res.setHeader("Retry-After", Math.ceil(retryAfterMs / 1000));
  }

  const domainPaths = Object.keys(factories);

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    if (url.pathname === "/favicon.ico" || url.pathname === "/icon.png") {
      res.writeHead(200, {
        ...CORS_HEADERS,
        "Content-Type": "image/png",
        "Content-Length": ICON_PNG_BUFFER.length,
        "Cache-Control": "public, max-age=604800",
      });
      res.end(ICON_PNG_BUFFER);
      return;
    }

    if (url.pathname === "/robots.txt") {
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=86400" });
      res.end("User-agent: *\nAllow: /\n");
      return;
    }

    if (url.pathname === "/" && req.method === "GET") {
      const links = domainPaths.map((p) => `<li><code>${p}</code></li>`).join("");
      const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<title>Anima MCP</title>
<link rel="icon" href="/favicon.ico">
<link rel="icon" type="image/png" sizes="96x96" href="/icon.png">
<link rel="apple-touch-icon" href="/icon.png">
</head><body>
<h1>Anima MCP Server</h1>
<p>This is an MCP (Model Context Protocol) server. Available domains:</p>
<ul>${links}</ul>
</body></html>`;
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=3600" });
      res.end(html);
      return;
    }

    if (options?.oauth && url.pathname === "/.well-known/oauth-protected-resource") {
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json", "Cache-Control": "public, max-age=3600" });
      res.end(JSON.stringify({
        resource: options.oauth.mcpBaseUrl,
        authorization_servers: [options.oauth.authServerUrl],
        bearer_methods_supported: ["header"],
      }));
      return;
    }

    if (url.pathname === "/health") {
      const uptimeMs = Date.now() - startedAt;
      res.writeHead(200, { ...CORS_HEADERS, "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        sessions: sessions.size,
        uptimeSeconds: Math.floor(uptimeMs / 1000),
        startedAt: new Date(startedAt).toISOString(),
        domains: domainPaths,
        metrics: metrics.snapshot(),
        registry: registry.stats(),
      }));
      return;
    }

    const factory = factories[url.pathname];
    if (!factory) {
      jsonError(res, 404, "Not Found");
      return;
    }

    const thisPath = url.pathname;

    if (req.method === "DELETE") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (session && session.path === thisPath) {
        if (sessionId) {
          sessions.delete(sessionId);
          registry.remove(sessionId);
          metrics.sessionClosed();
        }
        await session.transport.close();
        await session.server.close();
        res.writeHead(200, CORS_HEADERS);
        res.end();
      } else {
        jsonError(res, 404, "Session not found");
      }
      return;
    }

    if (req.method === "GET") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;
      const session = sessionId ? sessions.get(sessionId) : undefined;
      if (session && session.path === thisPath) {
        if (sessionId) registry.touch(sessionId);
        await session.transport.handleRequest(req, res);
      } else {
        jsonError(res, 400, "Missing or invalid mcp-session-id header");
      }
      return;
    }

    if (req.method === "POST") {
      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        jsonError(res, 400, "Invalid JSON body");
        return;
      }

      if (sessionId) {
        const session = sessions.get(sessionId);
        if (session && session.path === thisPath) {
          registry.touch(sessionId);
          const apiKeyId = session.apiKeyId ?? "unknown";
          const orgId = session.orgId ?? "unknown";

          const requestCheck = rateLimiter.checkRequest(apiKeyId);
          if (!requestCheck.allowed) {
            metrics.rateLimitHit();
            setRateLimitHeaders(res, requestCheck.remaining, requestCheck.limit, requestCheck.retryAfterMs);
            jsonError(res, 429, "Rate limit exceeded");
            return;
          }

          try {
            await circuitBreaker.execute(orgId, async () => {
              const callStart = Date.now();
              await session.transport.handleRequest(req, res, body);
              metrics.toolCallRecorded(Date.now() - callStart);
            });
          } catch (err) {
            if (err instanceof CircuitOpenError) {
              metrics.circuitBreakerTripped(orgId);
              setRateLimitHeaders(res, 0, 0, err.retryAfterMs);
              jsonError(res, 503, err.message);
            } else {
              console.error("MCP handleRequest error:", err);
              // handleRequest may have already written headers (SSE). Only send a
              // 500 if headers haven't gone out yet.
              if (!res.headersSent) {
                jsonError(res, 500, "Internal server error");
              } else {
                // Headers already sent — can't change status. Just end the response.
                try { res.end(); } catch { /* already closed */ }
              }
            }
          }
          return;
        }
        jsonError(res, 404, "Session not found. Create a new session with an initialize request.");
        return;
      }

      if (!isInitializeRequest(body)) {
        jsonError(res, 400, "First request must be an MCP initialize request");
        return;
      }

      let authContext: McpAuthContext | undefined;
      if (options?.authenticate) {
        try {
          authContext = await options.authenticate(req, thisPath);
        } catch (err) {
          const authErr = err as McpAuthError;
          metrics.authFailure();
          const status = authErr.status || 401;
          if (status === 401 && options.oauth) {
            res.setHeader("WWW-Authenticate", `Bearer resource_metadata="${options.oauth.mcpBaseUrl}/.well-known/oauth-protected-resource"`);
          }
          jsonError(res, status, authErr.message || "Authentication failed");
          return;
        }
      }

      const apiKeyId = authContext?.apiKeyId ?? "anonymous";
      const orgId = authContext?.orgId ?? "anonymous";

      const sessionCheck = rateLimiter.checkSessionCreation(apiKeyId, registry.countByKey(apiKeyId));
      if (!sessionCheck.allowed) {
        metrics.rateLimitHit();
        setRateLimitHeaders(res, sessionCheck.remaining, sessionCheck.limit, sessionCheck.retryAfterMs);
        jsonError(res, 429, "Too many active sessions for this API key");
        return;
      }

      if (!registry.canCreateSession(apiKeyId)) {
        jsonError(res, 429, "Maximum concurrent sessions reached for this API key");
        return;
      }

      const mcpServer = factory();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid: string) => {
          sessions.set(sid, { server: mcpServer, transport, path: thisPath, apiKeyId, orgId });
          registry.register(sid, apiKeyId, orgId);
          metrics.sessionCreated();
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid && sessions.has(sid)) {
          sessions.delete(sid);
          registry.remove(sid);
          metrics.sessionClosed();
        }
      };

      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, body);
      return;
    }

    jsonError(res, 405, "Method not allowed");
  });

  const close = async () => {
    registry.stopSweep();
    const snapshot = Array.from(sessions.values());
    for (const session of snapshot) {
      try {
        await session.transport.close();
        await session.server.close();
      } catch {
        // best-effort on shutdown
      }
    }
    sessions.clear();
    httpServer.close();
    options?.onShutdown?.();
  };

  return { httpServer, sessions, registry, rateLimiter, circuitBreaker, metrics, close };
}
