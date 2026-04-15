import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	withErrorHandling,
	toolSuccess,
	requireMasterKeyGuard,
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
	agentId: z
		.string()
		.describe("Agent ID sending the email."),
	to: z
		.array(z.string())
		.describe("List of recipient email addresses."),
	subject: z
		.string()
		.describe("Subject line for the outgoing email."),
	body: z
		.string()
		.describe("Plain-text body content for the email."),
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
		.describe("Optional message ID to set the In-Reply-To header for threading."),
	references: z
		.array(z.string())
		.optional()
		.describe("Optional list of message IDs to include in the References header."),
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
	agentId: z
		.string()
		.describe("Agent ID sending the reply."),
	originalId: z
		.string()
		.describe("Original email ID being replied to."),
	text: z
		.string()
		.describe("Plain-text content for your reply message."),
	html: z
		.string()
		.optional()
		.describe("Optional HTML content for the reply body."),
	replyAll: z
		.boolean()
		.optional()
		.describe("When true, include additional participants from the original email."),
});

const emailForwardSchema = z.object({
	agentId: z
		.string()
		.describe("Agent ID forwarding the email."),
	originalId: z
		.string()
		.describe("Original email ID being forwarded."),
	to: z
		.string()
		.describe("Recipient email address for the forwarded message."),
	text: z
		.string()
		.optional()
		.describe("Optional introductory text to prepend before forwarded content."),
});

const emailSearchSchema = z.object({
	query: z
		.string()
		.optional()
		.describe("Free-text search query applied across email content."),
	from: z
		.string()
		.optional()
		.describe("Optional sender email filter."),
	to: z
		.string()
		.optional()
		.describe("Optional recipient email filter."),
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
		.describe("Optional maximum number of recent emails to include in the digest."),
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

const manageFoldersSchema = z.object({
	action: z
		.enum(["list", "create"])
		.describe("Action to perform for email folders."),
	name: z
		.string()
		.optional()
		.describe("Folder name used when creating a folder."),
});

const manageContactsSchema = z.object({
	action: z
		.enum(["list", "create", "delete"])
		.describe("Action to perform for contacts."),
	email: z
		.string()
		.optional()
		.describe("Contact email used when creating a contact."),
	name: z
		.string()
		.optional()
		.describe("Contact display name used when creating a contact."),
	contactId: z
		.string()
		.optional()
		.describe("Contact ID used when deleting a contact."),
});

const manageTemplatesSchema = z.object({
	action: z
		.enum(["list", "create", "delete"])
		.describe("Action to perform for templates."),
	templateId: z
		.string()
		.optional()
		.describe("Template ID used when deleting a template."),
	name: z
		.string()
		.optional()
		.describe("Template name used when creating a template."),
	subject: z
		.string()
		.optional()
		.describe("Template subject used when creating a template."),
	body: z
		.string()
		.optional()
		.describe("Template body used when creating a template."),
});

const templateSendSchema = z.object({
	templateId: z
		.string()
		.describe("Template ID to send from."),
	to: z
		.string()
		.describe("Recipient email address for the template message."),
	variables: z
		.record(z.string())
		.optional()
		.describe("Optional template variables keyed by placeholder name."),
});

export function registerEmailTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"email_send",
		"Send a new outbound email from the agent mailbox. Use this when you need to compose and deliver a message with optional CC, threading headers.",
		emailSendSchema.shape,
		withErrorHandling(async (args, context) => {
			const body: Record<string, unknown> = {
				agentId: args.agentId,
				to: args.to,
				subject: args.subject,
				body: args.body,
			};
			if (args.bodyHtml) body.bodyHtml = args.bodyHtml;
			if (args.cc) body.cc = args.cc;
			if (args.bcc) body.bcc = args.bcc;
			if (args.inReplyTo) body.inReplyTo = args.inReplyTo;
			if (args.references) body.references = args.references;
			const result = await context.client.post<unknown>("/email/send", body);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"email_get",
		"Retrieve one specific email by ID, including metadata and body fields. Use this before replying, forwarding, or inspecting message details.",
		emailGetSchema.shape,
		withErrorHandling(async (args, context) => {
			const path = `/email/${encodeURIComponent(args.id)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"email_list",
		"List emails in inbox or another folder with pagination controls. Use this to browse recent messages and mailbox contents.",
		emailListSchema.shape,
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.folder) params.set("folder", args.folder);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			if (args.offset !== undefined) params.set("offset", String(args.offset));

			const path = params.toString() ? `/email?${params}` : "/email";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"email_reply",
		"Reply to an existing email thread by first loading the original message and setting threading headers. Use this when you need a proper in-thread response.",
		emailReplySchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);

			const originalPath = `/email/${encodeURIComponent(args.originalId)}`;
			const originalData = await context.client.get<unknown>(originalPath);
			const original = asRecord(originalData);
			if (!original) {
				throw new Error("Original email payload is missing or invalid.");
			}

			const replyToAddress =
				extractEmailAddress(original.replyTo) ??
				extractEmailAddress(original.from);
			if (!replyToAddress) {
				throw new Error("Unable to determine reply recipient from original email.");
			}

			const subjectRaw =
				typeof original.subject === "string"
					? original.subject
					: "No subject";
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
				const ccList = dedupeStrings([
					...extractStringArray(original.cc),
					...extractStringArray(original.to),
				].filter((address) => address !== replyToAddress));

				if (ccList.length > 0) {
					payload.cc = ccList;
				}
			}

			const result = await context.client.post<unknown>("/email/send", payload);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"email_forward",
		"Forward an existing email to another recipient by loading the original content first. Use this to share a prior message while preserving context.",
		emailForwardSchema.shape,
		withErrorHandling(async (args, context) => {
			const originalPath = `/email/${encodeURIComponent(args.originalId)}`;
			const originalData = await context.client.get<unknown>(originalPath);
			const original = asRecord(originalData);
			if (!original) {
				throw new Error("Original email payload is missing or invalid.");
			}

			const subjectRaw =
				typeof original.subject === "string"
					? original.subject
					: "No subject";
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

			const result = await context.client.post<unknown>("/email/send", payload);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"email_search",
		"Search mailbox messages by query text and structured filters like sender, recipient, subject, and date bounds. Use this to locate specific conversations quickly.",
		emailSearchSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/messages/search", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"inbox_digest",
		"Generate a compact digest of recent inbox messages with sender, subject, date, and snippet. Use this for quick triage without opening each email.",
		inboxDigestSchema.shape,
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.limit !== undefined) params.set("limit", String(args.limit));

			const path = params.toString() ? `/email?${params}` : "/email";
			const result = await context.client.get<unknown>(path);
			const items = extractEmailItems(result);

			const digestItems = items.map((item, index) => {
				const from = extractEmailAddress(item.from) ?? "unknown sender";
				const subject =
					typeof item.subject === "string" ? item.subject : "(no subject)";
				const date =
					typeof item.date === "string"
						? item.date
						: typeof item.createdAt === "string"
							? item.createdAt
							: "unknown date";
				const snippet =
					typeof item.snippet === "string"
						? item.snippet
						: typeof item.text === "string"
							? item.text.slice(0, 140)
							: "";

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

	server.tool(
		"email_mark_read",
		"Mark a specific email message as read by ID.",
		emailMarkReadSchema.shape,
		withErrorHandling(async (args, context) => {
			const path = `/email/${encodeURIComponent(args.id)}/read`;
			const result = await context.client.post<unknown>(path, { id: args.id });
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"email_mark_unread",
		"Mark a specific email message as unread by ID.",
		emailMarkUnreadSchema.shape,
		withErrorHandling(async (args, context) => {
			const path = `/email/${encodeURIComponent(args.id)}/unread`;
			const result = await context.client.post<unknown>(path, { id: args.id });
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"batch_mark_read",
		"Mark multiple email messages as read in one operation.",
		batchMarkReadSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/email/batch/read", {
				ids: args.ids,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"batch_mark_unread",
		"Mark multiple email messages as unread in one operation.",
		batchMarkUnreadSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/email/batch/unread", {
				ids: args.ids,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"batch_delete",
		"Delete multiple emails at once.",
		batchDeleteSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/email/batch/delete", {
				ids: args.ids,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"batch_move",
		"Move multiple emails to a specified folder.",
		batchMoveSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/email/batch/move", {
				ids: args.ids,
				folder: args.folder,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"email_move",
		"Move a specific email message to a destination folder.",
		emailMoveSchema.shape,
		withErrorHandling(async (args, context) => {
			const path = `/email/${encodeURIComponent(args.id)}/move`;
			const result = await context.client.post<unknown>(path, {
				id: args.id,
				folder: args.folder,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"email_delete",
		"Delete a specific email message by ID.",
		emailDeleteSchema.shape,
		withErrorHandling(async (args, context) => {
			const path = `/email/${encodeURIComponent(args.id)}`;
			const result = await context.client.delete<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"manage_folders",
		"List existing folders or create a new email folder.",
		manageFoldersSchema.shape,
		withErrorHandling(async (args, context) => {
			switch (args.action) {
				case "list": {
					const result = await context.client.get<unknown>("/email/folders");
					return toolSuccess(result);
				}
				case "create": {
					if (!args.name) {
						throw new Error("Folder name is required when action is 'create'.");
					}
					const result = await context.client.post<unknown>("/email/folders", {
						name: args.name,
					});
					return toolSuccess(result);
				}
			}
		}, options.context),
	);

	server.tool(
		"manage_contacts",
		"List, create, or delete contacts used for email workflows.",
		manageContactsSchema.shape,
		withErrorHandling(async (args, context) => {
			switch (args.action) {
				case "list": {
					const result = await context.client.get<unknown>("/contacts");
					return toolSuccess(result);
				}
				case "create": {
					if (!args.email) {
						throw new Error("Contact email is required when action is 'create'.");
					}
					const result = await context.client.post<unknown>("/contacts", {
						email: args.email,
						name: args.name,
					});
					return toolSuccess(result);
				}
				case "delete": {
					if (!args.contactId) {
						throw new Error("Contact ID is required when action is 'delete'.");
					}
					const path = `/contacts/${encodeURIComponent(args.contactId)}`;
					const result = await context.client.delete<unknown>(path);
					return toolSuccess(result);
				}
			}
		}, options.context),
	);

	server.tool(
		"manage_templates",
		"List, create, or delete email templates.",
		manageTemplatesSchema.shape,
		withErrorHandling(async (args, context) => {
			switch (args.action) {
				case "list": {
					const result = await context.client.get<unknown>("/templates");
					return toolSuccess(result);
				}
				case "create": {
					if (!args.name || !args.subject || !args.body) {
						throw new Error(
							"Template name, subject, and body are required when action is 'create'.",
						);
					}
					const result = await context.client.post<unknown>("/templates", {
						name: args.name,
						subject: args.subject,
						body: args.body,
					});
					return toolSuccess(result);
				}
				case "delete": {
					if (!args.templateId) {
						throw new Error("Template ID is required when action is 'delete'.");
					}
					const path = `/templates/${encodeURIComponent(args.templateId)}`;
					const result = await context.client.delete<unknown>(path);
					return toolSuccess(result);
				}
			}
		}, options.context),
	);

	server.tool(
		"template_send",
		"Send an email by rendering and dispatching a stored template.",
		templateSendSchema.shape,
		withErrorHandling(async (args, context) => {
			const path = `/templates/${encodeURIComponent(args.templateId)}/send`;
			const result = await context.client.post<unknown>(path, {
				to: args.to,
				variables: args.variables,
			});
			return toolSuccess(result);
		}, options.context),
	);
}
