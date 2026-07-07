import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import { toolSuccess, withErrorHandling } from "../../../shared/index.js";

// Part F of the headless extension-connect feature. Wraps
// POST /v1/extension/connect — the API mints a short-lived, single-use
// connect URL that a browser extension (or a headless Puppeteer worker)
// exchanges to bind itself to an agent. The response carries NO token or
// secret: `connectUrl` is itself the bearer of the one-time exchange
// code, and it expires (exchangeExpiresAt). So, unlike the vault tools,
// there is nothing to mask here — the payload is returned as-is.
//
// Auth model mirrors the API contract:
//   - master key (mk_): `agentId` is REQUIRED (no implicit agent).
//   - agent key (ak_ / oat_): OMIT `agentId` — the server resolves the
//     agent from the key. Passing it is unnecessary.
// `ttl` is optional: a value longer than the org's policy maximum is
// rejected (not silently shortened). Omit it to use the policy default.

const extensionConnectInput = z.object({
	agentId: z
		.string()
		.optional()
		.describe(
			"Agent to connect the extension to. REQUIRED when authenticating with a master key (mk_); OMIT when using an agent key (ak_/oat_) — the server resolves the agent from the key.",
		),
	ttl: z
		.enum(["15m", "1h", "session"])
		.optional()
		.describe(
			"Requested lifetime of the connection. A value longer than the org's policy maximum is rejected (not silently shortened); omit to use the policy default.",
		),
});

// The endpoint's response is a small, stable shape. A tight schema (vs the
// permissive objectOutput()) gives MCP clients real type info for chaining
// the connectUrl into a browser step. `.passthrough()` keeps it forward-
// compatible if the API adds fields.
const extensionConnectOutput = z
	.object({
		agentId: z.string(),
		connectUrl: z.string(),
		expiresAt: z.string().nullable(),
		exchangeExpiresAt: z.string(),
		policy: z.enum(["session", "pre_approved"]),
	})
	.passthrough();

export function registerExtensionTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"extension_connect",
		{
			title: "Connect Browser Extension",
			description:
				"Create a short-lived, single-use connect URL that links a browser extension (or a headless Puppeteer worker) to an Anima agent. " +
				"Returns `connectUrl` — hand it to the extension to complete the handshake before `exchangeExpiresAt`. The response carries no token or secret. " +
				"Auth: with a master key you MUST pass `agentId`; with an agent key OMIT `agentId` (the server resolves it from the key). " +
				"`ttl` is optional; a value above the org's maximum is rejected.",
			inputSchema: extensionConnectInput.shape,
			outputSchema: extensionConnectOutput,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			// Only send keys the caller actually provided. The server treats
			// a missing agentId (agent-key path) differently from an empty
			// one, so never synthesize fields the user didn't set.
			const body: Record<string, unknown> = {};
			if (args.agentId !== undefined) body.agentId = args.agentId;
			if (args.ttl !== undefined) body.ttl = args.ttl;

			const result = await context.client.post<unknown>(
				"/v1/extension/connect",
				body,
			);
			return toolSuccess(result);
		}, options.context),
	);
}
