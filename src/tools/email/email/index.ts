import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
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
	inReplyTo: z
		.string()
		.optional()
		.describe("Optional message ID to set the In-Reply-To header for threading."),
	references: z
		.array(z.string())
		.optional()
		.describe("Optional list of message IDs to include in the References header."),
});

const emailGetSchema = z.object({
	id: z
		.string()
		.optional()
		.describe(
			"Email ID. If provided, returns that one email with full metadata + body. If omitted, returns a paginated list of emails (use `folder`, `limit`, `offset`).",
		),
	folder: z
		.string()
		.optional()
		.describe("Folder filter (e.g. inbox, sent). Applies only when listing. Ignored when `id` is provided."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Max emails when listing. Ignored when `id` is provided."),
	offset: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Pagination offset when listing. Ignored when `id` is provided."),
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
});

const emailForwardSchema = z.object({
	agentId: z.string().describe("Agent ID forwarding the email."),
	originalId: z.string().describe("Original email ID being forwarded."),
	to: z.string().describe("Recipient email address for the forwarded message."),
	text: z
		.string()
		.optional()
		.describe("Optional introductory text to prepend before forwarded content."),
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
			if (args.inReplyTo) body.inReplyTo = args.inReplyTo;
			if (args.references) body.references = args.references;
			const result = await context.client.post<unknown>("/v1/email/send", body);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"email_get",
		{
			title: "Get or List Emails",
			description:
				"Fetch one email by ID, or list emails. Pass `id` to inspect a single email (full metadata + body). Omit `id` to list emails in a folder — `folder`, `limit`, `offset` apply only when listing.",
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
			if (args.id) {
				const path = `/v1/email/${encodeURIComponent(args.id)}`;
				const result = await context.client.get<unknown>(path);
				return toolSuccess(result);
			}
			const params = new URLSearchParams();
			if (args.folder) params.set("folder", args.folder);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			if (args.offset !== undefined) params.set("offset", String(args.offset));
			const path = params.toString() ? `/v1/email?${params}` : "/v1/email";
			const result = await context.client.get<unknown>(path);
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
			requireMasterKeyGuard(context);

			const originalPath = `/v1/email/${encodeURIComponent(args.originalId)}`;
			const originalData = await context.client.get<unknown>(originalPath);
			const original = asRecord(originalData);
			if (!original) {
				throw new Error("Original email payload is missing or invalid.");
			}

			const replyToAddress =
				extractEmailAddress(original.replyTo) ?? extractEmailAddress(original.from);
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

			const from = extractEmailAddress(original.from) ?? "unknown sender";
			const date = stringifyValue(original.date || original.createdAt || "unknown date");
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
}
