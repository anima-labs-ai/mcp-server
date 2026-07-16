import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	deleteOutput,
	listOutput,
	objectOutput,
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

// Attachment shape mirrors the API's EmailAttachmentInput contract.
// Inspired by AgentMail.to's attachment surface so agents already
// familiar with that pattern have minimal switching cost.
const emailAttachmentSchema = z
	.object({
		filename: z
			.string()
			.optional()
			.describe(
				"Filename presented to the recipient. Inferred from URL path when `url` is used and this is omitted; falls back to 'attachment'.",
			),
		contentId: z
			.string()
			.optional()
			.describe(
				"Content-ID for inline attachments referenced in the HTML body via `cid:<id>` (e.g. set to 'logo' for `<img src=\"cid:logo\">`). Present → `Content-Disposition: inline`; absent → `attachment`.",
			),
		contentType: z
			.string()
			.optional()
			.describe(
				"MIME type. Auto-detected from `filename` extension if omitted (e.g. 'application/pdf' for .pdf). Falls back to 'application/octet-stream'.",
			),
		content: z
			.string()
			.optional()
			.describe(
				"Base64-encoded attachment bytes. Provide either `content` or `url`. Max ~33MB on the wire (decodes to ~25MB binary).",
			),
		url: z
			.string()
			.optional()
			.describe(
				"Public URL the server fetches and attaches. Provide either `content` or `url`. Private/loopback/link-local IPs are rejected (SSRF guard). Max 25MB after download.",
			),
	})
	.describe(
		"File attachment for outbound email. Provide exactly one of `content` (base64-inline) or `url` (server-fetch).",
	);

const emailSendSchema = z.object({
	agentId: z.string().describe("Agent ID sending the email."),
	fromIdentityId: z
		.string()
		.optional()
		.describe(
			"Optional EmailIdentity ID to send from. Must belong to this agent and be verified. If omitted, the agent's primary identity is used. Use this to route different message types through different identities (e.g. transactional from @brawz.ai, support from @support.brawz.ai). Discover available IDs from the `emailIdentities` array returned by agent_get.",
		),
	to: z.array(z.string()).describe("List of recipient email addresses."),
	subject: z.string().describe("Subject line for the outgoing email."),
	body: z.string().describe("Plain-text body content for the email."),
	bodyHtml: z
		.string()
		.optional()
		.describe("Optional HTML body content for rich email formatting."),
	cc: z.array(z.string()).optional().describe("Optional CC recipient email addresses."),
	bcc: z.array(z.string()).optional().describe("Optional BCC recipient email addresses."),
	attachments: z
		.array(emailAttachmentSchema)
		.max(20)
		.optional()
		.describe(
			"Optional file attachments (max 20 entries, 25MB total). Each entry must provide either `content` (base64-inline) or `url` (public URL for server-fetch). Use `contentId` for inline images referenced in HTML via `cid:` URIs.",
		),
	inReplyTo: z
		.string()
		.optional()
		.describe("Optional message ID to set the In-Reply-To header for threading."),
	references: z
		.array(z.string())
		.optional()
		.describe("Optional list of message IDs to include in the References header."),
	headers: z
		.record(z.string())
		.optional()
		.describe(
			'Optional custom email headers as key-value pairs (e.g. {"X-Campaign": "onboarding"}). Merged with Anima\'s own threading/compliance headers, which win on conflict.',
		),
});

const emailGetSchema = z.object({
	id: z.string().describe("Email ID. Returns full metadata and body."),
});

// Mirrors the contract's EmailListInput (GET /email): cursor pagination +
// agentId filter. The previous `folder`/`offset` params were fictional —
// the API never accepted them, so they silently no-oped (spec item C7).
const emailListSchema = z.object({
	agentId: z
		.string()
		.optional()
		.describe(
			"Filter emails by agent ID. Agent-scoped keys are already limited to their own agent; master keys see the whole workspace unless filtered.",
		),
	cursor: z
		.string()
		.optional()
		.describe(
			"Opaque pagination cursor from a previous response's `pagination.nextCursor`. Omit for the first page.",
		),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Max emails to return per page (1-100, default 20)."),
});

const emailSearchSchema = z.object({
	query: z.string().min(1).describe("Search query text."),
	mode: z
		.enum(["fulltext", "semantic"])
		.optional()
		.describe(
			"Search mode. `fulltext` (default) does substring matching over subject/body/addresses of EMAIL messages and supports cursor pagination. `semantic` ranks by vector-embedding similarity — better for meaning-level questions (\"emails about the contract renewal\") — but searches messages across ALL channels (each result carries a `channel` field) and does not paginate.",
		),
	agentId: z
		.string()
		.optional()
		.describe("Filter results to a specific agent."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Max results (fulltext: 1-100, default 20; semantic: 1-50, default 10)."),
	cursor: z
		.string()
		.optional()
		.describe(
			"Pagination cursor from a previous fulltext response's `pagination.nextCursor`. Fulltext mode only.",
		),
	threshold: z
		.number()
		.min(0)
		.max(1)
		.optional()
		.describe("Minimum similarity score 0-1 (semantic mode only, default 0.7)."),
});

const emailReplySchema = z.object({
	agentId: z.string().describe("Agent ID sending the reply."),
	originalId: z.string().describe("Original email ID being replied to."),
	text: z.string().describe("Plain-text content for your reply message."),
	html: z.string().optional().describe("Optional HTML content for the reply body."),
	replyAll: z
		.boolean()
		.optional()
		.describe("When true, include additional participants from the original email."),
	attachments: z
		.array(emailAttachmentSchema)
		.max(20)
		.optional()
		.describe(
			"Optional file attachments on the reply (max 20 entries, 25MB total).",
		),
});

const emailForwardSchema = z.object({
	agentId: z.string().describe("Agent ID forwarding the email."),
	originalId: z.string().describe("Original email ID being forwarded."),
	to: z
		.array(z.string())
		.min(1)
		.describe("Recipient email address(es) for the forwarded message."),
	text: z
		.string()
		.optional()
		.describe("Optional introductory text to prepend before forwarded content."),
	attachments: z
		.array(emailAttachmentSchema)
		.max(20)
		.optional()
		.describe(
			"Optional additional file attachments on the forward (max 20 entries, 25MB total). Original email's attachments are NOT auto-included — pass them explicitly if you want them forwarded.",
		),
});

const emailThreadGetSchema = z.object({
	id: z
		.string()
		.optional()
		.describe("Single thread ID to fetch. Pass either `id` or `ids`."),
	ids: z
		.array(z.string())
		.optional()
		.describe("Multiple thread IDs to fetch in parallel. Pass either `id` or `ids`."),
	agentId: z
		.string()
		.optional()
		.describe("Optional agent scope filter (only return messages owned by this agent)."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Optional max messages per thread."),
});

const emailAttachmentGetSchema = z.object({
	id: z.string().describe("Attachment ID. Returns a temporary download URL."),
});

const emailDraftCreateSchema = z.object({
	agentId: z.string().describe("Owning agent ID."),
	fromIdentityId: z
		.string()
		.optional()
		.describe(
			"Optional EmailIdentity ID to send from. Must belong to this agent and be verified. If omitted, the agent's primary identity is used at send time. Discover available IDs from the `emailIdentities` array returned by agent_get.",
		),
	to: z.array(z.string()).optional().describe("Recipient email addresses (may be empty for an incomplete draft)."),
	cc: z.array(z.string()).optional().describe("CC recipients."),
	bcc: z.array(z.string()).optional().describe("BCC recipients."),
	subject: z.string().optional().describe("Subject line."),
	body: z.string().optional().describe("Plain-text body."),
	bodyHtml: z.string().optional().describe("HTML body."),
	inReplyTo: z
		.string()
		.optional()
		.describe("Optional In-Reply-To Message-ID for threading on send."),
	references: z.array(z.string()).optional().describe("Optional References chain for threading."),
	metadata: z.record(z.unknown()).optional().describe("Arbitrary metadata."),
});

const emailDraftListSchema = z.object({
	agentId: z.string().optional().describe("Filter drafts by agent ID."),
	cursor: z.string().optional().describe("Pagination cursor from a previous list response."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Max drafts when listing. Ignored when `id` is provided."),
});

const emailDraftIdSchema = z.object({
	id: z.string().describe("Draft ID."),
});

export function registerEmailTools(options: ToolRegistrationOptions): void {
	const { server } = options;

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
		withErrorHandling(async (args, context) => {
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
			if (args.attachments && args.attachments.length > 0) {
				body.attachments = args.attachments;
			}
			if (args.inReplyTo) body.inReplyTo = args.inReplyTo;
			if (args.references) body.references = args.references;
			if (args.headers && Object.keys(args.headers).length > 0) {
				body.headers = args.headers;
			}
			const result = await context.client.post<unknown>("/v1/email/send", body);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_get",
		{
			title: "Get Email",
			description:
				"Fetch full detail for a single email by ID, including metadata and body. Use email_list to browse emails in a folder.",
			inputSchema: emailGetSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/email/${encodeURIComponent(args.id)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_list",
		{
			title: "List Emails",
			description:
				"List emails with cursor pagination. Returns lightweight per-email records plus a `pagination` object — pass `pagination.nextCursor` back as `cursor` for the next page. Use email_get for the full body, email_search to find specific messages.",
			inputSchema: emailListSchema.shape,
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
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			const path = params.toString() ? `/v1/email?${params}` : "/v1/email";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_search",
		{
			title: "Search Emails",
			description:
				"Search messages by content. Fulltext mode (default) substring-matches subject/body/addresses of EMAIL messages and returns `{items, pagination}` with cursor paging. Semantic mode ranks by vector-embedding similarity and returns `{results}` scored 0-1 — each result spans ANY channel (check the `channel` field) and includes the message id for email_get / email_thread_get follow-ups.",
			inputSchema: emailSearchSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			if (args.mode === "semantic") {
				const body: Record<string, unknown> = { query: args.query };
				if (args.agentId) body.agentId = args.agentId;
				if (args.limit !== undefined) body.limit = args.limit;
				if (args.threshold !== undefined) body.threshold = args.threshold;
				const result = await context.client.post<unknown>(
					"/v1/messages/search/semantic",
					body,
				);
				return toolSuccess(result);
			}

			const filters: Record<string, unknown> = { channel: "EMAIL" };
			if (args.agentId) filters.agentId = args.agentId;
			const pagination: Record<string, unknown> = {};
			if (args.cursor) pagination.cursor = args.cursor;
			if (args.limit !== undefined) pagination.limit = args.limit;
			const body: Record<string, unknown> = { query: args.query, filters };
			if (Object.keys(pagination).length > 0) body.pagination = pagination;
			const result = await context.client.post<unknown>("/v1/messages/search", body);
			return toolSuccess(result);
		}, options.context),
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
			// NO master-key guard here: email_reply is not in MASTER_KEY_TOOLS
			// (shared/config.ts) and the backing routes (GET /email/{id} +
			// POST /email/send) are agent-key operations. A hardcoded guard
			// here broke replies for every agent-scoped key — self-hosted and
			// stdio deployments included (spec item C7).
			const originalPath = `/v1/email/${encodeURIComponent(args.originalId)}`;
			const originalData = await context.client.get<unknown>(originalPath);
			const original = asRecord(originalData);
			if (!original) {
				throw new Error("Original email payload is missing or invalid.");
			}

			// 2026-05-20: API returns fromAddress/toAddress (not from/to). For
			// OUTBOUND originals, "reply" should go to the original RECIPIENT
			// (toAddress), not the sender — replying to your own sent message
			// continues the thread with the same correspondent.
			const direction = typeof original.direction === "string"
				? original.direction
				: undefined;
			const isOutbound = direction === "OUTBOUND";
			const replyToAddress =
				extractEmailAddress(original.replyTo) ??
				(isOutbound
					? extractEmailAddress(original.toAddress) ?? extractEmailAddress(original.to)
					: extractEmailAddress(original.fromAddress) ?? extractEmailAddress(original.from));
			if (!replyToAddress) {
				throw new Error("Unable to determine reply recipient from original email.");
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
				attachments?: unknown;
			} = {
				agentId: args.agentId,
				to: [replyToAddress],
				subject,
				body: args.text,
			};

			if (args.html) payload.bodyHtml = args.html;
			if (inReplyTo) payload.inReplyTo = inReplyTo;
			if (references.length > 0) payload.references = references;
			if (args.attachments && args.attachments.length > 0) {
				payload.attachments = args.attachments;
			}

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

			const result = await context.client.post<unknown>("/v1/email/send", payload);
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

			// 2026-05-20: API uses fromAddress + body fields (not from/text/snippet).
			// Old code never matched and the forwarded body always said
			// "Original email body unavailable" / "From: unknown sender".
			const from =
				extractEmailAddress(original.fromAddress) ??
				extractEmailAddress(original.from) ??
				"unknown sender";
			const date = stringifyValue(
				original.sentAt ||
					original.receivedAt ||
					original.date ||
					original.createdAt ||
					"unknown date",
			);
			const originalText =
				typeof original.body === "string"
					? original.body
					: typeof original.text === "string"
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

			const payload: {
				agentId: string;
				to: string[];
				subject: string;
				body: string;
				attachments?: unknown;
			} = {
				agentId: args.agentId,
				to: args.to,
				subject,
				body: forwardedBody,
			};

			if (args.attachments && args.attachments.length > 0) {
				payload.attachments = args.attachments;
			}

			const result = await context.client.post<unknown>("/v1/email/send", payload);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_thread_get",
		{
			title: "Get Email Thread(s)",
			description:
				"Fetch all email messages in one or more threads. Pass `id` for a single thread or `ids` for multiple. Returns messages ordered within each thread. Uses the messages endpoint filtered by threadId + channel=EMAIL under the hood.",
			inputSchema: emailThreadGetSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const threadIds = args.ids ?? (args.id ? [args.id] : []);
			if (threadIds.length === 0) {
				throw new Error("email_thread_get requires either `id` or `ids`.");
			}

			const fetchOne = async (threadId: string): Promise<unknown> => {
				const params = new URLSearchParams();
				params.set("threadId", threadId);
				params.set("channel", "EMAIL");
				if (args.agentId) params.set("agentId", args.agentId);
				if (args.limit !== undefined) params.set("limit", String(args.limit));
				return context.client.get<unknown>(`/v1/messages?${params}`);
			};

			const results = await Promise.all(threadIds.map(fetchOne));

			if (threadIds.length === 1) {
				return toolSuccess(results[0]);
			}

			return toolSuccess({
				threads: threadIds.map((id, i) => ({ id, ...((asRecord(results[i]) ?? {}) as object) })),
			});
		}, options.context),
	);

	server.registerTool(
		"email_attachment_get",
		{
			title: "Get Email Attachment",
			description:
				"Get a temporary download URL for an email attachment. Use this when you need direct file access for preview or download.",
			inputSchema: emailAttachmentGetSchema.shape,
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
				`/v1/attachments/${encodeURIComponent(args.id)}/download`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_draft_create",
		{
			title: "Create Email Draft",
			description:
				"Create a new email draft (composed but not sent). Drafts can be incomplete — missing recipients, subject, or body. Use email_draft_send later to actually deliver, or email_draft_delete to discard.",
			inputSchema: emailDraftCreateSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const body: Record<string, unknown> = { agentId: args.agentId };
			if (args.fromIdentityId) body.fromIdentityId = args.fromIdentityId;
			if (args.to) body.to = args.to;
			if (args.cc) body.cc = args.cc;
			if (args.bcc) body.bcc = args.bcc;
			if (args.subject !== undefined) body.subject = args.subject;
			if (args.body !== undefined) body.body = args.body;
			if (args.bodyHtml !== undefined) body.bodyHtml = args.bodyHtml;
			if (args.inReplyTo !== undefined) body.inReplyTo = args.inReplyTo;
			if (args.references) body.references = args.references;
			if (args.metadata !== undefined) body.metadata = args.metadata;
			const result = await context.client.post<unknown>("/v1/email/drafts", body);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_draft_get",
		{
			title: "Get Email Draft",
			description:
				"Fetch full detail for a single draft by ID. Use email_draft_list to browse drafts.",
			inputSchema: emailDraftIdSchema.shape,
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
				`/v1/email/drafts/${encodeURIComponent(args.id)}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_draft_list",
		{
			title: "List Email Drafts",
			description:
				"List email drafts with optional filters. Returns lightweight draft records — use email_draft_get for full detail.",
			inputSchema: emailDraftListSchema.shape,
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
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			const path = params.toString() ? `/v1/email/drafts?${params}` : "/v1/email/drafts";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_draft_send",
		{
			title: "Send Email Draft",
			description:
				"Send a draft. Atomically converts the draft to a delivered Message + deletes the draft row. The draft must have at least one recipient, a subject, and a body. Returns the newly-created Message.",
			inputSchema: emailDraftIdSchema.shape,
			outputSchema: sendOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				`/v1/email/drafts/${encodeURIComponent(args.id)}/send`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_draft_delete",
		{
			title: "Delete Email Draft",
			description:
				"Discard a draft. Use this to remove drafts that are no longer needed. Use email_draft_send if you want to deliver instead.",
			inputSchema: emailDraftIdSchema.shape,
			outputSchema: deleteOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			// API returns the deleted draft body for forensics. The MCP
			// surface normalizes all destructive ops to `{success: true}` —
			// matches webhook_delete, vault_credential_delete, etc.
			await context.client.delete<unknown>(
				`/v1/email/drafts/${encodeURIComponent(args.id)}`,
			);
			return toolSuccess({ success: true });
		}, options.context),
	);
}
