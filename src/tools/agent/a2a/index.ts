import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	withErrorHandling,
	toolSuccess,
} from "../../../shared/index.js";

const discoverAgentInput = z.object({
	url: z.string().describe("The agent's public URL to fetch the Agent Card from (e.g. https://agent.example.com)"),
});

const submitA2aTaskInput = z.object({
	agentId: z.string().describe("Target agent ID"),
	type: z.string().describe("Task type identifier"),
	input: z.record(z.unknown()).describe("Task input payload as key-value pairs"),
	fromDid: z.string().optional().describe("Optional DID of the requesting agent"),
});

const getA2aTaskInput = z.object({
	agentId: z.string().describe("Agent ID that owns the task"),
	taskId: z.string().describe("Task ID to retrieve"),
});

const listA2aTasksInput = z.object({
	agentId: z.string().describe("Agent ID to list tasks for"),
	status: z.string().optional().describe("Filter by task status (SUBMITTED, WORKING, COMPLETED, CANCELED, FAILED)"),
	cursor: z.string().optional().describe("Pagination cursor from a previous response"),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Maximum number of tasks to return"),
});

const cancelA2aTaskInput = z.object({
	agentId: z.string().describe("Agent ID that owns the task"),
	taskId: z.string().describe("Task ID to cancel"),
});

function registerDiscoverAgentTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"discover_agent",
		{
			title: "Discover Agent",
			description: "Fetch an agent's Agent Card via the A2A protocol well-known URL (/.well-known/agent.json) at a public agent URL. Use this for inter-agent capability discovery; for the public Anima registry use `lookup_agent` (by DID) or `search_registry` (by text).",
			inputSchema: discoverAgentInput.shape,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, _context) => {
			const url = new URL("/.well-known/agent.json", args.url);
			const res = await fetch(url.toString());
			if (!res.ok) {
				throw new Error(`Failed to discover agent at ${url}: ${res.status} ${res.statusText}`);
			}
			const card = await res.json();
			return toolSuccess(card);
		}, options.context),
	);
}

function registerSubmitA2aTaskTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"submit_a2a_task",
		{
			title: "Submit A2A Task",
			description: "Submit a task to an agent via the A2A protocol. The agent will process the task asynchronously. Use discover_agent first to check supported task types.",
			inputSchema: submitA2aTaskInput.shape,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const { agentId, ...body } = args;
			const result = await context.client.post(`/v1/agents/${agentId}/a2a/tasks`, body);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerGetA2aTaskTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"get_a2a_task",
		{
			title: "Get A2A Task",
			description: "Get the current status and output of an A2A task. Use this to poll for task completion after submitting a task.",
			inputSchema: getA2aTaskInput.shape,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get(`/v1/agents/${args.agentId}/a2a/tasks/${args.taskId}`);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerListA2aTasksTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"list_a2a_tasks",
		{
			title: "List A2A Tasks",
			description: "List A2A tasks for an agent with optional status filtering and pagination. Use this to see all tasks submitted to or by an agent.",
			inputSchema: listA2aTasksInput.shape,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.status) params.set("status", args.status);
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit) params.set("limit", String(args.limit));
			const qs = params.toString();
			const path = qs ? `/v1/agents/${args.agentId}/a2a/tasks?${qs}` : `/v1/agents/${args.agentId}/a2a/tasks`;
			const result = await context.client.get(path);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerCancelA2aTaskTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"cancel_a2a_task",
		{
			title: "Cancel A2A Task",
			description: "Cancel a running A2A task. The task must be in SUBMITTED or WORKING status to be cancelable.",
			inputSchema: cancelA2aTaskInput.shape,
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post(`/v1/agents/${args.agentId}/a2a/tasks/${args.taskId}/cancel`);
			return toolSuccess(result);
		}, options.context),
	);
}

export function registerA2aTools(options: ToolRegistrationOptions): void {
	registerDiscoverAgentTool(options);
	registerSubmitA2aTaskTool(options);
	registerGetA2aTaskTool(options);
	registerListA2aTasksTool(options);
	registerCancelA2aTaskTool(options);
}
