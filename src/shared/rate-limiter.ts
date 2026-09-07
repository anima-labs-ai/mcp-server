export interface RateLimitResult {
	allowed: boolean;
	remaining: number;
	limit: number;
	retryAfterMs?: number;
}

export interface McpRateLimiterOptions {
	toolCallsPerMinute?: number;
	toolCallsPerHour?: number;
	sessionsPerKey?: number;
	requestsPerMinute?: number;
	/**
	 * The key every credential-less session shares, and its own session
	 * budget.
	 *
	 * Anonymous sessions exist only to introspect: handshake, list tools,
	 * done in a few seconds, never touching the upstream API. They are far
	 * cheaper than an authenticated session and there are far more of them —
	 * every directory that crawls us hourly opens one.
	 *
	 * Metering them against `sessionsPerKey` was wrong. Ten slots shared
	 * across every crawler on the internet, held for the 30-minute idle
	 * timeout because crawlers do not send DELETE, meant the bucket was
	 * permanently full: Glama's hourly check got HTTP 429 and marked the
	 * connector unhealthy — the exact failure that opening up introspection
	 * was meant to fix.
	 */
	anonymousKeyId?: string;
	anonymousSessionsPerKey?: number;
}

const DEFAULTS: Required<McpRateLimiterOptions> = {
	toolCallsPerMinute: 120,
	toolCallsPerHour: 3000,
	sessionsPerKey: 10,
	requestsPerMinute: 60,
	anonymousKeyId: "anonymous",
	anonymousSessionsPerKey: 250,
};

interface WindowEntry {
	timestamps: number[];
}

export interface McpRateLimiter {
	checkToolCall(apiKeyId: string): RateLimitResult;
	checkSessionCreation(apiKeyId: string, currentCount: number): RateLimitResult;
	checkRequest(apiKeyId: string): RateLimitResult;
	reset(apiKeyId: string): void;
}

export function createMcpRateLimiter(options?: McpRateLimiterOptions): McpRateLimiter {
	const config = { ...DEFAULTS, ...options };

	const toolCallMinute = new Map<string, WindowEntry>();
	const toolCallHour = new Map<string, WindowEntry>();
	const requestMinute = new Map<string, WindowEntry>();

	function slidingWindowCheck(
		store: Map<string, WindowEntry>,
		key: string,
		windowMs: number,
		limit: number,
	): RateLimitResult {
		const now = Date.now();
		let entry = store.get(key);
		if (!entry) {
			entry = { timestamps: [] };
			store.set(key, entry);
		}

		const cutoff = now - windowMs;
		entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

		if (entry.timestamps.length >= limit) {
			const oldestInWindow = entry.timestamps[0];
			const retryAfterMs = oldestInWindow + windowMs - now;
			return {
				allowed: false,
				remaining: 0,
				limit,
				retryAfterMs: Math.max(retryAfterMs, 1),
			};
		}

		entry.timestamps.push(now);
		return {
			allowed: true,
			remaining: limit - entry.timestamps.length,
			limit,
		};
	}

	function checkToolCall(apiKeyId: string): RateLimitResult {
		const minuteResult = slidingWindowCheck(
			toolCallMinute,
			apiKeyId,
			60_000,
			config.toolCallsPerMinute,
		);
		if (!minuteResult.allowed) return minuteResult;

		const hourResult = slidingWindowCheck(
			toolCallHour,
			apiKeyId,
			3_600_000,
			config.toolCallsPerHour,
		);
		return hourResult;
	}

	function checkSessionCreation(apiKeyId: string, currentCount: number): RateLimitResult {
		const limit =
			apiKeyId === config.anonymousKeyId
				? config.anonymousSessionsPerKey
				: config.sessionsPerKey;
		if (currentCount >= limit) {
			return {
				allowed: false,
				remaining: 0,
				limit,
				retryAfterMs: 60_000,
			};
		}
		return {
			allowed: true,
			remaining: limit - currentCount,
			limit,
		};
	}

	function checkRequest(apiKeyId: string): RateLimitResult {
		return slidingWindowCheck(
			requestMinute,
			apiKeyId,
			60_000,
			config.requestsPerMinute,
		);
	}

	function reset(apiKeyId: string): void {
		toolCallMinute.delete(apiKeyId);
		toolCallHour.delete(apiKeyId);
		requestMinute.delete(apiKeyId);
	}

	return {
		checkToolCall,
		checkSessionCreation,
		checkRequest,
		reset,
	};
}
