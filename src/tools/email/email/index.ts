import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	deleteOutput,
	listOutput,
	objectOutput,
	requireMasterKeyGuard,
	sendOutput,
	toolSuccess,
	withErrorHandling,
} from "../../../shared/index.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null
		? (value as UnknownRecord)
		: undefined;
}

function extractEmailAddress(value: unknown): string | undefined {
	if (typeof value === "string") {
		return value;
	}

	if (Array.isArray(value)) {
		for (const item of value) {
			const address = extractEmailAddress(item);
			if (address) return address;
		}
		return undefined;
	}

	const record = asRecord(value);
	if (!record) return undefined;

	const email = record.email;
	if (typeof email === "string") return email;

	const address = record.address;
	if (typeof address === "string") return address;

	return undefined;
}

function extractStringArray(value: unknown): string[] {
	if (Array.isArray(value)) {
		return value.filter((item): item is string => typeof item === "string");
	}
	if (typeof value === "string") {
		return [value];
	}
	return [];
}

function dedupeStrings(values: string[]): string[] {
	return [...new Set(values.filter((value) => value.length > 0))];
}

function ensureReplySubject(subject: string): string {
	return /^re:/i.test(subject.trim()) ? subject : `Re: ${subject}`;
}

function ensureForwardSubject(subject: string): string {
	return /^fwd:/i.test(subject.trim()) ? subject : `Fwd: ${subject}`;
}

function extractEmailItems(payload: unknown): UnknownRecord[] {
	if (Array.isArray(payload)) {
		return payload
			.map((item) => asRecord(item))
			.filter((item): item is UnknownRecord => Boolean(item));
	}

	const record = asRecord(payload);
	if (!record) return [];

	const candidates = [record.items, record.messages, record.data];
	for (const candidate of candidates) {
		if (Array.isArray(candidate)) {
			return candidate
				.map((item) => asRecord(item))
				.filter((item): item is UnknownRecord => Boolean(item));
		}
	}

	return [];
}

function extractHeaderId(original: UnknownRecord): string | undefined {
	const messageId = original.messageId;
	if (typeof messageId === "string") return messageId;

	const id = original.id;
	if (typeof id === "string") return id;

	return undefined;
}

function extractReferences(original: UnknownRecord): string[] {
	const refs = extractStringArray(original.references);
	const inReplyTo = original.inReplyTo;
	if (typeof inReplyTo === "string") refs.push(inReplyTo);

	const headerId = extractHeaderId(original);
	if (headerId) refs.push(headerId);

	return dedupeStrings(refs);
}

function stringifyValue(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null || value === undefined) return "";
	return JSON.stringify(value);
}

const emailSendSchema = z.object({
	agentId: z.string().describe("Agent ID sending the email."),
	fromIdentityId: z
		.string()
		.optional()
		.describe(
			"Optional EmailIdentity ID to send from. Must belong to this agent and be verified. If omitted, the agent's primary identity is used. Use this to route different message types through different identities (e.g. transactional from @brawz.ai, support from @support.brawz.ai). Discover available IDs via agent_email_identity_list.",
		),
	to: z.array(z.string()).describe("List of recipient email addresses."),
	subject: z.string().describe("Subject line for the outgoing email."),
	body: z.string().describe("Plain-text body content for the email."),
	bodyHtml: z
		.string()
		.optional()
		.describe("Optional HTML body content for rich email formatting."),
	cc: z
		.array(z.string())
		.optional()
		.describe("Optional CC recipient email addresses."),
	bcc: z
		.array(z.string())
		.optional()
		.describe("Optional BCC recipient email addresses."),
	inReplyTo: z
		.string()
		.optional()
		.describe(
			"Optional message ID to set the In-Reply-To header for threading.",
		),
	references: z
		.array(z.string())
		.optional()
		.describe(
			"Optional list of message IDs to include in the References header.",
		),
});

const emailGetSchema = z.object({
	id: z.string().describe("Unique email ID to fetch."),
});

const emailListSchema = z.object({
	folder: z
		.string()
		.optional()
		.describe("Optional folder name to list, such as inbox or sent."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Optional maximum number of emails to return."),
	offset: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Optional pagination offset for the email list."),
});

const emailReplySchema = z.object({
	agentId: z.string().describe("Agent ID sending the reply."),
	originalId: z.string().describe("Original email ID being replied to."),
	text: z.string().describe("Plain-text content for your reply message."),
	html: z
		.string()
		.optional()
		.describe("Optional HTML content for the reply body."),
	replyAll: z
		.boolean()
		.optional()
		.describe(
			"When true, include additional participants from the original email.",
		),
});

const emailForwardSchema = z.object({
	agentId: z.string().describe("Agent ID forwarding the email."),
	originalId: z.string().describe("Original email ID being forwarded."),
	to: z.string().describe("Recipient email address for the forwarded message."),
	text: z
		.string()
		.optional()
		.describe(
			"Optional introductory text to prepend before forwarded content.",
		),
});

const emailSearchSchema = z.object({
	query: z
		.string()
		.optional()
		.describe("Free-text search query applied across email content."),
	from: z.string().optional().describe("Optional sender email filter."),
	to: z.string().optional().describe("Optional recipient email filter."),
	subject: z
		.string()
		.optional()
		.describe("Optional subject-line search filter."),
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
		.describe("Optional maximum number of search results."),
});

const inboxDigestSchema = z.object({
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			"Optional maximum number of recent emails to include in the digest.",
		),
});

const emailMarkReadSchema = z.object({
	id: z.string().describe("Unique email ID to mark as read."),
});

const emailMarkUnreadSchema = z.object({
	id: z.string().describe("Unique email ID to mark as unread."),
});

const batchMarkReadSchema = z.object({
	ids: z
		.array(z.string())
		.min(1)
		.describe("List of email IDs to mark as read."),
});

const batchMarkUnreadSchema = z.object({
	ids: z
		.array(z.string())
		.min(1)
		.describe("List of email IDs to mark as unread."),
});

const batchDeleteSchema = z.object({
	ids: z
		.array(z.string())
		.min(1)
		.describe("List of email IDs to delete in one operation."),
});

const batchMoveSchema = z.object({
	ids: z
		.array(z.string())
		.min(1)
		.describe("List of email IDs to move in one operation."),
	folder: z.string().describe("Destination folder name for moved emails."),
});

const emailMoveSchema = z.object({
	id: z.string().describe("Unique email ID to move."),
	folder: z.string().describe("Destination folder name for the email."),
});

const emailDeleteSchema = z.object({
	id: z.string().describe("Unique email ID to delete."),
});

// manage_folders/contacts/templates + template_send schemas removed
// alongside their tool registrations — see comment near the end of
// registerEmailTools.

export function registerEmailTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	const emailSendHandler = withErrorHandling(async (args, context) => {
		const body: Record<string, unknown> = {
			agentId: args.agentId,
			to: args.to,
			subject: args.subject,
			body: args.body,
		};
		if (args.fromIdentityId) body.fromIdentityId = args.fromIdentityId;
		if (args.bodyHtml) body.bodyHtml = args.bodyHtml;
		if (args.cc) body.cc = args.cc;
		if (args.bcc) body.bcc = args.bcc;
		if (args.inReplyTo) body.inReplyTo = args.inReplyTo;
		if (args.references) body.references = args.references;
		const result = await context.client.post<unknown>("/v1/email/send", body);
		return toolSuccess(result);
	}, options.context);

	server.registerTool(
		"email_send",
		{
			title: "Send Email",
			description:
				"Send a new outbound email from the agent mailbox. Use this when you need to compose and deliver a message with optional CC, threading headers.",
			inputSchema: emailSendSchema.shape,
			outputSchema: sendOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		emailSendHandler,
	);

	const emailGetHandler = withErrorHandling<z.infer<typeof emailGetSchema>>(
		async (args, context) => {
			const path = `/v1/email/${encodeURIComponent(args.id)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		},
		options.context,
	);

	server.registerTool(
		"email_get",
		{
			title: "Get Email",
			description:
				"Retrieve one specific email by ID, including metadata and body fields. Use this before replying, forwarding, or inspecting message details.",
			inputSchema: emailGetSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		emailGetHandler,
	);

	const emailListHandler = withErrorHandling<z.infer<typeof emailListSchema>>(
		async (args, context) => {
			const params = new URLSearchParams();
			if (args.folder) params.set("folder", args.folder);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			if (args.offset !== undefined)
				params.set("offset", String(args.offset));

			const path = params.toString() ? `/v1/email?${params}` : "/v1/email";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		},
		options.context,
	);

	server.registerTool(
		"email_list",
		{
			title: "List Email",
			description:
				"List emails in inbox or another folder with pagination controls. Use this to browse recent messages and mailbox contents.",
			inputSchema: emailListSchema.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		emailListHandler,
	);

	server.registerTool(
		"email_reply",
		{
			title: "Reply Email",
			description:
				"Reply to an existing email thread by first loading the original message and setting threading headers. Use this when you need a proper in-thread response.",
			inputSchema: emailReplySchema.shape,
			outputSchema: sendOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);

			const originalPath = `/v1/email/${encodeURIComponent(args.originalId)}`;
			const originalData = await context.client.get<unknown>(originalPath);
			const original = asRecord(originalData);
			if (!original) {
				throw new Error("Original email payload is missing or invalid.");
			}

			const replyToAddress =
				extractEmailAddress(original.replyTo) ??
				extractEmailAddress(original.from);
			if (!replyToAddress) {
				throw new Error(
					"Unable to determine reply recipient from original email.",
				);
			}

			const subjectRaw =
				typeof original.subject === "string" ? original.subject : "No subject";
			const subject = ensureReplySubject(subjectRaw);

			const references = extractReferences(original);
			const inReplyTo = extractHeaderId(original);

			const payload: {
				agentId: string;
				to: string[];
				subject: string;
				body: string;
				bodyHtml?: string;
				cc?: string[];
				inReplyTo?: string;
				references?: string[];
			} = {
				agentId: args.agentId,
				to: [replyToAddress],
				subject,
				body: args.text,
			};

			if (args.html) payload.bodyHtml = args.html;
			if (inReplyTo) payload.inReplyTo = inReplyTo;
			if (references.length > 0) payload.references = references;

			if (args.replyAll) {
				const ccList = dedupeStrings(
					[
						...extractStringArray(original.cc),
						...extractStringArray(original.to),
					].filter((address) => address !== replyToAddress),
				);

				if (ccList.length > 0) {
					payload.cc = ccList;
				}
			}

			const result = await context.client.post<unknown>(
				"/v1/email/send",
				payload,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_forward",
		{
			title: "Forward Email",
			description:
				"Forward an existing email to another recipient by loading the original content first. Use this to share a prior message while preserving context.",
			inputSchema: emailForwardSchema.shape,
			outputSchema: sendOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const originalPath = `/v1/email/${encodeURIComponent(args.originalId)}`;
			const originalData = await context.client.get<unknown>(originalPath);
			const original = asRecord(originalData);
			if (!original) {
				throw new Error("Original email payload is missing or invalid.");
			}

			const subjectRaw =
				typeof original.subject === "string" ? original.subject : "No subject";
			const subject = ensureForwardSubject(subjectRaw);

			const from = extractEmailAddress(original.from) ?? "unknown sender";
			const date = stringifyValue(
				original.date || original.createdAt || "unknown date",
			);
			const originalText =
				typeof original.text === "string"
					? original.text
					: typeof original.snippet === "string"
						? original.snippet
						: "(Original email body unavailable)";

			const intro = args.text ? `${args.text}\n\n` : "";
			const forwardedBody =
				`${intro}---------- Forwarded message ----------\n` +
				`From: ${from}\n` +
				`Date: ${date}\n` +
				`Subject: ${subjectRaw}\n\n` +
				`${originalText}`;

			const payload = {
				agentId: args.agentId,
				to: [args.to],
				subject,
				body: forwardedBody,
			};

			const result = await context.client.post<unknown>(
				"/v1/email/send",
				payload,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_search",
		{
			title: "Search Email",
			description:
				"Search mailbox emails (EMAIL channel only) by query text and structured filters like sender, recipient, subject, and date bounds. For cross-channel search (email + SMS) use `message_search`.",
			inputSchema: emailSearchSchema.shape,
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
			// {query, filters, pagination: {limit, cursor}}. Sending args
			// flat caused the API to use pagination.limit=20 (the contract
			// default) and ignore the caller's `limit` — see message_search
			// fix for the same root cause and detail. Force EMAIL channel
			// since this is the email-domain alias of message_search.
			const dateRange =
				args.after || args.before
					? { from: args.after, to: args.before }
					: undefined;
			const body: Record<string, unknown> = {
				query: args.query ?? args.subject ?? "",
				filters: {
					channel: "EMAIL",
					...(dateRange ? { dateRange } : {}),
				},
				pagination: { limit: args.limit ?? 20 },
			};
			const result = await context.client.post<unknown>(
				"/v1/messages/search",
				body,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"inbox_digest",
		{
			title: "Inbox Digest",
			description:
				"Generate a compact digest of recent inbox messages with sender, subject, date, and snippet. Use this for quick triage without opening each email.",
			inputSchema: inboxDigestSchema.shape,
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
			if (args.limit !== undefined) params.set("limit", String(args.limit));

			const path = params.toString() ? `/v1/email?${params}` : "/v1/email";
			const result = await context.client.get<unknown>(path);
			const items = extractEmailItems(result);

			const digestItems = items.map((item, index) => {
				// API returns `fromAddress` (string) on EMAIL items. Some
				// shapes nest under `from` (legacy), so accept both. Same
				// for body/text/snippet and sentAt/receivedAt/createdAt
				// for ordering — INBOUND messages have receivedAt, OUTBOUND
				// have sentAt, both have createdAt as a fallback.
				const from =
					(typeof item.fromAddress === "string"
						? item.fromAddress
						: undefined) ??
					extractEmailAddress(item.from) ??
					"unknown sender";
				const subject =
					typeof item.subject === "string" && item.subject.length > 0
						? item.subject
						: "(no subject)";
				const date =
					(typeof item.sentAt === "string" ? item.sentAt : undefined) ??
					(typeof item.receivedAt === "string" ? item.receivedAt : undefined) ??
					(typeof item.createdAt === "string" ? item.createdAt : undefined) ??
					(typeof item.date === "string" ? item.date : undefined) ??
					"unknown date";
				const rawBody =
					(typeof item.body === "string" ? item.body : undefined) ??
					(typeof item.snippet === "string" ? item.snippet : undefined) ??
					(typeof item.text === "string" ? item.text : undefined) ??
					"";
				const snippet = rawBody.slice(0, 140);

				return {
					index: index + 1,
					from,
					subject,
					date,
					snippet,
				};
			});

			const summary = digestItems
				.map(
					(item) =>
						`${item.index}. ${item.from} | ${item.subject} | ${item.date}${item.snippet ? ` | ${item.snippet}` : ""}`,
				)
				.join("\n");

			return toolSuccess({
				count: digestItems.length,
				items: digestItems,
				summary,
			});
		}, options.context),
	);

	server.registerTool(
		"email_mark_read",
		{
			title: "Mark Email Read",
			description: "Mark a specific email message as read by ID.",
			inputSchema: emailMarkReadSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/email/${encodeURIComponent(args.id)}/read`;
			const result = await context.client.post<unknown>(path, { id: args.id });
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_mark_unread",
		{
			title: "Mark Email Unread",
			description: "Mark a specific email message as unread by ID.",
			inputSchema: emailMarkUnreadSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/email/${encodeURIComponent(args.id)}/unread`;
			const result = await context.client.post<unknown>(path, { id: args.id });
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"batch_mark_read",
		{
			title: "Mark Batch Read",
			description: "Mark multiple email messages as read in one operation.",
			inputSchema: batchMarkReadSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				"/v1/email/batch/read",
				{
					ids: args.ids,
				},
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"batch_mark_unread",
		{
			title: "Mark Batch Unread",
			description: "Mark multiple email messages as unread in one operation.",
			inputSchema: batchMarkUnreadSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				"/v1/email/batch/unread",
				{
					ids: args.ids,
				},
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"batch_delete",
		{
			title: "Delete Batch",
			description: "Delete multiple emails at once.",
			inputSchema: batchDeleteSchema.shape,
			outputSchema: deleteOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				"/v1/email/batch/delete",
				{
					ids: args.ids,
				},
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"batch_move",
		{
			title: "Move Batch",
			description: "Move multiple emails to a specified folder.",
			inputSchema: batchMoveSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				"/v1/email/batch/move",
				{
					ids: args.ids,
					folder: args.folder,
				},
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_move",
		{
			title: "Move Email",
			description: "Move a specific email message to a destination folder.",
			inputSchema: emailMoveSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/email/${encodeURIComponent(args.id)}/move`;
			const result = await context.client.post<unknown>(path, {
				id: args.id,
				folder: args.folder,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_delete",
		{
			title: "Delete Email",
			description: "Delete a specific email message by ID.",
			inputSchema: emailDeleteSchema.shape,
			outputSchema: deleteOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/email/${encodeURIComponent(args.id)}`;
			const result = await context.client.delete<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	// manage_folders / manage_contacts / manage_templates / template_send
	// removed — the underlying API routes (/v1/email/folders, /v1/contacts,
	// /v1/templates) don't exist on the Anima API. They were registered
	// against speculative endpoints; calling any of them returned 404 and
	// confused both LLMs and humans about whether the feature exists.
	// Re-add when (if) the corresponding API surface ships.
}
