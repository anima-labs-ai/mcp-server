import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	deleteOutput,
	listOutput,
	objectOutput,
	toolSuccess,
	withErrorHandling,
} from "../../../shared/index.js";

// 2026-05-20: vault group reduced to 7 credential-CRUD-plus-power tools.
// Dropped from prior surface (28 → 7): vault_provision, vault_deprovision
// (org-level lifecycle), vault_generate_password (utility), vault_sync,
// vault_status (admin-y), vault_share_credential, vault_list_shares,
// vault_revoke_share (sharing), vault_create_token, vault_exchange_token,
// vault_revoke_tokens (token issuance), vault_reload, vault_plan_exec,
// vault_plan_proxy, vault_audit_query (operator), plus the 6 OAuth tools
// (vault_oauth_*) in the deleted oauth.ts file. Naming normalized to
// resource_action: vault_get_credential → vault_credential_get.
// Hosted-only difference vs npm: agentId is OPTIONAL on every input
// because the agent-bound oat_* / ak_* credential context can resolve it
// implicitly. npm requires explicit agentId because static keys have no
// implicit agent.

const MASK = "****";

/**
 * Mask an API key like the server does: keep the identifying prefix
 * (sk_, ak_, ...) and last 4 chars. Idempotent on an already-masked
 * "sk_****abcd".
 */
function maskApiKeyValue(key: string): string {
	const prefix = key.match(/^([a-z]{1,6}[_-])/i)?.[1] ?? "";
	if (key.length <= prefix.length + 4) return `${prefix}${MASK}`;
	return `${prefix}${MASK}${key.slice(-4)}`;
}

type CredentialSection = Record<string, unknown>;

/**
 * Per-section maskers, mirroring the API's server-side masker (anima
 * monorepo, packages/vault/src/credential-masking.ts) — same sections,
 * same fields. Each mutates the section COPY handed to it.
 */
const SECTION_MASKERS: Record<string, (section: CredentialSection) => void> = {
	login: (login) => {
		if (login.password) login.password = MASK;
		if (login.totp) login.totp = MASK;
	},
	card: (card) => {
		if (card.code) card.code = MASK;
		if (card.number && typeof card.number === "string") {
			card.number = `${MASK}${card.number.slice(-4)}`;
		}
	},
	oauthToken: (oauth) => {
		delete oauth.refreshToken; // never returned, not even masked
		if (oauth.accessToken) oauth.accessToken = MASK;
		if (oauth.idToken) oauth.idToken = MASK;
		if (oauth.clientSecret) oauth.clientSecret = MASK;
	},
	apiKey: (apiKey) => {
		if (apiKey.key && typeof apiKey.key === "string") {
			apiKey.key = maskApiKeyValue(apiKey.key);
		}
	},
	certificate: (certificate) => {
		// The certificate itself and its chain are public material.
		if (certificate.privateKey) certificate.privateKey = MASK;
	},
	identity: (identity) => {
		if (identity.ssn) identity.ssn = MASK;
		if (identity.passportNumber) identity.passportNumber = MASK;
		if (identity.licenseNumber) identity.licenseNumber = MASK;
	},
};

/**
 * Masks sensitive fields in a vault credential response.
 * Invariant: "LLMs never see plaintext through tools." Callers that need
 * plaintext use the autofill/proxy token flow at the credential-broker.
 * Idempotent over already-masked values, so it can safely re-run on
 * responses the API has already masked. Exported for tests.
 */
export function maskCredentialFields(
	cred: Record<string, unknown>,
): Record<string, unknown> {
	const masked = { ...cred };
	for (const [field, maskSection] of Object.entries(SECTION_MASKERS)) {
		const value = masked[field];
		if (value && typeof value === "object") {
			const section = { ...(value as CredentialSection) };
			maskSection(section);
			masked[field] = section;
		}
	}
	return masked;
}

const vaultCredentialTypeSchema = z.enum([
	"login",
	"secure_note",
	"card",
	"identity",
]);

const vaultUriSchema = z.object({
	uri: z.string().optional().describe("URI value."),
	match: z.string().optional().describe("Optional URI match mode."),
});

const vaultLoginSchema = z.object({
	username: z.string().optional().describe("Optional login username."),
	password: z.string().optional().describe("Optional login password."),
	uris: z.array(vaultUriSchema).optional().describe("Optional list of login URIs."),
	totp: z.string().optional().describe("Optional TOTP secret."),
});

const vaultGeneratePasswordSchema = z.object({
	length: z
		.number()
		.int()
		.min(8)
		.max(128)
		.optional()
		.describe("Desired password length (8-128 characters, default 24)."),
	uppercase: z.boolean().optional().describe("Include uppercase letters (default true)."),
	lowercase: z.boolean().optional().describe("Include lowercase letters (default true)."),
	number: z.boolean().optional().describe("Include numeric digits (default true)."),
	special: z.boolean().optional().describe("Include special characters (default true)."),
});

const vaultCardSchema = z.object({
	cardholderName: z.string().optional().describe("Optional cardholder name."),
	brand: z.string().optional().describe("Optional card brand."),
	number: z.string().optional().describe("Optional card number."),
	expMonth: z.string().optional().describe("Optional expiration month."),
	expYear: z.string().optional().describe("Optional expiration year."),
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
	email: z.string().optional().describe("Optional identity email."),
	phone: z.string().optional().describe("Optional identity phone."),
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

const vaultListInput = z.object({
	agentId: z
		.string()
		.optional()
		.describe(
			"Agent ID whose vault to list. Optional when using an agent-bound credential (ak_* or oat_* with agentId).",
		),
	type: vaultCredentialTypeSchema
		.optional()
		.describe("Optional credential type filter."),
});

const vaultIdInput = z.object({
	agentId: z
		.string()
		.optional()
		.describe(
			"Agent ID that owns the credential. Optional when using an agent-bound credential.",
		),
	id: z.string().describe("Credential ID."),
});

const vaultCreateInput = z.object({
	agentId: z
		.string()
		.optional()
		.describe(
			"Agent ID that owns the new credential. Optional when using an agent-bound credential.",
		),
	type: vaultCredentialTypeSchema.describe("Credential type."),
	name: z.string().describe("Human-readable credential name."),
	login: vaultLoginSchema.optional().describe("Login payload for login-type."),
	generatePassword: vaultGeneratePasswordSchema
		.optional()
		.describe(
			"Generate the login password server-side instead of supplying login.password. " +
				"Preferred for login credentials: the password is created and stored inside the " +
				"vault and never enters the conversation. Only valid for login-type; mutually " +
				"exclusive with login.password. Pass {} for defaults.",
		),
	card: vaultCardSchema.optional().describe("Card payload for card-type."),
	identity: vaultIdentitySchema.optional().describe("Identity payload for identity-type."),
	notes: z.string().optional().describe("Optional secure note text."),
	fields: z.array(vaultFieldSchema).optional().describe("Optional custom fields."),
	favorite: z.boolean().optional().describe("Optional favorite flag."),
});

const vaultUpdateInput = z.object({
	agentId: z
		.string()
		.optional()
		.describe(
			"Agent ID that owns the credential. Optional when using an agent-bound credential.",
		),
	id: z.string().describe("Credential ID to update."),
	name: z.string().optional().describe("Optional updated name."),
	login: vaultLoginSchema.optional().describe("Optional updated login payload."),
	card: vaultCardSchema.optional().describe("Optional updated card payload."),
	identity: vaultIdentitySchema.optional().describe("Optional updated identity payload."),
	notes: z.string().optional().describe("Optional updated note text."),
	fields: z.array(vaultFieldSchema).optional().describe("Optional updated custom fields."),
	favorite: z.boolean().optional().describe("Optional updated favorite flag."),
});

const vaultSearchInput = z.object({
	agentId: z
		.string()
		.optional()
		.describe(
			"Agent ID whose vault to search. Optional when using an agent-bound credential.",
		),
	search: z.string().describe("Search text matched against names and content."),
	type: vaultCredentialTypeSchema
		.optional()
		.describe("Optional credential type filter."),
});

const vaultProvisionInput = z.object({
	agentId: z
		.string()
		.describe("Agent ID to provision a vault for. Master-key only."),
});

export function registerVaultTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"vault_provision",
		{
			title: "Provision Vault",
			description:
				"Provision a credential vault for an agent. Required before vault_credential_create can be called against a freshly-created agent — without a vault, credentials have nowhere to live. Idempotent: returns the existing vault if one already exists. Master-key only.",
			inputSchema: vaultProvisionInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/v1/vault/provision", {
				agentId: args.agentId,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_credential_list",
		{
			title: "List Vault Credentials",
			description:
				"List credentials in an agent vault with optional type filter. Use to browse stored secrets before reading, updating, or deleting entries. Sensitive fields are masked.",
			inputSchema: vaultListInput.shape,
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
			if (args.agentId) params.set("agentId", args.agentId);
			if (args.type) params.set("type", args.type);
			const result = await context.client.get<unknown>(
				`/v1/vault/credentials?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_credential_get",
		{
			title: "Get Vault Credential",
			description:
				"Get a single vault credential by ID. Sensitive fields (passwords, tokens, SSNs, CVV) are masked. To use the plaintext for autofill or as an upstream credential, mint a vault token at the credential broker — the LLM never sees the secret directly.",
			inputSchema: vaultIdInput.shape,
			outputSchema: objectOutput(),
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
			const path = `/v1/vault/credentials/${encodeURIComponent(args.id)}?${params.toString()}`;
			const result = await context.client.get<Record<string, unknown>>(path);
			return toolSuccess(maskCredentialFields(result));
		}, options.context),
	);

	server.registerTool(
		"vault_credential_create",
		{
			title: "Create Vault Credential",
			description:
				"Create a new credential in an agent vault. Pass `type` plus the matching payload block (login / card / identity / notes). " +
				"For login credentials, prefer `generatePassword` over supplying `login.password` — the vault generates and stores the " +
				"password server-side and returns only the credential reference, so the secret never enters the conversation.",
			inputSchema: vaultCreateInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<Record<string, unknown>>(
				"/v1/vault/credentials",
				args,
			);
			// The API already masks create responses; re-mask client-side so the
			// invariant holds even if the upstream response shape changes.
			return toolSuccess(maskCredentialFields(result));
		}, options.context),
	);

	server.registerTool(
		"vault_credential_update",
		{
			title: "Update Vault Credential",
			description:
				"Update an existing vault credential by ID, including optional structured sections and metadata flags. Use to rotate passwords or revise stored details.",
			inputSchema: vaultUpdateInput.shape,
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
			const path = `/v1/vault/credentials/${encodeURIComponent(id)}`;
			const result = await context.client.put<Record<string, unknown>>(path, payload);
			// Same defense-in-depth masking as create/get — never echo secrets.
			return toolSuccess(maskCredentialFields(result));
		}, options.context),
	);

	server.registerTool(
		"vault_credential_delete",
		{
			title: "Delete Vault Credential",
			description:
				"Delete a credential from vault storage by ID. Use to remove obsolete or compromised secrets.",
			inputSchema: vaultIdInput.shape,
			outputSchema: deleteOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/vault/credentials/${encodeURIComponent(args.id)}`;
			// oRPC DELETE reads agentId from request body
			const result = await context.client.delete<unknown>(path, {
				agentId: args.agentId,
			});
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_credential_search",
		{
			title: "Search Vault",
			description:
				"Search vault credentials by keyword across names and content. Use when you know part of the name, URL, or username but not the exact credential ID. Different access pattern from vault_credential_list — list is paginated browsing, search is text-query lookup.",
			inputSchema: vaultSearchInput.shape,
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
			if (args.agentId) params.set("agentId", args.agentId);
			params.set("search", args.search);
			if (args.type) params.set("type", args.type);
			const result = await context.client.get<unknown>(
				`/v1/vault/search?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_credential_get_totp",
		{
			title: "Get Vault TOTP",
			description:
				"Get the current TOTP code for a credential that has a TOTP secret configured. Returns the live 6-digit code derived from the stored secret — the secret itself is never disclosed.",
			inputSchema: vaultIdInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			const path = `/v1/vault/totp/${encodeURIComponent(args.id)}?${params.toString()}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);
}
