export type CircuitState = "closed" | "open" | "half-open";

export interface CircuitBreakerOptions {
	failureThreshold?: number;
	resetTimeoutMs?: number;
	halfOpenMaxAttempts?: number;
	volumeThreshold?: number;
}

const DEFAULTS: Required<CircuitBreakerOptions> = {
	failureThreshold: 5,
	resetTimeoutMs: 15_000,
	halfOpenMaxAttempts: 1,
	volumeThreshold: 5,
};

interface CircuitData {
	state: CircuitState;
	failures: number;
	successes: number;
	totalRequests: number;
	lastFailureAt: number;
	halfOpenAttempts: number;
}

export interface CircuitBreaker {
	execute<T>(orgId: string, fn: () => Promise<T>): Promise<T>;
	getState(orgId: string): CircuitState;
	reset(orgId: string): void;
	stats(orgId: string): CircuitData | undefined;
}

export class CircuitOpenError extends Error {
	readonly retryAfterMs: number;

	constructor(orgId: string, retryAfterMs: number) {
		super(`Circuit breaker open for org ${orgId}. Retry after ${retryAfterMs}ms.`);
		this.name = "CircuitOpenError";
		this.retryAfterMs = retryAfterMs;
	}
}

export function createCircuitBreaker(options?: CircuitBreakerOptions): CircuitBreaker {
	const config = { ...DEFAULTS, ...options };
	const circuits = new Map<string, CircuitData>();

	function getOrCreate(orgId: string): CircuitData {
		let circuit = circuits.get(orgId);
		if (!circuit) {
			circuit = {
				state: "closed",
				failures: 0,
				successes: 0,
				totalRequests: 0,
				lastFailureAt: 0,
				halfOpenAttempts: 0,
			};
			circuits.set(orgId, circuit);
		}
		return circuit;
	}

	function shouldTransitionToHalfOpen(circuit: CircuitData): boolean {
		if (circuit.state !== "open") return false;
		return Date.now() - circuit.lastFailureAt >= config.resetTimeoutMs;
	}

	function recordSuccess(circuit: CircuitData): void {
		circuit.successes++;
		circuit.totalRequests++;
		if (circuit.state === "half-open") {
			circuit.state = "closed";
			circuit.failures = 0;
			circuit.halfOpenAttempts = 0;
		}
	}

	function recordFailure(circuit: CircuitData): void {
		circuit.failures++;
		circuit.totalRequests++;
		circuit.lastFailureAt = Date.now();

		if (circuit.state === "half-open") {
			circuit.state = "open";
			circuit.halfOpenAttempts = 0;
			return;
		}

		if (
			circuit.totalRequests >= config.volumeThreshold &&
			circuit.failures >= config.failureThreshold
		) {
			circuit.state = "open";
		}
	}

	async function execute<T>(orgId: string, fn: () => Promise<T>): Promise<T> {
		const circuit = getOrCreate(orgId);

		if (circuit.state === "open") {
			if (shouldTransitionToHalfOpen(circuit)) {
				circuit.state = "half-open";
				circuit.halfOpenAttempts = 0;
			} else {
				const retryAfterMs = config.resetTimeoutMs - (Date.now() - circuit.lastFailureAt);
				throw new CircuitOpenError(orgId, Math.max(retryAfterMs, 1));
			}
		}

		if (circuit.state === "half-open" && circuit.halfOpenAttempts >= config.halfOpenMaxAttempts) {
			circuit.state = "open";
			const retryAfterMs = config.resetTimeoutMs;
			throw new CircuitOpenError(orgId, retryAfterMs);
		}

		if (circuit.state === "half-open") {
			circuit.halfOpenAttempts++;
		}

		try {
			const result = await fn();
			recordSuccess(circuit);
			return result;
		} catch (error) {
			recordFailure(circuit);
			throw error;
		}
	}

	function getState(orgId: string): CircuitState {
		const circuit = circuits.get(orgId);
		if (!circuit) return "closed";
		if (circuit.state === "open" && shouldTransitionToHalfOpen(circuit)) {
			return "half-open";
		}
		return circuit.state;
	}

	function reset(orgId: string): void {
		circuits.delete(orgId);
	}

	function stats(orgId: string): CircuitData | undefined {
		return circuits.get(orgId);
	}

	return { execute, getState, reset, stats };
}
