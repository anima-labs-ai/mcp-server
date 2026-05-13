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

const registerAgentSchema = z.object({
	did: z
		.string()
		.describe("The DID of the agent to register."),
	name: z
		.string()
		.describe("Display name for the agent in the registry."),
	description: z
		.string()
		.optional()
		.describe("Human-readable description of the agent."),
	category: z
		.string()
		.optional()
		.describe("Category for discovery (e.g. 'assistant', 'tool', 'service')."),
	capabilities: z
		.array(z.string())
		.optional()
		.describe("List of capability identifiers the agent supports."),
	endpoints: z
		.record(z.string())
		.optional()
		.describe("Map of endpoint names to URLs."),
	metadata: z
		.record(z.unknown())
		.optional()
		.describe("Additional metadata for the registry entry."),
});

const searchRegistrySchema = z.object({
	query: z
		.string()
		.describe("Search query to find agents in the registry."),
	category: z
		.string()
		.optional()
		.describe("Optional category filter."),
});

const didSchema = z.object({
	did: z
		.string()
		.describe("The DID of the agent to look up."),
});

const updateRegistrySchema = z.object({
	did: z
		.string()
		.describe("The DID of the agent to update."),
	name: z
		.string()
		.optional()
		.describe("Updated display name."),
	description: z
		.string()
		.optional()
		.describe("Updated description."),
	category: z
		.string()
		.optional()
		.describe("Updated category."),
	capabilities: z
		.array(z.string())
		.optional()
		.describe("Updated capabilities list."),
	endpoints: z
		.record(z.string())
		.optional()
		.describe("Updated endpoints map."),
	metadata: z
		.record(z.unknown())
		.optional()
		.describe("Updated metadata."),
});

export function registerRegistryTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"register_agent",
		{
			title: "Register Agent",
			description: "Register an agent in the public registry for discovery. Use this to make an agent discoverable by other agents.",
			inputSchema: registerAgentSchema.shape,
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
			const result = await context.client.post<unknown>("/v1/registry/agents", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"search_registry",
		{
			title: "Search Registry",
			description: "Search the public Anima agent registry by name, description, or category. Returns ranked matches. Use this to discover third-party agents; for fetching details of a known DID use `lookup_agent` instead.",
			inputSchema: searchRegistrySchema.shape,
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
			params.set("q", args.query);
			if (args.category) params.set("category", args.category);
			const result = await context.client.get<unknown>(`/v1/registry/agents/search?${params}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"lookup_agent",
		{
			title: "Lookup Agent",
			description: "Look up a specific registry-listed agent by DID. Use this when you already know the agent's DID; for free-text discovery use `search_registry` and for A2A protocol agent-card discovery use `discover_agent`.",
			inputSchema: didSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/registry/agents/${encodeURIComponent(args.did)}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"update_registry",
		{
			title: "Update Registry",
			description: "Update an agent's registry entry. Use this to change the public profile of a registered agent.",
			inputSchema: updateRegistrySchema.shape,
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
			const { did, ...body } = args;
			const result = await context.client.put<unknown>(`/v1/registry/agents/${encodeURIComponent(did)}`, body);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"unlist_agent",
		{
			title: "Unlist Agent",
			description: "Remove an agent from the public registry. Use this to make an agent no longer discoverable.",
			inputSchema: didSchema.shape,
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
			const result = await context.client.delete<unknown>(`/v1/registry/agents/${encodeURIComponent(args.did)}`);
			return toolSuccess(result);
		}, options.context),
	);
}
