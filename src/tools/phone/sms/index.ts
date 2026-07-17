/**
 * SMS MCP Tools
 *
 * 4 tools for SMS messaging on the agent's provisioned phone number(s).
 * Conceptually distinct from the phone group (number provisioning) —
 * these are runtime messaging tools.
 *
 *   - sms_get:         single SMS by id, or list filtered by agent
 *   - sms_thread_list: SMS conversation summaries (one entry per thread)
 *   - sms_thread_get:  full message history for a specific thread
 *   - sms_send:        send SMS or MMS (with optional media)
 *
 * SMS THREADS (spec F3): the two thread tools used to be FICTION. No SMS write
 * path ever set Message.threadId (the API's own backfill migration said "SMS
 * rows keep thread_id = NULL"), yet sms_thread_get filtered `/v1/messages` by
 * threadId and sms_thread_list grouped the results by threadId client-side,
 * skipping every row whose threadId was null — which was all of them. Both
 * returned EMPTY for every customer, always. The API now threads SMS by
 * (agent, counterparty) and serves real endpoints, so these are thin
 * pass-throughs to `/v1/phone/sms/threads`; the client-side aggregation (and
 * its 100-message truncation) is gone.
 */

import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	listOutput,
	objectOutput,
	sendOutput,
	toolSuccess,
	withErrorHandling,
} from "../../../shared/index.js";

const smsGetSchema = z.object({
	id: z.string().describe("SMS message ID."),
});

const smsListSchema = z.object({
	agentId: z.string().optional().describe("Filter SMS by agent ID."),
	cursor: z.string().optional().describe("Pagination cursor from a previous list response."),
	limit: z.number().int().positive().optional().describe("Max SMS messages to return."),
});

const smsThreadListSchema = z.object({
	agentId: z
		.string()
		.optional()
		.describe("Filter conversations by agent ID. Omit to see threads across all agents you have access to."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Max thread summaries to return. Defaults to 20."),
	offset: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Pagination offset (skip this many threads from the start)."),
});

const smsThreadGetSchema = z.object({
	id: z.string().describe("Thread ID (use sms_thread_list to find IDs)."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Max messages to return in the thread."),
});

const smsSendSchema = z.object({
	agentId: z.string().describe("Agent ID sending the SMS. The agent must have a provisioned phone number."),
	to: z.string().describe("Recipient phone number in E.164 format (e.g. +14155551234)."),
	body: z.string().describe("Message body. SMS character limits apply (~160 chars per segment)."),
	mediaUrls: z
		.array(z.string())
		.optional()
		.describe(
			"Optional array of media URLs for MMS. Pass one URL for a single image/file; multiple for multi-part MMS. Carrier limits apply.",
		),
});

export function registerSmsTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"sms_get",
		{
			title: "Get SMS",
			description:
				"Fetch full detail for a single SMS by ID (includes its `threadId` for joining the conversation). Use sms_list to browse multiple SMS messages.",
			inputSchema: smsGetSchema.shape,
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
				`/v1/messages/${encodeURIComponent(args.id)}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"sms_list",
		{
			title: "List SMS",
			description:
				"List SMS messages with optional filters. Each result includes its `threadId` for joining the conversation. Use sms_get for full single-message detail.",
			inputSchema: smsListSchema.shape,
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
			// SMS *and* MMS: a text conversation contains both, and a picture
			// message is stored as MMS (spec F4). Filtering `channel=SMS` alone
			// would silently hide every photo the agent sent or received.
			params.append("channels", "SMS");
			params.append("channels", "MMS");
			if (args.agentId) params.set("agentId", args.agentId);
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			const result = await context.client.get<unknown>(`/v1/messages?${params}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"sms_thread_list",
		{
			title: "List SMS Threads",
			description:
				"List SMS/MMS conversations, most recently active first. A conversation is one agent number talking to one external contact. Returns summaries (participant, last message snippet, message count) — use sms_thread_get for the full history. Optionally filter by agentId.",
			inputSchema: smsThreadListSchema.shape,
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
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			if (args.offset !== undefined) params.set("offset", String(args.offset));
			const query = params.toString();
			const result = await context.client.get<unknown>(
				`/v1/phone/sms/threads${query ? `?${query}` : ""}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"sms_thread_get",
		{
			title: "Get SMS Thread",
			description:
				"Get one SMS/MMS conversation with its message history, oldest first. Use sms_thread_list to find thread IDs (or take `threadId` off any SMS). For a conversation longer than `limit`, returns its most recent messages; page deeper history with sms_list.",
			inputSchema: smsThreadGetSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			const query = params.toString();
			const result = await context.client.get<unknown>(
				`/v1/phone/sms/threads/${encodeURIComponent(args.id)}${query ? `?${query}` : ""}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"sms_send",
		{
			title: "Send SMS",
			description:
				"Send an SMS to a phone number, or an MMS by passing `mediaUrls`. The agent must have a provisioned phone number. Use this for transactional texts or conversational messaging.",
			inputSchema: smsSendSchema.shape,
			outputSchema: sendOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const body: Record<string, unknown> = {
				agentId: args.agentId,
				to: args.to,
				body: args.body,
			};
			if (args.mediaUrls && args.mediaUrls.length > 0) {
				body.mediaUrls = args.mediaUrls;
			}
			const result = await context.client.post<unknown>("/v1/phone/send-sms", body);
			return toolSuccess(result);
		}, options.context),
	);
}
