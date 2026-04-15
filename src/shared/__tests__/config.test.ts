import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { loadConfig, DEFAULTS } from "../config.js";

describe("loadConfig", () => {
	const originalEnv = { ...process.env };

	beforeEach(() => {
		delete process.env.PORT;
		delete process.env.MCP_PORT;
		delete process.env.ANIMA_API_URL;
		delete process.env.ANIMA_API_KEY;
		delete process.env.ANIMA_MASTER_KEY;
	});

	afterEach(() => {
		process.env = { ...originalEnv };
	});

	test("defaults to stdio mode", () => {
		const config = loadConfig([]);
		expect(config.httpMode).toBe(false);
		expect(config.httpPort).toBe(DEFAULTS.mcpPort);
	});

	test("--http flag enables HTTP mode", () => {
		const config = loadConfig(["bun", "index.ts", "--http"]);
		expect(config.httpMode).toBe(true);
	});

	test("--port= overrides port", () => {
		const config = loadConfig(["bun", "index.ts", "--http", "--port=9090"]);
		expect(config.httpPort).toBe(9090);
	});

	test("PORT env var auto-enables HTTP mode (Cloud Run)", () => {
		process.env.PORT = "8080";
		const config = loadConfig([]);
		expect(config.httpMode).toBe(true);
		expect(config.httpPort).toBe(8080);
	});

	test("MCP_PORT env var sets port but does not enable HTTP mode", () => {
		process.env.MCP_PORT = "3000";
		const config = loadConfig([]);
		expect(config.httpMode).toBe(false);
		expect(config.httpPort).toBe(3000);
	});

	test("--port= takes precedence over PORT env var", () => {
		process.env.PORT = "8080";
		const config = loadConfig(["bun", "index.ts", "--port=9999"]);
		expect(config.httpPort).toBe(9999);
	});

	test("reads ANIMA_API_URL from env", () => {
		process.env.ANIMA_API_URL = "https://api.example.com";
		const config = loadConfig([]);
		expect(config.apiUrl).toBe("https://api.example.com");
	});

	test("reads ANIMA_API_KEY from env", () => {
		process.env.ANIMA_API_KEY = "ak_test123";
		const config = loadConfig([]);
		expect(config.apiKey).toBe("ak_test123");
	});

	test("reads ANIMA_MASTER_KEY from env", () => {
		process.env.ANIMA_MASTER_KEY = "mk_master";
		const config = loadConfig([]);
		expect(config.masterKey).toBe("mk_master");
	});
});
