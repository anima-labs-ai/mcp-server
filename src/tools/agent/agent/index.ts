import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	withErrorHandling,
	toolSuccess,
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
	id: z.string().describe("Agent ID"),
});

const agentListInput = z.object({
	cursor: z.string().optional().describe("Pagination cursor from a previous response"),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Maximum number of agents to return"),
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

const agentRotateKeyInput = z.object({
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
			title: "Get Agent",
			description: "Fetch one agent by ID. Use this to inspect current settings, metadata, and status for a single agent.",
			inputSchema: agentGetInput.shape,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get(`/v1/agents/${args.id}`);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentListTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"agent_list",
		{
			title: "List Agent",
			description: "List agents with optional cursor pagination. Use this to discover agents available in the current account context.",
			inputSchema: agentListInput.shape,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
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

function registerAgentRotateKeyTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"agent_rotate_key",
		{
			title: "Rotate Agent Key",
			description: "Rotate an agent API key and return the new key material. Use this when rotating credentials for security hygiene or after suspected exposure. Invalidates the previous key.",
			inputSchema: agentRotateKeyInput.shape,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post(`/v1/agents/${args.id}/rotate-key`);
			return toolSuccess(result);
		}, options.context),
	);
}

// ── Per-agent email identity management ───────────────────────────────────
// Wraps the API endpoints added by anima monorepo PR #63. Closes the
// user-reported gap: "I could not, via MCP, attach a custom verified-domain
// identity to my agent." The Layer 1 domain-verified gate (PR #62) is
// enforced server-side, so calling these with an unverified custom domain
// returns DOMAIN_NOT_VERIFIED 409 with a remediation hint.

const agentEmailIdentityAddInput = z.object({
	agentId: z.string().describe("Agent that will own the new identity"),
	email: z
		.string()
		.email()
		.describe(
			"Full email address to attach. The parent domain MUST be verified for the workspace, or be the platform-managed default `agents.useanima.sh`. Otherwise rejected with DOMAIN_NOT_VERIFIED.",
		),
	setAsPrimary: z
		.boolean()
		.optional()
		.describe(
			"If true, this identity becomes the agent's primary on attach (the existing primary is demoted). Default false: attached as a secondary identity.",
		),
});

const agentEmailIdentityListInput = z.object({
	agentId: z.string().describe("Agent whose identities to list"),
});

const agentEmailIdentityActionInput = z.object({
	agentId: z.string().describe("Owning agent ID"),
	identityId: z.string().describe("Email identity ID being acted on"),
});

function registerAgentEmailIdentityAddTool(options: ToolRegistrationOptions): void {
	const { server } = options;
	server.registerTool(
		"agent_email_identity_add",
		{
			title: "Add Agent Email Identity",
			description:
				"Attach a new email identity to an existing agent. The parent domain MUST be verified for the workspace (or be the platform-managed default `agents.useanima.sh`) — custom unverified domains are rejected with DOMAIN_NOT_VERIFIED so you don't end up with an agent that can't deliver mail. Use this to give an agent a workspace-domain identity (e.g. attach hello@brawz.ai to a digest agent that was auto-created on @agents.useanima.sh).",
			inputSchema: agentEmailIdentityAddInput.shape,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const { agentId, ...body } = args;
			const result = await context.client.post(
				`/v1/agents/${encodeURIComponent(agentId)}/email-identities`,
				body,
			);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentEmailIdentityListTool(options: ToolRegistrationOptions): void {
	const { server } = options;
	server.registerTool(
		"agent_email_identity_list",
		{
			title: "List Agent Email Identity",
			description:
				"List all email identities attached to an agent (primary first, then by creation order). Use this to discover what addresses the agent can send from before choosing one for fromIdentityId on email_send.",
			inputSchema: agentEmailIdentityListInput.shape,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get(
				`/v1/agents/${encodeURIComponent(args.agentId)}/email-identities`,
			);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentEmailIdentitySetPrimaryTool(options: ToolRegistrationOptions): void {
	const { server } = options;
	server.registerTool(
		"agent_email_identity_set_primary",
		{
			title: "Set Agent Email Identity Primary",
			description:
				"Promote an email identity to be the agent's primary. Atomically demotes the existing primary in the same transaction so there is never a moment with two primaries. Use this after attaching a verified-domain identity to switch the agent's default sending address.",
			inputSchema: agentEmailIdentityActionInput.shape,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post(
				`/v1/agents/${encodeURIComponent(args.agentId)}/email-identities/${encodeURIComponent(args.identityId)}/set-primary`,
				{},
			);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentEmailIdentityVerifyTool(options: ToolRegistrationOptions): void {
	const { server } = options;
	server.registerTool(
		"agent_email_identity_verify",
		{
			title: "Verify Agent Email Identity",
			description:
				"Surface the current verification state for an email identity. The platform's background SES verification worker flips identity.verified=true when SES confirms; this tool is your poll point for that transition. Use it after attaching a new identity (or when an existing one's verification went stale) to see if it's ready for outbound sending yet.",
			inputSchema: agentEmailIdentityActionInput.shape,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post(
				`/v1/agents/${encodeURIComponent(args.agentId)}/email-identities/${encodeURIComponent(args.identityId)}/verify`,
				{},
			);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentEmailIdentityDeleteTool(options: ToolRegistrationOptions): void {
	const { server } = options;
	server.registerTool(
		"agent_email_identity_delete",
		{
			title: "Delete Agent Email Identity",
			description:
				"Remove an email identity from an agent. Refuses on the agent's only remaining identity (would leave the agent unable to send or receive) or on a primary without an explicit successor (call agent_email_identity_set_primary on another identity first to make the choice deliberate).",
			inputSchema: agentEmailIdentityActionInput.shape,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.delete(
				`/v1/agents/${encodeURIComponent(args.agentId)}/email-identities/${encodeURIComponent(args.identityId)}`,
			);
			return toolSuccess(result);
		}, options.context),
	);
}

export function registerAgentTools(options: ToolRegistrationOptions): void {
	registerAgentCreateTool(options);
	registerAgentGetTool(options);
	registerAgentListTool(options);
	registerAgentUpdateTool(options);
	registerAgentDeleteTool(options);
	registerAgentRotateKeyTool(options);
	// Per-agent email identity management (anima monorepo PR #63).
	registerAgentEmailIdentityAddTool(options);
	registerAgentEmailIdentityListTool(options);
	registerAgentEmailIdentitySetPrimaryTool(options);
	registerAgentEmailIdentityVerifyTool(options);
	registerAgentEmailIdentityDeleteTool(options);
}
