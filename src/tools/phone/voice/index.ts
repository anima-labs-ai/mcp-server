/**
 * Voice MCP Tools
 *
 * 10 tools for voice call intelligence:
 *   - voice_catalog: list available voices
 *   - voice_call_create: initiate outbound call
 *   - voice_call_list: list past calls
 *   - voice_call_get: get call details
 *   - voice_transcript_get: get call transcript
 *   - voice_recording_get: get recording download URL
 *   - voice_get_summary: get AI-generated summary
 *   - voice_score_get: get call quality score
 *   - voice_call_search: semantic search across transcripts
 *   - voice_security_scan_get: get security scan results
 */

import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	listOutput,
	objectOutput,
	toolSuccess,
	withErrorHandling,
} from "../../../shared/index.js";
import { registerVoiceCallTool } from "./live-call.js";

export function registerVoiceTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	// Live Claude-driven call (separate file — uses elicitation + progress
	// notifications, which the other tools in this file don't need).
	registerVoiceCallTool(server, options.context);

	// ── voice_catalog (canonical) + voice_list_voices (deprecated alias) ──
	//
	// Both used to be registered as standalone tools (here and in
	// tools/phone/phone/index.ts) calling the same /v1/voice/catalog
	// endpoint with the same params. Customer feedback flagged the
	// duplicate; collapsing under voice_catalog (matches the API endpoint
	// path, shortest name) and keeping voice_list_voices as a deprecated
	// alias so existing prompts/scripts that pinned to the old name keep
	// working. Plan: remove the alias once usage logs go quiet.

	const voiceCatalogSchema = z.object({
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

	const voiceCatalogHandler = withErrorHandling<
		z.infer<typeof voiceCatalogSchema>
	>(async (args, context) => {
		const params = new URLSearchParams();
		if (args.tier) params.set("tier", args.tier);
		if (args.gender) params.set("gender", args.gender);
		if (args.language) params.set("language", args.language);
		const path = params.toString()
			? `/v1/voice/catalog?${params}`
			: "/v1/voice/catalog";
		const result = await context.client.get<unknown>(path);
		return toolSuccess(result);
	}, options.context);

	server.registerTool(
		"voice_catalog",
		{
			title: "Voice Catalog",
			description:
				"List available AI voices for phone calls. Filter by tier (basic for low-latency, premium for natural voices), gender, or language. Returns voice IDs needed for voice_call_create.",
			inputSchema: voiceCatalogSchema.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		voiceCatalogHandler,
	);

	// voice_create_call is only registered on the npm package (@anima-labs/mcp).
	// Hosted MCP uses voice_call (the live, Claude-driven flow) for outbound
	// calling — see live-call.ts.

	// ── voice_list_calls ──

	server.registerTool(
		"voice_call_list",
		{
			title: "List Voice Calls",
			description: "List voice calls with optional filters. Returns call history with status, direction, duration, and tier info.",
			inputSchema: {
			agentId: z.string().optional()
				.describe("Filter by agent ID."),
			direction: z.enum(["INBOUND", "OUTBOUND"]).optional()
				.describe("Filter by call direction."),
			state: z.string().optional()
				.describe("Filter by call state (INITIATING, RINGING, ACTIVE, ENDED)."),
			limit: z.number().int().positive().optional()
				.describe("Max results (default: 20)."),
			offset: z.number().int().nonnegative().optional()
				.describe("Offset for pagination."),
		},
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
			if (args.state) params.set("state", args.state);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			if (args.offset !== undefined) params.set("offset", String(args.offset));
			const path = params.toString() ? `/v1/voice/calls?${params}` : "/v1/voice/calls";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	// ── voice_get_call ──

	server.registerTool(
		"voice_call_get",
		{
			title: "Get Voice Call",
			description: "Get a voice call: status, duration, participants, tier, AND the AI-generated summary (one-liner, topics, action items, decisions, open questions, next steps, intent, outcome). The summary is generated once on the first read after post-call processing completes and cached on the call row — subsequent calls return the cached value without re-generating.",
			inputSchema: {
			callId: z.string()
				.describe("The call ID to retrieve."),
		},
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/voice/calls/${args.callId}`);
			return toolSuccess(result);
		}, options.context),
	);

	// ── voice_get_transcript ──

	server.registerTool(
		"voice_transcript_get",
		{
			title: "Get Voice Transcript",
			description: "Get the full transcript of a voice call with speaker labels, timestamps, and confidence scores. Available after the call ends and transcription completes.",
			inputSchema: {
			callId: z.string()
				.describe("The call ID to get the transcript for."),
		},
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/voice/calls/${args.callId}/transcript`);
			return toolSuccess(result);
		}, options.context),
	);

	// ── voice_get_recording ──

	server.registerTool(
		"voice_recording_get",
		{
			title: "Get Voice Recording",
			description: "Get a time-limited download URL for a call recording (WAV format). The URL expires after 1 hour. Recording must have been enabled during the call.",
			inputSchema: {
			callId: z.string()
				.describe("The call ID to get the recording for."),
		},
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/voice/calls/${args.callId}/recording`);
			return toolSuccess(result);
		}, options.context),
	);

	// voice_get_summary removed — the summary is now part of voice_get_call's
	// response. The backend generates the summary once on first read and
	// caches it on the call row, so callers no longer need a separate tool
	// (and the API no longer needs to re-run summarization on every fetch).

	// ── voice_get_score ──

	server.registerTool(
		"voice_score_get",
		{
			title: "Get Voice Score",
			description: "Get the quality score of a call with composite score (0-100), sub-scores (resolution, sentiment, efficiency, engagement, latency, compliance), and detailed metrics (speaking time, dead air, response latency).",
			inputSchema: {
			callId: z.string()
				.describe("The call ID to get the score for."),
		},
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/voice/calls/${args.callId}/score`);
			return toolSuccess(result);
		}, options.context),
	);

	// ── voice_search_calls ──

	server.registerTool(
		"voice_call_search",
		{
			title: "Search Voice Calls",
			description: "Semantic search across all call transcripts using natural language. Uses vector similarity to find relevant call segments. Great for finding specific conversations or topics discussed.",
			inputSchema: {
			query: z.string()
				.describe("Natural language search query (e.g. 'billing dispute', 'product demo')."),
			agentId: z.string().optional()
				.describe("Filter results to a specific agent."),
			dateFrom: z.string().optional()
				.describe("Filter from date (ISO 8601)."),
			dateTo: z.string().optional()
				.describe("Filter to date (ISO 8601)."),
			limit: z.number().int().positive().optional()
				.describe("Max results (default: 10)."),
			threshold: z.number().min(0).max(1).optional()
				.describe("Similarity threshold 0-1 (default: 0.7). Lower = more results."),
		},
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const body: Record<string, unknown> = { query: args.query };
			if (args.agentId) body.agentId = args.agentId;
			if (args.dateFrom) body.dateFrom = args.dateFrom;
			if (args.dateTo) body.dateTo = args.dateTo;
			if (args.limit !== undefined) body.limit = args.limit;
			if (args.threshold !== undefined) body.threshold = args.threshold;
			const result = await context.client.post<unknown>("/v1/voice/search", body);
			return toolSuccess(result);
		}, options.context),
	);

	// ── voice_get_security_scan ──

	server.registerTool(
		"voice_security_scan_get",
		{
			title: "Get Voice Security Scan",
			description: "Get security scan results for a call including detected threats (PII leakage, prompt injection, social engineering), compliance pass/fail, and risk score (0-100). Available after post-call security analysis.",
			inputSchema: {
			callId: z.string()
				.describe("The call ID to get security scan results for."),
		},
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/voice/calls/${args.callId}/security`);
			return toolSuccess(result);
		}, options.context),
	);
}
