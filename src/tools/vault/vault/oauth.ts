/**
 * OAuth MCP Tools — Expose OAuth management through MCP for agents.
 *
 * Tools:
 *   vault_oauth_list_apps    — Browse available OAuth services
 *   vault_oauth_create_link  — Generate a Connect Link for authentication
 *   vault_oauth_link_status  — Check if a Connect Link has been completed
 *   vault_oauth_list_accounts — List connected OAuth accounts
 *   vault_oauth_disconnect   — Disconnect an OAuth account
 *   vault_oauth_require_auth — Check auth status + get Connect Link if needed
 */

import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import { withErrorHandling, toolSuccess } from "../../../shared/index.js";

export function registerOAuthTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"vault_oauth_list_apps",
		{
			title: "List Vault OAuth Apps",
			description: "List available OAuth services that agents can connect to. Shows service name, auth method, default scopes, and category. Use this to discover which services support managed authentication.",
			inputSchema: {
			category: z
				.string()
				.optional()
				.describe("Filter by category (productivity, developer, communication, crm, etc.)"),
		},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.category) params.set("category", args.category);
			const qs = params.toString();
			const result = await context.client.get<unknown>(
				`/v1/vault/oauth/apps${qs ? `?${qs}` : ""}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_oauth_create_link",
		{
			title: "Create Vault OAuth Link",
			description: "Create a Connect Link — a hosted URL where a user can authenticate with an OAuth service. Share this link with the user; once they complete authentication, their tokens are stored securely in the vault.",
			inputSchema: {
			agentId: z
				.string()
				.optional()
				.describe("Agent ID. Optional with agent API key."),
			appSlug: z
				.string()
				.describe("Service slug (e.g. google, github, slack). Use vault_oauth_list_apps to see available options."),
			userId: z
				.string()
				.optional()
				.describe("End-user ID for multi-tenant scoping."),
			scopes: z
				.array(z.string())
				.optional()
				.describe("Override default scopes. Omit to use the service's defaults."),
			callbackUrl: z
				.string()
				.optional()
				.describe("URL to redirect to after authentication completes."),
		},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				"/v1/vault/oauth/link",
				args,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_oauth_link_status",
		{
			title: "Vault OAuth Link Status",
			description: "Check the status of a Connect Link. Poll this after creating a link to know when the user has completed authentication. Returns PENDING, COMPLETED, EXPIRED, or FAILED.",
			inputSchema: {
			token: z
				.string()
				.describe("The Connect Link token returned by vault_oauth_create_link."),
		},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(
				`/v1/vault/oauth/link/${encodeURIComponent(args.token)}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_oauth_list_accounts",
		{
			title: "List Vault OAuth Accounts",
			description: "List all connected OAuth accounts for an agent, optionally filtered by user or service. Shows connection status, granted scopes, and token expiry.",
			inputSchema: {
			agentId: z
				.string()
				.optional()
				.describe("Agent ID. Optional with agent API key."),
			userId: z
				.string()
				.optional()
				.describe("Filter by end-user ID."),
			appSlug: z
				.string()
				.optional()
				.describe("Filter by service slug (e.g. google, slack)."),
			status: z
				.enum(["PENDING", "ACTIVE", "EXPIRED", "REFRESHING", "FAILED", "REVOKED"])
				.optional()
				.describe("Filter by connection status."),
		},
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			if (args.userId) params.set("userId", args.userId);
			if (args.appSlug) params.set("appSlug", args.appSlug);
			if (args.status) params.set("status", args.status);
			const qs = params.toString();
			const result = await context.client.get<unknown>(
				`/v1/vault/oauth/accounts${qs ? `?${qs}` : ""}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_oauth_disconnect",
		{
			title: "Vault OAuth Disconnect",
			description: "Disconnect an OAuth account, revoking access and deleting stored tokens. Use this when an agent no longer needs access to a service.",
			inputSchema: {
			agentId: z
				.string()
				.optional()
				.describe("Agent ID. Optional with agent API key."),
			accountId: z
				.string()
				.describe("Connected account ID to disconnect."),
		},
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.delete<unknown>(
				`/v1/vault/oauth/accounts/${encodeURIComponent(args.accountId)}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_oauth_require_auth",
		{
			title: "Vault OAuth Require Auth",
			description: "Check if a service is authenticated for an agent/user. If authenticated, returns the connected account. If not, generates and returns a Connect Link URL. Use this for inline auth — present the link to the user when they need to connect a service.",
			inputSchema: {
			agentId: z
				.string()
				.optional()
				.describe("Agent ID. Optional with agent API key."),
			userId: z
				.string()
				.optional()
				.describe("End-user ID for multi-tenant scoping."),
			appSlug: z
				.string()
				.describe("Service slug to check (e.g. google, github, slack)."),
		},
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				"/v1/vault/oauth/require-auth",
				args,
			);
			return toolSuccess(result);
		}, options.context),
	);
}
