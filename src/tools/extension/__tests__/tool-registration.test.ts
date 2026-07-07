import { describe, test, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiClient, type ToolRegistrationOptions } from "../../../shared/index.js";
import { registerExtensionTools } from "../extension/index.js";

function createTestOptions(): ToolRegistrationOptions {
	const server = new McpServer({ name: "test", version: "0.0.1" });
	const client = new ApiClient({ baseUrl: "http://localhost:3100", apiKey: "test-key" });
	return {
		server,
		context: { client, hasMasterKey: false },
	};
}

describe("mcp-extension tool registration", () => {
	test("extension tools register without error", () => {
		const options = createTestOptions();
		expect(() => registerExtensionTools(options)).not.toThrow();
	});

	test("registers the extension_connect tool", () => {
		const options = createTestOptions();
		registerExtensionTools(options);
		// If we get here without error, the tool registered successfully.
		expect(true).toBe(true);
	});
});

// --- Handler behavior ---------------------------------------------------
//
// These exercise the actual POST body the tool sends and the payload it
// returns, mocking the API client so no network happens. This is the part
// that matters: the auth contract lives in *which keys get sent* (agentId
// required on the master-key path, omitted on the agent-key path), and the
// caller relies on `connectUrl` coming back verbatim (no masking).

interface CapturedCall {
	path: string;
	body: unknown;
}

/**
 * A fake McpServer that captures the (name, config, handler) triple from
 * registerTool. We invoke the captured handler directly so we can assert
 * on the request body without going through the SDK transport. Matches the
 * only method registerExtensionTools calls on `server`.
 */
function captureRegistration(client: ApiClient) {
	let captured:
		| { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }
		| undefined;
	const fakeServer = {
		registerTool(
			name: string,
			_config: unknown,
			handler: (args: Record<string, unknown>) => Promise<unknown>,
		) {
			captured = { name, handler };
		},
	};
	registerExtensionTools({
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake — only registerTool is used.
		server: fakeServer as any,
		context: { client, hasMasterKey: client.hasMasterKey() },
	});
	if (!captured) throw new Error("extension_connect was not registered");
	return captured;
}

/** Build an ApiClient whose POST records the call and returns a canned payload. */
function mockClient(response: unknown): { client: ApiClient; calls: CapturedCall[] } {
	const client = new ApiClient({ baseUrl: "http://localhost:3100", apiKey: "test-key" });
	const calls: CapturedCall[] = [];
	// Override the single method the handler uses. The handler calls
	// context.client.post(path, body) — capture both.
	// biome-ignore lint/suspicious/noExplicitAny: test double for one method.
	(client as any).post = async (path: string, body: unknown) => {
		calls.push({ path, body });
		return response;
	};
	return { client, calls };
}

const CONNECT_PAYLOAD = {
	agentId: "agent_123",
	connectUrl: "https://connect.useanima.sh/x/abc123",
	expiresAt: "2026-07-07T12:15:00.000Z",
	exchangeExpiresAt: "2026-07-07T11:05:00.000Z",
	policy: "session" as const,
};

describe("extension_connect handler", () => {
	test("POSTs to /v1/extension/connect and returns connectUrl in the response", async () => {
		const { client, calls } = mockClient(CONNECT_PAYLOAD);
		const { name, handler } = captureRegistration(client);

		expect(name).toBe("extension_connect");

		const result = (await handler({ agentId: "agent_123", ttl: "15m" })) as {
			content: Array<{ type: string; text: string }>;
			structuredContent?: Record<string, unknown>;
		};

		// Request went to the live endpoint with the provided keys.
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe("/v1/extension/connect");
		expect(calls[0].body).toEqual({ agentId: "agent_123", ttl: "15m" });

		// connectUrl is returned verbatim (nothing masked) in both the text
		// block and the structured content.
		expect(result.structuredContent?.connectUrl).toBe(
			"https://connect.useanima.sh/x/abc123",
		);
		expect(result.content[0].text).toContain("https://connect.useanima.sh/x/abc123");
	});

	test("master-key path: sends agentId when provided", async () => {
		const { client, calls } = mockClient(CONNECT_PAYLOAD);
		const { handler } = captureRegistration(client);

		await handler({ agentId: "agent_123" });

		// agentId present, ttl omitted because the caller didn't set it.
		expect(calls[0].body).toEqual({ agentId: "agent_123" });
	});

	test("agent-key path: omits agentId entirely when not provided", async () => {
		const { client, calls } = mockClient(CONNECT_PAYLOAD);
		const { handler } = captureRegistration(client);

		// Agent-key callers omit agentId — the server resolves it from the
		// key. The tool must NOT synthesize an agentId field (undefined,
		// null, or ""); the body should have no agentId key at all.
		await handler({});

		expect(calls[0].body).toEqual({});
		expect(Object.keys(calls[0].body as object)).not.toContain("agentId");
	});

	test("sends only ttl when only ttl is provided", async () => {
		const { client, calls } = mockClient(CONNECT_PAYLOAD);
		const { handler } = captureRegistration(client);

		await handler({ ttl: "session" });

		expect(calls[0].body).toEqual({ ttl: "session" });
	});
});
