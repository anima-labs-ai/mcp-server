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
}

const DEFAULTS: Required<McpRateLimiterOptions> = {
	toolCallsPerMinute: 120,
	toolCallsPerHour: 3000,
	sessionsPerKey: 10,
	requestsPerMinute: 60,
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
		if (currentCount >= config.sessionsPerKey) {
			return {
				allowed: false,
				remaining: 0,
				limit: config.sessionsPerKey,
				retryAfterMs: 60_000,
			};
		}
		return {
			allowed: true,
			remaining: config.sessionsPerKey - currentCount,
			limit: config.sessionsPerKey,
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
