import { describe, it, expect, beforeAll, afterAll } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpHttpServer, type HttpTransportServer } from "../http.ts";
import { DEFAULT_OAUTH_SCOPES, type ApiClient } from "../../shared/index.js";

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

  // Registry crawlers (Glama, PulseMCP) read this manifest instead of waiting
  // on a submission, so a regression here silently removes Anima from every
  // crawler-fed directory at once -- with no error anywhere to notice.
  it("serves a registry manifest at /.well-known/mcp.json", async () => {
    const r = await fetch(`${baseUrl}/.well-known/mcp.json`);
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toContain("application/json");

    const body = (await r.json()) as {
      name: string;
      remotes: { type: string; url: string }[];
    };
    expect(body.name).toBe("io.github.anima-labs-ai/anima");
    expect(body.remotes[0]?.type).toBe("streamable-http");
  });

  it("advertises the host it was actually reached on", async () => {
    // The same binary serves preview and production revisions. A hardcoded
    // production URL here would send crawlers indexing a preview deployment
    // to the wrong server, so the remote must follow the request's own host.
    const addr = handle.httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const r = await fetch(`${baseUrl}/.well-known/mcp.json`);
    const body = (await r.json()) as { remotes: { url: string }[] };
    expect(body.remotes[0]?.url).toBe(`http://127.0.0.1:${addr.port}/mcp`);
  });

  it("keeps the description within the registry's 100-character limit", async () => {
    // The official registry rejects a longer description with a 422, which is
    // only discovered at publish time -- pin it here where it is cheap to see.
    const r = await fetch(`${baseUrl}/.well-known/mcp.json`);
    const body = (await r.json()) as { description: string };
    expect(body.description.length).toBeLessThanOrEqual(100);
  });
});

describe("OAuth protected-resource metadata", () => {
  let handle: HttpTransportServer;
  let baseUrl: string;

  beforeAll(async () => {
    handle = createMcpHttpServer(
      { "/mcp": (_ctx) => buildEmptyServer("mcp") },
      {
        port: 0,
        oauth: {
          mcpBaseUrl: "https://mcp.example.test",
          authServerUrl: "https://connect.example.test",
          scopesSupported: DEFAULT_OAUTH_SCOPES,
        },
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

  it("advertises scopes_supported", async () => {
    // Anima Connect rejects an authorization request carrying no `scope`.
    // A client that cannot discover these sends none, and the OAuth flow dies
    // at `invalid_request` -- which is exactly how a third-party MCP client
    // fails to connect. This field is what makes the flow possible at all.
    const r = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { scopes_supported?: string[] };
    expect(body.scopes_supported).toBeDefined();
    expect(body.scopes_supported?.length).toBeGreaterThan(0);
  });

  it("does not advertise admin:full", async () => {
    // Clients commonly request every advertised scope. Advertising the admin
    // escalation would hand a directory or IDE full org admin for what is only
    // ever tool use.
    const r = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    const body = (await r.json()) as { scopes_supported: string[] };
    expect(body.scopes_supported).not.toContain("admin:full");
  });

  it("advertises no template scopes", async () => {
    // `vault:read_credential:{label}` is a template. A client cannot send it
    // without substituting a label, so advertising it produces an
    // unsatisfiable authorization request rather than a useful one.
    const r = await fetch(`${baseUrl}/.well-known/oauth-protected-resource`);
    const body = (await r.json()) as { scopes_supported: string[] };
    expect(body.scopes_supported.filter((s) => s.includes("{"))).toEqual([]);
  });
});

describe("OAuth metadata without configured scopes", () => {
  it("omits scopes_supported entirely rather than sending an empty array", async () => {
    // An empty array reads as "this resource supports no scopes", which is a
    // different and worse claim than staying silent.
    const handle = createMcpHttpServer(
      { "/mcp": (_ctx) => buildEmptyServer("mcp") },
      {
        port: 0,
        oauth: {
          mcpBaseUrl: "https://mcp.example.test",
          authServerUrl: "https://connect.example.test",
        },
      },
    );
    await new Promise<void>((res) => handle.httpServer.listen(0, () => res()));
    const addr = handle.httpServer.address();
    if (!addr || typeof addr === "string") throw new Error("no addr");
    const r = await fetch(`http://127.0.0.1:${addr.port}/.well-known/oauth-protected-resource`);
    const body = (await r.json()) as Record<string, unknown>;
    expect("scopes_supported" in body).toBe(false);
    await handle.close();
  });
});
