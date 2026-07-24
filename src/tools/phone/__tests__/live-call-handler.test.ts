import { describe, expect, test } from "bun:test";
import type { VoiceServerMessage } from "../../../shared/index.js";
import { handleServerMessage } from "../phone_call/live-call.js";

// handleServerMessage returns {} early for eager/unknown frames without
// touching the socket or elicitation, so a loose stub of its deps is enough.
function makeDeps() {
	const recorded: unknown[] = [];
	const deps = {
		callId: "call_x",
		socket: { send() {}, close() {} },
		extra: {},
		emitProgress: async () => {},
		recordTurn: (t: unknown) => recorded.push(t),
		serverSideAgent: true,
		recordLatencyTurns: () => {},
	} as unknown as Parameters<typeof handleServerMessage>[1];
	return { deps, recorded };
}

describe("handleServerMessage forward-compat (regression: the eager-frame crash)", () => {
	test("call.transcription.eager returns {} and is NOT recorded as a caller turn", async () => {
		const { deps, recorded } = makeDeps();
		const out = await handleServerMessage(
			{
				type: "call.transcription.eager",
				callId: "call_x",
				turnId: "t1",
				text: "hel",
				confidence: 0.8,
				timestamp: 1,
			},
			deps,
		);
		expect(out).toEqual({});
		// The eager hint must not double-report the turn; the authoritative
		// call.transcription (isFinal) is what gets recorded.
		expect(recorded).toHaveLength(0);
	});

	test("an unknown/future frame type returns {}, never undefined", async () => {
		const { deps } = makeDeps();
		const out = await handleServerMessage(
			{
				type: "call.some.future.frame",
				callId: "call_x",
			} as unknown as VoiceServerMessage,
			deps,
		);
		// Before the fix the switch had no `default`, so an unrecognized frame
		// returned undefined and the loop threw on `handled.callIdAssigned`.
		// This asserts the forward-compat default now swallows it safely.
		expect(out).toEqual({});
	});
});
