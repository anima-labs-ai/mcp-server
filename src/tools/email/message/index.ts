import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	withErrorHandling,
	toolSuccess,
} from "../../../shared/index.js";

export function registerMessageTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	const messageSendEmailInput = z.object({
		to: z.string().describe("Recipient email address."),
		subject: z.string().describe("Subject line for the email."),
		text: z
			.string()
			.optional()
			.describe("Optional plain-text body content."),
		html: z
			.string()
			.optional()
			.describe("Optional HTML body content."),
		agentId: z.string().describe("Agent ID sending the message."),
	});
    const messageSendSmsInput = z.object({
		to: z.string().describe("Destination phone number for the SMS."),
		body: z.string().describe("SMS body content to send."),
		agentId: z.string().describe("Agent ID sending the message."),
	});
	const messageGetInput = z.object({
		id: z.string().describe("Message ID to retrieve."),
	});
	const messageListInput = z.object({
		channel: z
			.string()
			.optional()
			.describe("Optional message channel filter such as EMAIL or SMS."),
		direction: z
			.string()
			.optional()
			.describe("Optional direction filter such as INBOUND or OUTBOUND."),
		status: z
			.string()
			.optional()
			.describe("Optional delivery status filter."),
		agentId: z
			.string()
			.optional()
			.describe("Optional agent ID to scope message results."),
		limit: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Optional maximum number of messages to return."),
		cursor: z
			.string()
			.optional()
			.describe("Optional pagination cursor from a previous response."),
	});
	const messageSearchInput = z.object({
		query: z.string().describe("Search text query."),
		channel: z
			.string()
			.optional()
			.describe("Optional channel filter for search results."),
		from: z
			.string()
			.optional()
			.describe("Optional sender filter, such as email address or phone."),
		to: z
			.string()
			.optional()
			.describe("Optional recipient filter, such as email address or phone."),
		after: z
			.string()
			.optional()
			.describe("Optional inclusive lower date bound in ISO format."),
		before: z
			.string()
			.optional()
			.describe("Optional inclusive upper date bound in ISO format."),
		limit: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Optional maximum number of matches to return."),
	});
	const messageSemanticSearchInput = z.object({
		query: z.string().describe("Semantic query text to search message meaning."),
		agentId: z
			.string()
			.optional()
			.describe("Optional agent ID to scope semantic search results."),
		limit: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Optional maximum number of semantic matches to return."),
		threshold: z
			.number()
			.min(0)
			.max(1)
			.optional()
			.describe("Optional minimum similarity threshold from 0 to 1."),
	});
	const conversationSearchInput = z.object({
		topic: z.string().describe("Topic description used for semantic conversation discovery."),
		agentId: z
			.string()
			.optional()
			.describe("Optional agent ID to scope conversation search results."),
		limit: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Optional maximum number of messages to consider."),
	});
	const messageUploadAttachmentInput = z.object({
		messageId: z.string().describe("Message ID receiving the attachment."),
		filename: z.string().describe("Attachment filename shown to recipients."),
		content: z
			.string()
			.describe("Attachment content encoded as a string payload."),
		contentType: z
			.string()
			.optional()
			.describe("Optional MIME type for the attachment."),
	});
	const messageGetAttachmentInput = z.object({
		id: z.string().describe("Attachment ID."),
	});

	server.registerTool(
		"message_send_email",
		{
			description: "Send an outbound email through the unified messaging API when your workflow should create a tracked message record. Use this for programmatic email delivery tied to an agent identity.",
			inputSchema: messageSendEmailInput.shape,
		},
		withErrorHandling(async (args, context) => {
			const payload = {
				agentId: args.agentId,
				to: [args.to],
				subject: args.subject,
				body: args.text ?? args.html ?? "(empty message)",
				bodyHtml: args.html,
			};
			const result = await context.client.post("/v1/messages/email", payload);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"message_send_sms",
		{
			description: "Send an outbound SMS through the unified messaging API and return the created message record. Use this for transactional texts or agent-driven mobile messaging.",
			inputSchema: messageSendSmsInput.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post("/v1/messages/sms", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"message_get",
		{
			description: "Fetch a specific message by ID, including channel metadata and delivery status. Use this when a workflow needs to inspect one message in detail.",
			inputSchema: messageGetInput.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get(`/v1/messages/${args.id}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"message_list",
		{
			description: "List messages with optional channel, direction, status, and pagination filters. Use this to browse recent traffic or build paged inbox/outbox views.",
			inputSchema: messageListInput.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.channel) params.set("channel", args.channel);
			if (args.direction) params.set("direction", args.direction);
			if (args.status) params.set("status", args.status);
			if (args.agentId) params.set("agentId", args.agentId);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			if (args.cursor) params.set("cursor", args.cursor);

			const path = params.toString() ? `/v1/messages?${params}` : "/v1/messages";
			const result = await context.client.get(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"message_search",
		{
			description: "Run full-text search across messages with optional channel and date constraints. Use this to locate prior conversations or audit communication history quickly.",
			inputSchema: messageSearchInput.shape,
		},
		withErrorHandling(async (args, context) => {
			// API contract MessageSearchInput expects nested
			// {query, filters: {channel, ...}, pagination: {limit, cursor}}.
			// Sending the args flat caused the API to fall back to
			// pagination.limit=20 (the contract default) regardless of what
			// the caller passed, so even `limit: 1` returned ~900KB of full
			// message bodies + raw email headers. Reshape into the contract.
			const dateRange =
				args.after || args.before
					? { from: args.after, to: args.before }
					: undefined;
			const body: Record<string, unknown> = {
				query: args.query,
				filters: {
					channel: args.channel,
					...(dateRange ? { dateRange } : {}),
					// `from`/`to` aren't on MessageSearchInput.filters today;
					// keeping them as filters here means they're ignored
					// silently. Pre-filter client-side or add to the contract.
				},
				pagination: { limit: args.limit ?? 20 },
			};
			const result = await context.client.post("/v1/messages/search", body);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"message_semantic_search",
		{
			description: "Search messages by semantic similarity using embeddings rather than exact keyword matching. Use this to find conceptually related messages even when wording differs.",
			inputSchema: messageSemanticSearchInput.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post("/v1/messages/search/semantic", {
				query: args.query,
				agentId: args.agentId,
				limit: args.limit,
				threshold: args.threshold,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"conversation_search",
		{
			description: "Search conversation threads by topic by combining semantic message retrieval with thread grouping. Use this to discover related discussions rather than individual messages.",
			inputSchema: conversationSearchInput.shape,
		},
		withErrorHandling(async (args, context) => {
			const semanticResult = await context.client.post<{
				results: Array<{
					id: string;
					content: string;
					similarity: number;
					channel: string;
					direction: string;
					createdAt: string;
					agentId: string;
				}>;
			}>("/v1/messages/search/semantic", {
				query: args.topic,
				agentId: args.agentId,
				limit: args.limit ?? 10,
				threshold: 0.65,
			});

			const grouped = new Map<
				string,
				{
					threadId: string;
					messageCount: number;
					maxSimilarity: number;
					messages: Array<{
						id: string;
						similarity: number;
						createdAt: string;
						contentPreview: string;
					}>;
				}
			>();

			for (const message of semanticResult.results) {
				const fullMessage = await context.client.get<{ threadId: string | null }>(
					`/v1/messages/${message.id}`,
				);
				const threadId = fullMessage.threadId ?? message.id;

				const existing = grouped.get(threadId);
				if (!existing) {
					grouped.set(threadId, {
						threadId,
						messageCount: 1,
						maxSimilarity: message.similarity,
						messages: [
							{
								id: message.id,
								similarity: message.similarity,
								createdAt: message.createdAt,
								contentPreview: message.content.slice(0, 200),
							},
						],
					});
					continue;
				}

				existing.messageCount += 1;
				existing.maxSimilarity = Math.max(existing.maxSimilarity, message.similarity);
				existing.messages.push({
					id: message.id,
					similarity: message.similarity,
					createdAt: message.createdAt,
					contentPreview: message.content.slice(0, 200),
				});
			}

			const conversations = [...grouped.values()].sort(
				(a, b) => b.maxSimilarity - a.maxSimilarity,
			);

			return toolSuccess({
				topic: args.topic,
				conversationCount: conversations.length,
				conversations,
			});
		}, options.context),
	);

	server.registerTool(
		"message_upload_attachment",
		{
			description: "Upload an attachment for an existing message by ID so downstream delivery or processing can reference the file. Use this when adding files after message creation.",
			inputSchema: messageUploadAttachmentInput.shape,
		},
		withErrorHandling(async (args, context) => {
			const { messageId, ...body } = args;
			const result = await context.client.post(
				`/v1/messages/${messageId}/attachments`,
				body,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"message_get_attachment",
		{
			description: "Retrieve a temporary download URL for a previously uploaded attachment. Use this when a client needs direct file access for preview or download.",
			inputSchema: messageGetAttachmentInput.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get(`/v1/attachments/${args.id}/download`);
			return toolSuccess(result);
		}, options.context),
	);
}
