import { describe, expect, test } from "bun:test";
import { webhookSetInput } from "../webhook/index.js";

describe("webhook_set input schema — advanced settings parity", () => {
	test("accepts a bearer authConfig plus throttle fields", () => {
		const parsed = webhookSetInput.parse({
			url: "https://example.com/hook",
			events: ["message.received"],
			authConfig: { type: "bearer", token: "tok_123" },
			rateLimitPerMinute: 60,
			maxAttempts: 5,
		});
		expect(parsed.authConfig).toEqual({ type: "bearer", token: "tok_123" });
		expect(parsed.rateLimitPerMinute).toBe(60);
		expect(parsed.maxAttempts).toBe(5);
	});

	test("accepts a custom_header authConfig", () => {
		const parsed = webhookSetInput.parse({
			authConfig: { type: "custom_header", headerName: "X-My-Secret", value: "s3cr3t" },
		});
		expect(parsed.authConfig).toEqual({
			type: "custom_header",
			headerName: "X-My-Secret",
			value: "s3cr3t",
		});
	});

	test("accepts { type: 'none' } to clear auth", () => {
		expect(webhookSetInput.parse({ authConfig: { type: "none" } }).authConfig).toEqual({
			type: "none",
		});
	});

	test("rejects an unknown authConfig type", () => {
		expect(() => webhookSetInput.parse({ authConfig: { type: "oauth" } })).toThrow();
	});

	test("rejects a bearer authConfig missing its token", () => {
		expect(() => webhookSetInput.parse({ authConfig: { type: "bearer" } })).toThrow();
	});

	test("stays backward-compatible when no auth/throttle fields are given", () => {
		const parsed = webhookSetInput.parse({
			url: "https://example.com/h",
			events: ["message.sent"],
		});
		expect(parsed.authConfig).toBeUndefined();
		expect(parsed.rateLimitPerMinute).toBeUndefined();
	});
});
