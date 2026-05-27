import { describe, test, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ApiClient, type ToolRegistrationOptions } from "../../../shared/index.js";
import { inputSchema as phoneCallInputSchema } from "../phone_call/live-call.js";
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

describe("phone_call_create input schema — agentConfig.systemPrompt cap (P0.3)", () => {
	// Wrap the schema fragment in a z.object so we can run .parse on it.
	// The inputSchema is a record (not a z.object) per MCP SDK convention,
	// so we wrap on the way in.
	const wrapper = z.object(phoneCallInputSchema);

	test("rejects systemPrompt longer than 600 chars at the MCP boundary", () => {
		const tooLong = "x".repeat(601);
		const result = wrapper.safeParse({
			to: "+14155551234",
			firstMessage: "Hi",
			agentConfig: { systemPrompt: tooLong },
		});
		expect(result.success).toBe(false);
		// Friendly error message — the zod message we wrote in
		// live-call.ts. Important because MCP clients see this error
		// surface and need to know WHY their call was rejected.
		if (!result.success) {
			const issue = result.error.issues.find(
				(i) => i.path.join(".") === "agentConfig.systemPrompt",
			);
			expect(issue?.message).toMatch(/600 characters or fewer/);
		}
	});

	test("accepts systemPrompt exactly at the 600-char cap", () => {
		const atCap = "x".repeat(600);
		const result = wrapper.safeParse({
			to: "+14155551234",
			firstMessage: "Hi",
			agentConfig: { systemPrompt: atCap },
		});
		expect(result.success).toBe(true);
	});

	test("accepts agentConfig without systemPrompt (other fields still validate)", () => {
		const result = wrapper.safeParse({
			to: "+14155551234",
			firstMessage: "Hi",
			agentConfig: { maxHistoryTurns: 10 },
		});
		expect(result.success).toBe(true);
	});
});
