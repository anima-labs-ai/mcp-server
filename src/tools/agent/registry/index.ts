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

	server.tool(
		"register_agent",
		"Register an agent in the public registry for discovery. Use this to make an agent discoverable by other agents.",
		registerAgentSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>("/registry/agents", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"search_registry",
		"Search the agent registry to discover agents. Use this to find agents by name, description, or category.",
		searchRegistrySchema.shape,
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			params.set("q", args.query);
			if (args.category) params.set("category", args.category);
			const result = await context.client.get<unknown>(`/registry/agents/search?${params}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"lookup_agent",
		"Look up a specific agent in the registry by DID. Use this to get full details about a registered agent.",
		didSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/registry/agents/${encodeURIComponent(args.did)}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"update_registry",
		"Update an agent's registry entry. Use this to change the public profile of a registered agent.",
		updateRegistrySchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const { did, ...body } = args;
			const result = await context.client.put<unknown>(`/registry/agents/${encodeURIComponent(did)}`, body);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"unlist_agent",
		"Remove an agent from the public registry. Use this to make an agent no longer discoverable.",
		didSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.delete<unknown>(`/registry/agents/${encodeURIComponent(args.did)}`);
			return toolSuccess(result);
		}, options.context),
	);
}
