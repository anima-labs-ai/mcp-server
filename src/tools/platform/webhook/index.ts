import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	registerToolWithAliases,
	withErrorHandling,
	toolSuccess,
} from "../../../shared/index.js";

// 2026-05-12: renamed 9 webhook tools from space-separated names to
// lower_snake_case with the resource_verb convention (webhook_create,
// webhook_get, etc.) to fix MCP SDK identifier warnings + match the
// agent_*, domain_*, pod_* families. Old names kept as deprecated
// aliases — both the space form ("Create Webhook") AND the underscore-
// normalized form ("Create_Webhook") because different clients
// normalize differently before pinning. Added MCP-spec `title` field
// for clients that render display labels.

export function registerWebhookTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	const webhookCreateInput = z.object({
		url: z.string().describe("Webhook destination URL."),
		events: z
			.array(z.string())
			.describe("Event names the webhook should subscribe to."),
		description: z
			.string()
			.optional()
			.describe("Optional human-readable description for the webhook."),
		agentId: z
			.string()
			.optional()
			.describe("Optional agent ID scope for webhook ownership."),
	});
	const webhookGetInput = z.object({
		id: z.string().describe("Webhook ID to retrieve."),
	});
	const webhookUpdateInput = z.object({
		id: z.string().describe("Webhook ID to update."),
		url: z
			.string()
			.optional()
			.describe("Optional updated webhook destination URL."),
		events: z
			.array(z.string())
			.optional()
			.describe("Optional replacement event subscription list."),
		enabled: z
			.boolean()
			.optional()
			.describe("Optional enabled state for this webhook endpoint."),
		description: z
			.string()
			.optional()
			.describe("Optional updated description."),
	});
	const webhookDeleteInput = z.object({
		id: z.string().describe("Webhook ID to delete."),
	});
	const webhookListInput = z.object({
		agentId: z
			.string()
			.optional()
			.describe("Optional agent ID filter for webhook ownership."),
		limit: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Optional maximum number of webhooks to return."),
		cursor: z
			.string()
			.optional()
			.describe("Optional pagination cursor from a previous response."),
	});
	const webhookTestInput = z.object({
		id: z.string().describe("Webhook ID to test."),
	});
	const webhookListDeliveriesInput = z.object({
		id: z.string().describe("Webhook ID whose deliveries should be listed."),
		limit: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Optional maximum number of delivery attempts to return."),
		cursor: z
			.string()
			.optional()
			.describe("Optional pagination cursor from a previous response."),
	});
	const webhookReenableInput = z.object({
		id: z.string().describe("Webhook ID to test and re-enable."),
	});
	const webhookStatsInput = z.object({
		id: z.string().describe("Webhook ID to get delivery statistics for."),
	});

	registerToolWithAliases(
		server,
		"webhook_create",
		["Create Webhook", "Create_Webhook"],
		{
			title: "Create Webhook",
			description:
				"Create a new webhook endpoint with subscribed event types so external systems can receive Anima events. Use this when integrating downstream processors or automations.",
			inputSchema: webhookCreateInput.shape,
			annotations: { readOnlyHint: false, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof webhookCreateInput>>(
			async (args, context) => {
				const result = await context.client.post("/v1/webhooks", args);
				return toolSuccess(result);
			},
			options.context,
		),
	);

	registerToolWithAliases(
		server,
		"webhook_get",
		["Get Webhook", "Get_Webhook"],
		{
			title: "Get Webhook",
			description:
				"Fetch full details for a specific webhook by ID, including URL, events, and status fields. Use this when validating an existing webhook configuration.",
			inputSchema: webhookGetInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof webhookGetInput>>(
			async (args, context) => {
				const result = await context.client.get(`/v1/webhooks/${args.id}`);
				return toolSuccess(result);
			},
			options.context,
		),
	);

	registerToolWithAliases(
		server,
		"webhook_update",
		["Update Webhook", "Update_Webhook"],
		{
			title: "Update Webhook",
			description:
				"Update an existing webhook's URL, subscribed events, enabled state, or description. Use this when endpoint destinations or subscription behavior changes.",
			inputSchema: webhookUpdateInput.shape,
			annotations: { readOnlyHint: false, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof webhookUpdateInput>>(
			async (args, context) => {
				const { id, enabled, ...rest } = args;
				const payload = {
					...rest,
					...(enabled === undefined ? {} : { active: enabled }),
				};
				const result = await context.client.put(`/v1/webhooks/${id}`, payload);
				return toolSuccess(result);
			},
			options.context,
		),
	);

	registerToolWithAliases(
		server,
		"webhook_delete",
		["Delete Webhook", "Delete_Webhook"],
		{
			title: "Delete Webhook",
			description:
				"Delete a webhook endpoint by ID so it no longer receives event deliveries. Use this when retiring integrations or removing invalid destinations.",
			inputSchema: webhookDeleteInput.shape,
			annotations: { readOnlyHint: false, destructiveHint: true },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof webhookDeleteInput>>(
			async (args, context) => {
				const result = await context.client.delete(`/v1/webhooks/${args.id}`);
				return toolSuccess(result);
			},
			options.context,
		),
	);

	registerToolWithAliases(
		server,
		"webhook_list",
		["List Webhooks", "List_Webhooks"],
		{
			title: "List Webhooks",
			description:
				"List webhooks with optional agent scope and cursor pagination. Use this to audit currently configured endpoints across your workspace.",
			inputSchema: webhookListInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof webhookListInput>>(
			async (args, context) => {
				const params = new URLSearchParams();
				if (args.agentId) params.set("agentId", args.agentId);
				if (args.limit !== undefined) params.set("limit", String(args.limit));
				if (args.cursor) params.set("cursor", args.cursor);

				const path = params.toString() ? `/v1/webhooks?${params}` : "/v1/webhooks";
				const result = await context.client.get(path);
				return toolSuccess(result);
			},
			options.context,
		),
	);

	registerToolWithAliases(
		server,
		"webhook_test",
		["Test Webhook", "Test_Webhook"],
		{
			title: "Test Webhook",
			description:
				"Trigger a test event delivery for a webhook to verify endpoint reachability and signature handling. Use this before enabling production event flows.",
			inputSchema: webhookTestInput.shape,
			annotations: { readOnlyHint: false, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof webhookTestInput>>(
			async (args, context) => {
				const result = await context.client.post(`/v1/webhooks/${args.id}/test`, {
					event: "message.received",
				});
				return toolSuccess(result);
			},
			options.context,
		),
	);

	registerToolWithAliases(
		server,
		"webhook_deliveries_list",
		["List Webhook Deliveries", "List_Webhook_Deliveries"],
		{
			title: "List Webhook Deliveries",
			description:
				"List delivery attempts for a specific webhook, including retry and response details when available. Use this to troubleshoot failed or delayed webhook calls.",
			inputSchema: webhookListDeliveriesInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof webhookListDeliveriesInput>>(
			async (args, context) => {
				const params = new URLSearchParams();
				if (args.limit !== undefined) params.set("limit", String(args.limit));
				if (args.cursor) params.set("cursor", args.cursor);

				const basePath = `/v1/webhooks/${args.id}/deliveries`;
				const path = params.toString() ? `${basePath}?${params}` : basePath;
				const result = await context.client.get(path);
				return toolSuccess(result);
			},
			options.context,
		),
	);

	// Re-enable Webhook had a hyphen in the name — doubly broken because
	// hyphens AND spaces are both non-standard identifier chars. Canonical
	// `webhook_reenable` (no underscore between "re" and "enable" — single
	// concept). Both legacy forms kept as aliases.
	registerToolWithAliases(
		server,
		"webhook_reenable",
		["Re-enable Webhook", "Re-enable_Webhook"],
		{
			title: "Re-enable Webhook",
			description:
				"Test a disabled webhook endpoint and re-enable it if the test delivery succeeds. Use this after fixing a webhook endpoint that was auto-disabled due to consecutive failures.",
			inputSchema: webhookReenableInput.shape,
			annotations: { readOnlyHint: false, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof webhookReenableInput>>(
			async (args, context) => {
				const result = await context.client.post(
					`/v1/webhooks/${args.id}/reenable`,
					{},
				);
				return toolSuccess(result);
			},
			options.context,
		),
	);

	registerToolWithAliases(
		server,
		"webhook_stats",
		["Webhook Stats", "Webhook_Stats"],
		{
			title: "Webhook Stats",
			description:
				"Get aggregate delivery statistics for a webhook, including total deliveries, success rate, and failure counts. Use this for monitoring webhook health.",
			inputSchema: webhookStatsInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof webhookStatsInput>>(
			async (args, context) => {
				const result = await context.client.get(
					`/v1/webhooks/${args.id}/stats`,
				);
				return toolSuccess(result);
			},
			options.context,
		),
	);
}
