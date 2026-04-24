import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import { withErrorHandling, toolSuccess } from "../../../shared/index.js";

const createSourceSchema = z.object({
	payment_method_id: z.string().describe("Stripe payment method ID to register as a funding source."),
	customer_id: z.string().describe("Stripe customer ID associated with the payment method."),
	label: z.string().optional().describe("Optional human-readable label for this funding source."),
	last4: z.string().optional().describe("Optional card last4 to store for display."),
	brand: z.string().optional().describe("Optional card brand to store for display."),
	expires_at: z.string().optional().describe("Optional ISO datetime when this source expires."),
	metadata: z.record(z.string()).optional().describe("Optional metadata key-value pairs."),
});

const listSourcesSchema = z.object({
	status: z
		.enum(["ACTIVE", "INACTIVE", "EXPIRED"])
		.optional()
		.describe("Optional funding source status filter."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.default(20)
		.describe("Optional maximum sources to return. Defaults to 20."),
});

const createHoldSchema = z.object({
	funding_source_id: z.string().describe("Funding source ID to place a hold against."),
	card_id: z.string().optional().describe("Optional card ID associated with this hold."),
	amount_cents: z.number().int().positive().describe("Hold amount in cents."),
	currency: z.string().optional().default("usd").describe("Hold currency. Defaults to usd."),
	reason: z.string().optional().describe("Optional reason for the hold."),
	hold_duration_hours: z
		.number()
		.int()
		.optional()
		.describe("Optional hold duration in hours (1-720)."),
	metadata: z.record(z.string()).optional().describe("Optional metadata key-value pairs."),
});

const holdIdSchema = z.object({
	hold_id: z.string().describe("Funding hold ID."),
});

const captureHoldSchema = z.object({
	hold_id: z.string().describe("Funding hold ID to capture."),
	amount_cents: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Optional capture amount in cents. Defaults to remaining amount."),
	metadata: z.record(z.string()).optional().describe("Optional metadata key-value pairs."),
});

const releaseHoldSchema = z.object({
	hold_id: z.string().describe("Funding hold ID to release."),
	reason: z.string().optional().describe("Optional release reason."),
	metadata: z.record(z.string()).optional().describe("Optional metadata key-value pairs."),
});

const listHoldsSchema = z.object({
	funding_source_id: z.string().optional().describe("Optional funding source ID filter."),
	card_id: z.string().optional().describe("Optional card ID filter."),
	status: z
		.enum(["PENDING", "HELD", "PARTIALLY_CAPTURED", "FULLY_CAPTURED", "RELEASED", "EXPIRED", "FAILED"])
		.optional()
		.describe("Optional hold status filter."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.default(20)
		.describe("Optional maximum holds to return. Defaults to 20."),
});

export function registerFundingTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"funding_create_source",
		{
			description: "Register a card funding source using Stripe payment method and customer IDs.",
			inputSchema: createSourceSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/funding/sources", {
				paymentMethodId: args.payment_method_id,
				customerId: args.customer_id,
				label: args.label,
				last4: args.last4,
				brand: args.brand,
				expiresAt: args.expires_at,
				metadata: args.metadata,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"funding_list_sources",
		{
			description: "List funding sources for the current organization, optionally filtered by status.",
			inputSchema: listSourcesSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.status) params.set("status", args.status);
			params.set("limit", String(args.limit));
			const result = await context.client.get<unknown>(`/funding/sources?${params.toString()}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"funding_create_hold",
		{
			description: "Create a pre-authorization hold on a funding source for later capture.",
			inputSchema: createHoldSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/funding/holds", {
				fundingSourceId: args.funding_source_id,
				cardId: args.card_id,
				amountCents: args.amount_cents,
				currency: args.currency,
				reason: args.reason,
				holdDurationHours: args.hold_duration_hours,
				metadata: args.metadata,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"funding_capture_hold",
		{
			description: "Capture part or all of an existing funding hold.",
			inputSchema: captureHoldSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/funding/holds/${encodeURIComponent(args.hold_id)}/capture`;
			const result = await context.client.post<unknown>(path, {
				amountCents: args.amount_cents,
				metadata: args.metadata,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"funding_release_hold",
		{
			description: "Release an existing funding hold and cancel remaining capturable amount.",
			inputSchema: releaseHoldSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/funding/holds/${encodeURIComponent(args.hold_id)}/release`;
			const result = await context.client.post<unknown>(path, {
				reason: args.reason,
				metadata: args.metadata,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"funding_get_hold",
		{
			description: "Get details for a specific funding hold by ID.",
			inputSchema: holdIdSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/funding/holds/${encodeURIComponent(args.hold_id)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"funding_list_holds",
		{
			description: "List funding holds for the current organization with optional filters.",
			inputSchema: listHoldsSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.funding_source_id) params.set("fundingSourceId", args.funding_source_id);
			if (args.card_id) params.set("cardId", args.card_id);
			if (args.status) params.set("status", args.status);
			params.set("limit", String(args.limit));
			const result = await context.client.get<unknown>(`/funding/holds?${params.toString()}`);
			return toolSuccess(result);
		}, options.context),
	);
}
