import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	listOutput,
	objectOutput,
	sendOutput,
	toolSuccess,
	withErrorHandling,
} from "../../../shared/index.js";


export function registerMessageTools(options: ToolRegistrationOptions): void {
	const { server } = options;

    const messageSendSmsInput = z.object({
		to: z.string().describe("Destination phone number for the SMS."),
		body: z.string().describe("SMS body content to send."),
		agentId: z.string().describe("Agent ID sending the message."),
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
	server.registerTool(
		"message_send_sms",
		{
			title: "Message Send SMS",
			description: "Send an outbound SMS through the unified messaging API and return the created message record. Use this for transactional texts or agent-driven mobile messaging.",
			inputSchema: messageSendSmsInput.shape,
			outputSchema: sendOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post("/v1/messages/sms", args);
			return toolSuccess(result);
		}, options.context),
	);
	server.registerTool(
		"message_search",
		{
			title: "Message Search",
			description: "Run full-text search across messages on every channel (email and SMS) with optional channel and date constraints. Use this for cross-channel auditing; for email-only search use `email_search`.",
			inputSchema: messageSearchInput.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
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
			title: "Message Semantic Search",
			description: "Search messages by semantic similarity using embeddings rather than exact keyword matching. Use this to find conceptually related messages even when wording differs.",
			inputSchema: messageSemanticSearchInput.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
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
			title: "Search Conversation",
			description: "Search conversation threads by topic by combining semantic message retrieval with thread grouping. Use this to discover related discussions rather than individual messages.",
			inputSchema: conversationSearchInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
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
			title: "Message Upload Attachment",
			description: "Upload an attachment for an existing message by ID so downstream delivery or processing can reference the file. Use this when adding files after message creation.",
			inputSchema: messageUploadAttachmentInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
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

}
