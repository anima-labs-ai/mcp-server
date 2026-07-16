import { describe, expect, test } from "bun:test";
import { ApiClient, type ToolRegistrationOptions } from "../../../shared/index.js";
import { registerEmailTools } from "../email/index.js";

// ---------------------------------------------------------------------------
// Spec items C7 + B11 (OPENSPEC-COMPETITIVE-PARITY-2026-07).
//
// C7: email_list's old `folder`/`offset` params were fictional — the API
// zod-stripped them, so "pagination" silently returned page one forever and
// "folder" filtered nothing. The real contract (GET /email) paginates by
// cursor and filters by agentId. These tests pin the honest surface: the
// params that exist reach the wire, and the fictional ones are gone.
//
// C7: email_reply carried a hardcoded master-key guard that MASTER_KEY_TOOLS
// never listed — every agent-scoped key (the default for self-hosted/stdio)
// got "requires ANIMA_MASTER_KEY" on a plain reply. Reply must work with
// agent keys.
//
// B11: email_search exposes the search endpoints (fulltext + pgvector
// semantic) that previously had zero MCP exposure.
// ---------------------------------------------------------------------------

interface CapturedRequest {
	method: "GET" | "POST";
	path: string;
	body?: unknown;
}

function buildHarness(options?: { hasMasterKey?: boolean; getResponses?: unknown[] }) {
	const client = new ApiClient({ baseUrl: "http://localhost:3100", apiKey: "test-key" });
	const calls: CapturedRequest[] = [];
	const getResponses = [...(options?.getResponses ?? [])];
	// biome-ignore lint/suspicious/noExplicitAny: test double.
	(client as any).get = async (path: string) => {
		calls.push({ method: "GET", path });
		return getResponses.length > 0 ? getResponses.shift() : { items: [] };
	};
	// biome-ignore lint/suspicious/noExplicitAny: test double.
	(client as any).post = async (path: string, body: unknown) => {
		calls.push({ method: "POST", path, body });
		return { id: "msg_1", status: "SENT" };
	};

	const handlers = new Map<string, (args: Record<string, unknown>) => Promise<unknown>>();
	const schemas = new Map<string, Record<string, unknown>>();
	const fakeServer = {
		registerTool(
			name: string,
			config: { inputSchema?: Record<string, unknown> },
			handler: (args: Record<string, unknown>) => Promise<unknown>,
		) {
			handlers.set(name, handler);
			schemas.set(name, config.inputSchema ?? {});
		},
	};
	registerEmailTools({
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake — only registerTool is used.
		server: fakeServer as any,
		context: { client, hasMasterKey: options?.hasMasterKey ?? false },
	} as ToolRegistrationOptions);
	return { handlers, schemas, calls };
}

function isError(result: unknown): boolean {
	return !!(result as { isError?: boolean })?.isError;
}

describe("email_list (C7): real cursor pagination + agentId, no fictional params", () => {
	test("cursor, agentId, and limit reach GET /v1/email as query params", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_list")?.({
			agentId: "clxagent00000000000000000",
			cursor: "clxcursor0000000000000000",
			limit: 5,
		});

		expect(calls).toHaveLength(1);
		const url = new URL(calls[0].path, "http://x");
		expect(url.pathname).toBe("/v1/email");
		expect(url.searchParams.get("agentId")).toBe("clxagent00000000000000000");
		expect(url.searchParams.get("cursor")).toBe("clxcursor0000000000000000");
		expect(url.searchParams.get("limit")).toBe("5");
	});

	test("bare call hits GET /v1/email with no params", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_list")?.({});
		expect(calls[0].path).toBe("/v1/email");
	});

	test("the fictional folder/offset params are gone from the schema", () => {
		const { schemas } = buildHarness();
		const props = Object.keys(schemas.get("email_list") ?? {});
		// These were zod-stripped by the API — an LLM setting them got page
		// one of everything back while believing it filtered/paginated.
		expect(props).not.toContain("folder");
		expect(props).not.toContain("offset");
		expect(props.sort()).toEqual(["agentId", "cursor", "limit"]);
	});
});

describe("email_search (B11): fulltext + semantic modes", () => {
	test("default (fulltext) POSTs /v1/messages/search pinned to channel EMAIL", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_search")?.({ query: "invoice from acme" });

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/v1/messages/search",
			body: { query: "invoice from acme", filters: { channel: "EMAIL" } },
		});
		// No pagination key when neither cursor nor limit was passed — the
		// contract defaults apply server-side.
		expect((calls[0].body as Record<string, unknown>).pagination).toBeUndefined();
	});

	test("fulltext maps agentId into filters and cursor/limit into pagination", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_search")?.({
			query: "renewal",
			mode: "fulltext",
			agentId: "clxagent00000000000000000",
			cursor: "clxcursor0000000000000000",
			limit: 3,
		});

		expect(calls[0].body).toEqual({
			query: "renewal",
			filters: { channel: "EMAIL", agentId: "clxagent00000000000000000" },
			pagination: { cursor: "clxcursor0000000000000000", limit: 3 },
		});
	});

	test("semantic mode POSTs /v1/messages/search/semantic with threshold", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_search")?.({
			query: "emails about the contract renewal",
			mode: "semantic",
			agentId: "clxagent00000000000000000",
			limit: 7,
			threshold: 0.42,
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/v1/messages/search/semantic",
			body: {
				query: "emails about the contract renewal",
				agentId: "clxagent00000000000000000",
				limit: 7,
				threshold: 0.42,
			},
		});
		// The semantic contract has no cursor/filters — nothing extra leaks in.
		const body = calls[0].body as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual(["agentId", "limit", "query", "threshold"]);
	});

	test("semantic mode never sends fulltext-only params (cursor)", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_search")?.({
			query: "q",
			mode: "semantic",
			cursor: "clxcursor0000000000000000",
		});
		const body = calls[0].body as Record<string, unknown>;
		expect(body.cursor).toBeUndefined();
	});
});

describe("email_reply (C7): agent-scoped keys can reply", () => {
	const ORIGINAL_EMAIL = {
		id: "clxmail000000000000000000",
		direction: "INBOUND",
		fromAddress: "human@example.com",
		toAddress: "agent@agents.useanima.sh",
		subject: "Question",
		messageId: "<abc123@mail.example.com>",
	};

	test("reply succeeds WITHOUT a master key (self-hosted/stdio default)", async () => {
		const { handlers, calls } = buildHarness({
			hasMasterKey: false,
			getResponses: [ORIGINAL_EMAIL],
		});
		const result = await handlers.get("email_reply")?.({
			agentId: "clxagent00000000000000000",
			originalId: ORIGINAL_EMAIL.id,
			text: "Answer.",
		});

		// The old hardcoded requireMasterKeyGuard turned this into
		// "requires ANIMA_MASTER_KEY" — a guard MASTER_KEY_TOOLS never
		// listed. A reply is an agent-level operation and must not error.
		expect(isError(result)).toBe(false);
		expect(calls).toEqual([
			{ method: "GET", path: `/v1/email/${ORIGINAL_EMAIL.id}` },
			expect.objectContaining({
				method: "POST",
				path: "/v1/email/send",
				body: expect.objectContaining({
					to: ["human@example.com"],
					subject: "Re: Question",
					inReplyTo: ORIGINAL_EMAIL.messageId,
				}),
			}),
		]);
	});
});

describe("email_send (C7): contract headers exposed", () => {
	test("custom headers pass through to POST /v1/email/send verbatim", async () => {
		const { handlers, calls } = buildHarness();
		const headers = { "X-Campaign": "onboarding", "X-Priority": "1" };
		await handlers.get("email_send")?.({
			agentId: "clxagent00000000000000000",
			to: ["user@example.com"],
			subject: "Hello",
			body: "Hi",
			headers,
		});

		expect((calls[0].body as Record<string, unknown>).headers).toEqual(headers);
	});

	test("no headers key when the caller sends none", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_send")?.({
			agentId: "clxagent00000000000000000",
			to: ["user@example.com"],
			subject: "Hello",
			body: "Hi",
		});

		expect("headers" in (calls[0].body as Record<string, unknown>)).toBe(false);
	});
});
