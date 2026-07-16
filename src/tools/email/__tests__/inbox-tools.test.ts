import { describe, test, expect, beforeEach, afterAll } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiClient, MASTER_KEY_TOOLS, type ToolRegistrationOptions } from "../../../shared/index.js";
import { registerInboxTools } from "../inbox/index.js";
import { buildEmailServer } from "../factory.js";
import { buildAllToolsServer } from "../../all/factory.js";

// ---------------------------------------------------------------------------
// Behavioral tests for the inbox_* tools (competitive-parity item C4,
// founder checklist row 6). Unlike the register-without-throwing suites,
// these assert the actual HTTP request each tool issues — method, path,
// query string, JSON body, and auth header — against a real local HTTP
// server, through the real ApiClient. If a tool starts hitting the wrong
// route, dropping a field, or eating an explicit `null`, these fail.
// ---------------------------------------------------------------------------

interface RecordedRequest {
	method: string;
	/** pathname + search, e.g. "/v1/inboxes?limit=5" */
	path: string;
	body: unknown;
	auth: string | null;
}

const recorded: RecordedRequest[] = [];
let nextResponse: { status: number; body: unknown } = { status: 200, body: {} };

const mockApi = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);
		let body: unknown;
		if (req.method !== "GET" && req.method !== "HEAD") {
			const text = await req.text();
			body = text ? JSON.parse(text) : undefined;
		}
		recorded.push({
			method: req.method,
			path: `${url.pathname}${url.search}`,
			body,
			auth: req.headers.get("authorization"),
		});
		return Response.json(nextResponse.body, { status: nextResponse.status });
	},
});

afterAll(() => mockApi.stop());

const baseUrl = `http://localhost:${mockApi.port}`;

/** Canned InboxOutput matching the API contract shape. */
const INBOX = {
	id: "clxinbox00000000000000000",
	email: "support@agents.useanima.sh",
	domain: "agents.useanima.sh",
	localPart: "support",
	displayName: "Support",
	agentId: "clxagent00000000000000000",
	createdAt: "2026-07-16T00:00:00.000Z",
};

interface ToolResult {
	content: Array<{ type: string; text: string }>;
	structuredContent?: Record<string, unknown>;
	isError?: true;
}

interface CapturedTool {
	config: {
		title?: string;
		description?: string;
		annotations?: Record<string, boolean>;
	};
	handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

/**
 * Register the inbox tools onto a minimal fake server that captures each
 * (name, config, handler) triple so tests can invoke handlers directly.
 * The ApiClient is real and points at the local mock API — the full
 * handler → client → HTTP path is exercised.
 */
function captureInboxTools(hasMasterKey: boolean): Map<string, CapturedTool> {
	const client = new ApiClient({ baseUrl, apiKey: "test-key" });
	const tools = new Map<string, CapturedTool>();
	const fakeServer = {
		registerTool(
			name: string,
			config: CapturedTool["config"],
			handler: CapturedTool["handler"],
		) {
			tools.set(name, { config, handler });
		},
	};
	registerInboxTools({
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake — only registerTool is used.
		server: fakeServer as any,
		context: { client, hasMasterKey },
	} as ToolRegistrationOptions);
	return tools;
}

function getTool(tools: Map<string, CapturedTool>, name: string): CapturedTool {
	const tool = tools.get(name);
	if (!tool) throw new Error(`tool ${name} was not registered`);
	return tool;
}

beforeEach(() => {
	recorded.length = 0;
	nextResponse = { status: 200, body: {} };
});

describe("inbox tool registration", () => {
	test("registers exactly the five inbox tools", () => {
		const tools = captureInboxTools(true);
		expect([...tools.keys()].sort()).toEqual([
			"inbox_create",
			"inbox_delete",
			"inbox_get",
			"inbox_list",
			"inbox_update",
		]);
	});

	test("read tools are marked read-only; delete is destructive", () => {
		const tools = captureInboxTools(true);
		expect(getTool(tools, "inbox_get").config.annotations?.readOnlyHint).toBe(true);
		expect(getTool(tools, "inbox_list").config.annotations?.readOnlyHint).toBe(true);
		expect(getTool(tools, "inbox_create").config.annotations?.readOnlyHint).toBe(false);
		expect(getTool(tools, "inbox_delete").config.annotations?.destructiveHint).toBe(true);
	});

	test("master-key gating mirrors the API's requireMaster mapping", () => {
		// The API gates create/update/delete behind requireMaster
		// (apps/api/src/routes/handlers/inbox.ts) while list/get accept any
		// key. MASTER_KEY_TOOLS must mirror that — a guard not in this set
		// (or vice versa) is exactly the C7 bug class.
		expect(MASTER_KEY_TOOLS.has("inbox_create")).toBe(true);
		expect(MASTER_KEY_TOOLS.has("inbox_update")).toBe(true);
		expect(MASTER_KEY_TOOLS.has("inbox_delete")).toBe(true);
		expect(MASTER_KEY_TOOLS.has("inbox_get")).toBe(false);
		expect(MASTER_KEY_TOOLS.has("inbox_list")).toBe(false);
	});
});

describe("inbox_create", () => {
	test("POSTs /v1/inboxes with exactly the provided fields and returns the inbox", async () => {
		nextResponse = { status: 200, body: INBOX };
		const { handler } = getTool(captureInboxTools(true), "inbox_create");

		const result = await handler({
			username: "support",
			domain: "agents.useanima.sh",
			displayName: "Support",
			agentId: "clxagent00000000000000000",
		});

		expect(recorded).toHaveLength(1);
		expect(recorded[0].method).toBe("POST");
		expect(recorded[0].path).toBe("/v1/inboxes");
		expect(recorded[0].body).toEqual({
			username: "support",
			domain: "agents.useanima.sh",
			displayName: "Support",
			agentId: "clxagent00000000000000000",
		});
		expect(recorded[0].auth).toBe("Bearer test-key");

		expect(result.isError).toBeUndefined();
		expect(result.structuredContent?.email).toBe("support@agents.useanima.sh");
		expect(result.content[0].text).toContain("support@agents.useanima.sh");
	});

	test("omits every unset optional — server generates username/domain", async () => {
		nextResponse = { status: 200, body: INBOX };
		const { handler } = getTool(captureInboxTools(true), "inbox_create");

		await handler({});

		expect(recorded).toHaveLength(1);
		expect(recorded[0].body).toEqual({});
	});

	test("without master key: fails loudly and makes NO HTTP call", async () => {
		const { handler } = getTool(captureInboxTools(false), "inbox_create");

		const result = await handler({ username: "support" });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("ANIMA_MASTER_KEY");
		expect(recorded).toHaveLength(0);
	});

	test("surfaces the API's typed error envelope on 4xx", async () => {
		// e.g. duplicate address → oRPC error body with a code. The MCP
		// caller must receive the code, not a generic string.
		nextResponse = {
			status: 409,
			body: { code: "CONFLICT", message: "Email address already exists" },
		};
		const { handler } = getTool(captureInboxTools(true), "inbox_create");

		const result = await handler({ username: "taken" });

		expect(result.isError).toBe(true);
		const parsed = JSON.parse(result.content[0].text) as {
			error: { code: string; message: string; status: number };
		};
		expect(parsed.error.code).toBe("CONFLICT");
		expect(parsed.error.status).toBe(409);
		expect(parsed.error.message).toBe("Email address already exists");
	});
});

describe("inbox_get", () => {
	test("GETs /v1/inboxes/{id}", async () => {
		nextResponse = { status: 200, body: INBOX };
		const { handler } = getTool(captureInboxTools(true), "inbox_get");

		const result = await handler({ id: "clxinbox00000000000000000" });

		expect(recorded).toHaveLength(1);
		expect(recorded[0].method).toBe("GET");
		expect(recorded[0].path).toBe("/v1/inboxes/clxinbox00000000000000000");
		expect(result.structuredContent?.id).toBe("clxinbox00000000000000000");
	});

	test("URL-encodes the id", async () => {
		const { handler } = getTool(captureInboxTools(true), "inbox_get");

		await handler({ id: "weird/../id" });

		expect(recorded[0].path).toBe("/v1/inboxes/weird%2F..%2Fid");
	});

	test("works without a master key (any-key read)", async () => {
		nextResponse = { status: 200, body: INBOX };
		const { handler } = getTool(captureInboxTools(false), "inbox_get");

		const result = await handler({ id: "clxinbox00000000000000000" });

		expect(result.isError).toBeUndefined();
		expect(recorded).toHaveLength(1);
	});
});

describe("inbox_list", () => {
	test("GETs bare /v1/inboxes when no filters are given", async () => {
		nextResponse = {
			status: 200,
			body: { items: [INBOX], pagination: { nextCursor: null, hasMore: false } },
		};
		const { handler } = getTool(captureInboxTools(false), "inbox_list");

		const result = await handler({});

		expect(recorded).toHaveLength(1);
		expect(recorded[0].method).toBe("GET");
		expect(recorded[0].path).toBe("/v1/inboxes");
		expect(result.structuredContent?.items).toHaveLength(1);
	});

	test("serializes query, cursor, and limit as query params", async () => {
		nextResponse = {
			status: 200,
			body: { items: [], pagination: { nextCursor: null, hasMore: false } },
		};
		const { handler } = getTool(captureInboxTools(false), "inbox_list");

		await handler({ query: "support desk", cursor: "clxcursor0000000000000000", limit: 5 });

		expect(recorded).toHaveLength(1);
		const url = new URL(`http://x${recorded[0].path}`);
		expect(url.pathname).toBe("/v1/inboxes");
		expect(url.searchParams.get("query")).toBe("support desk");
		expect(url.searchParams.get("cursor")).toBe("clxcursor0000000000000000");
		expect(url.searchParams.get("limit")).toBe("5");
	});
});

describe("inbox_update", () => {
	test("PATCHes /v1/inboxes/{id} with only the provided fields", async () => {
		nextResponse = { status: 200, body: { ...INBOX, displayName: "Renamed" } };
		const { handler } = getTool(captureInboxTools(true), "inbox_update");

		const result = await handler({
			id: "clxinbox00000000000000000",
			displayName: "Renamed",
		});

		expect(recorded).toHaveLength(1);
		expect(recorded[0].method).toBe("PATCH");
		expect(recorded[0].path).toBe("/v1/inboxes/clxinbox00000000000000000");
		// Only displayName — agentId omitted entirely (NOT sent as
		// null/undefined, which would unlink the agent).
		expect(recorded[0].body).toEqual({ displayName: "Renamed" });
		expect(result.structuredContent?.displayName).toBe("Renamed");
	});

	test("explicit null survives to the wire — unlink agent / clear name", async () => {
		nextResponse = { status: 200, body: { ...INBOX, displayName: null, agentId: null } };
		const { handler } = getTool(captureInboxTools(true), "inbox_update");

		await handler({
			id: "clxinbox00000000000000000",
			displayName: null,
			agentId: null,
		});

		expect(recorded).toHaveLength(1);
		expect(recorded[0].body).toEqual({ displayName: null, agentId: null });
	});

	test("without master key: fails loudly and makes NO HTTP call", async () => {
		const { handler } = getTool(captureInboxTools(false), "inbox_update");

		const result = await handler({ id: "clxinbox00000000000000000", displayName: "x" });

		expect(result.isError).toBe(true);
		expect(recorded).toHaveLength(0);
	});
});

describe("inbox_delete", () => {
	test("DELETEs /v1/inboxes/{id} and normalizes to { success: true }", async () => {
		nextResponse = { status: 200, body: { success: true } };
		const { handler } = getTool(captureInboxTools(true), "inbox_delete");

		const result = await handler({ id: "clxinbox00000000000000000" });

		expect(recorded).toHaveLength(1);
		expect(recorded[0].method).toBe("DELETE");
		expect(recorded[0].path).toBe("/v1/inboxes/clxinbox00000000000000000");
		expect(result.isError).toBeUndefined();
		expect(result.structuredContent).toEqual({ success: true });
	});

	test("without master key: fails loudly and makes NO HTTP call", async () => {
		const { handler } = getTool(captureInboxTools(false), "inbox_delete");

		const result = await handler({ id: "clxinbox00000000000000000" });

		expect(result.isError).toBe(true);
		expect(recorded).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Factory wiring — the tools must actually be exposed over MCP on both the
// unified /mcp server and the scoped /email server. Uses the SDK's public
// client + in-memory transport (no private fields) so this fails if either
// factory forgets to call registerInboxTools.
// ---------------------------------------------------------------------------

const INBOX_TOOL_NAMES = [
	"inbox_create",
	"inbox_get",
	"inbox_list",
	"inbox_update",
	"inbox_delete",
];

async function listToolNames(server: McpServer): Promise<string[]> {
	const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
	const mcpClient = new Client({ name: "test-client", version: "0.0.1" });
	await Promise.all([
		server.connect(serverTransport),
		mcpClient.connect(clientTransport),
	]);
	try {
		const { tools } = await mcpClient.listTools();
		return tools.map((t) => t.name);
	} finally {
		await mcpClient.close();
		await server.close();
	}
}

describe("factory wiring", () => {
	test("unified /mcp server exposes all five inbox tools", async () => {
		const client = new ApiClient({ baseUrl, apiKey: "test-key", masterKey: "test-key" });
		const names = await listToolNames(buildAllToolsServer(client));
		for (const name of INBOX_TOOL_NAMES) {
			expect(names).toContain(name);
		}
	});

	test("scoped /email server exposes all five inbox tools", async () => {
		const client = new ApiClient({ baseUrl, apiKey: "test-key", masterKey: "test-key" });
		const names = await listToolNames(buildEmailServer(client));
		for (const name of INBOX_TOOL_NAMES) {
			expect(names).toContain(name);
		}
	});
});
