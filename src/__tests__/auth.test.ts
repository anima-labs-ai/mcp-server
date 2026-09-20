import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { IncomingMessage } from "node:http";
import { makeAuthenticator } from "../auth.js";

let orgMeCalls = 0;
let orgListCalls = 0;

const server = Bun.serve({
	port: 0,
	fetch(req) {
		const url = new URL(req.url);
		const auth = req.headers.get("authorization") ?? "";
		const token = auth.replace(/^Bearer\s+/i, "");

		if (url.pathname === "/v1/orgs/me") {
			orgMeCalls += 1;
			if (token.includes("me-ok")) {
				return Response.json({ id: "org_me" });
			}
			if (token.includes("paginated")) {
				return Response.json({ message: "Endpoint unavailable" }, { status: 404 });
			}
			if (token.includes("upstream-flaky")) {
				return Response.json({ message: "Temporary upstream issue" }, { status: 503 });
			}
			return Response.json({ message: "Unauthorized" }, { status: 401 });
		}

		if (url.pathname === "/v1/orgs") {
			orgListCalls += 1;
			if (token.includes("paginated")) {
				return Response.json({
					items: [{ id: "org_from_items" }],
					pagination: { cursor: null },
				});
			}
			if (token.includes("upstream-flaky")) {
				return Response.json({ message: "Temporary upstream issue" }, { status: 503 });
			}
			if (token.includes("me-ok")) {
				return Response.json([{ id: "org_from_list" }]);
			}
			return Response.json({ message: "Unauthorized" }, { status: 401 });
		}

		return Response.json({ message: "Not found" }, { status: 404 });
	},
});

afterAll(() => server.stop());

beforeEach(() => {
	orgMeCalls = 0;
	orgListCalls = 0;
});

function makeRequest(token?: string): IncomingMessage {
	return {
		headers: token ? { authorization: `Bearer ${token}` } : {},
	} as IncomingMessage;
}

describe("makeAuthenticator", () => {
	const authenticate = makeAuthenticator(`http://localhost:${server.port}`);

	test("uses /v1/orgs/me success and skips /v1/orgs fallback probe", async () => {
		const context = await authenticate(makeRequest("oat_me-ok"));
		expect(context.orgId).toBe("org_me");
		expect(orgMeCalls).toBe(1);
		expect(orgListCalls).toBe(0);
	});

	test("accepts paginated /v1/orgs shape for OAuth tokens", async () => {
		const context = await authenticate(makeRequest("oat_paginated_token"));
		expect(context.orgId).toBe("org_from_items");
		expect(orgMeCalls).toBe(1);
		expect(orgListCalls).toBe(1);
	});

	test("accepts paginated /v1/orgs shape for API-key tokens", async () => {
		const context = await authenticate(makeRequest("ak_paginated_token"));
		expect(context.orgId).toBe("org_from_items");
		expect(orgMeCalls).toBe(1);
		expect(orgListCalls).toBe(1);
	});

	test("does not fail auth when probes have non-auth upstream errors", async () => {
		const context = await authenticate(makeRequest("oat_upstream-flaky"));
		expect(context.orgId).toBe("default");
		expect(orgMeCalls).toBe(1);
		expect(orgListCalls).toBe(1);
	});

	test("fails closed on real API 401 auth errors", async () => {
		await expect(authenticate(makeRequest("oat_unauthorized"))).rejects.toEqual(
			expect.objectContaining({
				status: 401,
				message: "Invalid or expired credentials",
			}),
		);
		expect(orgMeCalls).toBe(1);
		expect(orgListCalls).toBe(1);
	});
});
