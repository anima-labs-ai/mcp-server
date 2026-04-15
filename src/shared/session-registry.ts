import { randomUUID } from "node:crypto";

export interface SessionMetadata {
	sessionId: string;
	apiKeyId: string;
	orgId: string;
	createdAt: number;
	lastActivityAt: number;
	reconnectToken: string;
	toolCallCount: number;
}

export interface SessionRegistryOptions {
	idleTimeoutMs?: number;
	sweepIntervalMs?: number;
	maxSessionsPerKey?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 60 * 1000;
const DEFAULT_MAX_SESSIONS_PER_KEY = 10;

export interface SessionRegistry {
	register(sessionId: string, apiKeyId: string, orgId: string): SessionMetadata;
	touch(sessionId: string): void;
	remove(sessionId: string): void;
	get(sessionId: string): SessionMetadata | undefined;
	getByReconnectToken(token: string): SessionMetadata | undefined;
	countByKey(apiKeyId: string): number;
	countByOrg(orgId: string): number;
	canCreateSession(apiKeyId: string): boolean;
	getIdleSessions(): string[];
	stats(): RegistryStats;
	startSweep(onExpired: (sessionId: string) => Promise<void>): void;
	stopSweep(): void;
}

export interface RegistryStats {
	totalSessions: number;
	sessionsByOrg: Record<string, number>;
	oldestSessionAge: number | null;
}

export function createSessionRegistry(options?: SessionRegistryOptions): SessionRegistry {
	const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
	const maxSessionsPerKey = options?.maxSessionsPerKey ?? DEFAULT_MAX_SESSIONS_PER_KEY;
	const sweepIntervalMs = options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;

	const sessions = new Map<string, SessionMetadata>();
	const reconnectIndex = new Map<string, string>();
	let sweepTimer: ReturnType<typeof setInterval> | null = null;

	function register(sessionId: string, apiKeyId: string, orgId: string): SessionMetadata {
		const now = Date.now();
		const reconnectToken = randomUUID();
		const meta: SessionMetadata = {
			sessionId,
			apiKeyId,
			orgId,
			createdAt: now,
			lastActivityAt: now,
			reconnectToken,
			toolCallCount: 0,
		};
		sessions.set(sessionId, meta);
		reconnectIndex.set(reconnectToken, sessionId);
		return meta;
	}

	function touch(sessionId: string): void {
		const meta = sessions.get(sessionId);
		if (meta) {
			meta.lastActivityAt = Date.now();
			meta.toolCallCount += 1;
		}
	}

	function remove(sessionId: string): void {
		const meta = sessions.get(sessionId);
		if (meta) {
			reconnectIndex.delete(meta.reconnectToken);
			sessions.delete(sessionId);
		}
	}

	function get(sessionId: string): SessionMetadata | undefined {
		return sessions.get(sessionId);
	}

	function getByReconnectToken(token: string): SessionMetadata | undefined {
		const sessionId = reconnectIndex.get(token);
		return sessionId ? sessions.get(sessionId) : undefined;
	}

	function countByKey(apiKeyId: string): number {
		let count = 0;
		for (const meta of sessions.values()) {
			if (meta.apiKeyId === apiKeyId) count++;
		}
		return count;
	}

	function countByOrg(orgId: string): number {
		let count = 0;
		for (const meta of sessions.values()) {
			if (meta.orgId === orgId) count++;
		}
		return count;
	}

	function canCreateSession(apiKeyId: string): boolean {
		return countByKey(apiKeyId) < maxSessionsPerKey;
	}

	function getIdleSessions(): string[] {
		const now = Date.now();
		const idle: string[] = [];
		for (const meta of sessions.values()) {
			if (now - meta.lastActivityAt > idleTimeoutMs) {
				idle.push(meta.sessionId);
			}
		}
		return idle;
	}

	function stats(): RegistryStats {
		const sessionsByOrg: Record<string, number> = {};
		let oldestAge: number | null = null;
		const now = Date.now();

		for (const meta of sessions.values()) {
			sessionsByOrg[meta.orgId] = (sessionsByOrg[meta.orgId] ?? 0) + 1;
			const age = now - meta.createdAt;
			if (oldestAge === null || age > oldestAge) {
				oldestAge = age;
			}
		}

		return {
			totalSessions: sessions.size,
			sessionsByOrg,
			oldestSessionAge: oldestAge,
		};
	}

	function startSweep(onExpired: (sessionId: string) => Promise<void>): void {
		if (sweepTimer) return;
		sweepTimer = setInterval(async () => {
			const expired = getIdleSessions();
			for (const sessionId of expired) {
				try {
					await onExpired(sessionId);
				} finally {
					remove(sessionId);
				}
			}
		}, sweepIntervalMs);
	}

	function stopSweep(): void {
		if (sweepTimer) {
			clearInterval(sweepTimer);
			sweepTimer = null;
		}
	}

	return {
		register,
		touch,
		remove,
		get,
		getByReconnectToken,
		countByKey,
		countByOrg,
		canCreateSession,
		getIdleSessions,
		stats,
		startSweep,
		stopSweep,
	};
}
