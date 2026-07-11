import { describe, test, expect } from "bun:test";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import { runCredentialRequestCreate } from "../vault/index.js";

/**
 * Branch coverage for the form-first elicitation path in
 * vault_credential_request_create (runCredentialRequestCreate).
 *
 * These tests encode the WHY, not just the WHAT:
 *   - the secret the human types must NEVER appear in the tool's returned
 *     content — it goes only to the fill endpoint. A test that just checked
 *     "returns FULFILLED" could pass while leaking the secret; we assert the
 *     serialized result does not contain it.
 *   - email is sent ONLY when no inline dialog is viable (notifyOwner is the
 *     observable proxy for "did we fall back to the link").
 *   - each elicitation action maps to its documented terminal state +
 *     side-effect (fill / cancel / leave-open).
 */

const SECRET = "hunter2-super-secret";

type Call = { method: string; path: string; body?: unknown };

/**
 * Build a fake ToolRegistrationOptions whose ApiClient records calls and whose
 * McpServer reports the given declared `elicitation` capability.
 */
function makeOptions(opts: {
	elicitationDeclared?: boolean;
	/**
	 * Exact `elicitation` capability value to report (overrides
	 * `elicitationDeclared`). Use `{ form: {} }` / `{ url: {} }` to model
	 * elicitation sub-modes; `null` to report no elicitation capability at all.
	 */
	elicitationCap?: Record<string, unknown> | null;
	createResult?: Record<string, unknown>;
	getResult?: Record<string, unknown>;
	onFill?: (body: unknown) => void;
}): { options: ToolRegistrationOptions; calls: Call[] } {
	const calls: Call[] = [];
	const createResult = opts.createResult ?? {
		requestId: "req_123",
		fillUrl: "https://vault.useanima.sh/fill/tok_abc",
		status: "PENDING",
		emailSent: !opts.elicitationDeclared,
	};
	const getResult = opts.getResult ?? {
		status: "FULFILLED",
		credentialId: "cred_999",
		maskedPreview: "****er2",
	};

	const client = {
		async post(path: string, body?: unknown) {
			calls.push({ method: "POST", path, body });
			if (path.includes("/vault/fill/")) {
				opts.onFill?.(body);
				return { ok: true };
			}
			if (path.endsWith("/cancel")) return { status: "CANCELLED" };
			if (path === "/v1/vault/credential-requests") return createResult;
			return {};
		},
		async get(path: string) {
			calls.push({ method: "GET", path });
			return getResult;
		},
	};

	const server = {
		server: {
			getClientCapabilities() {
				if (opts.elicitationCap !== undefined) {
					return opts.elicitationCap === null
						? {}
						: { elicitation: opts.elicitationCap };
				}
				return opts.elicitationDeclared ? { elicitation: {} } : {};
			},
		},
	};

	const options = {
		server,
		context: { client, hasMasterKey: false },
		// biome-ignore lint/suspicious/noExplicitAny: hand-rolled doubles for ApiClient + McpServer; only the methods under test are stubbed.
	} as any as ToolRegistrationOptions;

	return { options, calls };
}

/** A fake `extra` whose sendRequest yields a fixed elicitation outcome. */
function makeExtra(outcome:
	| { action: "accept"; content: Record<string, unknown> }
	| { action: "decline" }
	| { action: "cancel" }
	| { throws: Error },
): { sendRequest: (req: unknown, schema: unknown, options?: unknown) => Promise<unknown> } {
	return {
		async sendRequest() {
			if ("throws" in outcome) throw outcome.throws;
			return outcome;
		},
	};
}

const baseArgs = {
	type: "login" as const,
	name: "Acme prod login",
	reason: "needed to file the weekly report",
};

function serialize(result: { content: Array<{ text: string }> }): string {
	return result.content.map((c) => c.text).join("\n");
}

describe("vault_credential_request_create — form-first elicitation", () => {
	test("no elicitation capability → baseline: notifyOwner=true, returns create result verbatim, no form shown", async () => {
		const { options, calls } = makeOptions({ elicitationDeclared: false });
		let elicitCalled = false;
		const extra = {
			async sendRequest() {
				elicitCalled = true;
				return { action: "cancel" };
			},
		};

		const result = await runCredentialRequestCreate(baseArgs, options, extra);

		expect(elicitCalled).toBe(false); // never elicit without the declared cap
		const create = calls.find((c) => c.path === "/v1/vault/credential-requests");
		expect((create?.body as { notifyOwner?: boolean }).notifyOwner).toBe(true);
		expect(serialize(result)).toContain("PENDING");
	});

	test("url-only elicitation (Claude Desktop declares { url: {} }) → baseline: never sends a form-mode request, notifyOwner=true", async () => {
		// A client that advertises ONLY url-mode elicitation cannot render the
		// inline secret form. Sending it a form-mode `elicitation/create` is a
		// request it never agreed to handle, so we must route to the baseline
		// link/email path instead — the same as a client with no elicitation.
		const { options, calls } = makeOptions({ elicitationCap: { url: {} } });
		let elicitCalled = false;
		const extra = {
			async sendRequest() {
				elicitCalled = true;
				return { action: "cancel" };
			},
		};

		const result = await runCredentialRequestCreate(baseArgs, options, extra);

		expect(elicitCalled).toBe(false);
		const create = calls.find((c) => c.path === "/v1/vault/credential-requests");
		expect((create?.body as { notifyOwner?: boolean }).notifyOwner).toBe(true);
		expect(serialize(result)).toContain("PENDING");
	});

	test("form+url elicitation (Inspector 0.22 declares { form: {}, url: {} }) → inline form is shown", async () => {
		const { options, calls } = makeOptions({
			elicitationCap: { form: {}, url: {} },
		});
		const extra = makeExtra({
			action: "accept",
			content: { username: "svc-acme", password: SECRET },
		});

		const result = await runCredentialRequestCreate(baseArgs, options, extra);

		// Form was viable → no owner email, secret went to the fill endpoint.
		const create = calls.find((c) => c.path === "/v1/vault/credential-requests");
		expect((create?.body as { notifyOwner?: boolean }).notifyOwner).toBe(false);
		expect(calls.some((c) => c.path.includes("/vault/fill/"))).toBe(true);
		expect(serialize(result)).toContain("FULFILLED");
	});

	test("accept → POSTs secret to fill endpoint, returns FULFILLED with credentialId, and the secret is NOT in the result", async () => {
		let filledBody: unknown;
		const { options, calls } = makeOptions({
			elicitationDeclared: true,
			onFill: (b) => {
				filledBody = b;
			},
		});
		const extra = makeExtra({
			action: "accept",
			content: { username: "svc-acme", password: SECRET },
		});

		const result = await runCredentialRequestCreate(baseArgs, options, extra);
		const text = serialize(result);

		// Owner NOT emailed while inline dialog was viable.
		const create = calls.find((c) => c.path === "/v1/vault/credential-requests");
		expect((create?.body as { notifyOwner?: boolean }).notifyOwner).toBe(false);

		// Secret travelled ONLY to the fill endpoint.
		const fill = calls.find((c) => c.path.includes("/vault/fill/"));
		expect(fill).toBeDefined();
		expect(fill?.path).toContain("tok_abc"); // token parsed from fillUrl
		expect((filledBody as { password?: string }).password).toBe(SECRET);

		// Result carries only the reference + masked preview — never the secret.
		expect(text).toContain("FULFILLED");
		expect(text).toContain("cred_999");
		expect(text).not.toContain(SECRET);
		expect(text).not.toContain("svc-acme");
	});

	test("decline → cancels the request, returns DECLINED, never hits the fill endpoint", async () => {
		const { options, calls } = makeOptions({ elicitationDeclared: true });
		const extra = makeExtra({ action: "decline" });

		const result = await runCredentialRequestCreate(baseArgs, options, extra);

		expect(calls.some((c) => c.path.includes("/vault/fill/"))).toBe(false);
		expect(calls.some((c) => c.path.endsWith("/cancel"))).toBe(true);
		expect(serialize(result)).toContain("DECLINED");
	});

	test("cancel/dismiss → leaves request open, returns PENDING + fillUrl, no fill, no cancel", async () => {
		const { options, calls } = makeOptions({ elicitationDeclared: true });
		const extra = makeExtra({ action: "cancel" });

		const result = await runCredentialRequestCreate(baseArgs, options, extra);
		const text = serialize(result);

		expect(calls.some((c) => c.path.includes("/vault/fill/"))).toBe(false);
		expect(calls.some((c) => c.path.endsWith("/cancel"))).toBe(false);
		expect(text).toContain("PENDING");
		expect(text).toContain("https://vault.useanima.sh/fill/tok_abc");
	});

	test("runtime reject (-32600 / not supported / timeout) → PENDING + fillUrl fallback, no leak of elicit error", async () => {
		const { options, calls } = makeOptions({ elicitationDeclared: true });
		const extra = makeExtra({
			throws: new Error("MCP error -32600: Elicitation not supported"),
		});

		const result = await runCredentialRequestCreate(baseArgs, options, extra);
		const text = serialize(result);

		expect(calls.some((c) => c.path.includes("/vault/fill/"))).toBe(false);
		expect(text).toContain("PENDING");
		expect(text).toContain("https://vault.useanima.sh/fill/tok_abc");
		// We don't surface the raw elicitation error text to the agent.
		expect(text).not.toContain("-32600");
	});

	test("explicit notifyOwner override is honored even when elicitation is declared", async () => {
		const { options, calls } = makeOptions({ elicitationDeclared: true });
		const extra = makeExtra({ action: "cancel" });

		await runCredentialRequestCreate(
			{ ...baseArgs, notifyOwner: true },
			options,
			extra,
		);

		const create = calls.find((c) => c.path === "/v1/vault/credential-requests");
		expect((create?.body as { notifyOwner?: boolean }).notifyOwner).toBe(true);
	});
});
