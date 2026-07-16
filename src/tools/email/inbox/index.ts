import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	deleteOutput,
	listOutput,
	objectOutput,
	requireMasterKeyGuard,
	toolSuccess,
	withErrorHandling,
} from "../../../shared/index.js";

// Schemas mirror the API contract (packages/contracts/src/schemas/inbox.ts).
// Bounds are replicated for LLM self-correction; the API remains the
// authoritative validator (regex/normalization rules live server-side and
// are described in the field text instead of duplicated here).

const inboxCreateSchema = z.object({
	username: z
		.string()
		.min(1)
		.max(64)
		.optional()
		.describe(
			"Local part of the inbox email address (letters, numbers, dots, hyphens, underscores; normalized to lowercase; must not start/end with a dot or hyphen). A random local part is generated when omitted.",
		),
	domain: z
		.string()
		.optional()
		.describe(
			"Domain for the inbox address. Uses the platform default (agents.useanima.sh) when omitted. Custom domains must already be registered and verified — see domain_list.",
		),
	displayName: z
		.string()
		.max(128)
		.optional()
		.describe("Human-readable display name for the inbox (max 128 characters)."),
	agentId: z
		.string()
		.optional()
		.describe(
			"Agent ID to associate with this inbox. Inbound mail to the inbox is attributed to this agent.",
		),
});

const inboxIdSchema = z.object({
	id: z.string().describe("Unique inbox ID."),
});

const inboxListSchema = z.object({
	query: z
		.string()
		.optional()
		.describe("Free-text search filter matched against inbox email addresses and display names."),
	cursor: z
		.string()
		.optional()
		.describe("Pagination cursor from a previous list response (pagination.nextCursor)."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Max inboxes to return per page (1-100, default 20)."),
});

const inboxUpdateSchema = z.object({
	id: z.string().describe("Unique inbox ID."),
	displayName: z
		.string()
		.max(128)
		.nullable()
		.optional()
		.describe(
			"New human-readable display name (max 128 characters). Pass null to clear it. Omit to leave unchanged.",
		),
	agentId: z
		.string()
		.nullable()
		.optional()
		.describe(
			"Agent ID to associate with the inbox. Pass null to unlink the current agent. Omit to leave unchanged.",
		),
});

export function registerInboxTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"inbox_create",
		{
			title: "Create Inbox",
			description:
				"Create a new email inbox (mailbox) that can receive mail immediately at its address. Choose a username and domain or let the platform generate them. Requires master key access.",
			inputSchema: inboxCreateSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const body: Record<string, unknown> = {};
			if (args.username) body.username = args.username;
			if (args.domain) body.domain = args.domain;
			if (args.displayName !== undefined) body.displayName = args.displayName;
			if (args.agentId) body.agentId = args.agentId;
			const result = await context.client.post<unknown>("/v1/inboxes", body);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"inbox_get",
		{
			title: "Get Inbox",
			description:
				"Fetch full detail for a single inbox by ID, including its email address, display name, and associated agent. Use inbox_list to browse all inboxes.",
			inputSchema: inboxIdSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/inboxes/${encodeURIComponent(args.id)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"inbox_list",
		{
			title: "List Inboxes",
			description:
				"List inboxes in the workspace with cursor pagination and optional free-text search. Returns the address, display name, and agent association for each inbox.",
			inputSchema: inboxListSchema.shape,
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
			if (args.query) params.set("query", args.query);
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			const path = params.toString() ? `/v1/inboxes?${params}` : "/v1/inboxes";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"inbox_update",
		{
			title: "Update Inbox",
			description:
				"Update the display name or agent association of an inbox. Pass null for a field to clear it (unlink the agent / remove the display name); omitted fields are left unchanged. The email address itself cannot be changed. Requires master key access.",
			inputSchema: inboxUpdateSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const body: Record<string, unknown> = {};
			// `!== undefined` (not truthiness) — explicit null is meaningful:
			// it clears the display name / unlinks the agent on the API side.
			if (args.displayName !== undefined) body.displayName = args.displayName;
			if (args.agentId !== undefined) body.agentId = args.agentId;
			const path = `/v1/inboxes/${encodeURIComponent(args.id)}`;
			const result = await context.client.patch<unknown>(path, body);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"inbox_delete",
		{
			title: "Delete Inbox",
			description:
				"Permanently delete an inbox and its mailbox. Mail sent to the address after deletion bounces. This cannot be undone. Requires master key access.",
			inputSchema: inboxIdSchema.shape,
			outputSchema: deleteOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			// API returns { success: true }; normalize destructive ops to the
			// same shape regardless of body (matches email_draft_delete,
			// webhook_delete) so a 204-no-body response can't break the
			// declared outputSchema.
			await context.client.delete<unknown>(`/v1/inboxes/${encodeURIComponent(args.id)}`);
			return toolSuccess({ success: true });
		}, options.context),
	);
}
