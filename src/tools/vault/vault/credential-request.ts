// Credential-request machinery for vault_credential_request_create — the
// human-in-the-loop "use-not-see" flow. Split out of index.ts (now tool
// registration only), mirroring the credential-ui.ts sibling.
//
// From the connecting MCP client's DECLARED capabilities a request is delivered
// to the human over one of four tiers (best → most universal):
//   ui    → branded MCP-Apps widget rendered from the tool result (credential-ui.ts)
//   url   → native dialog linking to our masked fill page
//   form  → generic inline elicitation form
//   email → single-use fill link emailed to the org owner (no interactive surface)
// The secret the human enters only ever travels to the token-gated
// /vault/fill/{token} endpoint — it is never logged, echoed, or returned; the
// agent receives only the resulting `credentialId` + masked preview.
import { ElicitResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import { toolError, toolSuccess } from "../../../shared/index.js";

// The request (human-in-the-loop) flow deliberately supports a narrower set
// than the vault can store: the three types with a concrete agent use case —
// sign-in, arbitrary secret, and checkout. `identity` is omitted until an
// autofill consumer exists; the vault still stores identities directly via
// vault_credential_create.
const credentialRequestTypeSchema = z.enum(["login", "secure_note", "card"]);

export const vaultCredentialRequestCreateInput = z.object({
	agentId: z
		.string()
		.optional()
		.describe(
			"Agent ID whose vault the requested credential lands in. Optional when using an agent-bound credential.",
		),
	type: credentialRequestTypeSchema.describe(
		"Credential type the human will be asked to fill: login, secure_note, or card.",
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
	type: z.infer<typeof credentialRequestTypeSchema>,
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
					number: { type: "string", title: "Card number", description: "Full card number (sensitive)." },
					expMonth: { type: "string", title: "Expiry month", description: "Two-digit expiry month (e.g. 04)." },
					expYear: { type: "string", title: "Expiry year", description: "Expiry year (e.g. 2028)." },
					code: { type: "string", title: "Security code", description: "CVV / security code (sensitive)." },
				},
				// Brand is auto-detected from the number by the vault, so we don't
				// ask the human for it. All remaining fields are needed to transact.
				required: ["cardholderName", "number", "expMonth", "expYear", "code"],
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
export type ToolHandlerExtra = any;

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
 * `form` tier — the client declared a generic inline elicitation form (bare
 * `elicitation: {}` or an explicit `form` sub-mode) but no branded `ui`/`url`
 * surface. We show the per-type secret form; on accept we POST the value
 * straight to the token-gated fill endpoint (the ONLY place it travels) and
 * hand back the reference. Reuses readbackRequest + fulfilledResult so the
 * terminal envelope is identical to the other tiers.
 */
async function deliverViaForm(
	d: CredentialDelivery,
): Promise<ReturnType<typeof toolSuccess> | ReturnType<typeof toolError>> {
	let elicitResult: { action: string; content?: Record<string, unknown> };
	try {
		elicitResult = await d.sendRequest(
			{
				method: "elicitation/create",
				params: {
					mode: "form",
					message: `Enter ${d.args.name} — ${d.args.reason}`,
					requestedSchema: buildCredentialElicitSchema(d.args.type),
				},
			},
			ElicitResultSchema,
			{ timeout: d.timeoutMs },
		);
	} catch {
		// Runtime failure on a client that DECLARED elicitation: a JSON-RPC
		// -32600 / "not supported" rejection or a timeout. Treat as a capability
		// gap and fall back to the link (no owner email was sent — acceptable, the
		// link is still actionable on any device). Same capability-error handling
		// as live-call.ts. We deliberately do NOT surface the elicitation error.
		return toolSuccess({
			status: "PENDING",
			requestId: d.requestId,
			fillUrl: d.fillUrl,
			message: "Open this link to provide the secret.",
		});
	}

	if (elicitResult.action === "accept") {
		const value = elicitResult.content ?? {};
		// Push the secret straight to the public, token-gated fill endpoint. This
		// is the ONLY place the elicited value travels — it never enters a log
		// line or the returned content.
		try {
			await d.client.post<{ ok?: boolean }>(
				`/vault/fill/${encodeURIComponent(d.fillToken)}`,
				value,
			);
		} catch (error) {
			return toolErrorFromUnknown(error);
		}
		// Read the request back once so we can hand the agent the reference.
		const state = await readbackRequest(d.client, d.requestId);
		return fulfilledResult(state);
	}

	if (elicitResult.action === "decline") {
		// Human explicitly declined → cancel the request (invalidates the link).
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

	// action === "cancel": dismissed without an explicit choice. Leave the
	// request open and hand back the link as the escape hatch (the SDK collapses
	// "dismiss" into "cancel"; both land here).
	return toolSuccess({
		status: "PENDING",
		requestId: d.requestId,
		fillUrl: d.fillUrl,
		message:
			"Dismissed — open the link to finish, or it can be completed on another device.",
	});
}

/**
 * vault_credential_request_create with form-first elicitation.
 *
 * Branches on the tier chosen from the client's declared capabilities:
 *   - email → no interactive surface: create the request, owner is emailed the
 *     fill link, return the baseline result verbatim for polling.
 *   - url   → native dialog linking to our masked fill page (deliverViaUrlDialog).
 *   - ui    → branded MCP-Apps widget rendered from the result (deliverViaUiApp).
 *   - form  → generic inline elicitation form (deliverViaForm).
 * When a surface exists the request is created with notifyOwner=false (no email
 * while an inline dialog is viable) unless the caller set notifyOwner explicitly.
 *
 * INVARIANT: the elicited secret is POSTed ONLY to /vault/fill/{token}. It is
 * never logged, never echoed, and never placed in the returned content — the
 * caller only ever receives the reference (`credentialId`) + masked preview.
 */
// Exported for direct branch testing (see __tests__/credential-request-elicit.test.ts).
// Production callers reach it through the registered tool handler in index.ts.
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

	// 3. Bound the human's typing window by the request TTL when one was set
	//    (never wait past link expiry).
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

	// 4. Hand off to the tier's delivery surface. All three return the same
	//    envelope shape (status + reference / link), so the caller is uniform.
	if (tier === "url") return deliverViaUrlDialog(delivery);
	if (tier === "ui") return deliverViaUiApp(delivery);
	return deliverViaForm(delivery);
}
