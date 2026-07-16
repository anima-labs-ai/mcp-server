/**
 * Phone Call MCP Tools (hosted)
 *
 * 6 tools for phone calls:
 *   - phone_call:                live Claude-driven outbound call (streams
 *                                via elicitation + progress notifications)
 *   - phone_call_list:           list calls with filters
 *   - phone_call_get:            full single-call detail (includes summary,
 *                                score, and other derived fields)
 *   - phone_call_transcript_get: transcript by callId
 *   - phone_call_recording_get:  recording URL by callId
 *   - voices_list:               available AI voices for placing calls
 */

import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	listOutput,
	objectOutput,
	toolSuccess,
	withErrorHandling,
} from "../../../shared/index.js";
import { registerPhoneCallLiveTool } from "./live-call.js";

// Mirrors the contract's GET /voice/calls input. The previous `numberId`
// (sent as phoneIdentityId) and `search` params were fictional — the API's
// zod-strip dropped them, so those "filters" silently returned unfiltered
// results (spec item M3 class; same bug family as email_list folder/offset).
const phoneCallListSchema = z.object({
	agentId: z.string().optional().describe("Filter by agent ID."),
	direction: z
		.enum(["INBOUND", "OUTBOUND"])
		.optional()
		.describe("Filter by call direction."),
	status: z
		.string()
		.optional()
		.describe("Filter by call state (INITIATING, RINGING, ACTIVE, ENDED, etc.)."),
	limit: z.number().int().positive().optional().describe("Max results (default: 20)."),
	offset: z.number().int().nonnegative().optional().describe("Offset for pagination."),
});

const phoneCallIdSchema = z.object({
	id: z.string().describe("The call ID."),
});

const voicesListSchema = z.object({
	tier: z
		.enum(["basic", "premium"])
		.optional()
		.describe("Filter by pricing tier."),
	gender: z
		.enum(["male", "female", "neutral"])
		.optional()
		.describe("Filter by voice gender."),
	language: z
		.string()
		.optional()
		.describe("Filter by language code (e.g. 'en-US', 'fr-FR')."),
});

export function registerPhoneCallTools(options: ToolRegistrationOptions): void {
	const { server, context } = options;

	// Live Claude-driven phone_call lives in its own file (uses elicitation +
	// progress notifications for streaming).
	registerPhoneCallLiveTool(server, context);

	server.registerTool(
		"phone_call_list",
		{
			title: "List Phone Calls",
			description:
				"List phone calls with optional filters. Returns lightweight call records — for full call detail including summary and score, use phone_call_get.",
			inputSchema: phoneCallListSchema.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			if (args.direction) params.set("direction", args.direction);
			if (args.status) params.set("state", args.status);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			if (args.offset !== undefined) params.set("offset", String(args.offset));
			const path = params.toString() ? `/v1/voice/calls?${params}` : "/v1/voice/calls";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"phone_call_get",
		{
			title: "Get Phone Call",
			description:
				"Get full detail for a single phone call: status, duration, participants, tier, AI-generated summary (one-liner, topics, action items, decisions, open questions, next steps), and quality score. The summary is generated once on first read after post-call processing and cached.",
			inputSchema: phoneCallIdSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(
				`/v1/voice/calls/${encodeURIComponent(args.id)}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"phone_call_transcript_get",
		{
			title: "Get Phone Call Transcript",
			description:
				"Get the full transcript of a phone call with speaker labels, timestamps, and confidence scores. Available after the call ends and transcription completes.",
			inputSchema: phoneCallIdSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(
				`/v1/voice/calls/${encodeURIComponent(args.id)}/transcript`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"phone_call_recording_get",
		{
			title: "Get Phone Call Recording",
			description:
				"Get a time-limited download URL for a call recording (WAV format). The URL expires after 1 hour. Recording must have been enabled during the call.",
			inputSchema: phoneCallIdSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(
				`/v1/voice/calls/${encodeURIComponent(args.id)}/recording`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"voice_list",
		{
			title: "List AI Voices",
			description:
				"List available AI voices for placing phone calls. Filter by tier (basic for low-latency, premium for natural voices), gender, or language. Returns voice IDs needed for phone_call_create.",
			inputSchema: voicesListSchema.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.tier) params.set("tier", args.tier);
			if (args.gender) params.set("gender", args.gender);
			if (args.language) params.set("language", args.language);
			const path = params.toString() ? `/v1/voice/catalog?${params}` : "/v1/voice/catalog";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);
}
