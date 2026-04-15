import { describe, test, expect } from "bun:test";
import { createCircuitBreaker, CircuitOpenError } from "../circuit-breaker.js";

describe("CircuitBreaker", () => {
	test("starts in closed state", () => {
		const cb = createCircuitBreaker();
		expect(cb.getState("org1")).toBe("closed");
	});

	test("allows successful calls through", async () => {
		const cb = createCircuitBreaker();
		const result = await cb.execute("org1", async () => "ok");
		expect(result).toBe("ok");
	});

	test("opens after failure threshold", async () => {
		const cb = createCircuitBreaker({
			failureThreshold: 3,
			volumeThreshold: 3,
		});

		for (let i = 0; i < 3; i++) {
			try {
				await cb.execute("org1", async () => {
					throw new Error("fail");
				});
			} catch {
				// expected
			}
		}

		expect(cb.getState("org1")).toBe("open");
	});

	test("throws CircuitOpenError when open", async () => {
		const cb = createCircuitBreaker({
			failureThreshold: 1,
			volumeThreshold: 1,
			resetTimeoutMs: 60_000,
		});

		try {
			await cb.execute("org1", async () => {
				throw new Error("fail");
			});
		} catch {
			// expected
		}

		try {
			await cb.execute("org1", async () => "should not run");
			expect(true).toBe(false);
		} catch (err) {
			expect(err).toBeInstanceOf(CircuitOpenError);
			expect((err as CircuitOpenError).retryAfterMs).toBeGreaterThan(0);
		}
	});

	test("transitions to half-open after reset timeout", async () => {
		const cb = createCircuitBreaker({
			failureThreshold: 1,
			volumeThreshold: 1,
			resetTimeoutMs: 1, // 1ms for testing
		});

		try {
			await cb.execute("org1", async () => {
				throw new Error("fail");
			});
		} catch {
			// expected
		}

		// Wait for reset timeout
		await new Promise((r) => setTimeout(r, 5));

		expect(cb.getState("org1")).toBe("half-open");
	});

	test("closes again after successful half-open call", async () => {
		const cb = createCircuitBreaker({
			failureThreshold: 1,
			volumeThreshold: 1,
			resetTimeoutMs: 1,
		});

		try {
			await cb.execute("org1", async () => {
				throw new Error("fail");
			});
		} catch {
			// expected
		}

		await new Promise((r) => setTimeout(r, 5));

		const result = await cb.execute("org1", async () => "recovered");
		expect(result).toBe("recovered");
		expect(cb.getState("org1")).toBe("closed");
	});

	test("reset clears circuit state", async () => {
		const cb = createCircuitBreaker({
			failureThreshold: 1,
			volumeThreshold: 1,
		});

		try {
			await cb.execute("org1", async () => {
				throw new Error("fail");
			});
		} catch {
			// expected
		}

		cb.reset("org1");
		expect(cb.getState("org1")).toBe("closed");
	});

	test("stats returns circuit data", async () => {
		const cb = createCircuitBreaker();
		await cb.execute("org1", async () => "ok");
		const s = cb.stats("org1");
		expect(s).toBeDefined();
		expect(s!.successes).toBe(1);
		expect(s!.totalRequests).toBe(1);
	});
});
