import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	withErrorHandling,
	toolSuccess,
	requireMasterKeyGuard,
} from "../../../shared/index.js";

const agentIdSchema = z.object({
	agentId: z
		.string()
		.describe("ID of the agent."),
});

const createWalletSchema = z.object({
	agentId: z
		.string()
		.describe("ID of the agent to create a wallet for."),
	currency: z
		.string()
		.optional()
		.describe("Currency for the wallet (default: USD)."),
	metadata: z
		.record(z.unknown())
		.optional()
		.describe("Optional metadata for the wallet."),
});

const walletPaySchema = z.object({
	agentId: z
		.string()
		.describe("ID of the agent making the payment."),
	to: z
		.string()
		.describe("Recipient address or identifier."),
	amount: z
		.number()
		.describe("Amount to pay."),
	currency: z
		.string()
		.optional()
		.describe("Currency for the payment."),
	memo: z
		.string()
		.optional()
		.describe("Optional memo for the transaction."),
	metadata: z
		.record(z.unknown())
		.optional()
		.describe("Optional transaction metadata."),
});

const x402FetchSchema = z.object({
	agentId: z
		.string()
		.describe("ID of the agent making the x402 request."),
	url: z
		.string()
		.describe("URL to fetch (may require payment via x402 protocol)."),
	method: z
		.string()
		.optional()
		.describe("HTTP method (default: GET)."),
	headers: z
		.record(z.string())
		.optional()
		.describe("Optional request headers."),
	body: z
		.string()
		.optional()
		.describe("Optional request body."),
	maxPaymentAmount: z
		.number()
		.optional()
		.describe("Maximum amount the agent is willing to pay."),
});

const walletTransactionsSchema = z.object({
	agentId: z
		.string()
		.describe("ID of the agent."),
	status: z
		.string()
		.optional()
		.describe("Optional status filter for transactions."),
});

export function registerWalletTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"create_wallet",
		"Create a new wallet for an agent. Use this to provision a payment wallet for agent-to-agent transactions.",
		createWalletSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const { agentId, ...body } = args;
			const result = await context.client.post<unknown>(`/agents/${encodeURIComponent(agentId)}/wallet`, body);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"get_wallet",
		"Get wallet details for an agent including balance. Use this to check an agent's wallet status and balance.",
		agentIdSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/agents/${encodeURIComponent(args.agentId)}/wallet`);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"wallet_pay",
		"Send a payment from an agent's wallet. Use this to transfer funds to another agent or address.",
		walletPaySchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const { agentId, ...body } = args;
			const result = await context.client.post<unknown>(`/agents/${encodeURIComponent(agentId)}/wallet/pay`, body);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"wallet_x402_fetch",
		"Fetch a URL with automatic x402 payment negotiation via the agent's wallet API. Use this to access paid APIs and content.",
		x402FetchSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const { agentId, ...body } = args;
			const result = await context.client.post<unknown>(`/agents/${encodeURIComponent(agentId)}/wallet/x402-fetch`, body);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"wallet_transactions",
		"List wallet transactions for an agent. Use this to review payment history.",
		walletTransactionsSchema.shape,
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.status) params.set("status", args.status);
			const qs = params.toString();
			const path = `/agents/${encodeURIComponent(args.agentId)}/wallet/transactions${qs ? `?${qs}` : ""}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"freeze_wallet",
		"Freeze an agent's wallet to prevent transactions. Use this to temporarily disable payments.",
		agentIdSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>(`/agents/${encodeURIComponent(args.agentId)}/wallet/freeze`);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"unfreeze_wallet",
		"Unfreeze an agent's wallet to re-enable transactions. Use this to restore payment capability.",
		agentIdSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>(`/agents/${encodeURIComponent(args.agentId)}/wallet/unfreeze`);
			return toolSuccess(result);
		}, options.context),
	);
}
