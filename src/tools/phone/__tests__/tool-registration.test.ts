import { describe, test, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiClient, type ToolRegistrationOptions } from "../../../shared/index.js";
import { registerPhoneTools } from "../phone/index.js";
import { registerPhoneCallTools } from "../phone_call/index.js";

function createTestOptions(): ToolRegistrationOptions {
	const server = new McpServer({ name: "test", version: "0.0.1" });
	const client = new ApiClient({ baseUrl: "http://localhost:3100", apiKey: "test-key" });
	return {
		server,
		context: { client, hasMasterKey: false },
	};
}

describe("mcp-phone tool registration", () => {
	test("phone tools register without error", () => {
		const options = createTestOptions();
		expect(() => registerPhoneTools(options)).not.toThrow();
	});

	test("phone_call tools register without error", () => {
		const options = createTestOptions();
		expect(() => registerPhoneCallTools(options)).not.toThrow();
	});

	test("all tools register on single server", () => {
		const options = createTestOptions();
		registerPhoneTools(options);
		registerPhoneCallTools(options);
		// If we get here without error, all tools registered successfully
		expect(true).toBe(true);
	});
});
