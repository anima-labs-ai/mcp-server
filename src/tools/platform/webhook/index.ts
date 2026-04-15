import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	withErrorHandling,
	toolSuccess,
} from "../../../shared/index.js";

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

	server.tool(
		"Create Webhook",
		"Create a new webhook endpoint with subscribed event types so external systems can receive Anima events. Use this when integrating downstream processors or automations.",
		webhookCreateInput.shape,
		{ readOnlyHint: false, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const result = await context.client.post("/webhooks", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"Get Webhook",
		"Fetch full details for a specific webhook by ID, including URL, events, and status fields. Use this when validating an existing webhook configuration.",
		webhookGetInput.shape,
		{ readOnlyHint: true, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const result = await context.client.get(`/webhooks/${args.id}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"Update Webhook",
		"Update an existing webhook's URL, subscribed events, enabled state, or description. Use this when endpoint destinations or subscription behavior changes.",
		webhookUpdateInput.shape,
		{ readOnlyHint: false, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const { id, enabled, ...rest } = args;
			const payload = {
				...rest,
				...(enabled === undefined ? {} : { active: enabled }),
			};
			const result = await context.client.put(`/webhooks/${id}`, payload);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"Delete Webhook",
		"Delete a webhook endpoint by ID so it no longer receives event deliveries. Use this when retiring integrations or removing invalid destinations.",
		webhookDeleteInput.shape,
		{ readOnlyHint: false, destructiveHint: true },
		withErrorHandling(async (args, context) => {
			const result = await context.client.delete(`/webhooks/${args.id}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"List Webhooks",
		"List webhooks with optional agent scope and cursor pagination. Use this to audit currently configured endpoints across your workspace.",
		webhookListInput.shape,
		{ readOnlyHint: true, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			if (args.cursor) params.set("cursor", args.cursor);

			const path = params.toString() ? `/webhooks?${params}` : "/webhooks";
			const result = await context.client.get(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"Test Webhook",
		"Trigger a test event delivery for a webhook to verify endpoint reachability and signature handling. Use this before enabling production event flows.",
		webhookTestInput.shape,
		{ readOnlyHint: false, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const result = await context.client.post(`/webhooks/${args.id}/test`, {
				event: "message.received",
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"List Webhook Deliveries",
		"List delivery attempts for a specific webhook, including retry and response details when available. Use this to troubleshoot failed or delayed webhook calls.",
		webhookListDeliveriesInput.shape,
		{ readOnlyHint: true, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			if (args.cursor) params.set("cursor", args.cursor);

			const basePath = `/webhooks/${args.id}/deliveries`;
			const path = params.toString() ? `${basePath}?${params}` : basePath;
			const result = await context.client.get(path);
			return toolSuccess(result);
		}, options.context),
	);

	const webhookReenableInput = z.object({
		id: z.string().describe("Webhook ID to test and re-enable."),
	});

	server.tool(
		"Re-enable Webhook",
		"Test a disabled webhook endpoint and re-enable it if the test delivery succeeds. Use this after fixing a webhook endpoint that was auto-disabled due to consecutive failures.",
		webhookReenableInput.shape,
		{ readOnlyHint: false, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const result = await context.client.post(`/webhooks/${args.id}/reenable`, {});
			return toolSuccess(result);
		}, options.context),
	);

	const webhookStatsInput = z.object({
		id: z.string().describe("Webhook ID to get delivery statistics for."),
	});

	server.tool(
		"Webhook Stats",
		"Get aggregate delivery statistics for a webhook, including total deliveries, success rate, and failure counts. Use this for monitoring webhook health.",
		webhookStatsInput.shape,
		{ readOnlyHint: true, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const result = await context.client.get(`/webhooks/${args.id}/stats`);
			return toolSuccess(result);
		}, options.context),
	);
}
