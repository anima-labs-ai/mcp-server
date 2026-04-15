import { describe, test, expect } from "bun:test";
import { createMcpRateLimiter } from "../rate-limiter.js";

describe("McpRateLimiter", () => {
	test("allows requests within per-minute limit", () => {
		const limiter = createMcpRateLimiter({ toolCallsPerMinute: 3, toolCallsPerHour: 100 });
		expect(limiter.checkToolCall("key1").allowed).toBe(true);
		expect(limiter.checkToolCall("key1").allowed).toBe(true);
		expect(limiter.checkToolCall("key1").allowed).toBe(true);
		expect(limiter.checkToolCall("key1").allowed).toBe(false);
	});

	test("tracks remaining count for requests", () => {
		const limiter = createMcpRateLimiter({ requestsPerMinute: 5 });
		const r1 = limiter.checkRequest("key1");
		expect(r1.remaining).toBe(4);
		const r2 = limiter.checkRequest("key1");
		expect(r2.remaining).toBe(3);
	});

	test("isolates keys", () => {
		const limiter = createMcpRateLimiter({ toolCallsPerMinute: 2, toolCallsPerHour: 100 });
		limiter.checkToolCall("key1");
		limiter.checkToolCall("key1");
		expect(limiter.checkToolCall("key1").allowed).toBe(false);
		expect(limiter.checkToolCall("key2").allowed).toBe(true);
	});

	test("session creation limit", () => {
		const limiter = createMcpRateLimiter({ sessionsPerKey: 2 });
		expect(limiter.checkSessionCreation("key1", 0).allowed).toBe(true);
		expect(limiter.checkSessionCreation("key1", 1).allowed).toBe(true);
		expect(limiter.checkSessionCreation("key1", 2).allowed).toBe(false);
	});

	test("request rate limit", () => {
		const limiter = createMcpRateLimiter({ requestsPerMinute: 2 });
		expect(limiter.checkRequest("key1").allowed).toBe(true);
		expect(limiter.checkRequest("key1").allowed).toBe(true);
		expect(limiter.checkRequest("key1").allowed).toBe(false);
	});

	test("reset clears all windows for a key", () => {
		const limiter = createMcpRateLimiter({ toolCallsPerMinute: 1, toolCallsPerHour: 100 });
		limiter.checkToolCall("key1");
		expect(limiter.checkToolCall("key1").allowed).toBe(false);
		limiter.reset("key1");
		expect(limiter.checkToolCall("key1").allowed).toBe(true);
	});

	test("returns retryAfterMs when rate limited", () => {
		const limiter = createMcpRateLimiter({ toolCallsPerMinute: 1, toolCallsPerHour: 100 });
		limiter.checkToolCall("key1");
		const result = limiter.checkToolCall("key1");
		expect(result.allowed).toBe(false);
		expect(result.retryAfterMs).toBeGreaterThan(0);
	});
});
