import { describe, test, expect, afterAll } from "bun:test";
import { ApiClient, ApiError, createApiClientFromEnv } from "../api-client.js";

// Mock HTTP server
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const url = new URL(req.url);

		if (url.pathname === "/test/ok") {
			return Response.json({ result: "success" });
		}
		if (url.pathname === "/test/text") {
			return new Response("plain text", { headers: { "content-type": "text/plain" } });
		}
		if (url.pathname === "/test/no-content") {
			return new Response(null, { status: 204 });
		}
		if (url.pathname === "/test/error") {
			return Response.json({ message: "Not found" }, { status: 404 });
		}
		if (url.pathname === "/test/post") {
			const body = await req.json();
			return Response.json({ echo: body });
		}
		if (url.pathname === "/test/auth") {
			const auth = req.headers.get("authorization");
			return Response.json({ auth });
		}

		return Response.json({ error: "Not found" }, { status: 404 });
	},
});

afterAll(() => server.stop());

const baseUrl = `http://localhost:${server.port}`;

describe("ApiClient", () => {
	test("GET request returns JSON", async () => {
		const client = new ApiClient({ baseUrl, apiKey: "test-key" });
		const result = await client.get<{ result: string }>("/test/ok");
		expect(result.result).toBe("success");
	});

	test("GET request returns text for non-JSON", async () => {
		const client = new ApiClient({ baseUrl, apiKey: "test-key" });
		const result = await client.get<string>("/test/text");
		expect(result).toBe("plain text");
	});

	test("handles 204 no-content", async () => {
		const client = new ApiClient({ baseUrl, apiKey: "test-key" });
		const result = await client.get("/test/no-content");
		expect(result).toBeUndefined();
	});

	test("throws ApiError on non-ok response", async () => {
		const client = new ApiClient({ baseUrl, apiKey: "test-key" });
		try {
			await client.get("/test/error");
			expect(true).toBe(false); // should not reach
		} catch (err) {
			expect(err).toBeInstanceOf(ApiError);
			expect((err as ApiError).status).toBe(404);
			expect((err as ApiError).message).toBe("Not found");
		}
	});

	test("POST sends JSON body", async () => {
		const client = new ApiClient({ baseUrl, apiKey: "test-key" });
		const result = await client.post<{ echo: { foo: string } }>("/test/post", { foo: "bar" });
		expect(result.echo.foo).toBe("bar");
	});

	test("sends Bearer token in Authorization header", async () => {
		const client = new ApiClient({ baseUrl, apiKey: "my-secret-key" });
		const result = await client.get<{ auth: string }>("/test/auth");
		expect(result.auth).toBe("Bearer my-secret-key");
	});

	test("uses master key when requested", async () => {
		const client = new ApiClient({ baseUrl, apiKey: "normal", masterKey: "master" });
		const result = await client.get<{ auth: string }>("/test/auth", { useMasterKey: true });
		expect(result.auth).toBe("Bearer master");
	});

	test("hasMasterKey returns true when master key set", () => {
		const client = new ApiClient({ baseUrl, apiKey: "key", masterKey: "mk" });
		expect(client.hasMasterKey()).toBe(true);
	});

	test("hasMasterKey returns false when no master key", () => {
		const client = new ApiClient({ baseUrl, apiKey: "key" });
		expect(client.hasMasterKey()).toBe(false);
	});

	test("strips trailing slash from baseUrl", async () => {
		const client = new ApiClient({ baseUrl: baseUrl + "/", apiKey: "key" });
		const result = await client.get<{ result: string }>("/test/ok");
		expect(result.result).toBe("success");
	});
});

describe("createApiClientFromEnv", () => {
	test("creates client with defaults", () => {
		const original = process.env.ANIMA_API_KEY;
		process.env.ANIMA_API_KEY = "env-key";
		const client = createApiClientFromEnv();
		expect(client).toBeInstanceOf(ApiClient);
		process.env.ANIMA_API_KEY = original;
	});
});
