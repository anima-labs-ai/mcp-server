import { z } from "zod";
import type { ToolContext, ToolRegistrationOptions } from "../../../shared/index.js";
import { withErrorHandling, toolSuccess } from "../../../shared/index.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null
		? (value as UnknownRecord)
		: undefined;
}

function asNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

async function resolveCurrentAgentId(context: ToolContext): Promise<string> {
	const whoami = await context.client.get<unknown>("/v1/accounts/me");
	const whoamiObject = asRecord(whoami);
	const agentId =
		asString(whoamiObject?.id) ??
		asString(asRecord(whoamiObject?.agent)?.id) ??
		asString(whoamiObject?.agentId);

	if (!agentId) {
		throw new Error("Could not determine current agent ID");
	}

	return agentId;
}

function extractSpendingSummary(payload: unknown): {
	cardId: string | undefined;
	status: string | undefined;
	spentTodayCents: number | undefined;
	dailyLimitCents: number | undefined;
	spentWeekCents: number | undefined;
	weeklyLimitCents: number | undefined;
	spentMonthCents: number | undefined;
	monthlyLimitCents: number | undefined;
	spentYearCents: number | undefined;
	yearlyLimitCents: number | undefined;
	spentLifetimeCents: number | undefined;
	lifetimeLimitCents: number | undefined;
} {
	const card = asRecord(payload);
	const limits = asRecord(card?.limits);
	const spend = asRecord(card?.spend);

	const spentTodayCents =
		asNumber(card?.spent_today) ??
		asNumber(card?.spentToday) ??
		asNumber(spend?.today) ??
		asNumber(spend?.daily);

	const dailyLimitCents =
		asNumber(card?.spend_limit_daily) ??
		asNumber(card?.spendLimitDaily) ??
		asNumber(limits?.daily) ??
		asNumber(limits?.dailyLimit);

	const spentWeekCents =
		asNumber(card?.spent_this_week) ??
		asNumber(card?.spentThisWeek) ??
		asNumber(spend?.weekly) ??
		asNumber(spend?.week);

	const weeklyLimitCents =
		asNumber(card?.spend_limit_weekly) ??
		asNumber(card?.spendLimitWeekly) ??
		asNumber(limits?.weekly) ??
		asNumber(limits?.weeklyLimit);

	const spentMonthCents =
		asNumber(card?.spent_monthly) ??
		asNumber(card?.spentMonthly) ??
		asNumber(spend?.monthly) ??
		asNumber(spend?.month);

	const monthlyLimitCents =
		asNumber(card?.spend_limit_monthly) ??
		asNumber(card?.spendLimitMonthly) ??
		asNumber(limits?.monthly) ??
		asNumber(limits?.monthlyLimit);

	const spentYearCents =
		asNumber(card?.spent_this_year) ??
		asNumber(card?.spentThisYear) ??
		asNumber(spend?.yearly) ??
		asNumber(spend?.year);

	const yearlyLimitCents =
		asNumber(card?.spend_limit_yearly) ??
		asNumber(card?.spendLimitYearly) ??
		asNumber(limits?.yearly) ??
		asNumber(limits?.yearlyLimit);

	const spentLifetimeCents =
		asNumber(card?.spent_lifetime) ??
		asNumber(card?.spentLifetime) ??
		asNumber(spend?.lifetime) ??
		asNumber(spend?.allTime);

	const lifetimeLimitCents =
		asNumber(card?.spend_limit_lifetime) ??
		asNumber(card?.spendLimitLifetime) ??
		asNumber(limits?.lifetime) ??
		asNumber(limits?.lifetimeLimit);

	return {
		cardId: asString(card?.id),
		status: asString(card?.status),
		spentTodayCents,
		dailyLimitCents,
		spentWeekCents,
		weeklyLimitCents,
		spentMonthCents,
		monthlyLimitCents,
		spentYearCents,
		yearlyLimitCents,
		spentLifetimeCents,
		lifetimeLimitCents,
	};
}

const createCardSchema = z.object({
	label: z.string().optional().describe("Optional human-readable card label."),
	currency: z
		.string()
		.optional()
		.default("usd")
		.describe("Optional currency for card spending. Defaults to usd."),
	spend_limit_daily: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Optional daily spending limit in cents."),
	spend_limit_monthly: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Optional monthly spending limit in cents."),
	spend_limit_weekly: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Optional weekly spending limit in cents."),
	spend_limit_yearly: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Optional yearly spending limit in cents."),
	spend_limit_lifetime: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Optional lifetime spending limit in cents."),
	spend_limit_per_auth: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Optional per-authorization spending limit in cents."),
});

const listCardsSchema = z.object({
	status: z
		.enum(["ACTIVE", "FROZEN", "CANCELED"])
		.optional()
		.describe("Optional card status filter."),
});

const cardIdSchema = z.object({
	card_id: z.string().describe("Card ID."),
});

const getTransactionsSchema = z.object({
	card_id: z.string().optional().describe("Optional card ID filter."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.default(20)
		.describe("Optional maximum number of transactions to return. Defaults to 20."),
});

const createSpendingPolicySchema = z.object({
	card_id: z.string().describe("Card ID this policy applies to."),
	name: z.string().describe("Human-readable spending policy name."),
	action: z
		.enum(["AUTO_APPROVE", "REQUIRE_APPROVAL", "ALWAYS_DECLINE"])
		.describe("Policy action when this rule matches."),
	priority: z
		.number()
		.int()
		.optional()
		.default(0)
		.describe("Optional policy evaluation priority. Defaults to 0."),
	max_amount_cents: z
		.number()
		.int()
		.nonnegative()
		.optional()
		.describe("Optional max amount in cents allowed by this policy."),
	allowed_categories: z
		.array(z.string())
		.optional()
		.describe("Optional merchant categories explicitly allowed."),
	blocked_categories: z
		.array(z.string())
		.optional()
		.describe("Optional merchant categories explicitly blocked."),
	allowed_merchants: z
		.array(z.string())
		.optional()
		.describe("Optional merchant names explicitly allowed."),
	blocked_merchants: z
		.array(z.string())
		.optional()
		.describe("Optional merchant names explicitly blocked."),
});

const listSpendingPoliciesSchema = z.object({
	card_id: z.string().describe("Card ID whose spending policies should be listed."),
});

const deleteSpendingPolicySchema = z.object({
	policy_id: z.string().describe("Policy ID to delete."),
});

const createCardholderSchema = z.object({
	name: z.string().max(24).describe("Cardholder name (max 24 chars)."),
	type: z
		.enum(["individual", "company"])
		.optional()
		.default("company")
		.describe("Cardholder type. Defaults to company."),
	email: z.string().optional().describe("Optional cardholder email."),
	phone_number: z.string().optional().describe("Optional cardholder phone number."),
	billing_line1: z.string().describe("Billing address line 1."),
	billing_line2: z.string().optional().describe("Billing address line 2."),
	billing_city: z.string().describe("Billing city."),
	billing_state: z.string().optional().describe("Billing state/region."),
	billing_postal_code: z.string().describe("Billing postal code."),
	billing_country: z.string().optional().default("US").describe("Billing country code."),
	first_name: z.string().optional().describe("Optional first name for individual cardholders."),
	last_name: z.string().optional().describe("Optional last name for individual cardholders."),
	preferred_mcc: z.string().optional().describe("Optional preferred MCC."),
	product_description: z.string().optional().describe("Optional product description."),
	metadata: z.record(z.string()).optional().describe("Optional metadata key-value pairs."),
});

const getCardholderSchema = z.object({
	id: z.string().describe("Cardholder ID."),
});

const listCardholdersSchema = z.object({
	page: z.number().int().positive().optional().default(1).describe("Page number, default 1."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.default(20)
		.describe("Maximum cardholders per page, default 20."),
});

const updateCardholderSchema = z.object({
	id: z.string().describe("Cardholder ID."),
	name: z.string().max(24).optional().describe("Updated cardholder name."),
	email: z.string().optional().describe("Updated cardholder email."),
	phone_number: z.string().optional().describe("Updated cardholder phone number."),
	status: z.enum(["active", "inactive"]).optional().describe("Updated cardholder status."),
	billing_line1: z.string().optional().describe("Updated billing address line 1."),
	billing_line2: z.string().optional().describe("Updated billing address line 2."),
	billing_city: z.string().optional().describe("Updated billing city."),
	billing_state: z.string().optional().describe("Updated billing state/region."),
	billing_postal_code: z.string().optional().describe("Updated billing postal code."),
	billing_country: z.string().optional().describe("Updated billing country code."),
	preferred_mcc: z.string().optional().describe("Updated preferred MCC."),
	product_description: z.string().optional().describe("Updated product description."),
	metadata: z.record(z.string()).optional().describe("Updated metadata key-value pairs."),
});

export function registerCardTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"create_card",
		{
			description: "Create a virtual card for the current agent with optional spend limits. Use this to provision a controlled card before running purchase workflows.",
			inputSchema: createCardSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const agentId = await resolveCurrentAgentId(context);
			const {
				spend_limit_daily,
				spend_limit_monthly,
				spend_limit_weekly,
				spend_limit_yearly,
				spend_limit_lifetime,
				spend_limit_per_auth,
				...rest
			} = args;
			const result = await context.client.post<unknown>("/v1/cards", {
				agentId,
				...rest,
				spendLimitDaily: spend_limit_daily,
				spendLimitMonthly: spend_limit_monthly,
				spendLimitWeekly: spend_limit_weekly,
				spendLimitYearly: spend_limit_yearly,
				spendLimitLifetime: spend_limit_lifetime,
				spendLimitPerAuth: spend_limit_per_auth,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"list_cards",
		{
			description: "List cards for the current agent with an optional status filter. Use this to inspect available cards before selecting one for operations.",
			inputSchema: listCardsSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const agentId = await resolveCurrentAgentId(context);
			const params = new URLSearchParams();
			params.set("agentId", agentId);
			if (args.status) params.set("status", args.status);
			const result = await context.client.get<unknown>(
				`/v1/cards?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"get_card",
		{
			description: "Get full details for a specific card by ID, including status and limit information. Use this when you need card-level state before taking action.",
			inputSchema: cardIdSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/cards/${encodeURIComponent(args.card_id)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"freeze_card",
		{
			description: "Freeze a card to block all new transactions immediately. Use this when suspicious activity is detected or temporary lockout is required.",
			inputSchema: cardIdSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.put<unknown>("/v1/cards", {
				cardId: args.card_id,
				status: "FROZEN",
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"unfreeze_card",
		{
			description: "Unfreeze a previously frozen card so transactions can proceed again. Use this after reviewing and clearing a freeze condition.",
			inputSchema: cardIdSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.put<unknown>("/v1/cards", {
				cardId: args.card_id,
				status: "ACTIVE",
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"get_transactions",
		{
			description: "Get card transaction history with merchant and amount details. Use this to audit recent spend activity and inspect charge-level outcomes.",
			inputSchema: getTransactionsSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.card_id) params.set("cardId", args.card_id);
			params.set("limit", String(args.limit));
			const result = await context.client.get<unknown>(
				`/v1/cards/transactions?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"create_spending_policy",
		{
			description: "Create a spending policy for a card with action rules, optional limits, and merchant/category constraints. Use this to enforce card governance automatically.",
			inputSchema: createSpendingPolicySchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const {
				card_id,
				max_amount_cents,
				allowed_categories,
				blocked_categories,
				allowed_merchants,
				blocked_merchants,
				...rest
			} = args;

			const result = await context.client.post<unknown>("/v1/cards/policies", {
				cardId: card_id,
				...rest,
				maxAmountCents: max_amount_cents,
				allowedCategories: allowed_categories,
				blockedCategories: blocked_categories,
				allowedMerchants: allowed_merchants,
				blockedMerchants: blocked_merchants,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"list_spending_policies",
		{
			description: "List all spending policies attached to a specific card. Use this to review active controls and policy ordering.",
			inputSchema: listSpendingPoliciesSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			params.set("cardId", args.card_id);
			const result = await context.client.get<unknown>(
				`/v1/cards/policies?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"delete_spending_policy",
		{
			description: "Delete a spending policy by policy ID. Use this when removing obsolete card controls or simplifying rule sets.",
			inputSchema: deleteSpendingPolicySchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/cards/policies/${encodeURIComponent(args.policy_id)}`;
			const result = await context.client.delete<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"get_spending_summary",
		{
			description: "Get a normalized spending summary for a card, including today and month totals versus configured limits. Use this for quick budget and status checks.",
			inputSchema: cardIdSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/cards/${encodeURIComponent(args.card_id)}`;
			const card = await context.client.get<unknown>(path);
			const summary = extractSpendingSummary(card);
			return toolSuccess({
				cardId: summary.cardId,
				status: summary.status,
				spending: {
					today: {
						spentCents: summary.spentTodayCents,
						limitCents: summary.dailyLimitCents,
					},
					week: {
						spentCents: summary.spentWeekCents,
						limitCents: summary.weeklyLimitCents,
					},
					month: {
						spentCents: summary.spentMonthCents,
						limitCents: summary.monthlyLimitCents,
					},
					year: {
						spentCents: summary.spentYearCents,
						limitCents: summary.yearlyLimitCents,
					},
					lifetime: {
						spentCents: summary.spentLifetimeCents,
						limitCents: summary.lifetimeLimitCents,
					},
				},
			});
		}, options.context),
	);

	server.registerTool(
		"create_cardholder",
		{
			description: "Create a cardholder for the current organization to use as the owner of issuing cards. Use this before creating cards when individual cardholder profiles are required.",
			inputSchema: createCardholderSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/v1/cardholders", {
				name: args.name,
				type: args.type,
				email: args.email,
				phoneNumber: args.phone_number,
				billing: {
					line1: args.billing_line1,
					line2: args.billing_line2,
					city: args.billing_city,
					state: args.billing_state,
					postalCode: args.billing_postal_code,
					country: args.billing_country,
				},
				individual:
					args.first_name || args.last_name
						? {
							firstName: args.first_name ?? "",
							lastName: args.last_name ?? "",
						}
						: undefined,
				preferredMcc: args.preferred_mcc,
				productDescription: args.product_description,
				metadata: args.metadata,
				tosAccepted: true,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"get_cardholder",
		{
			description: "Get details for a specific cardholder by ID. Use this to inspect billing and status fields before assigning or updating cardholders.",
			inputSchema: getCardholderSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/cardholders/${encodeURIComponent(args.id)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"list_cardholders",
		{
			description: "List cardholders in the current organization with pagination. Use this to select existing cardholders for card assignment workflows.",
			inputSchema: listCardholdersSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			params.set("page", String(args.page));
			params.set("limit", String(args.limit));
			const result = await context.client.get<unknown>(`/v1/cardholders?${params.toString()}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"update_cardholder",
		{
			description: "Update cardholder profile fields such as status and billing details. Use this to keep cardholder records aligned with operational needs.",
			inputSchema: updateCardholderSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/cardholders/${encodeURIComponent(args.id)}`;
			const result = await context.client.patch<unknown>(path, {
				id: args.id,
				name: args.name,
				email: args.email,
				phoneNumber: args.phone_number,
				status: args.status,
				billing:
					args.billing_line1 ||
					args.billing_line2 ||
					args.billing_city ||
					args.billing_state ||
					args.billing_postal_code ||
					args.billing_country
						? {
							line1: args.billing_line1,
							line2: args.billing_line2,
							city: args.billing_city,
							state: args.billing_state,
							postalCode: args.billing_postal_code,
							country: args.billing_country,
						}
						: undefined,
				preferredMcc: args.preferred_mcc,
				productDescription: args.product_description,
				metadata: args.metadata,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"delete_cardholder",
		{
			description: "Delete a cardholder by ID after deactivating it upstream. Use this to remove obsolete cardholder records from active use.",
			inputSchema: getCardholderSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/cardholders/${encodeURIComponent(args.id)}`;
			const result = await context.client.delete<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	// --- Update & Delete Card Tools ---

	const updateCardSchema = z.object({
		card_id: z.string().describe("Card ID to update."),
		label: z.string().optional().describe("Updated human-readable card label."),
		spend_limit_daily: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe("Updated daily spending limit in cents."),
		spend_limit_monthly: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe("Updated monthly spending limit in cents."),
		spend_limit_weekly: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe("Updated weekly spending limit in cents."),
		spend_limit_yearly: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe("Updated yearly spending limit in cents."),
		spend_limit_lifetime: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe("Updated lifetime spending limit in cents."),
		spend_limit_per_auth: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe("Updated per-authorization spending limit in cents."),
	});

	server.registerTool(
		"update_card",
		{
			description: "Update a card's label or spending limits. Use this to adjust card controls after creation without needing to recreate the card.",
			inputSchema: updateCardSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const {
				card_id,
				spend_limit_daily,
				spend_limit_monthly,
				spend_limit_weekly,
				spend_limit_yearly,
				spend_limit_lifetime,
				spend_limit_per_auth,
				...rest
			} = args;
			const path = `/v1/cards/${encodeURIComponent(card_id)}`;
			const result = await context.client.patch<unknown>(path, {
				...rest,
				spendLimitDaily: spend_limit_daily,
				spendLimitMonthly: spend_limit_monthly,
				spendLimitWeekly: spend_limit_weekly,
				spendLimitYearly: spend_limit_yearly,
				spendLimitLifetime: spend_limit_lifetime,
				spendLimitPerAuth: spend_limit_per_auth,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"delete_card",
		{
			description: "Permanently delete a card by ID. The card must be frozen or canceled first. Use this to remove decommissioned cards from the system.",
			inputSchema: cardIdSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/cards/${encodeURIComponent(args.card_id)}`;
			const result = await context.client.delete<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	// --- Update Spending Policy Tool ---

	const updateSpendingPolicySchema = z.object({
		policy_id: z.string().describe("Policy ID to update."),
		name: z.string().optional().describe("Updated policy name."),
		action: z
			.enum(["AUTO_APPROVE", "REQUIRE_APPROVAL", "ALWAYS_DECLINE"])
			.optional()
			.describe("Updated policy action."),
		priority: z
			.number()
			.int()
			.optional()
			.describe("Updated policy evaluation priority."),
		max_amount_cents: z
			.number()
			.int()
			.nonnegative()
			.optional()
			.describe("Updated max amount in cents allowed by this policy."),
		allowed_categories: z
			.array(z.string())
			.optional()
			.describe("Updated merchant categories explicitly allowed."),
		blocked_categories: z
			.array(z.string())
			.optional()
			.describe("Updated merchant categories explicitly blocked."),
		allowed_merchants: z
			.array(z.string())
			.optional()
			.describe("Updated merchant names explicitly allowed."),
		blocked_merchants: z
			.array(z.string())
			.optional()
			.describe("Updated merchant names explicitly blocked."),
	});

	server.registerTool(
		"update_spending_policy",
		{
			description: "Update an existing spending policy by ID to change its rules, action, or merchant constraints. Use this to refine card governance without deleting and recreating policies.",
			inputSchema: updateSpendingPolicySchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const {
				policy_id,
				max_amount_cents,
				allowed_categories,
				blocked_categories,
				allowed_merchants,
				blocked_merchants,
				...rest
			} = args;
			const path = `/v1/cards/policies/${encodeURIComponent(policy_id)}`;
			const result = await context.client.patch<unknown>(path, {
				...rest,
				maxAmountCents: max_amount_cents,
				allowedCategories: allowed_categories,
				blockedCategories: blocked_categories,
				allowedMerchants: allowed_merchants,
				blockedMerchants: blocked_merchants,
			});
			return toolSuccess(result);
		}, options.context),
	);

	// --- Get Transaction Tool ---

	const getTransactionSchema = z.object({
		transaction_id: z.string().describe("Transaction ID to retrieve."),
	});

	server.registerTool(
		"get_transaction",
		{
			description: "Get full details for a single card transaction by ID, including merchant info, amount, and status. Use this to inspect a specific charge or refund.",
			inputSchema: getTransactionSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/cards/transactions/${encodeURIComponent(args.transaction_id)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	// --- Kill Switch Tool ---

	const killSwitchSchema = z.object({
		scope: z
			.enum(["agent", "organization"])
			.describe("Scope of the kill switch: freeze all cards for the agent or the entire organization."),
		agent_id: z.string().optional().describe("Agent ID when scope is 'agent'. Required for agent scope."),
	});

	server.registerTool(
		"kill_switch",
		{
			description: "Emergency kill switch that immediately freezes all cards within the specified scope. Use this when widespread fraud or compromise is detected and all card activity must stop.",
			inputSchema: killSwitchSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/v1/cards/kill-switch", {
				scope: args.scope,
				agentId: args.agent_id,
			});
			return toolSuccess(result);
		}, options.context),
	);

	// --- Approval Tools ---

	const listApprovalsSchema = z.object({
		card_id: z
			.string()
			.optional()
			.describe("Optional card ID filter. If omitted, lists all approvals for the agent."),
		status: z
			.enum(["PENDING", "APPROVED", "DECLINED", "EXPIRED"])
			.optional()
			.describe("Optional approval status filter."),
		limit: z
			.number()
			.int()
			.positive()
			.optional()
			.default(20)
			.describe("Maximum number of approvals to return. Defaults to 20."),
	});

	const approvalDecisionSchema = z.object({
		approval_id: z.string().describe("Approval ID to decide on."),
	});

	server.registerTool(
		"list_approvals",
		{
			description: "List pending and historical card authorization approvals. Use this to review transactions awaiting human decision or audit past approval outcomes.",
			inputSchema: listApprovalsSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.card_id) params.set("cardId", args.card_id);
			if (args.status) params.set("status", args.status);
			params.set("limit", String(args.limit));
			const result = await context.client.get<unknown>(
				`/v1/cards/approvals?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"approve_authorization",
		{
			description: "Approve a pending card authorization. This records the approval decision and creates a pre-approval pattern so future similar transactions from the same merchant auto-approve. Note: the original Stripe authorization was already declined due to the 2-second webhook deadline, but approving creates a pattern for future transactions.",
			inputSchema: approvalDecisionSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/cards/approvals/${encodeURIComponent(args.approval_id)}/decision`;
			const result = await context.client.post<unknown>(path, {
				decision: "APPROVED",
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"decline_authorization",
		{
			description: "Decline a pending card authorization. This confirms the decline decision and does not create a pre-approval pattern. Use this when the transaction should not be allowed in the future either.",
			inputSchema: approvalDecisionSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/cards/approvals/${encodeURIComponent(args.approval_id)}/decision`;
			const result = await context.client.post<unknown>(path, {
				decision: "DECLINED",
			});
			return toolSuccess(result);
		}, options.context),
	);
}
