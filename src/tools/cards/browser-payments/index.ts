import { z } from "zod";
import {
	withErrorHandling,
	toolSuccess,
	type ToolRegistrationOptions,
} from "../../../shared/index.js";

const detectCheckoutSchema = z.object({
	tabId: z.number().optional(),
});

const payCheckoutSchema = z.object({
	cardId: z.string(),
	amount: z.number().optional(),
	currency: z.string().optional(),
});

const fillCardSchema = z.object({
	cardId: z.string(),
	tabId: z.number().optional(),
});

const fillAddressSchema = z.object({
	addressType: z.enum(["billing", "shipping"]).default("billing"),
	tabId: z.number().optional(),
});

export function registerBrowserPaymentsTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"browser_detect_checkout",
		{
			description: "Detect checkout forms on the current browser page.",
			inputSchema: detectCheckoutSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/internal/extension/tool-call", {
				tool: "detect_checkout",
				args,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"browser_pay_checkout",
		{
			description: "Execute payment on a detected checkout form.",
			inputSchema: payCheckoutSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/internal/extension/tool-call", {
				tool: "pay_checkout",
				args,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"browser_fill_card",
		{
			description: "Fill card details into checkout form fields.",
			inputSchema: fillCardSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/internal/extension/tool-call", {
				tool: "fill_card",
				args,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"browser_fill_address",
		{
			description: "Fill billing or shipping address into checkout form fields.",
			inputSchema: fillAddressSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/internal/extension/tool-call", {
				tool: "fill_address",
				args,
			});
			return toolSuccess(result);
		}, options.context),
	);
}
