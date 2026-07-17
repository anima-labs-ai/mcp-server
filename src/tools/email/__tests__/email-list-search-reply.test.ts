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
	method: "GET" | "POST" | "PATCH";
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
	// biome-ignore lint/suspicious/noExplicitAny: test double.
	(client as any).patch = async (path: string, body: unknown) => {
		calls.push({ method: "PATCH", path, body });
		return { id: "msg_1", labels: ["read"] };
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

/** The text an LLM caller actually sees when a tool refuses. */
function errorText(result: unknown): string {
	return (
		(result as { content?: Array<{ text?: string }> })?.content
			?.map((c) => c.text ?? "")
			.join("\n") ?? ""
	);
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
		// Pinned: every param here must be one GET /email really accepts (B3 added
		// labels/includeSpam). The tool-contract gate proves that against the
		// contract snapshot; this pin keeps the list from growing unnoticed.
		expect(props.sort()).toEqual(["agentId", "cursor", "includeSpam", "labels", "limit"]);
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

// ---------------------------------------------------------------------------
// Spec item B3 — labels + read state on the MCP surface.
//
// Labels are the agent's workflow state machine: without them every list
// returns the same undifferentiated stream forever. The API shipped them in
// anima#307; these tests pin the client half — that the filters reach the wire
// in the shape the API actually reads, and that the one place the surface
// CANNOT honour them fails loudly instead of lying.
// ---------------------------------------------------------------------------
describe("email_label (B3): add/remove labels on one message", () => {
	test("PATCHes the message's labels route with both operations", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_label")?.({
			id: "clxmsg000000000000000000",
			addLabels: ["read", "urgent"],
			removeLabels: ["unread"],
		});

		expect(calls).toHaveLength(1);
		expect(calls[0]).toMatchObject({
			method: "PATCH",
			path: "/v1/messages/clxmsg000000000000000000/labels",
			body: { addLabels: ["read", "urgent"], removeLabels: ["unread"] },
		});
	});

	test("omits the operation the caller did not ask for", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_label")?.({
			id: "clxmsg000000000000000000",
			addLabels: ["archived"],
		});

		const body = calls[0].body as Record<string, unknown>;
		// Sending removeLabels:[] would be a no-op the API still has to process;
		// more importantly the absent key is what "leave the rest alone" means.
		expect("removeLabels" in body).toBe(false);
		expect(body.addLabels).toEqual(["archived"]);
	});

	test("a call with neither add nor remove is refused, not silently successful", async () => {
		const { handlers, calls } = buildHarness();
		// The failure this prevents: an LLM "marks the message read", gets a
		// success back, and the labels never changed.
		const result = await handlers.get("email_label")?.({ id: "clxmsg000000000000000000" });

		expect(isError(result)).toBe(true);
		expect(errorText(result)).toMatch(/at least one of `addLabels` or `removeLabels`/);
		// Refused before the wire, not by the API rejecting it.
		expect(calls).toHaveLength(0);
	});

	test("the message id is URL-encoded into the path", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_label")?.({ id: "a/../b", addLabels: ["x"] });

		// A raw id would let a crafted value walk the path to another route.
		expect(calls[0].path).toBe("/v1/messages/a%2F..%2Fb/labels");
	});
});

describe("email_list (B3): label filters reach the wire", () => {
	test("each label becomes its own `labels=` key", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_list")?.({ labels: ["urgent", "unread"] });

		// The repeated-key form is what the API reads as an array. `set` would keep
		// only the last label, quietly widening "urgent AND unread" to "unread" and
		// returning MORE mail than asked for — a filter that under-filters in
		// silence is worse than one that errors.
		const url = new URL(`http://x${calls[0].path}`);
		expect(url.searchParams.getAll("labels")).toEqual(["urgent", "unread"]);
	});

	test("a single label survives as a lone value (anima#309)", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_list")?.({ labels: ["unread"] });

		// `?labels=unread` 400'd until the contract accepted a lone value; this is
		// the single most common label call, so it is pinned explicitly.
		expect(calls[0].path).toBe("/v1/email?labels=unread");
	});

	test("includeSpam is sent only when the caller decides", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_list")?.({});
		expect(calls[0].path).toBe("/v1/email");

		await handlers.get("email_list")?.({ includeSpam: true });
		// Must serialise as the string the API parses as boolean true, not "on"/"1".
		expect(calls[1].path).toBe("/v1/email?includeSpam=true");

		await handlers.get("email_list")?.({ includeSpam: false });
		// Explicit false must still be transmitted — it is the caller overriding,
		// and `if (args.includeSpam)` would drop it.
		expect(calls[2].path).toBe("/v1/email?includeSpam=false");
	});
});

describe("email_search (B3): labels in fulltext, refused in semantic", () => {
	test("fulltext mode nests labels into the search filters", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_search")?.({
			query: "invoice",
			labels: ["unread"],
			includeSpam: true,
		});

		expect(calls[0]).toMatchObject({
			method: "POST",
			path: "/v1/messages/search",
			body: { filters: { channel: "EMAIL", labels: ["unread"], includeSpam: true } },
		});
	});

	test("semantic mode REFUSES labels instead of dropping them", async () => {
		const { handlers, calls } = buildHarness();
		// POST /messages/search/semantic accepts only query/agentId/limit/threshold,
		// so labels would be zod-stripped and the caller told its filter applied
		// while every label was ignored. The contract gate cannot catch this — it
		// unions the props of both search routes and fulltext does accept labels —
		// so the refusal is the only thing standing between the LLM and a lie.
		const result = await handlers.get("email_search")?.({
			query: "invoice",
			mode: "semantic",
			labels: ["unread"],
		});

		expect(isError(result)).toBe(true);
		expect(errorText(result)).toMatch(/does not support `labels`\/`includeSpam` in semantic mode/);
		expect(calls).toHaveLength(0);
	});

	test("semantic mode refuses includeSpam too, including an explicit false", async () => {
		const { handlers, calls } = buildHarness();
		// `includeSpam: false` looks harmless but is still a filter the semantic
		// route cannot honour: it returns spam regardless. Accepting it would be
		// the same lie in a quieter voice, so `!== undefined` is the right test and
		// a falsy check would be the bug.
		const result = await handlers.get("email_search")?.({
			query: "invoice",
			mode: "semantic",
			includeSpam: false,
		});

		expect(isError(result)).toBe(true);
		expect(calls).toHaveLength(0);
	});

	test("semantic mode without labels still works", async () => {
		const { handlers, calls } = buildHarness();
		await handlers.get("email_search")?.({ query: "invoice", mode: "semantic" });

		// The refusal must be scoped to the label params, not break semantic search.
		expect(calls[0]).toMatchObject({ path: "/v1/messages/search/semantic" });
	});
});
