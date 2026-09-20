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

  it("serves the Glama ownership claim, unauthenticated", async () => {
    // Glama re-checks this file to keep our connector ownership verified, and
    // ownership is what lets us read the health-check output for the listing.
    // It must stay public and unauthenticated: a 401 here silently un-verifies
    // us, and the symptom appears on someone else's site, not in our logs.
    const r = await fetch(`${baseUrl}/.well-known/glama.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");
    const body = await r.json() as { $schema: string; claim: string };
    expect(body.$schema).toBe("https://glama.ai/mcp/schemas/connector.json");
    expect(body.claim).toMatch(/^glama_claim_/);
  });

  it("requires auth to list tools on /agent when OAuth is configured", async () => {
    const init = await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();

    const list = await fetch(`${baseUrl}/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sid as string },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(list.status).toBe(401);
    expect(list.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("requires auth to list tools on /mcp when OAuth is configured", async () => {
    const init = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();

    const list = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sid as string },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(list.status).toBe(401);
    expect(list.headers.get("www-authenticate")).toContain("resource_metadata");
  });

  it("returns the tool list to an authenticated client", async () => {
    const init = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: "Bearer ak_test",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "probe", version: "0" } } }),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id") as string;

    await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });

    const list = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    });
    expect(list.status).toBe(200);
    const text = await list.text();
    // Streamable HTTP may answer as SSE, so assert on the payload rather than
    // parsing a JSON envelope that is not guaranteed to be one.
    expect(text).toContain("account_overview");
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
  it("requires auth to call tools on /platform when OAuth is configured", async () => {
    const init = await fetch(`${baseUrl}/platform`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } }),
    });
    expect(init.status).toBe(200);
    const sid = init.headers.get("mcp-session-id");
    expect(sid).toBeTruthy();

    const call = await fetch(`${baseUrl}/platform`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "mcp-session-id": sid as string },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "account_overview", arguments: {} } }),
    });
    expect(call.status).toBe(401);
    expect(call.headers.get("www-authenticate")).toContain("resource_metadata");
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
