import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHttpServer, type HttpTransportServer } from "../http.ts";
import type { ApiClient } from "../../shared/index.js";

const buildEmptyServer = (name: string) =>
  new McpServer({ name, version: "0.0.0" }, { capabilities: { tools: {} } });

describe("createMcpHttpServer path routing", () => {
  let handle: HttpTransportServer;
  let baseUrl: string;

  beforeAll(async () => {
    handle = createMcpHttpServer(
      {
        "/agent": (_ctx) => buildEmptyServer("agent"),
        "/email": (_ctx) => buildEmptyServer("email"),
      },
      {
        port: 0,
        authenticate: async () => ({
          apiKeyId: "test",
          orgId: "test-org",
          client: {} as ApiClient,
        }),
      },
    );
    await new Promise<void>((res) => handle.httpServer.listen(0, () => res()));
    const addr = handle.httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("returns 200 on /health", async () => {
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    const body = await r.json() as { status: string };
    expect(body.status).toBe("ok");
  });

  it("404s an unknown domain path", async () => {
    const r = await fetch(`${baseUrl}/unknown`, { method: "POST" });
    expect(r.status).toBe(404);
  });

  it("accepts an MCP initialize on a registered path", async () => {
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    };
    const r = await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test",
      },
      body: JSON.stringify(init),
    });
    expect(r.status).toBe(200);
    expect(r.headers.get("mcp-session-id")).toBeTruthy();
  });

  it("rejects cross-path session reuse with 404", async () => {
    // Initialize on /agent
    const init = {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "test", version: "0" },
      },
    };
    const initRes = await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer test",
      },
      body: JSON.stringify(init),
    });
    expect(initRes.status).toBe(200);
    const sessionId = initRes.headers.get("mcp-session-id");
    expect(sessionId).toBeTruthy();
    // Drain the initialize response so the server's write is complete.
    await initRes.text().catch(() => "");

    // Try to POST a subsequent message to /email using the /agent session id
    const abuse = await fetch(`${baseUrl}/email`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-session-id": sessionId!,
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(abuse.status).toBe(404);
  });
});
