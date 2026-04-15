import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import { withErrorHandling, toolSuccess } from "../../../shared/index.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null
		? (value as UnknownRecord)
		: undefined;
}

const processInvoiceSchema = z.object({
	invoice_id: z.string().describe("Invoice ID to process"),
	confirm: z
		.boolean()
		.optional()
		.default(false)
		.describe("Set to true to confirm the invoice (change status from detected to confirmed)"),
	create_card: z
		.boolean()
		.optional()
		.default(false)
		.describe("Set to true to auto-create a payee-locked virtual card for this invoice"),
	dry_run: z
		.boolean()
		.optional()
		.default(true)
		.describe("When true, validate and return what would happen without making changes. Defaults to true for safety."),
});

const autoPayInvoiceSchema = z.object({
	invoice_id: z.string().describe("Invoice ID to auto-pay"),
	dry_run: z
		.boolean()
		.optional()
		.default(true)
		.describe("When true, show payment plan without executing. Defaults to true for safety."),
});

const reconcilePaymentsSchema = z.object({
	receipt_ids: z
		.array(z.string())
		.optional()
		.describe("Optional specific receipt IDs to reconcile. If omitted, reconciles all unmatched receipts."),
	invoice_ids: z
		.array(z.string())
		.optional()
		.describe("Optional invoice IDs to match against. If omitted, matches against all paid invoices."),
	auto_link_threshold: z
		.number()
		.min(0)
		.max(1)
		.optional()
		.default(0.7)
		.describe("Confidence threshold for auto-linking matches. Default 0.7."),
	dry_run: z
		.boolean()
		.optional()
		.default(true)
		.describe("When true, show matches without linking. Defaults to true for safety."),
});

export function registerInvoiceTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"invoice_process",
		"Process a detected invoice — validate fields, confirm the invoice, and optionally create a payee-locked card. Use dry_run=true to preview without making changes.",
		processInvoiceSchema.shape,
		withErrorHandling(async (args, context) => {
			const shouldConfirm = args.confirm ?? false;
			const shouldCreateCard = args.create_card ?? false;
			const dryRun = args.dry_run ?? true;
			const invoicePath = `/invoices/${encodeURIComponent(args.invoice_id)}`;
			const invoice = await context.client.get<unknown>(invoicePath);

			if (dryRun) {
				return toolSuccess({
					dryRun: true,
					invoiceId: args.invoice_id,
					invoice,
					actions: {
						confirm: shouldConfirm,
						createCard: shouldCreateCard,
					},
				});
			}

			let confirmedInvoice: unknown = null;
			let createdCard: unknown = null;

			if (shouldConfirm) {
				confirmedInvoice = await context.client.patch<unknown>(invoicePath, {
					status: "confirmed",
				});
			}

			if (shouldCreateCard) {
				createdCard = await context.client.post<unknown>(`${invoicePath}/card`, {});
			}

			return toolSuccess({
				dryRun: false,
				invoiceId: args.invoice_id,
				invoice,
				actions: {
					confirm: shouldConfirm,
					createCard: shouldCreateCard,
				},
				confirmedInvoice,
				createdCard,
			});
		}, options.context),
	);

	server.tool(
		"invoice_auto_pay",
		"Trigger auto-payment for a confirmed invoice. Enqueues a payment job that will select the optimal payment path (browser extension or direct API) and handle retries.",
		autoPayInvoiceSchema.shape,
		withErrorHandling(async (args, context) => {
			const dryRun = args.dry_run ?? true;
			const invoicePath = `/invoices/${encodeURIComponent(args.invoice_id)}`;

			if (dryRun) {
				const invoice = await context.client.get<unknown>(invoicePath);
				const invoiceRecord = asRecord(invoice);

				return toolSuccess({
					dryRun: true,
					invoiceId: args.invoice_id,
					invoice,
					paymentPlan: {
						amount:
							invoiceRecord?.amount ??
							invoiceRecord?.amountCents ??
							invoiceRecord?.total ??
							invoiceRecord?.totalAmount,
						currency: invoiceRecord?.currency,
						card: invoiceRecord?.card ?? invoiceRecord?.cardInfo ?? invoiceRecord?.paymentCard,
					},
				});
			}

			const result = await context.client.post<unknown>(`${invoicePath}/auto-pay`, {});
			return toolSuccess({
				invoiceId: args.invoice_id,
				status: "queued",
				queued: true,
				result,
			});
		}, options.context),
	);

	server.tool(
		"invoice_reconcile",
		"Match payment receipts against invoices using amount, time, vendor, and order ID signals. Returns confidence scores and auto-links high-confidence matches.",
		reconcilePaymentsSchema.shape,
		withErrorHandling(async (args, context) => {
			const autoLinkThreshold = args.auto_link_threshold ?? 0.7;
			const dryRun = args.dry_run ?? true;
			const body: {
				receipts: string[];
				invoiceIds?: string[];
				autoLinkThreshold: number;
				dryRun?: true;
			} = {
				receipts: args.receipt_ids ?? [],
				autoLinkThreshold,
			};

			if (args.invoice_ids) {
				body.invoiceIds = args.invoice_ids;
			}

			if (dryRun) {
				body.dryRun = true;
			}

			const result = await context.client.post<unknown>("/invoices/match-receipts", body);
			return toolSuccess(result);
		}, options.context),
	);
}
