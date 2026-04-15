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

	server.tool(
		"vault_provision",
		"Provision a vault for an agent so credentials can be securely stored and managed. Use this before creating vault credentials for a newly onboarded agent.",
		vaultProvisionSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>("/vault/provision", {
				agentId: args.agentId,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"vault_deprovision",
		"Deprovision an agent vault and remove its active vault assignment. Use this when retiring an agent or revoking vault access.",
		vaultDeprovisionSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>("/vault/deprovision", {
				agentId: args.agentId,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"vault_list_credentials",
		"List credentials in an agent vault with optional type and search filters. Use this to browse stored secrets before reading, updating, or deleting entries.",
		vaultListCredentialsSchema.shape,
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

	server.tool(
		"vault_get_credential",
		"Get a single vault credential by ID. Sensitive fields (passwords, tokens) are masked for security. Use vault_create_token with scope 'autofill' or 'proxy' to access raw credential data securely.",
		vaultCredentialIdSchema.shape,
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			const path = `/vault/credentials/${encodeURIComponent(args.id)}?${params.toString()}`;
			const result = await context.client.get<Record<string, unknown>>(path);
			return toolSuccess(maskCredentialFields(result));
		}, options.context),
	);

	server.tool(
		"vault_create_credential",
		"Create a new credential in an agent vault with login, card, identity, or secure note content. Use this to store new secrets for agent automation tasks.",
		vaultCreateCredentialSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/vault/credentials", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"vault_update_credential",
		"Update an existing vault credential by ID, including optional structured sections and metadata flags. Use this to rotate passwords or revise stored secret details.",
		vaultUpdateCredentialSchema.shape,
		withErrorHandling(async (args, context) => {
			const { id, ...payload } = args;
			const path = `/vault/credentials/${encodeURIComponent(id)}`;
			// agentId is part of payload and sent in the body for PUT
			const result = await context.client.put<unknown>(path, payload);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"vault_delete_credential",
		"Delete a credential from vault storage by ID. Use this to remove obsolete or compromised secrets from an agent vault.",
		vaultCredentialIdSchema.shape,
		withErrorHandling(async (args, context) => {
			const path = `/vault/credentials/${encodeURIComponent(args.id)}`;
			// oRPC DELETE reads agentId from request body
			const result = await context.client.delete<unknown>(path, { agentId: args.agentId });
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"vault_generate_password",
		"Generate a secure password using configurable character class options and length. Use this when creating or rotating login credentials in vault.",
		vaultGeneratePasswordSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				"/vault/generate-password",
				args,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"vault_get_totp",
		"Get the current TOTP code for a credential that has a TOTP secret configured. Use this for time-based one-time passcode login flows.",
		vaultCredentialIdSchema.shape,
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

	server.tool(
		"vault_search",
		"Search vault credentials by keyword across names and content. Use this for targeted credential lookup when you know part of the name, URL, or username.",
		vaultSearchSchema.shape,
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

	server.tool(
		"vault_sync",
		"Force a sync of an agent's vault to ensure local and remote credential state are consistent. Use this after bulk credential changes or when stale data is suspected.",
		vaultSyncSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/vault/sync", {
				agentId: args.agentId,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"vault_status",
		"Get current vault status for an agent, including provisioning and readiness information. Use this to verify vault availability before secret operations.",
		vaultStatusSchema.shape,
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

	server.tool(
		"vault_share_credential",
		"Share a vault credential with another agent at a specified permission level. Use this to grant cross-agent access to secrets for collaborative workflows.",
		vaultShareSchema.shape,
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

	server.tool(
		"vault_list_shares",
		"List credential shares granted by or received by an agent. Use this to audit cross-agent secret access.",
		vaultListSharesSchema.shape,
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

	server.tool(
		"vault_revoke_share",
		"Revoke a previously granted credential share by share ID. Use this to remove cross-agent access when it is no longer needed.",
		vaultRevokeShareSchema.shape,
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

	server.tool(
		"vault_create_token",
		"Create a short-lived ephemeral token for a credential. The vtk_ token can be used in commands for CLI/extension auto-fill without exposing the raw secret to the LLM.",
		vaultCreateTokenSchema.shape,
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

	server.tool(
		"vault_exchange_token",
		"Exchange a vtk_ ephemeral token for the underlying credential data. Tokens are single-use and consumed on exchange. No auth header required.",
		vaultExchangeTokenSchema.shape,
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

	server.tool(
		"vault_revoke_tokens",
		"Revoke all active ephemeral tokens for a credential. Use this to invalidate outstanding vtk_ tokens after a security event or credential rotation.",
		vaultRevokeTokensSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>(
				"/vault/token/revoke",
				args,
			);
			return toolSuccess(result);
		}, options.context),
	);
}
