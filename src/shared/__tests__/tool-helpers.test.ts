import { describe, test, expect } from "bun:test";
import {
	requiresMasterKey,
	toolSuccess,
	toolError,
	withErrorHandling,
	requireMasterKeyGuard,
	type ToolContext,
} from "../tool-helpers.js";
import { ApiClient } from "../api-client.js";

const mockContext: ToolContext = {
	client: new ApiClient({ baseUrl: "http://localhost", apiKey: "test" }),
	hasMasterKey: false,
};

describe("requiresMasterKey", () => {
	test("returns true for master key tools", () => {
		expect(requiresMasterKey("agent_delete")).toBe(true);
		expect(requiresMasterKey("domain_create")).toBe(true);
		expect(requiresMasterKey("domain_delete")).toBe(true);
	});

	test("returns false for normal tools", () => {
		expect(requiresMasterKey("agent_get")).toBe(false);
		expect(requiresMasterKey("email_send")).toBe(false);
	});
});

describe("toolSuccess", () => {
	test("formats object as JSON", () => {
		const result = toolSuccess({ foo: "bar" });
		expect(result.content[0].type).toBe("text");
		expect(result.content[0].text).toContain('"foo"');
	});

	test("passes string through directly", () => {
		const result = toolSuccess("hello");
		expect(result.content[0].text).toBe("hello");
	});

	test("emits structuredContent for object data (MCP spec 2025-11-25)", () => {
		const result = toolSuccess({ foo: "bar", n: 1 });
		expect(result.structuredContent).toEqual({ foo: "bar", n: 1 });
	});

	test("wraps array in { items } for structuredContent", () => {
		const result = toolSuccess([1, 2, 3]);
		expect(result.structuredContent).toEqual({ items: [1, 2, 3] });
	});

	test("omits structuredContent for string data", () => {
		const result = toolSuccess("hello");
		expect(result.structuredContent).toBeUndefined();
	});

	test("omits structuredContent for null/undefined", () => {
		expect(toolSuccess(null).structuredContent).toBeUndefined();
		expect(toolSuccess(undefined).structuredContent).toBeUndefined();
	});

	test("wraps primitives as { value }", () => {
		expect(toolSuccess(42).structuredContent).toEqual({ value: 42 });
		expect(toolSuccess(true).structuredContent).toEqual({ value: true });
	});
});

describe("toolError", () => {
	test("formats error with isError flag", () => {
		const result = toolError("something broke");
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe("Error: something broke");
	});
});

describe("withErrorHandling", () => {
	test("passes through successful results", async () => {
		const handler = withErrorHandling(
			async () => toolSuccess("ok"),
			mockContext,
		);
		const result = await handler({});
		expect(result.content[0].text).toBe("ok");
		expect(result.isError).toBeUndefined();
	});

	test("catches errors and formats as tool error", async () => {
		const handler = withErrorHandling(
			async () => {
				throw new Error("boom");
			},
			mockContext,
		);
		const result = await handler({});
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("boom");
	});
});

describe("requireMasterKeyGuard", () => {
	test("throws when no master key", () => {
		expect(() => requireMasterKeyGuard(mockContext)).toThrow("ANIMA_MASTER_KEY");
	});

	test("does not throw when master key present", () => {
		const ctx = { ...mockContext, hasMasterKey: true };
		expect(() => requireMasterKeyGuard(ctx)).not.toThrow();
	});
});
