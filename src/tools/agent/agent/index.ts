import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	withErrorHandling,
	toolSuccess,
} from "../../../shared/index.js";

const agentCreateInput = z.object({
	name: z.string().describe("Agent display name"),
	metadata: z
		.record(z.string())
		.optional()
		.describe("Optional agent metadata as key-value string pairs"),
});

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
			description: "Create a new agent with optional metadata and return the created record. Use this when provisioning a new sending identity or automation actor.",
			inputSchema: agentCreateInput.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post("/v1/agents", args);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentGetTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"agent_get",
		{
			description: "Fetch one agent by ID. Use this to inspect current settings, metadata, and status for a single agent.",
			inputSchema: agentGetInput.shape,
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
			description: "List agents with optional cursor pagination. Use this to discover agents available in the current account context.",
			inputSchema: agentListInput.shape,
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
			description: "Update an agent's name or metadata by ID. Use this when an agent needs renaming or profile metadata changes.",
			inputSchema: agentUpdateInput.shape,
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
			description: "Delete an agent by ID. Use this to remove deprecated or compromised agents that should no longer send messages.",
			inputSchema: agentDeleteInput.shape,
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
			description: "Rotate an agent API key and return the new key material. Use this when rotating credentials for security hygiene or after suspected exposure.",
			inputSchema: agentRotateKeyInput.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post(`/v1/agents/${args.id}/rotate-key`);
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
}
