import { describe, test, expect } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	ApiClient,
	type ToolRegistrationOptions,
} from "../../../shared/index.js";
import { registerVaultTools } from "../vault/index.js";

function createTestOptions(): ToolRegistrationOptions {
	const server = new McpServer({ name: "test", version: "0.0.1" });
	const client = new ApiClient({
		baseUrl: "http://localhost:3100",
		apiKey: "test-key",
	});
	return {
		server,
		context: { client, hasMasterKey: false },
	};
}

describe("mcp-vault tool registration", () => {
	test("vault tools register without error", () => {
		const options = createTestOptions();
		expect(() => registerVaultTools(options)).not.toThrow();
	});

	test("all tools register on single server", () => {
		const options = createTestOptions();
		registerVaultTools(options);
		// If we get here without error, all tools registered successfully
		expect(true).toBe(true);
	});

	test("the vault tool surface has no UNGATED plaintext path (never-see guarantee)", () => {
		const names: string[] = [];
		const server = new McpServer({ name: "test", version: "0.0.1" });
		// biome-ignore lint/suspicious/noExplicitAny: test shim over the SDK signature
		server.registerTool = ((name: string) => {
			names.push(name);
			return undefined as unknown as ReturnType<typeof server.registerTool>;
		}) as typeof server.registerTool;
		const client = new ApiClient({
			baseUrl: "http://localhost:3100",
			apiKey: "test-key",
		});
		registerVaultTools({ server, context: { client, hasMasterKey: false } });

		// The exact, closed set. Adding ANY new tool must be a deliberate change to
		// this list — especially one that could return plaintext.
		expect([...names].sort()).toEqual(
			[
				"vault_provision",
				"vault_credential_create",
				"vault_credential_delete",
				"vault_credential_get",
				"vault_credential_get_totp",
				"vault_credential_list",
				"vault_credential_search",
				"vault_credential_update",
				"vault_credential_use",
				"vault_exchange_token_for_injection",
			].sort(),
		);
		// The ONLY tool that returns plaintext is the injection exchange, and it is
		// gated at the API to injector credentials (master / vault:inject) — a plain
		// agent key gets 403, so an ordinary agent can never read a secret (see the
		// anima vault-use-broker integration gate tests). Every OTHER tool must not
		// be a reveal/unmask/export/token path by name.
		const GATED_PLAINTEXT = "vault_exchange_token_for_injection";
		for (const n of names) {
			if (n === GATED_PLAINTEXT) continue;
			expect(n).not.toMatch(/reveal|unmask|exchange|token|export/i);
		}
	});

	test("registers vault_credential_use", () => {
		const names = new Set<string>();
		const server = new McpServer({ name: "test", version: "0.0.1" });
		const realRegister = server.registerTool.bind(server);
		// biome-ignore lint/suspicious/noExplicitAny: test shim over the SDK signature
		server.registerTool = ((name: string, ...rest: any[]) => {
			names.add(name);
			// biome-ignore lint/suspicious/noExplicitAny: passthrough
			return (realRegister as any)(name, ...rest);
		}) as typeof server.registerTool;
		const client = new ApiClient({
			baseUrl: "http://localhost:3100",
			apiKey: "test-key",
		});
		registerVaultTools({ server, context: { client, hasMasterKey: false } });
		expect(names.has("vault_credential_use")).toBe(true);
	});

	test("vault_credential_use POSTs to /use with the request minus id", async () => {
		type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
		const calls: Array<{ path: string; body: unknown }> = [];
		const handlers: Record<string, ToolHandler> = {};

		const client = new ApiClient({
			baseUrl: "http://localhost:3100",
			apiKey: "test-key",
		});
		// biome-ignore lint/suspicious/noExplicitAny: stub the network layer
		(client as any).post = async (path: string, body: unknown) => {
			calls.push({ path, body });
			return { status: 200, headers: {}, body: "{}", truncated: false };
		};

		const server = new McpServer({ name: "test", version: "0.0.1" });
		// biome-ignore lint/suspicious/noExplicitAny: test shim over the SDK signature
		server.registerTool = ((name: string, _cfg: unknown, h: ToolHandler) => {
			handlers[name] = h;
			return undefined as unknown as ReturnType<typeof server.registerTool>;
		}) as typeof server.registerTool;

		registerVaultTools({ server, context: { client, hasMasterKey: false } });

		const handler = handlers.vault_credential_use;
		expect(handler).toBeDefined();

		await handler({
			id: "cred/with spaces",
			method: "POST",
			url: "https://api.example.com/charge",
			headers: { "X-Idempotency": "1" },
			body: "{}",
		});

		expect(calls).toHaveLength(1);
		// id is URL-encoded into the path and dropped from the body.
		expect(calls[0].path).toBe(
			"/v1/vault/credentials/cred%2Fwith%20spaces/use",
		);
		const body = calls[0].body as Record<string, unknown>;
		expect(body.id).toBeUndefined();
		expect(body.method).toBe("POST");
		expect(body.url).toBe("https://api.example.com/charge");
		expect(body.headers).toEqual({ "X-Idempotency": "1" });
	});
});
