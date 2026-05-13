import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	deleteOutput,
	objectOutput,
	toolSuccess,
	withErrorHandling,
} from "../../../shared/index.js";

const agentCreateInput = z.object({
	name: z.string().describe("Agent display name"),
	slug: z
		.string()
		.regex(/^[a-z0-9-]+$/)
		.min(2)
		.max(64)
		.optional()
		.describe(
			"URL-friendly unique identifier (lowercase alphanumeric + hyphens, 2-64 chars). Auto-derived from name if omitted.",
		),
	email: z
		.string()
		.email()
		.optional()
		.describe("Optional email address to provision for this agent"),
	provisionPhone: z
		.boolean()
		.optional()
		.describe("Whether to auto-provision a phone number for this agent"),
	metadata: z
		.record(z.string())
		.optional()
		.describe("Optional agent metadata as key-value string pairs"),
	idempotencyKey: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[\x20-\x7E]+$/)
		.optional()
		.describe(
			"Optional Idempotency-Key. Send the SAME key on retries of the SAME create payload to guarantee exactly-once provisioning even if the network drops mid-flight. Reuse with a different body returns IDEMPOTENCY_BODY_MISMATCH 409. Keys are scoped per-credential, ASCII-printable 1-255 chars (Stripe convention). Server caches the response for 24h.",
		),
});

/**
 * Derive an API-acceptable slug from a display name. The API requires
 * `^[a-z0-9-]+$`, so lowercase, replace runs of non-alphanumerics with
 * hyphens, trim. The 6-char random suffix avoids unique-constraint
 * collisions across "Test Agent" → "test-agent" being created twice.
 */
function slugifyName(name: string): string {
	const base = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 56);
	const safe = base.length >= 2 ? base : "agent";
	const suffix = Math.random().toString(36).slice(2, 8);
	return `${safe}-${suffix}`;
}

const agentGetInput = z.object({
	id: z
		.string()
		.optional()
		.describe(
			"Agent ID. If provided, returns that one agent. If omitted, returns a paginated list of all agents in the org.",
		),
	cursor: z
		.string()
		.optional()
		.describe("Pagination cursor from a previous list response. Ignored when `id` is provided."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Maximum number of agents to return when listing. Ignored when `id` is provided."),
});

const agentUpdateInput = z.object({
	id: z.string().describe("Agent ID"),
	name: z.string().optional().describe("Updated agent display name"),
	metadata: z
		.record(z.string())
		.optional()
		.describe("Updated metadata as key-value string pairs"),
});

const agentDeleteInput = z.object({
	id: z.string().describe("Agent ID"),
});

function registerAgentCreateTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"agent_create",
		{
			title: "Create Agent",
			description:
				"Create a new agent with optional metadata and return the created record. Use this when provisioning a new sending identity or automation actor. Pass idempotencyKey to make retries safe — same key + same body returns the original response, same key + different body returns IDEMPOTENCY_BODY_MISMATCH 409.",
			inputSchema: agentCreateInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			// Strip idempotencyKey from the body — it travels as an HTTP
			// header, not as a request field. Server-side middleware
			// (apps/api/src/middleware/idempotency.ts) reads it from the
			// Idempotency-Key header and caches the response for 24h scoped
			// per-credential.
			const { idempotencyKey, ...rest } = args;
			const payload = {
				...rest,
				slug: rest.slug ?? slugifyName(rest.name),
			};
			const result = await context.client.post("/v1/agents", payload, {
				headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
			});
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentGetTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"agent_get",
		{
			title: "Get or List Agents",
			description:
				"Fetch one agent by ID, or list all agents. Pass `id` to inspect a single agent (settings, metadata, status). Omit `id` to list all agents in the current account context — `cursor` and `limit` apply only when listing.",
			inputSchema: agentGetInput.shape,
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
				const result = await context.client.get(`/v1/agents/${args.id}`);
				return toolSuccess(result);
			}
			const params = new URLSearchParams();
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit) params.set("limit", String(args.limit));
			const path = params.toString() ? `/v1/agents?${params.toString()}` : "/v1/agents";
			const result = await context.client.get(path);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentUpdateTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"agent_update",
		{
			title: "Update Agent",
			description: "Update an agent's name or metadata by ID. Use this when an agent needs renaming or profile metadata changes.",
			inputSchema: agentUpdateInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const { id, ...body } = args;
			const result = await context.client.patch(`/v1/agents/${id}`, body);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentDeleteTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"agent_delete",
		{
			title: "Delete Agent",
			description: "Delete an agent by ID. Use this to remove deprecated or compromised agents that should no longer send messages.",
			inputSchema: agentDeleteInput.shape,
			outputSchema: deleteOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.delete(`/v1/agents/${args.id}`);
			return toolSuccess(result);
		}, options.context),
	);
}

export function registerAgentTools(options: ToolRegistrationOptions): void {
	registerAgentCreateTool(options);
	registerAgentGetTool(options);
	registerAgentUpdateTool(options);
	registerAgentDeleteTool(options);
}
