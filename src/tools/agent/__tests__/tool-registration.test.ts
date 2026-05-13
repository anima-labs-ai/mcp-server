import { describe, test, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiClient, type ToolRegistrationOptions } from "../../../shared/index.js";
import { registerAgentTools } from "../agent/index.js";
import { registerOrganizationTools } from "../organization/index.js";

function createTestOptions(): ToolRegistrationOptions {
	const server = new McpServer({ name: "test", version: "0.0.1" });
	const client = new ApiClient({ baseUrl: "http://localhost:3100", apiKey: "test-key" });
	return {
		server,
		context: { client, hasMasterKey: false },
	};
}

describe("mcp-agent tool registration", () => {
	test("agent tools register without error", () => {
		const options = createTestOptions();
		expect(() => registerAgentTools(options)).not.toThrow();
	});

	test("organization tools register without error", () => {
		const options = createTestOptions();
		expect(() => registerOrganizationTools(options)).not.toThrow();
	});

	test("all tools register on single server", () => {
		const options = createTestOptions();
		registerAgentTools(options);
		registerOrganizationTools(options);
		// If we get here without error, all tools registered successfully
		expect(true).toBe(true);
	});
});
