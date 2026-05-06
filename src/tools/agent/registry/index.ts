import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	withErrorHandling,
	toolSuccess,
	requireMasterKeyGuard,
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
			description: "Register an agent in the public registry for discovery. Use this to make an agent discoverable by other agents.",
			inputSchema: registerAgentSchema.shape,
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
			description: "Search the agent registry to discover agents. Use this to find agents by name, description, or category.",
			inputSchema: searchRegistrySchema.shape,
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
			description: "Look up a specific agent in the registry by DID. Use this to get full details about a registered agent.",
			inputSchema: didSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/registry/agents/${encodeURIComponent(args.did)}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"update_registry",
		{
			description: "Update an agent's registry entry. Use this to change the public profile of a registered agent.",
			inputSchema: updateRegistrySchema.shape,
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
			description: "Remove an agent from the public registry. Use this to make an agent no longer discoverable.",
			inputSchema: didSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.delete<unknown>(`/v1/registry/agents/${encodeURIComponent(args.did)}`);
			return toolSuccess(result);
		}, options.context),
	);
}
