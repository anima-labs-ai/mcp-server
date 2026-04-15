import { describe, test, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ApiClient, type ToolRegistrationOptions } from "../../../shared/index.js";
import { registerCardTools } from "../cards/index.js";
import { registerWalletTools } from "../wallet/index.js";
import { registerFundingTools } from "../funding/index.js";
import { registerInvoiceTools } from "../invoice/index.js";
import { registerBrowserPaymentsTools } from "../browser-payments/index.js";
import { registerX402Tools } from "../x402/index.js";

function createTestOptions(): ToolRegistrationOptions {
	const server = new McpServer({ name: "test", version: "0.0.1" });
	const client = new ApiClient({ baseUrl: "http://localhost:3100", apiKey: "test-key" });
	return {
		server,
		context: { client, hasMasterKey: false },
	};
}

describe("mcp-cards tool registration", () => {
	test("card tools register without error", () => {
		const options = createTestOptions();
		expect(() => registerCardTools(options)).not.toThrow();
	});

	test("wallet tools register without error", () => {
		const options = createTestOptions();
		expect(() => registerWalletTools(options)).not.toThrow();
	});

	test("funding tools register without error", () => {
		const options = createTestOptions();
		expect(() => registerFundingTools(options)).not.toThrow();
	});

	test("invoice tools register without error", () => {
		const options = createTestOptions();
		expect(() => registerInvoiceTools(options)).not.toThrow();
	});

	test("browser-payments tools register without error", () => {
		const options = createTestOptions();
		expect(() => registerBrowserPaymentsTools(options)).not.toThrow();
	});

	test("x402 tools register without error", () => {
		const options = createTestOptions();
		expect(() => registerX402Tools(options)).not.toThrow();
	});

	test("all tools register on single server", () => {
		const options = createTestOptions();
		registerCardTools(options);
		registerWalletTools(options);
		registerFundingTools(options);
		registerInvoiceTools(options);
		registerBrowserPaymentsTools(options);
		registerX402Tools(options);
		// If we get here without error, all tools registered successfully
		expect(true).toBe(true);
	});
});
