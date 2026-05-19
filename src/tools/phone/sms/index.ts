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

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null
		? (value as UnknownRecord)
		: undefined;
}

/**
 * Aggregate a flat list of SMS messages into per-thread summaries.
 *
 * Each thread summary carries the threadId, the agent's other party
 * (participantAddress), the most recent message snippet + timestamp + direction,
 * and a messageCount. Sorted by lastMessageAt descending.
 *
 * Pre-launch note: aggregation is client-side; replace with a server-side
 * /v1/sms/threads endpoint when SMS traffic grows past `messageFetchLimit`.
 */
function aggregateThreads(messages: UnknownRecord[]): UnknownRecord[] {
	const byThread = new Map<string, UnknownRecord & { messageCount: number }>();

	for (const msg of messages) {
		const threadId = typeof msg.threadId === "string" ? msg.threadId : null;
		if (!threadId) continue;

		const direction = typeof msg.direction === "string" ? msg.direction : null;
		const participantAddress =
			direction === "INBOUND" && typeof msg.fromAddress === "string"
				? msg.fromAddress
				: typeof msg.toAddress === "string"
					? msg.toAddress
					: null;
		const createdAt = typeof msg.createdAt === "string" ? msg.createdAt : null;
		const body = typeof msg.body === "string" ? msg.body : "";

		const existing = byThread.get(threadId);
		const isNewer =
			!existing ||
			(createdAt !== null &&
				typeof existing.lastMessageAt === "string" &&
				createdAt > existing.lastMessageAt);

		if (isNewer) {
			byThread.set(threadId, {
				threadId,
				agentId: msg.agentId ?? null,
				participantAddress,
				lastMessageAt: createdAt,
				lastMessageSnippet: body.slice(0, 140),
				lastMessageDirection: direction,
				messageCount: (existing?.messageCount ?? 0) + 1,
			});
		} else if (existing) {
			existing.messageCount += 1;
		}
	}

	const threads = [...byThread.values()];
	threads.sort((a, b) => {
		const aTime = typeof a.lastMessageAt === "string" ? a.lastMessageAt : "";
		const bTime = typeof b.lastMessageAt === "string" ? b.lastMessageAt : "";
		return bTime.localeCompare(aTime);
	});
	return threads;
}

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
			params.set("channel", "SMS");
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
				"List SMS conversations. Optionally filter by agent_id to see conversations for a specific agent. Each conversation is a thread between your number and an external contact. Returns thread summaries with last message snippet + participant address.",
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
			const messageFetchLimit = 500;
			const params = new URLSearchParams();
			params.set("channel", "SMS");
			params.set("limit", String(messageFetchLimit));
			if (args.agentId) params.set("agentId", args.agentId);

			const raw = await context.client.get<unknown>(`/v1/messages?${params}`);
			const rawRecord = asRecord(raw);
			const items = Array.isArray(rawRecord?.items)
				? (rawRecord.items as UnknownRecord[])
				: Array.isArray(raw)
					? (raw as UnknownRecord[])
					: [];

			const threads = aggregateThreads(items);
			const offset = args.offset ?? 0;
			const limit = args.limit ?? 20;
			const page = threads.slice(offset, offset + limit);

			return toolSuccess({
				items: page,
				total: threads.length,
				hasMore: offset + limit < threads.length,
			});
		}, options.context),
	);

	server.registerTool(
		"sms_thread_get",
		{
			title: "Get SMS Thread",
			description:
				"Get a specific SMS conversation with message history. Use sms_thread_list to find IDs. Returns messages in the thread ordered by time.",
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
			params.set("threadId", args.id);
			params.set("channel", "SMS");
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			const result = await context.client.get<unknown>(`/v1/messages?${params}`);
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
