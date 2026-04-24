import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	withErrorHandling,
	toolSuccess,
	requireMasterKeyGuard,
} from "../../../shared/index.js";

/**
 * Masks sensitive fields in a vault credential response.
 * Passwords, access tokens, and refresh tokens are replaced with "****".
 * Refresh tokens are omitted entirely.
 */
function maskCredentialFields(
	cred: Record<string, unknown>,
): Record<string, unknown> {
	const masked = { ...cred };

	if (masked.login && typeof masked.login === "object") {
		const login = { ...(masked.login as Record<string, unknown>) };
		if (login.password) login.password = "****";
		if (login.totp) login.totp = "****";
		masked.login = login;
	}

	if (masked.card && typeof masked.card === "object") {
		const card = { ...(masked.card as Record<string, unknown>) };
		if (card.code) card.code = "****";
		if (card.number && typeof card.number === "string") {
			card.number = "****" + (card.number as string).slice(-4);
		}
		masked.card = card;
	}

	if (masked.oauth && typeof masked.oauth === "object") {
		const oauth = { ...(masked.oauth as Record<string, unknown>) };
		if (oauth.accessToken) oauth.accessToken = "****";
		delete oauth.refreshToken;
		if (oauth.idToken) oauth.idToken = "****";
		masked.oauth = oauth;
	}

	if (masked.identity && typeof masked.identity === "object") {
		const identity = { ...(masked.identity as Record<string, unknown>) };
		if (identity.ssn) identity.ssn = "****";
		if (identity.passportNumber) identity.passportNumber = "****";
		if (identity.licenseNumber) identity.licenseNumber = "****";
		masked.identity = identity;
	}

	return masked;
}

const vaultCredentialTypeSchema = z.enum([
	"login",
	"secure_note",
	"card",
	"identity",
]);

const vaultProvisionSchema = z.object({
	agentId: z.string().describe("Agent ID to provision a vault for."),
});

const vaultDeprovisionSchema = z.object({
	agentId: z.string().describe("Agent ID to remove vault access for."),
});

const vaultListCredentialsSchema = z.object({
	agentId: z.string().optional().describe("Agent ID whose vault credentials should be listed. Optional when using an agent API key."),
	type: vaultCredentialTypeSchema
		.optional()
		.describe("Optional credential type filter."),
	search: z
		.string()
		.optional()
		.describe("Optional search text used to filter credential names and content."),
});

const vaultCredentialIdSchema = z.object({
	agentId: z.string().optional().describe("Agent ID that owns the credential. Optional when using an agent API key."),
	id: z.string().describe("Credential ID."),
});

const vaultUriSchema = z.object({
	uri: z.string().optional().describe("URI value."),
	match: z.string().optional().describe("Optional URI match mode."),
});

const vaultLoginSchema = z.object({
	username: z
		.string()
		.optional()
		.describe("Optional username associated with the login credential."),
	password: z
		.string()
		.optional()
		.describe("Optional password associated with the login credential."),
	uris: z
		.array(vaultUriSchema)
		.optional()
		.describe("Optional list of login URIs for this credential."),
	totp: z
		.string()
		.optional()
		.describe("Optional TOTP secret configured for this login credential."),
});

const vaultCardSchema = z.object({
	cardholderName: z.string().optional().describe("Optional cardholder name."),
	brand: z.string().optional().describe("Optional card brand."),
	number: z.string().optional().describe("Optional card number."),
	expMonth: z.string().optional().describe("Optional card expiration month."),
	expYear: z.string().optional().describe("Optional card expiration year."),
	code: z.string().optional().describe("Optional security code."),
});

const vaultIdentitySchema = z.object({
	title: z.string().optional().describe("Optional identity title."),
	firstName: z.string().optional().describe("Optional first name."),
	middleName: z.string().optional().describe("Optional middle name."),
	lastName: z.string().optional().describe("Optional last name."),
	address1: z.string().optional().describe("Optional address line 1."),
	address2: z.string().optional().describe("Optional address line 2."),
	address3: z.string().optional().describe("Optional address line 3."),
	city: z.string().optional().describe("Optional city."),
	state: z.string().optional().describe("Optional state or province."),
	postalCode: z.string().optional().describe("Optional postal code."),
	country: z.string().optional().describe("Optional country."),
	company: z.string().optional().describe("Optional company name."),
	email: z.string().optional().describe("Optional identity email address."),
	phone: z.string().optional().describe("Optional identity phone number."),
	ssn: z.string().optional().describe("Optional SSN or national ID."),
	username: z.string().optional().describe("Optional username value."),
	passportNumber: z.string().optional().describe("Optional passport number."),
	licenseNumber: z.string().optional().describe("Optional license number."),
});

const vaultFieldSchema = z.object({
	name: z.string().describe("Custom field name."),
	value: z.string().optional().describe("Optional custom field value."),
	type: z.string().optional().describe("Optional custom field type."),
	linkedId: z.string().optional().describe("Optional linked field identifier."),
});

const vaultCreateCredentialSchema = z.object({
	agentId: z.string().optional().describe("Agent ID that owns the new credential. Optional when using an agent API key."),
	type: vaultCredentialTypeSchema.describe("Credential type."),
	name: z.string().describe("Human-readable credential name."),
	login: vaultLoginSchema
		.optional()
		.describe("Optional login payload for login-type credentials."),
	card: vaultCardSchema
		.optional()
		.describe("Optional card payload for card-type credentials."),
	identity: vaultIdentitySchema
		.optional()
		.describe("Optional identity payload for identity-type credentials."),
	notes: z.string().optional().describe("Optional secure note text."),
	fields: z
		.array(vaultFieldSchema)
		.optional()
		.describe("Optional custom fields for the credential."),
	favorite: z
		.boolean()
		.optional()
		.describe("Optional favorite flag for quick access."),
});

const vaultUpdateCredentialSchema = z.object({
	agentId: z.string().optional().describe("Agent ID that owns the credential. Optional when using an agent API key."),
	id: z.string().describe("Credential ID to update."),
	name: z.string().optional().describe("Optional updated credential name."),
	login: vaultLoginSchema
		.optional()
		.describe("Optional updated login payload."),
	card: vaultCardSchema.optional().describe("Optional updated card payload."),
	identity: vaultIdentitySchema
		.optional()
		.describe("Optional updated identity payload."),
	notes: z.string().optional().describe("Optional updated secure note text."),
	fields: z
		.array(vaultFieldSchema)
		.optional()
		.describe("Optional updated custom fields."),
	favorite: z
		.boolean()
		.optional()
		.describe("Optional updated favorite flag."),
});

const vaultGeneratePasswordSchema = z.object({
	agentId: z.string().optional().describe("Agent ID requesting the password. Optional when using an agent API key."),
	length: z
		.number()
		.int()
		.positive()
		.optional()
		.default(32)
		.describe("Optional password length. Defaults to 32."),
	uppercase: z
		.boolean()
		.optional()
		.describe("Include uppercase letters when true."),
	lowercase: z
		.boolean()
		.optional()
		.describe("Include lowercase letters when true."),
	number: z
		.boolean()
		.optional()
		.describe("Include numeric characters when true."),
	special: z
		.boolean()
		.optional()
		.describe("Include special characters when true."),
});

const vaultStatusSchema = z.object({
	agentId: z.string().optional().describe("Agent ID to inspect vault status for. Optional when using an agent API key."),
});

export function registerVaultTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"vault_provision",
		{
			description: "Provision a vault for an agent so credentials can be securely stored and managed. Use this before creating vault credentials for a newly onboarded agent.",
			inputSchema: vaultProvisionSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>("/vault/provision", {
				agentId: args.agentId,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_deprovision",
		{
			description: "Deprovision an agent vault and remove its active vault assignment. Use this when retiring an agent or revoking vault access.",
			inputSchema: vaultDeprovisionSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>("/vault/deprovision", {
				agentId: args.agentId,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_list_credentials",
		{
			description: "List credentials in an agent vault with optional type and search filters. Use this to browse stored secrets before reading, updating, or deleting entries.",
			inputSchema: vaultListCredentialsSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			if (args.type) params.set("type", args.type);
			if (args.search) params.set("search", args.search);

			const result = await context.client.get<unknown>(
				`/vault/credentials?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_get_credential",
		{
			description: "Get a single vault credential by ID. Sensitive fields (passwords, tokens) are masked for security. Use vault_create_token with scope 'autofill' or 'proxy' to access raw credential data securely.",
			inputSchema: vaultCredentialIdSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			const path = `/vault/credentials/${encodeURIComponent(args.id)}?${params.toString()}`;
			const result = await context.client.get<Record<string, unknown>>(path);
			return toolSuccess(maskCredentialFields(result));
		}, options.context),
	);

	server.registerTool(
		"vault_create_credential",
		{
			description: "Create a new credential in an agent vault with login, card, identity, or secure note content. Use this to store new secrets for agent automation tasks.",
			inputSchema: vaultCreateCredentialSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/vault/credentials", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_update_credential",
		{
			description: "Update an existing vault credential by ID, including optional structured sections and metadata flags. Use this to rotate passwords or revise stored secret details.",
			inputSchema: vaultUpdateCredentialSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const { id, ...payload } = args;
			const path = `/vault/credentials/${encodeURIComponent(id)}`;
			// agentId is part of payload and sent in the body for PUT
			const result = await context.client.put<unknown>(path, payload);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_delete_credential",
		{
			description: "Delete a credential from vault storage by ID. Use this to remove obsolete or compromised secrets from an agent vault.",
			inputSchema: vaultCredentialIdSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const path = `/vault/credentials/${encodeURIComponent(args.id)}`;
			// oRPC DELETE reads agentId from request body
			const result = await context.client.delete<unknown>(path, { agentId: args.agentId });
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_generate_password",
		{
			description: "Generate a secure password using configurable character class options and length. Use this when creating or rotating login credentials in vault.",
			inputSchema: vaultGeneratePasswordSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				"/vault/generate-password",
				args,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_get_totp",
		{
			description: "Get the current TOTP code for a credential that has a TOTP secret configured. Use this for time-based one-time passcode login flows.",
			inputSchema: vaultCredentialIdSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			const path = `/vault/totp/${encodeURIComponent(args.id)}?${params.toString()}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	const vaultSearchSchema = z.object({
		agentId: z.string().optional().describe("Agent ID whose vault to search. Optional when using an agent API key."),
		search: z.string().describe("Search text to match against credential names and content."),
		type: vaultCredentialTypeSchema
			.optional()
			.describe("Optional credential type filter."),
	});

	server.registerTool(
		"vault_search",
		{
			description: "Search vault credentials by keyword across names and content. Use this for targeted credential lookup when you know part of the name, URL, or username.",
			inputSchema: vaultSearchSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			params.set("search", args.search);
			if (args.type) params.set("type", args.type);
			const result = await context.client.get<unknown>(
				`/vault/search?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	const vaultSyncSchema = z.object({
		agentId: z.string().optional().describe("Agent ID whose vault should be synced. Optional when using an agent API key."),
	});

	server.registerTool(
		"vault_sync",
		{
			description: "Force a sync of an agent's vault to ensure local and remote credential state are consistent. Use this after bulk credential changes or when stale data is suspected.",
			inputSchema: vaultSyncSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/vault/sync", {
				agentId: args.agentId,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_status",
		{
			description: "Get current vault status for an agent, including provisioning and readiness information. Use this to verify vault availability before secret operations.",
			inputSchema: vaultStatusSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			const result = await context.client.get<unknown>(
				`/vault/status?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	// -----------------------------------------------------------------------
	// Sharing tools
	// -----------------------------------------------------------------------

	const vaultShareSchema = z.object({
		agentId: z.string().describe("Source agent ID that owns the credential."),
		credentialId: z.string().describe("Credential ID to share."),
		targetAgentId: z.string().describe("Agent ID to share the credential with."),
		permission: z
			.enum(["READ", "USE", "MANAGE"])
			.describe("Permission level for the share."),
		expiresInSeconds: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Optional TTL in seconds for the share."),
	});

	server.registerTool(
		"vault_share_credential",
		{
			description: "Share a vault credential with another agent at a specified permission level. Use this to grant cross-agent access to secrets for collaborative workflows.",
			inputSchema: vaultShareSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/vault/share", args);
			return toolSuccess(result);
		}, options.context),
	);

	const vaultListSharesSchema = z.object({
		agentId: z.string().optional().describe("Agent ID to list shares for. Optional when using an agent API key."),
		direction: z
			.enum(["granted", "received"])
			.describe("Whether to list shares this agent has granted or received."),
	});

	server.registerTool(
		"vault_list_shares",
		{
			description: "List credential shares granted by or received by an agent. Use this to audit cross-agent secret access.",
			inputSchema: vaultListSharesSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			params.set("direction", args.direction);
			const result = await context.client.get<unknown>(
				`/vault/shares?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	const vaultRevokeShareSchema = z.object({
		shareId: z.string().describe("Share ID to revoke."),
		agentId: z.string().optional().describe("Agent ID that owns the share. Optional when using an agent API key."),
	});

	server.registerTool(
		"vault_revoke_share",
		{
			description: "Revoke a previously granted credential share by share ID. Use this to remove cross-agent access when it is no longer needed.",
			inputSchema: vaultRevokeShareSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				"/vault/share/revoke",
				args,
			);
			return toolSuccess(result);
		}, options.context),
	);

	// -----------------------------------------------------------------------
	// Ephemeral token tools
	// -----------------------------------------------------------------------

	const vaultCreateTokenSchema = z.object({
		agentId: z.string().optional().describe("Agent ID that owns the credential. Optional when using an agent API key."),
		credentialId: z
			.string()
			.describe("Credential ID to create an ephemeral token for."),
		scope: z
			.enum(["autofill", "proxy", "export"])
			.describe(
				"Token scope: autofill for CLI/extension injection, proxy for delegated access, export for one-time reveal.",
			),
		ttlSeconds: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Optional TTL in seconds (10–3600, default 60)."),
	});

	server.registerTool(
		"vault_create_token",
		{
			description: "Create a short-lived ephemeral token for a credential. The vtk_ token can be used in commands for CLI/extension auto-fill without exposing the raw secret to the LLM.",
			inputSchema: vaultCreateTokenSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/vault/token", args);
			return toolSuccess(result);
		}, options.context),
	);

	const vaultExchangeTokenSchema = z.object({
		token: z
			.string()
			.describe(
				"The vtk_ ephemeral token to exchange for credential data. Single-use.",
			),
	});

	server.registerTool(
		"vault_exchange_token",
		{
			description: "Exchange a vtk_ ephemeral token for the underlying credential data. Tokens are single-use and consumed on exchange. No auth header required.",
			inputSchema: vaultExchangeTokenSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				"/vault/token/exchange",
				args,
			);
			return toolSuccess(result);
		}, options.context),
	);

	const vaultRevokeTokensSchema = z.object({
		agentId: z.string().optional().describe("Agent ID that owns the credential. Optional when using an agent API key."),
		credentialId: z
			.string()
			.describe("Credential ID whose tokens should be revoked."),
	});

	server.registerTool(
		"vault_revoke_tokens",
		{
			description: "Revoke all active ephemeral tokens for a credential. Use this to invalidate outstanding vtk_ tokens after a security event or credential rotation.",
			inputSchema: vaultRevokeTokensSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				"/vault/token/revoke",
				args,
			);
			return toolSuccess(result);
		}, options.context),
	);

	// -----------------------------------------------------------------------
	// Zero-knowledge execution primitives (v0.5+)
	//
	// These tools match the CLI surface (am vault exec / audit / reload /
	// unlock / proxy / agent). The contract is ORCHESTRATION-ONLY: the LLM
	// names which credential goes where, but resolution and substitution
	// happen in a trusted process (the CLI or daemon). Plaintext is never
	// returned to the LLM.
	// -----------------------------------------------------------------------

	const vaultReloadSchema = z.object({
		agentId: z.string().optional().describe("Agent ID whose snapshot should be reloaded. Optional with an agent API key."),
	});
	server.registerTool(
		"vault_reload",
		{
			description: "Force the server-side vault snapshot to refresh from its backing store. Use after a secret has been rotated at the provider so the next access sees the new value. Atomic swap — last-known-good stays active if the refresh fails.",
			inputSchema: vaultReloadSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/vault/reload", args);
			return toolSuccess(result);
		}, options.context),
	);

	const vaultPlanExecSchema = z.object({
		agentId: z.string().optional().describe("Agent ID whose credentials to resolve. Optional with agent API key."),
		command: z.string().describe("The command to run (e.g. 'node', 'python', './deploy.sh'). Never includes secrets."),
		args: z.array(z.string()).optional().describe("Arguments to pass to the command. Must NOT contain plaintext secrets — use envBindings instead."),
		envBindings: z
			.record(z.string(), z.object({
				credentialId: z.string(),
				field: z.string().describe("Dotted path, e.g. 'login.password', 'apiKey.key'."),
			}))
			.describe(
				"Map of env-var-name -> credential ref. The CLI resolves these and injects them into the child process env. The LLM never sees the resolved values.",
			),
	});
	server.registerTool(
		"vault_plan_exec",
		{
			description: "Plan a credential-injected subprocess run. Returns a plan the CLI (or orchestrator) can apply via `am vault exec` — the LLM describes which credentials go into which env vars, and a trusted local process does the resolution. This tool does NOT itself run anything; it's an orchestration primitive so the LLM can express intent without ever receiving plaintext.",
			inputSchema: vaultPlanExecSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/vault/plan/exec", args);
			return toolSuccess(result);
		}, options.context),
	);

	const vaultPlanProxySchema = z.object({
		agentId: z.string().optional().describe("Agent ID. Optional with agent API key."),
		credentialId: z.string().describe("Credential ID to inject into outbound requests."),
		field: z.string().default("apiKey.key").describe("Dotted field path to use as the secret value."),
		allowHosts: z.array(z.string()).min(1).describe("Whitelist of hostnames the proxy may forward to. Required — refusing open proxies."),
		header: z.string().default("Authorization").describe("Header name to inject (default: Authorization)."),
		scheme: z.string().default("Bearer ").describe("Prefix for the header value (default: 'Bearer ')."),
		ttlSeconds: z.number().int().positive().max(86400).default(3600).describe("How long the proxy authorization is valid."),
	});
	server.registerTool(
		"vault_plan_proxy",
		{
			description: "Plan a local HTTPS proxy that injects a vault credential into outbound requests to an allowlist of hosts. Returns a planId the caller can pass to `am vault proxy --plan <id>`. The LLM specifies intent (which credential, which hosts, which header); a trusted local process does the injection. The LLM never receives the secret value.",
			inputSchema: vaultPlanProxySchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/vault/plan/proxy", args);
			return toolSuccess(result);
		}, options.context),
	);

	const vaultAuditQuerySchema = z.object({
		agentId: z.string().optional().describe("Agent ID whose audit trail to query. Optional with agent API key."),
		credentialId: z.string().optional().describe("Filter by credential."),
		action: z
			.enum(["access", "access_reveal", "create", "update", "delete", "share", "token_create", "token_exchange", "token_revoke"])
			.optional()
			.describe("Filter by audit action type."),
		since: z.string().optional().describe("ISO-8601 timestamp — only return entries on or after this time."),
		limit: z.number().int().positive().max(200).optional().default(50),
	});
	server.registerTool(
		"vault_audit_query",
		{
			description: "Query the vault audit log for a credential or agent. Use this to surface every access (including plaintext reveals via master key) with timestamps and actor metadata. Safe for LLM consumption — the audit log itself contains no plaintext secrets.",
			inputSchema: vaultAuditQuerySchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>("/vault/audit", args as Record<string, unknown>);
			return toolSuccess(result);
		}, options.context),
	);
}
