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

// 2026-05-12: renamed Create/Get/List/Update/Delete Pod + Pod Usage from
// space-separated to lower_snake_case (resource_verb to match agent_*,
// domain_*, vault_* families). Old names kept as deprecated aliases —
// both the space form ("Create Pod") AND the underscore-normalized form
// ("Create_Pod") because different clients normalize differently before
// pinning. Added MCP-spec `title` for clients that render display labels.

const createPodSchema = z.object({
	agentId: z
		.string()
		.describe("ID of the agent to create the pod for."),
	name: z
		.string()
		.describe("Name for the pod."),
	image: z
		.string()
		.describe("Container image to run (e.g. 'node:24-alpine')."),
	resources: z
		.object({
			cpu: z.string().optional().describe("CPU allocation (e.g. '0.5', '1')."),
			memory: z.string().optional().describe("Memory allocation (e.g. '256Mi', '1Gi')."),
			storage: z.string().optional().describe("Storage allocation (e.g. '1Gi', '10Gi')."),
		})
		.optional()
		.describe("Resource specifications for the pod."),
	env: z
		.record(z.string())
		.optional()
		.describe("Environment variables for the container."),
	metadata: z
		.record(z.unknown())
		.optional()
		.describe("Optional metadata for the pod."),
});

const listPodsSchema = z.object({
	agentId: z
		.string()
		.optional()
		.describe("Optional agent ID to filter pods by."),
});

const podIdSchema = z.object({
	id: z
		.string()
		.describe("Pod ID."),
});

const updatePodSchema = z.object({
	id: z
		.string()
		.describe("Pod ID to update."),
	name: z
		.string()
		.optional()
		.describe("Updated pod name."),
	resources: z
		.object({
			cpu: z.string().optional().describe("Updated CPU allocation."),
			memory: z.string().optional().describe("Updated memory allocation."),
			storage: z.string().optional().describe("Updated storage allocation."),
		})
		.optional()
		.describe("Updated resource specifications."),
	env: z
		.record(z.string())
		.optional()
		.describe("Updated environment variables."),
	metadata: z
		.record(z.unknown())
		.optional()
		.describe("Updated metadata."),
});

export function registerPodTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"pod_create",
		{
			title: "Create Pod",
			description: "Create a new compute pod for an agent. Use this to provision a container that runs alongside the agent.",
			inputSchema: createPodSchema.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: false, destructiveHint: false },
		},
		withErrorHandling<z.infer<typeof createPodSchema>>(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>("/v1/pods", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"pod_list",
		{
			title: "List Pods",
			description: "List all compute pods, optionally filtered by agent. Use this to see running and stopped pods.",
			inputSchema: listPodsSchema.shape,
			outputSchema: listOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		withErrorHandling<z.infer<typeof listPodsSchema>>(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			const qs = params.toString();
			const path = `/v1/pods${qs ? `?${qs}` : ""}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"pod_get",
		{
			title: "Get Pod",
			description: "Get details for a specific pod. Use this to check pod status, resources, and configuration.",
			inputSchema: podIdSchema.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		withErrorHandling<z.infer<typeof podIdSchema>>(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/pods/${encodeURIComponent(args.id)}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"pod_update",
		{
			title: "Update Pod",
			description: "Update a pod's configuration. Use this to change resources, environment variables, or metadata.",
			inputSchema: updatePodSchema.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: false, destructiveHint: false },
		},
		withErrorHandling<z.infer<typeof updatePodSchema>>(async (args, context) => {
			requireMasterKeyGuard(context);
			const { id, ...body } = args;
			const result = await context.client.put<unknown>(`/v1/pods/${encodeURIComponent(id)}`, body);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"pod_delete",
		{
			title: "Delete Pod",
			description: "Delete a compute pod. Use this to tear down a pod that is no longer needed.",
			inputSchema: podIdSchema.shape,
			outputSchema: deleteOutput(),
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		withErrorHandling<z.infer<typeof podIdSchema>>(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.delete<unknown>(`/v1/pods/${encodeURIComponent(args.id)}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"pod_usage",
		{
			title: "Pod Usage",
			description: "Get resource usage metrics for a pod. Use this to monitor CPU, memory, storage, and network usage.",
			inputSchema: podIdSchema.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		withErrorHandling<z.infer<typeof podIdSchema>>(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/pods/${encodeURIComponent(args.id)}/usage`);
			return toolSuccess(result);
		}, options.context),
	);
}
