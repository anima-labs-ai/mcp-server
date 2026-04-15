export interface McpMetrics {
	sessionCreated(): void;
	sessionClosed(): void;
	toolCallRecorded(durationMs: number): void;
	rateLimitHit(): void;
	circuitBreakerTripped(orgId: string): void;
	authFailure(): void;
	snapshot(): MetricsSnapshot;
}

export interface MetricsSnapshot {
	activeSessions: number;
	totalSessionsCreated: number;
	totalSessionsClosed: number;
	totalToolCalls: number;
	totalRateLimitHits: number;
	totalCircuitBreakerTrips: number;
	totalAuthFailures: number;
	avgToolCallDurationMs: number;
	p95ToolCallDurationMs: number;
}

export function createMcpMetrics(): McpMetrics {
	let activeSessions = 0;
	let totalSessionsCreated = 0;
	let totalSessionsClosed = 0;
	let totalToolCalls = 0;
	let totalRateLimitHits = 0;
	let totalCircuitBreakerTrips = 0;
	let totalAuthFailures = 0;
	const toolCallDurations: number[] = [];
	const MAX_DURATION_SAMPLES = 1000;

	function sessionCreated(): void {
		activeSessions++;
		totalSessionsCreated++;
	}

	function sessionClosed(): void {
		activeSessions = Math.max(0, activeSessions - 1);
		totalSessionsClosed++;
	}

	function toolCallRecorded(durationMs: number): void {
		totalToolCalls++;
		toolCallDurations.push(durationMs);
		if (toolCallDurations.length > MAX_DURATION_SAMPLES) {
			toolCallDurations.splice(0, toolCallDurations.length - MAX_DURATION_SAMPLES);
		}
	}

	function rateLimitHit(): void {
		totalRateLimitHits++;
	}

	function circuitBreakerTripped(_orgId: string): void {
		totalCircuitBreakerTrips++;
	}

	function authFailure(): void {
		totalAuthFailures++;
	}

	function percentile(sorted: number[], p: number): number {
		if (sorted.length === 0) return 0;
		const index = Math.ceil((p / 100) * sorted.length) - 1;
		return sorted[Math.max(0, index)];
	}

	function snapshot(): MetricsSnapshot {
		const sorted = [...toolCallDurations].sort((a, b) => a - b);
		const avg = sorted.length > 0
			? sorted.reduce((sum, d) => sum + d, 0) / sorted.length
			: 0;

		return {
			activeSessions,
			totalSessionsCreated,
			totalSessionsClosed,
			totalToolCalls,
			totalRateLimitHits,
			totalCircuitBreakerTrips,
			totalAuthFailures,
			avgToolCallDurationMs: Math.round(avg),
			p95ToolCallDurationMs: percentile(sorted, 95),
		};
	}

	return {
		sessionCreated,
		sessionClosed,
		toolCallRecorded,
		rateLimitHit,
		circuitBreakerTripped,
		authFailure,
		snapshot,
	};
}
