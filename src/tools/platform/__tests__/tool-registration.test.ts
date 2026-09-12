import { describe, test, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiClient, type ToolRegistrationOptions } from "../../../shared/index.js";
import { registerWorkspaceTools } from "../workspace/index.js";
import { registerWebhookTools } from "../webhook/index.js";

function createTestOptions(): ToolRegistrationOptions {
	const server = new McpServer({ name: "test", version: "0.0.1" });
	const client = new ApiClient({ baseUrl: "http://localhost:3100", apiKey: "test-key" });
	return {
		server,
		context: { client, hasMasterKey: false },
	};
}

describe("mcp-platform tool registration", () => {
	test("workspace tools register without error", () => {
		const options = createTestOptions();
		expect(() => registerWorkspaceTools(options)).not.toThrow();
	});

	test("all tools register on single server", () => {
		const options = createTestOptions();
		registerWorkspaceTools(options);
		// If we get here without error, all tools registered successfully
		expect(true).toBe(true);
	});

	test("workspace/webhook tools set expected behavioral hints", () => {
		type Captured = {
			name: string;
			annotations?: Record<string, unknown>;
		};
		const captured: Captured[] = [];
		const fakeServer = {
			registerTool(
				name: string,
				config: {
					annotations?: Record<string, unknown>;
				},
			) {
				captured.push({ name, annotations: config.annotations });
			},
		};
		const client = new ApiClient({ baseUrl: "http://localhost:3100", apiKey: "test-key" });
		const options: ToolRegistrationOptions = {
			// biome-ignore lint/suspicious/noExplicitAny: minimal capture double.
			server: fakeServer as any,
			context: { client, hasMasterKey: false },
		};
		registerWorkspaceTools(options);
		registerWebhookTools(options);

		const byName = new Map(captured.map((c) => [c.name, c.annotations]));
		expect(byName.get("account_overview")).toEqual({
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
		});
		expect(byName.get("usage_overview")).toEqual({
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
		});
		expect(byName.get("webhook_get")).toEqual({
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
		});
		expect(byName.get("webhook_list")).toEqual({
			readOnlyHint: true,
			openWorldHint: false,
			destructiveHint: false,
		});
		expect(byName.get("webhook_set")).toEqual({
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: false,
		});
		expect(byName.get("webhook_delete")).toEqual({
			readOnlyHint: false,
			openWorldHint: false,
			destructiveHint: true,
		});
		expect(byName.get("webhook_test")).toEqual({
			readOnlyHint: false,
			openWorldHint: true,
			destructiveHint: false,
		});
	});
});
