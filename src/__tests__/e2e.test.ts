import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { buildUnifiedServer, type UnifiedServerHandle } from "../index.js";

describe("mcp-server e2e", () => {
  let handle: UnifiedServerHandle;
  let baseUrl: string;

  beforeAll(async () => {
    // Set a dummy API URL that won't actually be hit (auth will fail fast for these tests)
    process.env.ANIMA_API_URL = "http://localhost:9999";
    handle = await buildUnifiedServer({ port: 0 });
    await new Promise<void>((res) => handle.httpServer.listen(0, () => res()));
    const addr = handle.httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    baseUrl = `http://127.0.0.1:${addr.port}`;
  });

  afterAll(async () => {
    await handle.close();
  });

  it("lists /mcp plus all 6 scoped domains on /health", async () => {
    const r = await fetch(`${baseUrl}/health`);
    expect(r.status).toBe(200);
    const body = await r.json() as { domains: string[] };
    expect(body.domains.slice().sort()).toEqual(["/agent", "/email", "/extension", "/mcp", "/phone", "/platform", "/vault"]);
  });

  it("401s unauthenticated initialize on /agent", async () => {
    const r = await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(r.status).toBe(401);
  });

  it("401s unauthenticated initialize on /mcp (unified)", async () => {
    const r = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(r.status).toBe(401);
  });

  it("401s bad key prefix", async () => {
    const r = await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Authorization": "Bearer invalid_prefix_token",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(r.status).toBe(401);
  });

  // 2026-05-20: /platform hosts the renamed `workspace` group + the new
  // `webhook` group. Same auth model as the other domain mounts — 401
  // without a bearer token, full surface available with one.
  it("401s unauthenticated initialize on /platform (workspace + webhook tools)", async () => {
    const r = await fetch(`${baseUrl}/platform`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(r.status).toBe(401);
  });

  it("rejects non-MCP requests on /platform", async () => {
    // A plain GET on an MCP transport endpoint should not return a JSON-RPC
    // response — confirms the transport handler is wired and not letting
    // arbitrary HTTP requests through. Acceptable rejections: 400 (the
    // streamable-http transport returns "Bad Request" for an empty GET),
    // 401 (auth checked first), or 405 (method not allowed). All three
    // mean "you didn't get past the front door."
    const r = await fetch(`${baseUrl}/platform`, { method: "GET" });
    expect([400, 401, 405]).toContain(r.status);
  });
});
