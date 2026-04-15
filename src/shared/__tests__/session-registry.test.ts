import { describe, test, expect } from "bun:test";
import { createSessionRegistry } from "../session-registry.js";

describe("SessionRegistry", () => {
	test("register creates session metadata", () => {
		const reg = createSessionRegistry();
		const meta = reg.register("s1", "key1", "org1");
		expect(meta.sessionId).toBe("s1");
		expect(meta.apiKeyId).toBe("key1");
		expect(meta.orgId).toBe("org1");
		expect(meta.reconnectToken).toBeTruthy();
		expect(meta.toolCallCount).toBe(0);
	});

	test("get retrieves registered session", () => {
		const reg = createSessionRegistry();
		reg.register("s1", "key1", "org1");
		expect(reg.get("s1")).toBeDefined();
		expect(reg.get("s2")).toBeUndefined();
	});

	test("touch increments tool call count", () => {
		const reg = createSessionRegistry();
		reg.register("s1", "key1", "org1");
		reg.touch("s1");
		reg.touch("s1");
		expect(reg.get("s1")!.toolCallCount).toBe(2);
	});

	test("remove deletes session", () => {
		const reg = createSessionRegistry();
		reg.register("s1", "key1", "org1");
		reg.remove("s1");
		expect(reg.get("s1")).toBeUndefined();
	});

	test("getByReconnectToken finds session", () => {
		const reg = createSessionRegistry();
		const meta = reg.register("s1", "key1", "org1");
		const found = reg.getByReconnectToken(meta.reconnectToken);
		expect(found?.sessionId).toBe("s1");
	});

	test("countByKey counts sessions for API key", () => {
		const reg = createSessionRegistry();
		reg.register("s1", "key1", "org1");
		reg.register("s2", "key1", "org1");
		reg.register("s3", "key2", "org2");
		expect(reg.countByKey("key1")).toBe(2);
		expect(reg.countByKey("key2")).toBe(1);
	});

	test("countByOrg counts sessions for org", () => {
		const reg = createSessionRegistry();
		reg.register("s1", "key1", "org1");
		reg.register("s2", "key2", "org1");
		expect(reg.countByOrg("org1")).toBe(2);
	});

	test("canCreateSession respects max limit", () => {
		const reg = createSessionRegistry({ maxSessionsPerKey: 2 });
		reg.register("s1", "key1", "org1");
		expect(reg.canCreateSession("key1")).toBe(true);
		reg.register("s2", "key1", "org1");
		expect(reg.canCreateSession("key1")).toBe(false);
	});

	test("getIdleSessions returns sessions past idle timeout", async () => {
		const reg = createSessionRegistry({ idleTimeoutMs: 1 });
		reg.register("s1", "key1", "org1");
		await new Promise((r) => setTimeout(r, 5));
		const idle = reg.getIdleSessions();
		expect(idle).toContain("s1");
	});

	test("stats returns aggregate info", () => {
		const reg = createSessionRegistry();
		reg.register("s1", "key1", "org1");
		reg.register("s2", "key2", "org2");
		const s = reg.stats();
		expect(s.totalSessions).toBe(2);
		expect(s.sessionsByOrg["org1"]).toBe(1);
		expect(s.sessionsByOrg["org2"]).toBe(1);
		expect(s.oldestSessionAge).toBeGreaterThanOrEqual(0);
	});
});
