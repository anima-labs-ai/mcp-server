/**
 * phone_call MCP tool — live, Claude-driven phone calls.
 *
 * One MCP `tools/call` invocation holds the entire conversation. The tool
 * opens a WebSocket to `/ws/voice`, sends `call.create`, and then loops:
 *
 *   1. Wait for an incoming server event.
 *   2. On `call.transcription` with `isFinal: true && speaker: "caller"`,
 *      push a `notifications/progress` event (so the live transcript
 *      streams back to Claude Code's UI), then issue an
 *      `elicitation/create` request asking Claude what to say next.
 *   3. Send Claude's reply as `call.speak`.
 *   4. Repeat until `call.ended`.
 *
 * The tool result is the full transcript + reason the call ended. Cancel-
 * lation via `extra.signal` triggers a clean `call.hangup` before exiting.
 *
 * The same handler works for both `tier: "basic"` and `tier: "premium"`.
 * The differences (Telnyx native STT/TTS vs Deepgram+ElevenLabs) live
 * entirely server-side; the protocol surface is identical.
 *
 * For the full WS protocol see apps/api/src/plugins/ws-voice.ts.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
	type ToolContext,
	VoiceSocket,
	VoiceSocketError,
	type VoiceServerMessage,
	toolError,
	toolSuccess,
} from "../../../shared/index.js";

// ── Tool config ──

/**
 * Per-turn elicitation timeout. The MCP `elicitation/create` request blocks
 * the entire conversation loop while waiting for the client to respond. If
 * the client doesn't implement elicitation (or hands it off in a way that
 * never resolves), the call hangs and the only signal we get is the caller
 * eventually giving up. Capping at 30s gives a slow LLM enough headroom
 * while still failing loudly within one turn.
 */
const ELICITATION_TIMEOUT_MS = 30_000;

const DEFAULT_MAX_DURATION_SEC = 600; // 10 min
const HARD_CAP_DURATION_SEC = 1800; // 30 min — matches max_call_duration on the API
const DEFAULT_SILENCE_TIMEOUT_SEC = 30;
const HARD_CAP_SILENCE_SEC = 120;

const inputSchema = {
	to: z
		.string()
		.regex(
			/^\+[1-9]\d{7,14}$/,
			"Must be E.164 format (e.g. +14155551234)",
		)
		.describe("Destination phone number in E.164 format."),
	firstMessage: z
		.string()
		.min(1)
		.max(500)
		.describe(
			"Opening line the agent speaks when the call is answered. Be natural — this is what the human hears first.",
		),
	tier: z
		.enum(["basic", "premium"])
		.optional()
		.describe(
			"Voice quality tier. `basic` = Telnyx native STT/TTS (cheaper, slightly more robotic). `premium` = Deepgram STT + ElevenLabs TTS (lower latency, natural voice). Default: basic.",
		),
	voiceId: z
		.string()
		.optional()
		.describe(
			"Optional voice override. Use voice_list to list valid IDs for the chosen tier.",
		),
	fromNumber: z
		.string()
		.optional()
		.describe(
			"Optional source phone in E.164. Default: the calling agent's primary phone identity.",
		),
	maxDurationSec: z
		.number()
		.int()
		.positive()
		.max(HARD_CAP_DURATION_SEC)
		.optional()
		.describe(
			`Hard cap on total call duration in seconds. Default ${DEFAULT_MAX_DURATION_SEC} (10 min). Max ${HARD_CAP_DURATION_SEC} (30 min).`,
		),
	silenceTimeoutSec: z
		.number()
		.int()
		.positive()
		.max(HARD_CAP_SILENCE_SEC)
		.optional()
		.describe(
			`If no caller utterance arrives within this many seconds (measured from the last agent utterance), the call hangs up automatically. Default ${DEFAULT_SILENCE_TIMEOUT_SEC}.`,
		),
	agentId: z
		.string()
		.optional()
		.describe(
			"Required when the API key / OAuth grant is user-bound (no agentId in the auth context, e.g. a master key or a user-consented Anima Connect grant) — picks which of the org's agents places the call. Ignored when the auth is already agent-bound (the bound agent wins; mismatches are rejected with AGENT_MISMATCH). Use agent_list to find valid IDs.",
		),
};

// Output shape — returned as the tool result content.
interface TranscriptTurn {
	role: "agent" | "caller";
	text: string;
	at: string;
	turnId?: string;
}

interface VoiceCallResult {
	callId: string | null;
	endedReason:
		| "completed"
		| "caller_hangup"
		| "agent_hangup"
		| "silence_timeout"
		| "max_duration"
		| "client_cancelled"
		| "client_declined"
		| "elicitation_unsupported"
		| "error";
	durationSec: number;
	transcript: TranscriptTurn[];
	error?: { code: string; message: string };
}

// ── Public registration ──

export function registerPhoneCallLiveTool(
	server: McpServer,
	context: ToolContext,
): void {
	server.registerTool(
		"phone_call_create",
		{
			title: "Phone Call (Live)",
			description:
				"Place a live phone call and have a real conversation. The tool stays open for the entire call duration. As the caller speaks, you receive live transcript chunks via progress notifications; when the caller finishes a turn (server emits isFinal: true), an elicitation prompt asks you what the agent should say next. You respond with `say` (the exact text to speak) and optional `endCallAfterSpoken: true` to hang up after the line. Returns the full transcript when the call ends. Works on both `basic` and `premium` voice tiers. Requires the connecting MCP client to support elicitation — without it, the tool errors out immediately.",
			inputSchema,
			outputSchema: {
				callId: z
					.string()
					.nullable()
					.describe(
						"ID of the placed call. `null` if the call ended before the carrier assigned an ID (e.g. WS auth failure or pre-ring termination) — use `endedReason` to understand why.",
					),
				endedReason: z.string().describe("Why the call ended (hangup, timeout, error, etc.)."),
				durationSec: z.number().optional().describe("Total call duration in seconds."),
				transcript: z
					.array(
						z.object({
							role: z
								.enum(["caller", "agent"])
								.describe("Who spoke this turn — `caller` is the human, `agent` is the AI."),
							text: z.string(),
							at: z.string().optional().describe("ISO 8601 timestamp."),
							turnId: z.string().optional(),
						}),
					)
					.describe("Full transcript with role labels in chronological order."),
				error: z
					.object({
						code: z.string(),
						message: z.string(),
					})
					.optional()
					.describe(
						"Present when `endedReason` is `error` or `elicitation_unsupported` — carries the underlying code+message so callers can distinguish capability gaps from real failures.",
					),
			},
			annotations: {
				destructiveHint: false,
				openWorldHint: true,
				readOnlyHint: false,
				idempotentHint: false,
			},
		},
		async (args, extra) => {
			return runVoiceCall(args, context, extra);
		},
	);
}

// ── Implementation ──

type VoiceCallArgs = {
	to: string;
	firstMessage: string;
	tier?: "basic" | "premium";
	voiceId?: string;
	fromNumber?: string;
	maxDurationSec?: number;
	silenceTimeoutSec?: number;
	agentId?: string;
};

// biome-ignore lint/suspicious/noExplicitAny: SDK's RequestHandlerExtra type is generic over the server's request/notification unions; mirroring those generics here would require ~30 lines of type plumbing for no runtime benefit. We use `extra` for two specific calls (sendNotification, sendRequest); both are typed on the SDK side.
type ToolHandlerExtra = any;

async function runVoiceCall(
	args: VoiceCallArgs,
	context: ToolContext,
	extra: ToolHandlerExtra,
): Promise<ReturnType<typeof toolSuccess> | ReturnType<typeof toolError>> {
	const startedAtMs = Date.now();
	const maxDurationMs = (args.maxDurationSec ?? DEFAULT_MAX_DURATION_SEC) * 1000;
	const silenceTimeoutMs =
		(args.silenceTimeoutSec ?? DEFAULT_SILENCE_TIMEOUT_SEC) * 1000;
	const progressToken = extra?._meta?.progressToken as
		| string
		| number
		| undefined;

	const transcript: TranscriptTurn[] = [];

	const emitProgress = async (message: string): Promise<void> => {
		// Progress notifications are best-effort. The client may not have
		// asked for them (no progressToken in _meta), in which case we
		// emit nothing — sending without a token is a spec violation.
		if (progressToken === undefined) return;
		try {
			await extra.sendNotification({
				method: "notifications/progress",
				params: {
					progressToken,
					progress: transcript.length,
					message,
				},
			});
		} catch {
			// Notification failures are non-fatal: the call should keep
			// running even if the client's progress stream broke. The
			// final tool result still carries the full transcript.
		}
	};

	const recordTurn = (turn: TranscriptTurn): void => {
		transcript.push(turn);
	};

	const buildResult = (
		callId: string | null,
		endedReason: VoiceCallResult["endedReason"],
		error?: { code: string; message: string },
	): VoiceCallResult => ({
		callId,
		endedReason,
		durationSec: Math.round((Date.now() - startedAtMs) / 1000),
		transcript,
		error,
	});

	// ── 1. Open the WS ──

	const { token, baseUrl } = context.client.getAuth();
	const wsUrlOverride = process.env.ANIMA_VOICE_WS_URL || undefined;

	let socket: VoiceSocket;
	try {
		socket = await VoiceSocket.open({
			apiBaseUrl: baseUrl,
			apiKey: token,
			wsUrlOverride,
			signal: extra?.signal,
		});
	} catch (err) {
		if (err instanceof VoiceSocketError) {
			// 4001 = invalid token, 4002 = connection limit — both are
			// configuration problems the caller can fix. Surface the code.
			return toolError({
				code:
					err.code === 4001
						? "AUTH_FAILED"
						: err.code === 4002
							? "CONNECTION_LIMIT"
							: "WS_OPEN_FAILED",
				message: err.message,
			});
		}
		return toolError(
			err instanceof Error ? err.message : "Failed to open voice WebSocket",
		);
	}

	// ── 2. Send call.create ──

	const requestId = `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
	try {
		socket.send({
			type: "call.create",
			requestId,
			to: args.to,
			tier: args.tier,
			voice: args.voiceId ? { voiceId: args.voiceId } : undefined,
			greeting: args.firstMessage,
			fromNumber: args.fromNumber,
			agentId: args.agentId,
		});
	} catch (err) {
		socket.close();
		return toolError(
			err instanceof Error ? err.message : "Failed to initiate call",
		);
	}

	// ── 3. Drive the conversation ──

	let callId: string | null = null;
	let endedReason: VoiceCallResult["endedReason"] | null = null;
	let endError: { code: string; message: string } | undefined;

	const remainingMs = (): number =>
		Math.max(0, maxDurationMs - (Date.now() - startedAtMs));

	while (endedReason === null) {
		// Whichever fires first decides the next iteration: a new server
		// event, the silence watchdog, or the hard duration cap.
		const waitMs = Math.min(silenceTimeoutMs, remainingMs());
		if (waitMs === 0) {
			endedReason = "max_duration";
			if (callId) {
				try {
					socket.send({
						type: "call.hangup",
						callId,
						reason: "max_duration_exceeded",
					});
				} catch {
					// socket might already be dead — proceed to break
				}
			}
			break;
		}

		const msg = await socket.next(waitMs);

		if (msg === null) {
			// Either socket closed or we timed out waiting. Distinguish.
			if (socket.isClosed) {
				endedReason = endedReason ?? "completed";
				const { code, reason } = socket.closeInfo;
				if (code && code >= 4000) {
					endError = {
						code: `WS_CLOSED_${code}`,
						message: reason ?? "WebSocket closed abnormally",
					};
					endedReason = "error";
				}
				break;
			}
			// Silence timeout — hang up.
			endedReason = "silence_timeout";
			if (callId) {
				try {
					socket.send({
						type: "call.hangup",
						callId,
						reason: "silence_timeout",
					});
				} catch {
					// proceed
				}
			}
			break;
		}

		const handled = await handleServerMessage(msg, {
			callId,
			socket,
			extra,
			emitProgress,
			recordTurn,
		});

		// Lift state out of handler — keeps the loop linear.
		if (handled.callIdAssigned) {
			callId = handled.callIdAssigned;
		}
		if (handled.terminate) {
			endedReason = handled.terminate.reason;
			endError = handled.terminate.error;
			break;
		}
	}

	// ── 4. Tear down ──

	socket.close();

	return toolSuccess(
		buildResult(callId, endedReason ?? "completed", endError),
	);
}

// ── Per-message handler ──

interface HandlerDeps {
	callId: string | null;
	socket: VoiceSocket;
	extra: ToolHandlerExtra;
	emitProgress: (message: string) => Promise<void>;
	recordTurn: (turn: TranscriptTurn) => void;
}

interface HandlerOutcome {
	callIdAssigned?: string;
	terminate?: {
		reason: VoiceCallResult["endedReason"];
		error?: { code: string; message: string };
	};
}

async function handleServerMessage(
	msg: VoiceServerMessage,
	deps: HandlerDeps,
): Promise<HandlerOutcome> {
	switch (msg.type) {
		case "call.ringing":
			await deps.emitProgress(`Ringing — callId=${msg.callId}`);
			return { callIdAssigned: msg.callId };

		case "call.started":
			await deps.emitProgress(
				`Call connected from ${msg.from} to ${msg.to} (tier=${msg.tier})`,
			);
			return { callIdAssigned: msg.callId };

		case "call.transcription": {
			// Partial caller segments are ignored — we only react to final
			// utterances (matches BasicPipeline's own threshold). Premium
			// emits both but Claude only needs the final to decide its
			// reply. Skipping partials also keeps elicitation traffic sane.
			if (!msg.isFinal) return {};

			if (msg.speaker === "agent") {
				// Our own speech echoed back as a transcription — record it
				// in the transcript but don't elicit.
				deps.recordTurn({
					role: "agent",
					text: msg.text,
					at: new Date().toISOString(),
					turnId: msg.turnId,
				});
				return {};
			}

			// Caller, final → record + elicit Claude for the reply.
			deps.recordTurn({
				role: "caller",
				text: msg.text,
				at: new Date().toISOString(),
				turnId: msg.turnId,
			});
			await deps.emitProgress(`Caller: ${msg.text}`);

			return await elicitAndSpeak(msg, deps);
		}

		case "call.interrupted": {
			// Caller barged in mid-agent-speech. The agent only delivered
			// `spokenUntil`; treat newTranscription as the next caller turn.
			deps.recordTurn({
				role: "caller",
				text: msg.newTranscription,
				at: new Date().toISOString(),
			});
			await deps.emitProgress(
				`Caller interrupted (agent had spoken up to: "${msg.spokenUntil}"). Caller: ${msg.newTranscription}`,
			);

			return await elicitAndSpeak(
				{
					type: "call.transcription",
					callId: msg.callId,
					speaker: "caller",
					text: msg.newTranscription,
					isFinal: true,
				},
				deps,
			);
		}

		case "call.speak.ended":
			// Agent finished its turn — silence timer effectively starts now.
			// We don't restart it explicitly (the next iteration's `waitMs`
			// already covers this), but a progress event helps the trace.
			await deps.emitProgress(`Agent finished speaking: "${msg.text}"`);
			return {};

		case "call.ended": {
			const reason: VoiceCallResult["endedReason"] =
				msg.reason === "AGENT_HANGUP"
					? "agent_hangup"
					: msg.reason === "CALLER_HANGUP" || msg.reason === "completed"
						? "caller_hangup"
						: "completed";
			await deps.emitProgress(
				`Call ended: ${msg.reason} (duration ${msg.duration}s)`,
			);
			return { terminate: { reason } };
		}

		case "call.error":
			await deps.emitProgress(`Voice error: ${msg.code} — ${msg.message}`);
			// Most errors are not fatal mid-call (e.g. TTS rate limit, retried
			// internally). We only terminate on connection-level codes that
			// imply the call can't continue.
			if (msg.code === "NO_VOICE_NUMBER" || msg.code === "CALL_FAILED") {
				return {
					terminate: {
						reason: "error",
						error: { code: msg.code, message: msg.message },
					},
				};
			}
			return {};

		case "pong":
		case "call.incoming":
		case "call.reconnected":
			// Not relevant to outbound-call orchestration; ignore.
			return {};
	}
}

// ── Elicitation + speak ──

const ELICIT_SCHEMA = {
	type: "object",
	properties: {
		say: {
			type: "string",
			description:
				"Exact text the agent will speak on the call right now. Use a natural conversational reply. Empty string means stay silent (rare — usually you should say something to acknowledge the caller).",
		},
		endCallAfterSpoken: {
			type: "boolean",
			description:
				"If true, hang up after speaking. Use this for natural goodbyes (e.g. \"Thanks, talk soon!\" + true).",
		},
	},
	required: ["say"],
} as const;

async function elicitAndSpeak(
	transcription: Extract<VoiceServerMessage, { type: "call.transcription" }>,
	deps: HandlerDeps,
): Promise<HandlerOutcome> {
	if (!deps.callId) {
		// We received a transcription before call.ringing assigned a callId.
		// Shouldn't happen with the current ws-voice plugin flow, but the
		// type system can't guarantee it — fail loud rather than guess.
		return {
			terminate: {
				reason: "error",
				error: {
					code: "MISSING_CALL_ID",
					message:
						"Received transcription before call.ringing — call state is inconsistent",
				},
			},
		};
	}

	let elicitResult: { action: string; content?: Record<string, unknown> };
	const elicitStartedAt = Date.now();
	const turnTextPreview = transcription.text.slice(0, 80);
	console.log(
		`[phone_call_create] elicitation/create → sending (callId=${deps.callId}, callerTextLen=${transcription.text.length}, preview="${turnTextPreview}", timeoutMs=${ELICITATION_TIMEOUT_MS})`,
	);
	try {
		// Race the SDK request against an explicit timeout. Without this the
		// request blocks forever when the client doesn't surface elicitation
		// to its end user — the only symptom the caller hears is silence.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeoutPromise = new Promise<never>((_, reject) => {
			timer = setTimeout(() => {
				reject(
					new Error(
						`elicitation/create timed out after ${ELICITATION_TIMEOUT_MS}ms — the client did not respond. The most common cause is an MCP client that doesn't surface elicitation requests to its end user (Claude Code mid-tool-call, some IDEs, some agent harnesses). Consider switching to a client that supports elicitation, or splitting the call into discrete tool invocations.`,
					),
				);
			}, ELICITATION_TIMEOUT_MS);
		});
		try {
			elicitResult = await Promise.race([
				deps.extra.sendRequest(
					{
						method: "elicitation/create",
						params: {
							mode: "form",
							message: `Caller said: "${transcription.text}"\n\nWhat should the agent say next? Set endCallAfterSpoken=true to hang up after speaking (e.g. for a goodbye).`,
							requestedSchema: ELICIT_SCHEMA,
						},
					},
					ElicitResultSchema,
				),
				timeoutPromise,
			]);
		} finally {
			if (timer) clearTimeout(timer);
		}
		console.log(
			`[phone_call_create] elicitation/create ← resolved (callId=${deps.callId}, action=${elicitResult.action}, elapsedMs=${Date.now() - elicitStartedAt}, contentKeys=${
				elicitResult.content ? Object.keys(elicitResult.content).join(",") : "none"
			})`,
		);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		const elapsedMs = Date.now() - elicitStartedAt;
		// Distinguish three failure modes so callers can act on them:
		//   1. Client explicitly says "does not support elicitation" → fix client
		//   2. Our timeout fired → client probably silent-dropped the request
		//   3. Anything else → real error (network, schema mismatch, etc.)
		// Capability-error detection: clients signal "I don't do elicitation"
		// in a few different phrasings. Match any of:
		//   - "does not support elicitation"  (some MCP SDKs)
		//   - "Elicitation not supported"     (Claude Code's MCP client)
		//   - "elicitation is unsupported"
		//   - JSON-RPC -32600 / -32601 (Invalid Request / Method Not Found)
		//     when the message also mentions elicitation
		const mentionsElicitation = /elicitation/i.test(message);
		const isCapabilityError =
			mentionsElicitation &&
			(/(not\s+support|unsupported|-32600|-32601)/i.test(message));
		const isTimeout = /elicitation\/create timed out/i.test(message);
		console.error(
			`[phone_call_create] elicitation/create ✗ failed (callId=${deps.callId}, elapsedMs=${elapsedMs}, isCapability=${isCapabilityError}, isTimeout=${isTimeout}, error=${message.slice(0, 200)})`,
		);
		try {
			deps.socket.send({
				type: "call.hangup",
				callId: deps.callId,
				reason: isCapabilityError
					? "client_no_elicitation"
					: isTimeout
						? "elicitation_timeout"
						: "elicitation_failed",
			});
		} catch {
			// proceed
		}
		return {
			terminate: {
				reason:
					isCapabilityError || isTimeout ? "elicitation_unsupported" : "error",
				error: {
					code: isTimeout ? "ELICITATION_TIMEOUT" : "ELICITATION_FAILED",
					message,
				},
			},
		};
	}

	if (elicitResult.action !== "accept") {
		// Declined / cancelled → hang up gracefully.
		try {
			deps.socket.send({
				type: "call.hangup",
				callId: deps.callId,
				reason: `orchestrator_${elicitResult.action}`,
			});
		} catch {
			// proceed
		}
		return { terminate: { reason: "client_declined" } };
	}

	const content = elicitResult.content ?? {};
	const say = typeof content.say === "string" ? content.say : "";
	const endAfter =
		typeof content.endCallAfterSpoken === "boolean"
			? content.endCallAfterSpoken
			: false;

	if (say.length > 0) {
		try {
			deps.socket.send({
				type: "call.speak",
				callId: deps.callId,
				text: say,
				turnId: transcription.turnId,
			});
			deps.recordTurn({
				role: "agent",
				text: say,
				at: new Date().toISOString(),
				turnId: transcription.turnId,
			});
		} catch (err) {
			return {
				terminate: {
					reason: "error",
					error: {
						code: "SPEAK_SEND_FAILED",
						message:
							err instanceof Error ? err.message : "Failed to send speak",
					},
				},
			};
		}
	}

	if (endAfter) {
		try {
			deps.socket.send({
				type: "call.hangup",
				callId: deps.callId,
				reason: "agent_complete",
			});
		} catch {
			// proceed — server will close the WS soon and the loop exits
		}
		return { terminate: { reason: "agent_hangup" } };
	}

	return {};
}
