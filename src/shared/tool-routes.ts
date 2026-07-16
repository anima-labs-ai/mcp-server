/**
 * Tool → backing-contract-route registry (spec items M2 + M3).
 *
 * Every MCP tool this server registers must declare which `@anima/contracts`
 * routes back it. Composed tools (client-side orchestrations like
 * email_reply) declare ALL their primitive routes. The CI gate
 * (src/__tests__/tool-contract-gate.test.ts) then asserts, against the
 * committed contract snapshot (scripts/contracts-snapshot.json):
 *
 *   1. every registered tool has an entry here, and vice versa;
 *   2. every declared route exists in the contract (M2 — kills tools backed
 *      by endpoints that don't exist, the `sms_thread_*`/credential-request
 *      window class);
 *   3. every tool inputSchema property is accepted by at least one declared
 *      route, or is explicitly allowlisted in `clientSideParams` (M3 — kills
 *      fictional params that zod-strip silently no-ops, the email_list
 *      `folder`/`offset` class).
 *
 * Route string forms:
 *   - "METHOD /path"    — a contract route, exactly as it appears in the
 *                         snapshot. Paths are contract-bare: the API mounts
 *                         the contract router under /v1, so code calls
 *                         `/v1/email/send` while the contract (and this
 *                         registry) says `POST /email/send`.
 *   - "ws:/path"        — a WebSocket protocol endpoint (not a REST
 *                         contract route). Exempt from route/param checks;
 *                         the gate pins the exact allowed set.
 *   - "app:METHOD /path" — a non-/v1 application route that exists outside
 *                         the contract router. Same exemption rules as ws.
 *
 * `clientSideParams` is per-tool and every entry needs a justification
 * comment. The gate also fails on stale entries (param no longer in the
 * tool schema) and redundant ones (param actually exists in the contract),
 * so the allowlist cannot rot into a bypass.
 */

export interface ToolRouteDecl {
	/** Backing routes (see forms above). */
	routes: readonly string[];
	/** Tool schema properties consumed client-side instead of being passed
	 *  verbatim to a backing route. Justify every entry with a comment. */
	clientSideParams?: readonly string[];
}

export const TOOL_ROUTES: Record<string, ToolRouteDecl> = {
	// ── Agent ────────────────────────────────────────────────────────────
	agent_create: {
		routes: ["POST /agents", "POST /addresses"],
		clientSideParams: [
			// Travels as the Idempotency-Key HTTP header, not a body field.
			"idempotencyKey",
			// Nested address object; unpacked into the follow-up POST /addresses body.
			"address",
		],
	},
	agent_get: {
		routes: ["GET /agents/{id}", "GET /addresses"],
	},
	agent_list: {
		routes: ["GET /agents"],
	},
	agent_update: {
		routes: [
			"GET /agents/{id}",
			"PATCH /agents/{id}",
			"POST /addresses",
			"PUT /addresses/{id}",
			"DELETE /addresses/{id}",
		],
		clientSideParams: [
			// Composition directives: unpacked into the address sub-requests above.
			"addAddress",
			"updateAddress",
			"deleteAddressId",
		],
	},
	agent_delete: {
		routes: ["DELETE /agents/{id}"],
	},

	// ── Email ────────────────────────────────────────────────────────────
	email_send: {
		routes: ["POST /email/send"],
	},
	email_get: {
		routes: ["GET /email/{id}"],
	},
	email_list: {
		routes: ["GET /email"],
	},
	email_search: {
		routes: ["POST /messages/search", "POST /messages/search/semantic"],
		clientSideParams: [
			// Selects which of the two search routes to call.
			"mode",
		],
	},
	email_reply: {
		routes: ["GET /email/{id}", "POST /email/send"],
		clientSideParams: [
			// Maps to the {id} path param of GET /email/{id}.
			"originalId",
			// Reply composition: text/html become the send body/bodyHtml;
			// replyAll drives client-side recipient math.
			"text",
			"html",
			"replyAll",
		],
	},
	email_forward: {
		routes: ["GET /email/{id}", "POST /email/send"],
		clientSideParams: [
			// Maps to the {id} path param of GET /email/{id}.
			"originalId",
			// Intro text prepended to the quoted forward body client-side.
			"text",
		],
	},
	email_thread_get: {
		routes: ["GET /messages"],
		clientSideParams: [
			// id/ids map to the threadId query param (single or fan-out).
			"id",
			"ids",
		],
	},
	email_attachment_get: {
		routes: ["GET /attachments/{id}/download"],
	},
	email_draft_create: {
		routes: ["POST /email/drafts"],
	},
	email_draft_get: {
		routes: ["GET /email/drafts/{id}"],
	},
	email_draft_list: {
		routes: ["GET /email/drafts"],
	},
	email_draft_send: {
		routes: ["POST /email/drafts/{id}/send"],
	},
	email_draft_delete: {
		routes: ["DELETE /email/drafts/{id}"],
	},

	// ── Domain ───────────────────────────────────────────────────────────
	domain_create: {
		routes: ["POST /domains"],
	},
	domain_verify: {
		routes: ["POST /domains/{id}/verify"],
	},
	domain_get: {
		routes: ["GET /domains/{id}"],
	},
	domain_list: {
		routes: ["GET /domains"],
	},
	domain_delete: {
		routes: ["DELETE /domains/{id}"],
	},
	domain_update: {
		routes: ["PATCH /domains/{id}"],
	},
	domain_zone_file: {
		routes: ["GET /domains/{id}/zone-file"],
	},

	// ── Inbox ────────────────────────────────────────────────────────────
	inbox_create: {
		routes: ["POST /inboxes"],
	},
	inbox_get: {
		routes: ["GET /inboxes/{id}"],
	},
	inbox_list: {
		routes: ["GET /inboxes"],
	},
	inbox_update: {
		routes: ["PATCH /inboxes/{id}"],
	},
	inbox_delete: {
		routes: ["DELETE /inboxes/{id}"],
	},

	// ── Phone / SMS / Voice ──────────────────────────────────────────────
	phone_number_list: {
		routes: ["GET /phone/numbers"],
	},
	phone_number_provision: {
		routes: ["POST /phone/provision"],
	},
	phone_number_release: {
		routes: ["POST /phone/release"],
	},
	sms_send: {
		routes: ["POST /phone/send-sms"],
	},
	sms_get: {
		routes: ["GET /messages/{id}"],
	},
	sms_list: {
		routes: ["GET /messages"],
	},
	sms_thread_list: {
		routes: ["GET /messages"],
		clientSideParams: [
			// Pagination over the client-side thread aggregation (messages are
			// fetched at a fixed limit, grouped by threadId, then sliced).
			"offset",
		],
	},
	sms_thread_get: {
		routes: ["GET /messages"],
		clientSideParams: [
			// Maps to the threadId query param.
			"id",
		],
	},
	phone_call_create: {
		// Live call over the WS voice protocol (apps/api ws-voice.ts), not REST.
		routes: ["ws:/ws/voice"],
	},
	phone_call_list: {
		routes: ["GET /voice/calls"],
		clientSideParams: [
			// Renamed client-side to the contract's `state` query param.
			"status",
		],
	},
	phone_call_get: {
		routes: ["GET /voice/calls/{callId}"],
		clientSideParams: [
			// Maps to the {callId} path param.
			"id",
		],
	},
	phone_call_transcript_get: {
		routes: ["GET /voice/calls/{callId}/transcript"],
		clientSideParams: [
			// Maps to the {callId} path param.
			"id",
		],
	},
	phone_call_recording_get: {
		routes: ["GET /voice/calls/{callId}/recording"],
		clientSideParams: [
			// Maps to the {callId} path param.
			"id",
		],
	},
	voice_list: {
		routes: ["GET /voice/catalog"],
	},

	// ── Platform ─────────────────────────────────────────────────────────
	account_overview: {
		routes: ["GET /orgs/me", "GET /orgs/me/workspace-health"],
	},
	usage_overview: {
		routes: ["GET /orgs/me/usage"],
	},
	webhook_get: {
		routes: ["GET /webhooks/{id}"],
	},
	webhook_list: {
		routes: ["GET /webhooks"],
	},
	webhook_set: {
		routes: ["POST /webhooks", "PUT /webhooks/{id}"],
	},
	webhook_delete: {
		routes: ["DELETE /webhooks/{id}"],
	},
	webhook_test: {
		routes: ["POST /webhooks/{id}/test"],
	},

	// ── Vault ────────────────────────────────────────────────────────────
	vault_provision: {
		routes: ["POST /vault/provision"],
	},
	vault_credential_list: {
		routes: ["GET /vault/credentials"],
		clientSideParams: [
			// Client-side filter over the returned list (the list endpoint
			// takes only agentId).
			"type",
		],
	},
	vault_credential_get: {
		routes: ["GET /vault/credentials/{id}"],
	},
	vault_credential_create: {
		routes: ["POST /vault/credentials"],
	},
	vault_credential_update: {
		routes: ["PUT /vault/credentials/{id}"],
	},
	vault_credential_delete: {
		routes: ["DELETE /vault/credentials/{id}"],
	},
	vault_credential_search: {
		routes: ["GET /vault/search"],
	},
	vault_credential_get_totp: {
		routes: ["GET /vault/totp/{id}"],
	},
	vault_credential_use: {
		routes: ["POST /vault/credentials/{id}/use"],
	},
	vault_exchange_token_for_injection: {
		routes: ["POST /vault/token/exchange"],
	},
	vault_credential_request_create: {
		// Creates the request, then (delivery-tier dependent) polls status and
		// cancels on abort — all three primitives are part of this tool.
		routes: [
			"POST /vault/credential-requests",
			"GET /vault/credential-requests/{requestId}",
			"POST /vault/credential-requests/{requestId}/cancel",
		],
	},
	vault_credential_request_status: {
		routes: ["GET /vault/credential-requests/{requestId}"],
	},
	vault_credential_request_cancel: {
		routes: ["POST /vault/credential-requests/{requestId}/cancel"],
	},
	vault_credential_request_fill: {
		// App-only widget bridge: submits the human's secret to the public
		// fill route, which lives outside the /v1 contract router by design
		// (single-use token URL, no API key auth).
		routes: ["app:POST /vault/fill/{token}"],
	},

	// ── Extension ────────────────────────────────────────────────────────
	extension_connect: {
		routes: ["POST /extension/connect"],
	},
};
