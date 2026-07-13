import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { CREDENTIAL_UI_HTML, CREDENTIAL_UI_RESOURCE } from "./credential-ui.js";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	deleteOutput,
	listOutput,
	objectOutput,
	toolError,
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

/**
 * Masks sensitive fields in a vault credential response.
 * Invariant: "LLMs never see plaintext through tools." Callers that need
 * plaintext use the autofill/proxy token flow at the credential-broker.
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
			card.number = `****${(card.number as string).slice(-4)}`;
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

const vaultCredentialRequestCreateInput = z.object({
	agentId: z
		.string()
		.optional()
		.describe(
			"Agent ID whose vault the requested credential lands in. Optional when using an agent-bound credential.",
		),
	type: vaultCredentialTypeSchema.describe(
		"Credential type the human will be asked to fill (same types as vault_credential_create).",
	),
	name: z.string().describe("Human-readable name for the requested credential."),
	reason: z
		.string()
		.describe(
			"Plain-language reason shown to the human explaining why the credential is needed.",
		),
	ttlSeconds: z
		.number()
		.optional()
		.describe(
			"Optional fill-link lifetime in seconds before the request expires.",
		),
	notifyOwner: z
		.boolean()
		.optional()
		.describe(
			"Whether to email the single-use fill link to the org owner. Defaults to true.",
		),
});

const vaultCredentialRequestIdInput = z.object({
	requestId: z.string().describe("Credential-request ID."),
});

const vaultCredentialRequestFillInput = z.object({
	fillToken: z.string().describe("Single-use fill token from the ui-tier render-data."),
	values: z
		.record(z.string(), z.string())
		.describe("The secret field values the human entered in the widget."),
});

// ── Form-first elicitation for vault_credential_request_create ──
//
// When the connecting MCP client DECLARED the `elicitation` capability at
// initialize, vault_credential_request_create skips the email/fill-link
// round-trip and instead asks the human to type the secret straight into an
// inline form (`elicitation/create`, form mode). The agent/LLM never sees the
// value: on `accept` we POST it directly to the public, token-gated fill
// endpoint and return only the resulting `credentialId` + masked preview.
//
// This mirrors the live phone-call elicitation flow in
// src/tools/phone/phone_call/live-call.ts — same `extra.sendRequest(...,
// ElicitResultSchema)` surface and the same runtime-failure → fallback
// treatment (a client that declared the capability but rejects/at-runtime
// times out is treated as a capability gap, and we hand back the fill link).

/**
 * Elicitation timeout for the secret-entry form. Unlike the per-turn voice
 * elicitation (30s — a model deciding what to say), this blocks on a HUMAN
 * physically retrieving and typing a credential, so it gets a generous
 * 5-minute ceiling. It is further bounded by the request TTL when the caller
 * set one (no point waiting past link expiry).
 */
const CREDENTIAL_ELICITATION_TIMEOUT_MS = 5 * 60_000;

/** MCP elicitation `requestedSchema` — a flat object of primitive fields. */
interface ElicitFormSchema {
	type: "object";
	properties: Record<
		string,
		{
			type: "string";
			title?: string;
			description?: string;
			format?: "email" | "uri" | "date" | "date-time";
		}
	>;
	required?: string[];
}

/**
 * Build the elicitation form for a credential request's VALUE, per type.
 *
 * MCP's elicitation schema is a restricted JSON-Schema subset: flat top-level
 * primitive properties only (no nesting), and notably NO "sensitive"/"secret"
 * flag — the spec deliberately omits one. So secrecy is enforced by THIS
 * server (the elicited value is only ever POSTed to the fill endpoint, never
 * logged or returned), not by a schema annotation. We surface the per-type
 * fields the same shape vault_credential_create accepts, and the accepted
 * content maps 1:1 to the fill body (the bare value object for the type).
 */
function buildCredentialElicitSchema(
	type: z.infer<typeof vaultCredentialTypeSchema>,
): ElicitFormSchema {
	switch (type) {
		case "login":
			return {
				type: "object",
				properties: {
					username: { type: "string", title: "Username", description: "Login username." },
					password: { type: "string", title: "Password", description: "Login password (sensitive — entered directly into the vault, never shown to the agent)." },
					totp: { type: "string", title: "TOTP secret", description: "Optional TOTP/2FA secret key (sensitive). Leave blank if not applicable." },
				},
				required: ["username", "password"],
			};
		case "secure_note":
			return {
				type: "object",
				properties: {
					notes: { type: "string", title: "Secure note", description: "The secret note text (sensitive — stored directly in the vault)." },
				},
				required: ["notes"],
			};
		case "card":
			return {
				type: "object",
				properties: {
					cardholderName: { type: "string", title: "Cardholder name", description: "Name on the card." },
					brand: { type: "string", title: "Brand", description: "Card brand (e.g. Visa, Mastercard)." },
					number: { type: "string", title: "Card number", description: "Full card number (sensitive)." },
					expMonth: { type: "string", title: "Expiry month", description: "Two-digit expiry month (e.g. 04)." },
					expYear: { type: "string", title: "Expiry year", description: "Expiry year (e.g. 2028)." },
					code: { type: "string", title: "Security code", description: "CVV / security code (sensitive)." },
				},
				required: ["number"],
			};
		case "identity":
			return {
				type: "object",
				properties: {
					firstName: { type: "string", title: "First name" },
					lastName: { type: "string", title: "Last name" },
					email: { type: "string", title: "Email", format: "email" },
					phone: { type: "string", title: "Phone" },
					ssn: { type: "string", title: "SSN / national ID", description: "Sensitive national identifier." },
					passportNumber: { type: "string", title: "Passport number", description: "Sensitive." },
					licenseNumber: { type: "string", title: "License number", description: "Sensitive." },
				},
				// Identity has no single canonical secret; leave required empty
				// so the human can fill whichever fields the flow needs.
				required: [],
			};
	}
}

/**
 * Pull the bare fill token out of a credential-request create response.
 * The create endpoint returns a full `fillUrl`; the public fill endpoint is
 * addressed by the bare token (`POST /vault/fill/{token}`). Prefer an
 * explicit token field if the API surfaces one, else parse the last path
 * segment of `fillUrl`. Deterministic — no guessing.
 */
function extractFillToken(result: Record<string, unknown>): string | null {
	const explicit =
		(typeof result.token === "string" && result.token) ||
		(typeof result.fillToken === "string" && result.fillToken);
	if (explicit) return explicit;
	if (typeof result.fillUrl === "string" && result.fillUrl.length > 0) {
		// Last non-empty path segment, query/hash stripped.
		const noQuery = result.fillUrl.split(/[?#]/)[0];
		const segments = noQuery.split("/").filter(Boolean);
		const last = segments[segments.length - 1];
		if (last) return last;
	}
	return null;
}

// biome-ignore lint/suspicious/noExplicitAny: the SDK's RequestHandlerExtra is generic over the server's request/notification unions; mirroring those generics buys nothing here. We use `extra` for one call (sendRequest) and `_meta`, both typed on the SDK side. Same rationale as live-call.ts.
type ToolHandlerExtra = any;

export function registerVaultTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	// Branded MCP-App form for the `ui` tier of vault_credential_request_create
	// (linked from that tool via `_meta.ui.resourceUri`). CSP: the widget loads
	// the ext-apps SDK from esm.sh (resourceDomains) and POSTs the secret to our
	// token-gated fill endpoint (connectDomains) — nothing else.
	const apiOrigin = (() => {
		try {
			return new URL(
				process.env.ANIMA_PUBLIC_API_URL ??
					process.env.ANIMA_API_URL ??
					"https://api.useanima.sh",
			).origin;
		} catch {
			return "https://api.useanima.sh";
		}
	})();
	server.registerResource(
		"credential-request-ui",
		CREDENTIAL_UI_RESOURCE,
		{
			title: "Anima credential form",
			description: "Branded inline form for vault_credential_request_create.",
			mimeType: "text/html;profile=mcp-app",
		},
		async () => ({
			contents: [
				{
					uri: CREDENTIAL_UI_RESOURCE,
					mimeType: "text/html;profile=mcp-app",
					text: CREDENTIAL_UI_HTML,
					_meta: {
						ui: {
							csp: {
								connectDomains: [apiOrigin],
								resourceDomains: ["https://esm.sh"],
							},
						},
					},
				},
			],
		}),
	);

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
				"Create a new credential in an agent vault. Pass `type` plus the matching payload block (login / card / identity / notes).",
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
			const result = await context.client.post<unknown>("/v1/vault/credentials", args);
			return toolSuccess(result);
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
			const result = await context.client.put<unknown>(path, payload);
			return toolSuccess(result);
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

	server.registerTool(
		"vault_credential_request_create",
		{
			title: "Request Credential From Human",
			description:
				"Request a credential from a HUMAN without the agent or LLM ever seeing the secret. When the connecting MCP client supports inline elicitation, the human is shown a form to type the secret directly — the tool returns `status: FULFILLED` with the `credentialId` in one call, no link needed. Otherwise it returns a single-use fill link (`fillUrl`, emailed to the org owner); poll vault_credential_request_status until `status` is FULFILLED, then use the returned `credentialId` as a normal vault credential. Use this when a flow needs a secret the agent doesn't hold and can't safely be given (passwords, API keys, card numbers, identity details).",
			inputSchema: vaultCredentialRequestCreateInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			// MCP Apps (SEP-1865): links this tool to our branded credential form.
			// A ui-capable host (Claude Desktop) renders the resource inline and
			// drives it as the elicitation surface; other clients ignore this.
			_meta: { ui: { resourceUri: CREDENTIAL_UI_RESOURCE } },
		},
		// NOT wrapped in withErrorHandling: that wrapper drops the handler's
		// second arg (`extra`), but form-first elicitation needs
		// `extra.sendRequest` to issue `elicitation/create`. We replicate the
		// wrapper's typed-error envelope inline instead (see runCredentialRequestCreate).
		async (args, extra) =>
			runCredentialRequestCreate(args, options, extra as ToolHandlerExtra),
	);

	server.registerTool(
		"vault_credential_request_status",
		{
			title: "Get Credential Request Status",
			description:
				"Get the status of a pending credential request by ID. Poll this after vault_credential_request_create until `status` is FULFILLED, then use `credentialId` as a normal vault credential. `maskedPreview` shows a redacted hint of the filled value once available — the plaintext is never returned.",
			inputSchema: vaultCredentialRequestIdInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/vault/credential-requests/${encodeURIComponent(args.requestId)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"vault_credential_request_cancel",
		{
			title: "Cancel Credential Request",
			description:
				"Cancel a pending credential request by ID. Invalidates the single-use fill link so the human can no longer submit a value. Use when the request is no longer needed or was created in error.",
			inputSchema: vaultCredentialRequestIdInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/vault/credential-requests/${encodeURIComponent(args.requestId)}/cancel`;
			const result = await context.client.post<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	// App-only: the branded ui-tier widget submits the human's secret through this
	// tool (host-bridged callTool) instead of a cross-origin fetch, which some
	// hosts' widget CSP blocks. `visibility: ["app"]` keeps it — and the secret in
	// its args — off the model. The value only ever travels to /vault/fill/{token}.
	server.registerTool(
		"vault_credential_request_fill",
		{
			title: "Submit Credential (widget)",
			description:
				"Internal: submit a credential-request secret from the Anima UI widget. Not for direct agent use.",
			inputSchema: vaultCredentialRequestFillInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
			_meta: { ui: { visibility: ["app"] } },
		},
		withErrorHandling(async (args, context) => {
			await context.client.post<{ ok?: boolean }>(
				`/vault/fill/${encodeURIComponent(args.fillToken)}`,
				args.values,
			);
			return toolSuccess({
				status: "FULFILLED",
				message: "Secret captured; the agent can now use it.",
			});
		}, options.context),
	);
}

/**
 * Translate an unknown thrown error into the same typed-error envelope
 * `withErrorHandling` produces. The elicitation-aware create handler can't use
 * that wrapper (it needs `extra`), so it calls this for its terminal failures
 * — keeping the on-the-wire error shape identical to every other vault tool.
 */
function toolErrorFromUnknown(
	error: unknown,
): ReturnType<typeof toolError> {
	const errObj = error as Record<string, unknown> | null;
	if (
		errObj &&
		typeof errObj === "object" &&
		errObj.name === "ApiError" &&
		typeof errObj.body === "object" &&
		errObj.body !== null
	) {
		const body = errObj.body as Record<string, unknown>;
		const status = typeof errObj.status === "number" ? errObj.status : undefined;
		const code = typeof body.code === "string" ? body.code : "API_ERROR";
		const fallback =
			typeof errObj.message === "string" ? errObj.message : "API error";
		const message =
			typeof body.message === "string" ? body.message : fallback;
		const dataFields =
			body.data && typeof body.data === "object" && !Array.isArray(body.data)
				? (body.data as Record<string, unknown>)
				: {};
		return toolError({
			code,
			message,
			...(status !== undefined ? { status } : {}),
			...dataFields,
		});
	}
	return toolError(error instanceof Error ? error.message : String(error));
}

/** MCP Apps UI capability key (SEP-1865). Present in a client's declared
 *  `capabilities.extensions` when it can render server-provided `ui://`
 *  resources (`text/html;profile=mcp-app`) inline — e.g. Claude Desktop. */
export const MCP_UI_EXTENSION = "io.modelcontextprotocol/ui";

/** How a human is asked for a secret, best-to-most-universal. */
export type CredentialDeliveryTier = "ui" | "url" | "form" | "email";

/**
 * Choose the credential-entry surface from the client's DECLARED capabilities.
 * See credential-delivery-tier.test.ts for the ordering rationale. A client is
 * only ever handed a surface it advertised — an unadvertised mode fails at
 * runtime — and for a *credential* a branded/masked surface (`url` → our fill
 * page) beats a generic inline `form`.
 */
export function selectCredentialDeliveryTier(
	capabilities:
		| {
				extensions?: Record<string, unknown>;
				elicitation?: { form?: unknown; url?: unknown };
		  }
		| undefined,
): CredentialDeliveryTier {
	if (capabilities?.extensions?.[MCP_UI_EXTENSION] != null) return "ui";
	const elicitation = capabilities?.elicitation;
	if (elicitation?.url != null) return "url"; // native dialog → our fill page
	if (elicitation != null) return "form"; // form / bare `{}` → generic inline form
	return "email";
}

/** Resolved request + the surfaces a delivery helper needs. The secret only
 *  ever travels to /vault/fill/{token}; it never enters a log or the result. */
interface CredentialDelivery {
	client: ToolRegistrationOptions["context"]["client"];
	args: z.infer<typeof vaultCredentialRequestCreateInput>;
	requestId: string;
	fillToken: string;
	fillUrl: string | undefined;
	sendRequest: ToolHandlerExtra["sendRequest"];
	timeoutMs: number;
}

/** Best-effort single read-back of a request's current state. */
async function readbackRequest(
	client: CredentialDelivery["client"],
	requestId: string,
): Promise<Record<string, unknown>> {
	try {
		return await client.get<Record<string, unknown>>(
			`/v1/vault/credential-requests/${encodeURIComponent(requestId)}`,
		);
	} catch {
		return {}; // fill (if any) already happened; a failed read isn't a failure
	}
}

/** Terminal FULFILLED result from a read-back state (reference + masked preview only). */
function fulfilledResult(state: Record<string, unknown>): ReturnType<typeof toolSuccess> {
	return toolSuccess({
		status: "FULFILLED",
		credentialId: state.credentialId,
		maskedPreview: state.maskedPreview,
		message: "Secret captured; the agent can now use it.",
	});
}

/**
 * `url` tier — the client shows a native dialog linking to our branded, masked
 * fill page. The human enters the secret THERE (the page POSTs to
 * /vault/fill/{token}), never through the agent. On accept we read the request
 * back: FULFILLED if already completed, else PENDING with the link to finish.
 */
async function deliverViaUrlDialog(
	d: CredentialDelivery,
): Promise<ReturnType<typeof toolSuccess> | ReturnType<typeof toolError>> {
	let action: string;
	try {
		const result = (await d.sendRequest(
			{
				method: "elicitation/create",
				params: {
					mode: "url",
					message: `Provide ${d.args.name} — ${d.args.reason}`,
					url: d.fillUrl,
					elicitationId: d.requestId,
				},
			},
			ElicitResultSchema,
			{ timeout: d.timeoutMs },
		)) as { action: string };
		action = result.action;
	} catch {
		// Declared url but rejected/timed out → hand back the link (no leak of err).
		return toolSuccess({
			status: "PENDING",
			requestId: d.requestId,
			fillUrl: d.fillUrl,
			message: "Open this link to provide the secret.",
		});
	}

	if (action === "decline") {
		try {
			await d.client.post<unknown>(
				`/v1/vault/credential-requests/${encodeURIComponent(d.requestId)}/cancel`,
			);
		} catch (error) {
			return toolErrorFromUnknown(error);
		}
		return toolSuccess({
			status: "DECLINED",
			message:
				"The human declined; create a new request if you still need the credential.",
		});
	}

	// accept / dismiss: the fill (if any) happened on the page — reflect reality.
	const state = await readbackRequest(d.client, d.requestId);
	if (state.status === "FULFILLED") return fulfilledResult(state);
	return toolSuccess({
		status: "PENDING",
		requestId: d.requestId,
		fillUrl: d.fillUrl,
		message:
			"Opened the fill page — finish there, then poll vault_credential_request_status.",
	});
}

/**
 * `ui` tier — an MCP-Apps host (Claude Desktop) renders our linked
 * `ui://anima/credential-request` widget from THIS tool result. CD advertises
 * `extensions["io.modelcontextprotocol/ui"]` but no elicitation capability, so
 * we must NOT elicit — we return the render-data the widget needs (the fill
 * target + field schema) to draw the branded form and POST the secret straight
 * to the token-gated fill endpoint. The value never returns through the agent.
 */
async function deliverViaUiApp(
	d: CredentialDelivery,
): Promise<ReturnType<typeof toolSuccess>> {
	const apiBase = (
		process.env.ANIMA_PUBLIC_API_URL ??
		process.env.ANIMA_API_URL ??
		"https://api.useanima.sh"
	).replace(/\/+$/, "");
	const consoleUrl = (
		process.env.CONSOLE_URL ??
		process.env.CONNECT_URL ??
		"https://console.useanima.sh"
	).replace(/\/+$/, "");
	return toolSuccess({
		status: "AWAITING_INPUT",
		requestId: d.requestId,
		fillUrl: d.fillUrl,
		// The widget submits the secret via `callServerTool(vault_credential_request_fill)`
		// (host-bridged, so no cross-origin fetch/CSP). fillEndpoint is a direct-POST
		// fallback for hosts that allow it.
		fillToken: d.fillToken,
		fillEndpoint: `${apiBase}/vault/fill/${encodeURIComponent(d.fillToken)}`,
		// Where the human can view the stored secret after saving.
		vaultUrl: `${consoleUrl}/vault`,
		requestedSchema: buildCredentialElicitSchema(d.args.type),
		message: `Enter ${d.args.name} — ${d.args.reason}`,
	});
}

/**
 * vault_credential_request_create with form-first elicitation.
 *
 * Branches:
 *   - client can't render the inline form (no elicitation, or url-mode only
 *     like Claude Desktop) → baseline behaviour: create the request, owner is
 *     emailed the fill link, return PENDING for polling.
 *   - client can render the form (bare `elicitation: {}` or `form` sub-mode) →
 *     create with notifyOwner=false (no email while an inline dialog is
 *     viable), then show the secret form:
 *       accept  → POST the value to the fill endpoint, re-read once, return FULFILLED
 *       decline → cancel the request, return DECLINED
 *       cancel  → return PENDING + fillUrl (dismissed; finish via link)
 *       runtime reject / -32600 / "not supported" / timeout → PENDING + fillUrl
 *
 * INVARIANT: the elicited secret is POSTed ONLY to /vault/fill/{token}. It
 * is never logged, never echoed, and never placed in the returned content —
 * the caller only ever receives the reference (`credentialId`) + masked preview.
 */
// Exported for direct branch testing (see __tests__/credential-request-elicit.test.ts).
// Production callers reach it through the registered tool handler above.
export async function runCredentialRequestCreate(
	args: z.infer<typeof vaultCredentialRequestCreateInput>,
	options: ToolRegistrationOptions,
	extra: ToolHandlerExtra,
): Promise<ReturnType<typeof toolSuccess> | ReturnType<typeof toolError>> {
	const { context, server } = options;

	// 1. Pick the entry surface from the client's declared capabilities
	//    (populated from the `initialize` handshake). See
	//    selectCredentialDeliveryTier for the ordering rationale.
	const tier = selectCredentialDeliveryTier(
		server.server.getClientCapabilities() as
			| { extensions?: Record<string, unknown>; elicitation?: { form?: unknown; url?: unknown } }
			| undefined,
	);
	// TEMP DEBUG (remove after Claude Desktop `ui`-tier validation): surfaces the
	// exact capabilities the connecting client declared + the tier chosen.
	console.error(
		`[credreq] client caps: ${JSON.stringify(server.server.getClientCapabilities())} → tier: ${tier}`,
	);

	// 2. Create the request. Email the owner only when there's no interactive
	//    surface to enter the secret — an explicit args.notifyOwner always wins.
	let createResult: Record<string, unknown>;
	try {
		createResult = await context.client.post<Record<string, unknown>>(
			"/v1/vault/credential-requests",
			{ ...args, notifyOwner: args.notifyOwner ?? tier === "email" },
		);
	} catch (error) {
		return toolErrorFromUnknown(error);
	}

	const requestId =
		typeof createResult.requestId === "string" ? createResult.requestId : undefined;
	const fillUrl =
		typeof createResult.fillUrl === "string" ? createResult.fillUrl : undefined;

	// No interactive surface → return the baseline result verbatim (owner
	// emailed, agent polls vault_credential_request_status).
	if (tier === "email") {
		return toolSuccess(createResult);
	}

	const fillToken = extractFillToken(createResult);

	// If we somehow can't address the fill endpoint, degrade to the link path
	// rather than dropping the request on the floor.
	if (!requestId || !fillToken) {
		return toolSuccess({
			...createResult,
			status: "PENDING",
			message:
				"Open the fill link to provide the secret (inline entry was unavailable).",
		});
	}

	// 3. Show the inline secret form. Bound the human's typing window by the
	//    request TTL when one was set (never wait past link expiry).
	const ttlMs =
		typeof args.ttlSeconds === "number" && args.ttlSeconds > 0
			? args.ttlSeconds * 1000
			: undefined;
	const timeoutMs = ttlMs
		? Math.min(CREDENTIAL_ELICITATION_TIMEOUT_MS, ttlMs)
		: CREDENTIAL_ELICITATION_TIMEOUT_MS;

	const delivery: CredentialDelivery = {
		client: context.client,
		args,
		requestId,
		fillToken,
		fillUrl,
		sendRequest: extra.sendRequest,
		timeoutMs,
	};
	// `url` shows a native dialog linking to our fill page. `ui` renders our
	// linked `ui://` widget from the tool RESULT (Claude Desktop's MCP-Apps model
	// is widget-from-result, NOT elicitation — CD advertises the ui extension but
	// no elicitation capability), so we return render-data instead of eliciting.
	// `form` (below) is the generic inline elicitation form.
	if (tier === "url") return deliverViaUrlDialog(delivery);
	if (tier === "ui") return deliverViaUiApp(delivery);

	let elicitResult: { action: string; content?: Record<string, unknown> };
	try {
		elicitResult = await extra.sendRequest(
			{
				method: "elicitation/create",
				params: {
					mode: "form",
					message: `Enter ${args.name} — ${args.reason}`,
					requestedSchema: buildCredentialElicitSchema(args.type),
				},
			},
			ElicitResultSchema,
			{ timeout: timeoutMs },
		);
	} catch (err) {
		// Runtime failure on a client that DECLARED elicitation: a JSON-RPC
		// -32600 / "not supported" rejection or a timeout. Treat as a
		// capability gap and fall back to the link (no owner email was sent —
		// acceptable, the link is still actionable on any device). Same
		// capability-error detection as live-call.ts. We deliberately do NOT
		// surface the elicitation error text — fall through to the URL escape.
		void err;
		return toolSuccess({
			requestId,
			fillUrl,
			status: "PENDING",
			message: "Open this link to provide the secret.",
		});
	}

	// 4. Branch on the human's action.
	if (elicitResult.action === "accept") {
		const value = elicitResult.content ?? {};
		// Push the secret straight to the public, token-gated fill endpoint.
		// This is the ONLY place the elicited value travels — it never enters
		// a log line or the returned content.
		try {
			await context.client.post<{ ok?: boolean }>(
				`/vault/fill/${encodeURIComponent(fillToken)}`,
				value,
			);
		} catch (error) {
			return toolErrorFromUnknown(error);
		}

		// Read the request back once so we can hand the agent the reference.
		let finalState: Record<string, unknown> = {};
		try {
			finalState = await context.client.get<Record<string, unknown>>(
				`/v1/vault/credential-requests/${encodeURIComponent(requestId)}`,
			);
		} catch {
			// The fill succeeded; a failed read-back shouldn't masquerade as a
			// fill failure. Fall through with whatever we have.
		}

		return toolSuccess({
			status: "FULFILLED",
			credentialId: finalState.credentialId,
			maskedPreview: finalState.maskedPreview,
			message: "Secret captured; the agent can now use it.",
		});
	}

	if (elicitResult.action === "decline") {
		// Human explicitly declined → cancel the request (invalidates the link).
		try {
			await context.client.post<unknown>(
				`/v1/vault/credential-requests/${encodeURIComponent(requestId)}/cancel`,
			);
		} catch (error) {
			return toolErrorFromUnknown(error);
		}
		return toolSuccess({
			status: "DECLINED",
			message:
				"The human declined; create a new request if you still need the credential.",
		});
	}

	// action === "cancel": dismissed without an explicit choice. Leave the
	// request open and hand back the link as the escape hatch (the SDK
	// collapses "dismiss" into "cancel"; both land here).
	return toolSuccess({
		status: "PENDING",
		requestId,
		fillUrl,
		message:
			"Dismissed — open the link to finish, or it can be completed on another device.",
	});
}
