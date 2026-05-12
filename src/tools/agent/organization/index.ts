import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	withErrorHandling,
	toolSuccess,
	requireMasterKeyGuard,
} from "../../../shared/index.js";

const orgCreateInput = z.object({
	name: z.string().describe("Organization name"),
	metadata: z
		.record(z.string())
		.optional()
		.describe("Optional organization metadata as key-value string pairs"),
});

const orgGetInput = z.object({
	id: z.string().describe("Organization ID"),
});

const orgUpdateInput = z.object({
	id: z.string().describe("Organization ID"),
	name: z.string().optional().describe("Updated organization name"),
	metadata: z
		.record(z.string())
		.optional()
		.describe("Updated metadata as key-value string pairs"),
});

const orgDeleteInput = z.object({
	id: z.string().describe("Organization ID"),
});

const orgRotateKeyInput = z.object({
	id: z.string().describe("Organization ID"),
});

const orgListInput = z.object({
	cursor: z.string().optional().describe("Pagination cursor from a previous response"),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Maximum number of organizations to return"),
});

function registerOrgCreateTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"org_create",
		{
			title: "Create Org",
			description: "Create a new organization and return its details, including credentials when available. Use this when onboarding a new tenant and ensure a master key is configured.",
			inputSchema: orgCreateInput.shape,
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post("/v1/orgs", args, {
				useMasterKey: true,
			});
			return toolSuccess(result);
		}, options.context),
	);
}

function registerOrgGetTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"org_get",
		{
			title: "Get Org",
			description: "Fetch one organization by ID. Use this to inspect current organization configuration and metadata.",
			inputSchema: orgGetInput.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get(`/v1/orgs/${args.id}`);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerOrgUpdateTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"org_update",
		{
			title: "Update Org",
			description: "Update organization name or metadata fields. Use this when organization settings need to be corrected or renamed.",
			inputSchema: orgUpdateInput.shape,
		},
		withErrorHandling(async (args, context) => {
			const { id, ...body } = args;
			const result = await context.client.patch(`/v1/orgs/${id}`, body);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerOrgDeleteTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"org_delete",
		{
			title: "Delete Org",
			description: "Delete an organization permanently by ID. Use this only for irreversible cleanup and requires master key access.",
			inputSchema: orgDeleteInput.shape,
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.delete(`/v1/orgs/${args.id}`, {
				useMasterKey: true,
			});
			return toolSuccess(result);
		}, options.context),
	);
}

function registerOrgRotateKeyTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"org_rotate_key",
		{
			title: "Rotate Org Key",
			description: "Rotate the API key for an organization and return the new credential material. Use this when keys are compromised or part of regular security rotation.",
			inputSchema: orgRotateKeyInput.shape,
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post(`/v1/orgs/${args.id}/rotate-key`, undefined, {
				useMasterKey: true,
			});
			return toolSuccess(result);
		}, options.context),
	);
}

function registerOrgListTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"org_list",
		{
			title: "List Org",
			description: "List organizations with optional cursor pagination. Use this to browse all tenants and audit organization inventory; requires master key.",
			inputSchema: orgListInput.shape,
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const params = new URLSearchParams();
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit) params.set("limit", String(args.limit));
			const path = params.toString() ? `/v1/orgs?${params.toString()}` : "/v1/orgs";
			const result = await context.client.get(path, { useMasterKey: true });
			return toolSuccess(result);
		}, options.context),
	);
}

export function registerOrganizationTools(options: ToolRegistrationOptions): void {
	registerOrgCreateTool(options);
	registerOrgGetTool(options);
	registerOrgUpdateTool(options);
	registerOrgDeleteTool(options);
	registerOrgRotateKeyTool(options);
	registerOrgListTool(options);
}
