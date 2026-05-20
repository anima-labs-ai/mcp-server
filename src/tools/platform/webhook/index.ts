import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	deleteOutput,
	listOutput,
	objectOutput,
	toolSuccess,
	withErrorHandling,
} from "../../../shared/index.js";

// Webhook group (hosted): 5 tools matching the public API surface.
// webhook_set is an UPSERT — `id` present routes to PUT (update), absent
// routes to POST (create). API has separate create / update endpoints
// but a single tool keeps the agent surface tighter and matches
// declarative "ensure webhook X exists" workflows.
//
// Additional API surface (listDeliveries, stats, reenable, replayDelivery,
// listDeadLetters, eventTypes) is intentionally NOT exposed via MCP —
// operational/debugging concerns, not agent-driven actions. Live in the
// dashboard / CLI instead.

const webhookIdInput = z.object({
	id: z.string().describe("Webhook ID"),
});

const webhookListInput = z.object({
	cursor: z.string().optional().describe("Pagination cursor from a previous list call"),
	limit: z
		.number()
		.int()
		.positive()
		.max(100)
		.optional()
		.describe("Maximum number of webhooks to return (1-100)"),
});

const webhookSetInput = z.object({
	id: z
		.string()
		.optional()
		.describe(
			"Webhook ID. Present → updates that webhook (PUT). Omitted → creates a new one (POST).",
		),
	url: z
		.string()
		.url()
		.optional()
		.describe(
			"HTTPS endpoint URL that will receive event payloads. Required on create; optional on update.",
		),
	events: z
		.array(z.string())
		.optional()
		.describe(
			"List of event types to subscribe to (e.g. 'message.received', 'email.bounced'). Required on create; optional on update.",
		),
	description: z.string().optional().describe("Optional human-readable label"),
	active: z
		.boolean()
		.optional()
		.describe("Whether the webhook is active. Defaults to true on create."),
});

const webhookTestInput = z.object({
	id: z.string().describe("Webhook ID to send a test delivery to"),
	event: z
		.string()
		.optional()
		.describe(
			"Event type to simulate in the test payload (e.g. 'message.received'). Defaults to 'message.received'.",
		),
});

export function registerWebhookTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"webhook_get",
		{
			title: "Get Webhook",
			description:
				"Get a webhook subscription by ID. Returns the full configuration (URL, subscribed events, active state, description).",
			inputSchema: webhookIdInput.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/webhooks/${encodeURIComponent(args.id)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"webhook_list",
		{
			title: "List Webhooks",
			description:
				"List webhook subscriptions for the calling org with cursor pagination. Use to enumerate existing webhooks before set/delete operations.",
			inputSchema: webhookListInput.shape,
			outputSchema: listOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit) params.set("limit", String(args.limit));
			const qs = params.toString();
			const url = qs ? `/v1/webhooks?${qs}` : "/v1/webhooks";
			const result = await context.client.get<unknown>(url);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"webhook_set",
		{
			title: "Set Webhook",
			description:
				"Create or update a webhook subscription (upsert). If `id` is provided the call updates that webhook (PUT). If omitted it creates a new one (POST) — `url` and `events` are then required. Use this for declarative 'ensure webhook X exists' workflows.",
			inputSchema: webhookSetInput.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: false, destructiveHint: false },
		},
		withErrorHandling(async (args, context) => {
			if (args.id) {
				const { id, ...payload } = args;
				const path = `/v1/webhooks/${encodeURIComponent(id)}`;
				const result = await context.client.put<unknown>(path, payload);
				return toolSuccess(result);
			}
			const { id: _ignored, ...payload } = args;
			const result = await context.client.post<unknown>("/v1/webhooks", payload);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"webhook_delete",
		{
			title: "Delete Webhook",
			description:
				"Delete a webhook subscription by ID. Permanently removes the configuration and stops future deliveries. To temporarily pause without deleting, use webhook_set with { id, active: false }.",
			inputSchema: webhookIdInput.shape,
			outputSchema: deleteOutput(),
			annotations: { readOnlyHint: false, destructiveHint: true },
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/webhooks/${encodeURIComponent(args.id)}`;
			const result = await context.client.delete<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"webhook_test",
		{
			title: "Test Webhook",
			description:
				"Send a test event payload to a webhook to verify the endpoint is reachable and signature verification works. Returns a deliveryId you can correlate with your endpoint's logs.",
			inputSchema: webhookTestInput.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: false, destructiveHint: false },
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/webhooks/${encodeURIComponent(args.id)}/test`;
			const payload: Record<string, unknown> = {};
			if (args.event) payload.event = args.event;
			const result = await context.client.post<unknown>(path, payload);
			return toolSuccess(result);
		}, options.context),
	);
}
