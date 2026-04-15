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

	server.tool(
		"agent_create",
		"Create a new agent with optional metadata and return the created record. Use this when provisioning a new sending identity or automation actor.",
		agentCreateInput.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.post("/agents", args);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentGetTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"agent_get",
		"Fetch one agent by ID. Use this to inspect current settings, metadata, and status for a single agent.",
		agentGetInput.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.get(`/agents/${args.id}`);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentListTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"agent_list",
		"List agents with optional cursor pagination. Use this to discover agents available in the current account context.",
		agentListInput.shape,
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit) params.set("limit", String(args.limit));
			const path = params.toString() ? `/agents?${params.toString()}` : "/agents";
			const result = await context.client.get(path);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentUpdateTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"agent_update",
		"Update an agent's name or metadata by ID. Use this when an agent needs renaming or profile metadata changes.",
		agentUpdateInput.shape,
		withErrorHandling(async (args, context) => {
			const { id, ...body } = args;
			const result = await context.client.patch(`/agents/${id}`, body);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentDeleteTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"agent_delete",
		"Delete an agent by ID. Use this to remove deprecated or compromised agents that should no longer send messages.",
		agentDeleteInput.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.delete(`/agents/${args.id}`);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerAgentRotateKeyTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"agent_rotate_key",
		"Rotate an agent API key and return the new key material. Use this when rotating credentials for security hygiene or after suspected exposure.",
		agentRotateKeyInput.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.post(`/agents/${args.id}/rotate-key`);
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
