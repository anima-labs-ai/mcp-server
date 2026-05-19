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

const domainAddSchema = z.object({
	domain: z
		.string()
		.describe("Domain name to add, such as mail.example.com or example.com."),
});

const domainIdSchema = z.object({
	id: z.string().describe("Unique domain ID."),
});

const domainListSchema = z.object({
	cursor: z.string().optional().describe("Pagination cursor from a previous list response."),
	limit: z.number().int().positive().optional().describe("Max domains to return."),
});

export function registerDomainTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"domain_add",
		{
			title: "Add Domain",
			description: "Add a custom sending domain to the workspace so it can be configured for email traffic. Use this before DNS setup and verification.",
			inputSchema: domainAddSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>("/v1/domains", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"domain_verify",
		{
			title: "Verify Domain",
			description: "Trigger a verification check for a domain after DNS records are configured. Use this to re-run DNS validation and update verification status.",
			inputSchema: domainIdSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const path = `/v1/domains/${encodeURIComponent(args.id)}/verify`;
			const result = await context.client.post<unknown>(path, {});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"domain_get",
		{
			title: "Get Domain",
			description:
				"Fetch full detail for a single domain by ID, including verification and configuration state. Use domain_list to browse all domains.",
			inputSchema: domainIdSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/domains/${encodeURIComponent(args.id)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"domain_list",
		{
			title: "List Domains",
			description:
				"List all domains connected to the current workspace. Use this to audit configured sender domains and choose one for follow-up actions.",
			inputSchema: domainListSchema.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			const path = params.toString() ? `/v1/domains?${params}` : "/v1/domains";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"domain_delete",
		{
			title: "Delete Domain",
			description: "Delete a domain from the workspace when it is no longer needed. Use this to remove old or incorrect domain configurations.",
			inputSchema: domainIdSchema.shape,
			outputSchema: deleteOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const path = `/v1/domains/${encodeURIComponent(args.id)}`;
			const result = await context.client.delete<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	const domainUpdateSchema = z.object({
		id: z.string().describe("Unique domain ID."),
		catchAll: z
			.boolean()
			.optional()
			.describe("Enable or disable catch-all for this domain."),
		autoVerify: z
			.boolean()
			.optional()
			.describe("Enable or disable automatic verification."),
	});

	server.registerTool(
		"domain_update",
		{
			title: "Update Domain",
			description: "Update configuration for a domain, such as catch-all behavior or auto-verify settings. Use this to adjust domain behavior after initial setup.",
			inputSchema: domainUpdateSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const { id, ...payload } = args;
			const path = `/v1/domains/${encodeURIComponent(id)}`;
			const result = await context.client.patch<unknown>(path, payload);
			return toolSuccess(result);
		}, options.context),
	);


	server.registerTool(
		"domain_zone_file",
		{
			title: "Domain Zone File",
			description: "Get the full DNS zone file for a domain. Use this for complete DNS export or to verify all records are correctly configured.",
			inputSchema: domainIdSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/domains/${encodeURIComponent(args.id)}/zone-file`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);
}
