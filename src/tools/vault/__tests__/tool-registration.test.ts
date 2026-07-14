import { describe, expect, test } from "bun:test";
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

	test("the vault tool surface is a closed, reviewed set (adding a tool trips this lock)", () => {
		// This lock is MEMBERSHIP + NAME-level: it fails if an unexpected tool
		// registers or a reveal/unmask/export/token-named tool appears. The
		// BEHAVIORAL never-see guarantee (responses are actually masked) is proven
		// in credential-masking.test.ts and the anima vault-use-broker API gate.
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

		// The closed CORE set: every one of these must register. Adding ANY new
		// tool must be a deliberate change to this list — especially one that
		// could return plaintext.
		const CORE = [
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
		];
		// Tolerated (not required) so this test composes with the
		// credential-request branch (mcp-server #38) in either merge order.
		// All four are secret-INGEST or status paths — none returns plaintext
		// (request_fill is widget-only, visibility ["app"], and answers with a
		// status message; the secret travels to /vault/fill/{token}).
		const ALLOWED_WITH_38 = [
			"vault_credential_request_create",
			"vault_credential_request_status",
			"vault_credential_request_cancel",
			"vault_credential_request_fill",
		];
		const allowed = new Set([...CORE, ...ALLOWED_WITH_38]);
		for (const tool of CORE) {
			expect(names).toContain(tool);
		}
		for (const n of names) {
			expect(
				allowed.has(n),
				`unexpected vault tool "${n}" — extending the surface must be a deliberate edit to this lock test`,
			).toBe(true);
		}
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

	test("vault_credential_create forwards api_key payloads (broker config) and masks the response", async () => {
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
			// Echo back what a create would return, plaintext included — the
			// tool must re-mask it before it reaches the model.
			return {
				id: "cred_1",
				type: "api_key",
				apiKey: { provider: "stripe", key: "sk_live_SUPERSECRET1234" },
			};
		};

		const server = new McpServer({ name: "test", version: "0.0.1" });
		// biome-ignore lint/suspicious/noExplicitAny: test shim over the SDK signature
		server.registerTool = ((name: string, _cfg: unknown, h: ToolHandler) => {
			handlers[name] = h;
			return undefined as unknown as ReturnType<typeof server.registerTool>;
		}) as typeof server.registerTool;

		registerVaultTools({ server, context: { client, hasMasterKey: false } });

		const result = await handlers.vault_credential_create({
			type: "api_key",
			name: "Stripe key",
			apiKey: {
				provider: "stripe",
				key: "sk_live_SUPERSECRET1234",
				allowedHosts: ["api.stripe.com"],
				authScheme: "Bearer ",
			},
			revealPolicy: "brokered",
		});

		// The full broker config reaches the API unchanged.
		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe("/v1/vault/credentials");
		const body = calls[0].body as {
			apiKey: Record<string, unknown>;
			revealPolicy: string;
		};
		expect(body.apiKey.allowedHosts).toEqual(["api.stripe.com"]);
		expect(body.revealPolicy).toBe("brokered");

		// The plaintext key never reaches the model: masked on the way out.
		const text = JSON.stringify(result);
		expect(text).not.toContain("sk_live_SUPERSECRET1234");
		expect(text).toContain("1234"); // masked form keeps the tail
	});

	test("vault_credential_list re-masks secret sections in returned items", async () => {
		type ToolHandler = (args: Record<string, unknown>) => Promise<unknown>;
		const handlers: Record<string, ToolHandler> = {};

		const client = new ApiClient({
			baseUrl: "http://localhost:3100",
			apiKey: "test-key",
		});
		// biome-ignore lint/suspicious/noExplicitAny: stub the network layer
		(client as any).get = async () => ({
			items: [
				{
					id: "cred_1",
					type: "api_key",
					apiKey: { provider: "stripe", key: "sk_live_SUPERSECRET1234" },
				},
			],
		});

		const server = new McpServer({ name: "test", version: "0.0.1" });
		// biome-ignore lint/suspicious/noExplicitAny: test shim over the SDK signature
		server.registerTool = ((name: string, _cfg: unknown, h: ToolHandler) => {
			handlers[name] = h;
			return undefined as unknown as ReturnType<typeof server.registerTool>;
		}) as typeof server.registerTool;

		registerVaultTools({ server, context: { client, hasMasterKey: false } });

		const result = await handlers.vault_credential_list({});
		// Defense-in-depth: even if the API leaked plaintext in a bulk listing,
		// the tool re-masks every item before it reaches the model.
		const text = JSON.stringify(result);
		expect(text).not.toContain("sk_live_SUPERSECRET1234");
		expect(text).toContain("1234"); // masked form keeps the tail
	});
});
