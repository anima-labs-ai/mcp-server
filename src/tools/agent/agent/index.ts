import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	deleteOutput,
	objectOutput,
	toolSuccess,
	withErrorHandling,
} from "../../../shared/index.js";

const addressTypeEnum = z.enum(["BILLING", "SHIPPING", "MAILING", "REGISTERED"]);

const addressInputSchema = z.object({
	type: addressTypeEnum.describe("Address type: BILLING, SHIPPING, MAILING, or REGISTERED."),
	label: z.string().optional().describe("Optional human-readable label."),
	street1: z.string().describe("Primary street address line."),
	street2: z.string().optional().describe("Secondary street address line (apt, suite, etc.)."),
	city: z.string().describe("City name."),
	state: z.string().describe("State or province code."),
	postalCode: z.string().describe("Postal or ZIP code."),
	country: z.string().describe("ISO country code (e.g. US, GB)."),
});

const addressUpdateInputSchema = z.object({
	addressId: z.string().describe("ID of the address to update."),
	type: addressTypeEnum.optional().describe("Updated address type."),
	label: z.string().optional().describe("Updated label."),
	street1: z.string().optional().describe("Updated primary street address."),
	street2: z.string().optional().describe("Updated secondary street address."),
	city: z.string().optional().describe("Updated city."),
	state: z.string().optional().describe("Updated state or province."),
	postalCode: z.string().optional().describe("Updated postal code."),
	country: z.string().optional().describe("Updated country code."),
});

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
	address: addressInputSchema
		.optional()
		.describe(
			"Optional initial postal address to attach to the agent on creation. To add more addresses later, use agent_update.",
		),
	idempotencyKey: z
		.string()
		.min(1)
		.max(255)
		.regex(/^[\x20-\x7E]+$/)
		.optional()
		.describe(
			"Optional Idempotency-Key. Send the SAME key on retries of the SAME create payload to guarantee exactly-once provisioning even if the network drops mid-flight. Reuse with a different body returns IDEMPOTENCY_BODY_MISMATCH 409. Keys are scoped per-credential, ASCII-printable 1-255 chars (Stripe convention). Server caches the response for 24h. Note: the idempotency guarantee covers the agent record only — if a subsequent address attachment fails, the agent will still exist.",
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
			"Agent ID. If provided, returns that one agent including its addresses[]. If omitted, returns a paginated list of agents (addresses not included to avoid N+1 round-trips).",
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
	addAddress: addressInputSchema
		.optional()
		.describe("Attach a new postal address to this agent."),
	updateAddress: addressUpdateInputSchema
		.optional()
		.describe("Update fields on an existing address. Pass addressId + the fields to change."),
	deleteAddressId: z
		.string()
		.optional()
		.describe("ID of an address to remove from this agent."),
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
				"Create a new agent with optional metadata, and optionally attach an initial address. Use this when provisioning a new sending identity or automation actor. To add more addresses later, use agent_update. Pass idempotencyKey to make retries safe — same key + same body returns the original response, same key + different body returns IDEMPOTENCY_BODY_MISMATCH 409.",
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
			// Strip idempotencyKey + address from the body — they're handled
			// separately. idempotencyKey travels as an HTTP header; address is
			// a follow-up POST after the agent is created.
			const { idempotencyKey, address, ...rest } = args;
			const payload = {
				...rest,
				slug: rest.slug ?? slugifyName(rest.name),
			};
			const agent = (await context.client.post("/v1/agents", payload, {
				headers: idempotencyKey ? { "Idempotency-Key": idempotencyKey } : undefined,
			})) as { id: string };

			if (!address) {
				return toolSuccess(agent);
			}

			const createdAddress = await context.client.post("/v1/addresses", {
				agentId: agent.id,
				...address,
			});
			return toolSuccess({ ...agent, addresses: [createdAddress] });
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
				"Fetch one agent by ID (including its addresses), or list all agents. Pass `id` to inspect a single agent — the response includes its postal addresses alongside emailIdentities and phoneIdentities. Omit `id` to list agents in the current account context — `cursor` and `limit` apply only when listing; addresses are not included in list mode.",
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
				const [agent, addressResp] = await Promise.all([
					context.client.get(`/v1/agents/${args.id}`),
					context.client.get(
						`/v1/addresses?agentId=${encodeURIComponent(args.id)}`,
					),
				]);
				const addresses = (addressResp as { items?: unknown[] })?.items ?? addressResp;
				return toolSuccess({ ...(agent as object), addresses });
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
			description:
				"Update an agent's name or metadata, and/or add/update/delete an address. Use addAddress to attach a new address, updateAddress to change fields on an existing one (by addressId), deleteAddressId to remove one. Multiple field-level changes can be combined in a single call.",
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
			const { id, name, metadata, addAddress, updateAddress, deleteAddressId } = args;
			const result: Record<string, unknown> = {};

			if (name !== undefined || metadata !== undefined) {
				result.agent = await context.client.patch(`/v1/agents/${id}`, { name, metadata });
			}

			if (addAddress) {
				result.addedAddress = await context.client.post("/v1/addresses", {
					agentId: id,
					...addAddress,
				});
			}

			if (updateAddress) {
				const { addressId, ...fields } = updateAddress;
				result.updatedAddress = await context.client.put(
					`/v1/addresses/${encodeURIComponent(addressId)}`,
					fields,
				);
			}

			if (deleteAddressId) {
				await context.client.delete(
					`/v1/addresses/${encodeURIComponent(deleteAddressId)}`,
				);
				result.deletedAddressId = deleteAddressId;
			}

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
			description: "Delete an agent by ID. Use this to remove deprecated or compromised agents that should no longer send messages. Cascades to attached addresses, email identities, and phone identities.",
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
