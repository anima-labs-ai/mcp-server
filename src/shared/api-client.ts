/**
 * API Client for Anima MCP Servers
 *
 * HTTP client that communicates with the Anima REST API.
 * Used by all MCP tools to make API calls.
 */

export interface ApiClientConfig {
	baseUrl: string;
	apiKey: string;
	masterKey?: string;
	timeoutMs?: number;
}

export interface ApiResponse<T = unknown> {
	ok: boolean;
	status: number;
	data: T;
}

export class ApiError extends Error {
	constructor(
		public readonly status: number,
		public readonly statusText: string,
		public readonly body: unknown,
	) {
		const message =
			typeof body === "object" && body !== null && "message" in body
				? (body as { message: string }).message
				: `API error ${status}: ${statusText}`;
		super(message);
		this.name = "ApiError";
	}
}

export class ApiClient {
	private readonly baseUrl: string;
	private readonly apiKey: string;
	private readonly masterKey?: string;
	private readonly timeoutMs: number;

	constructor(config: ApiClientConfig) {
		this.baseUrl = config.baseUrl.replace(/\/$/, "");
		this.apiKey = config.apiKey;
		this.masterKey = config.masterKey;
		this.timeoutMs = config.timeoutMs ?? 30_000;
	}

	/**
	 * Make an API request to the Anima REST API.
	 */
	async request<T = unknown>(
		method: string,
		path: string,
		body?: unknown,
		options?: { useMasterKey?: boolean; timeoutMs?: number },
	): Promise<T> {
		const url = `${this.baseUrl}${path}`;
		const key =
			options?.useMasterKey && this.masterKey
				? this.masterKey
				: this.apiKey;
		const timeout = options?.timeoutMs ?? this.timeoutMs;

		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);

		try {
			const headers: Record<string, string> = {
				Authorization: `Bearer ${key}`,
				Accept: "application/json",
			};

			const fetchOptions: RequestInit = {
				method,
				headers,
				signal: controller.signal,
			};

			if (body !== undefined && method !== "GET") {
				headers["Content-Type"] = "application/json";
				fetchOptions.body = JSON.stringify(body);
			}

			const response = await fetch(url, fetchOptions);

			// Handle no-content responses
			if (
				response.status === 204 ||
				response.headers.get("content-length") === "0"
			) {
				return undefined as T;
			}

			const contentType = response.headers.get("content-type") ?? "";
			const data = contentType.includes("application/json")
				? await response.json()
				: await response.text();

			if (!response.ok) {
				throw new ApiError(response.status, response.statusText, data);
			}

			return data as T;
		} finally {
			clearTimeout(timer);
		}
	}

	/** GET request */
	async get<T = unknown>(
		path: string,
		options?: { useMasterKey?: boolean },
	): Promise<T> {
		return this.request<T>("GET", path, undefined, options);
	}

	/** POST request */
	async post<T = unknown>(
		path: string,
		body?: unknown,
		options?: { useMasterKey?: boolean },
	): Promise<T> {
		return this.request<T>("POST", path, body, options);
	}

	/** PATCH request */
	async patch<T = unknown>(
		path: string,
		body?: unknown,
		options?: { useMasterKey?: boolean },
	): Promise<T> {
		return this.request<T>("PATCH", path, body, options);
	}

	/** PUT request */
	async put<T = unknown>(
		path: string,
		body?: unknown,
		options?: { useMasterKey?: boolean },
	): Promise<T> {
		return this.request<T>("PUT", path, body, options);
	}

	/** DELETE request (supports optional body for oRPC endpoints that read input from body) */
	async delete<T = unknown>(
		path: string,
		bodyOrOptions?: unknown | { useMasterKey?: boolean },
		options?: { useMasterKey?: boolean },
	): Promise<T> {
		// If second arg looks like options (has useMasterKey), treat it as options with no body
		if (
			bodyOrOptions &&
			typeof bodyOrOptions === "object" &&
			"useMasterKey" in (bodyOrOptions as Record<string, unknown>)
		) {
			return this.request<T>("DELETE", path, undefined, bodyOrOptions as { useMasterKey?: boolean });
		}
		return this.request<T>("DELETE", path, bodyOrOptions, options);
	}

	/** Check if master key is available */
	hasMasterKey(): boolean {
		return !!this.masterKey;
	}
}

/**
 * Create an API client from environment variables.
 */
export function createApiClientFromEnv(): ApiClient {
	const baseUrl =
		process.env.ANIMA_API_URL ?? "http://127.0.0.1:3100";
	const apiKey = process.env.ANIMA_API_KEY ?? "";
	const masterKey = process.env.ANIMA_MASTER_KEY;

	if (!apiKey) {
		console.error(
			"Warning: ANIMA_API_KEY not set. API calls will fail.",
		);
	}

	return new ApiClient({ baseUrl, apiKey, masterKey });
}
