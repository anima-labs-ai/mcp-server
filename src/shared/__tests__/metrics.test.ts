import { describe, test, expect } from "bun:test";
import { createMcpMetrics } from "../metrics.js";

describe("McpMetrics", () => {
	test("tracks session lifecycle", () => {
		const m = createMcpMetrics();
		m.sessionCreated();
		m.sessionCreated();
		let snap = m.snapshot();
		expect(snap.activeSessions).toBe(2);
		expect(snap.totalSessionsCreated).toBe(2);

		m.sessionClosed();
		snap = m.snapshot();
		expect(snap.activeSessions).toBe(1);
		expect(snap.totalSessionsClosed).toBe(1);
	});

	test("active sessions never goes below 0", () => {
		const m = createMcpMetrics();
		m.sessionClosed();
		expect(m.snapshot().activeSessions).toBe(0);
	});

	test("tracks tool call durations", () => {
		const m = createMcpMetrics();
		m.toolCallRecorded(100);
		m.toolCallRecorded(200);
		m.toolCallRecorded(300);
		const snap = m.snapshot();
		expect(snap.totalToolCalls).toBe(3);
		expect(snap.avgToolCallDurationMs).toBe(200);
	});

	test("tracks rate limit hits", () => {
		const m = createMcpMetrics();
		m.rateLimitHit();
		m.rateLimitHit();
		expect(m.snapshot().totalRateLimitHits).toBe(2);
	});

	test("tracks circuit breaker trips", () => {
		const m = createMcpMetrics();
		m.circuitBreakerTripped("org1");
		expect(m.snapshot().totalCircuitBreakerTrips).toBe(1);
	});

	test("tracks auth failures", () => {
		const m = createMcpMetrics();
		m.authFailure();
		expect(m.snapshot().totalAuthFailures).toBe(1);
	});

	test("p95 calculation", () => {
		const m = createMcpMetrics();
		for (let i = 1; i <= 100; i++) {
			m.toolCallRecorded(i);
		}
		const snap = m.snapshot();
		expect(snap.p95ToolCallDurationMs).toBe(95);
	});

	test("handles empty durations in snapshot", () => {
		const m = createMcpMetrics();
		const snap = m.snapshot();
		expect(snap.avgToolCallDurationMs).toBe(0);
		expect(snap.p95ToolCallDurationMs).toBe(0);
	});
});
