/**
 * Tool Registration Types and Helpers
 *
 * Provides the framework for registering MCP tools organized by domain.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ApiClient } from "./api-client.js";
import { MASTER_KEY_TOOLS } from "./config.js";

/** Context passed to each tool handler */
export interface ToolContext {
	client: ApiClient;
	hasMasterKey: boolean;
}

/** Options for tool registration */
export interface ToolRegistrationOptions {
	server: McpServer;
	context: ToolContext;
}

/**
 * Type for a domain-level tool registrar function.
 * Each domain (org, agent, email, etc.) exports a function matching this signature.
 */
export type DomainRegistrar = (options: ToolRegistrationOptions) => void;

/**
 * Check if a tool requires master key access.
 */
export function requiresMasterKey(toolName: string): boolean {
	return MASTER_KEY_TOOLS.has(toolName);
}

/**
 * Format a successful tool response for MCP.
 *
 * Emits BOTH unstructured text content AND `structuredContent` per the
 * MCP spec 2025-11-25:
 *   - `content` — text block, preserved for clients that don't yet read
 *     `structuredContent`. Required for backward compatibility.
 *   - `structuredContent` — JSON object that conforms to the tool's
 *     declared `outputSchema`. Required by spec whenever outputSchema is
 *     set on the tool. Lets clients typecheck and consume responses
 *     without re-parsing the text block.
 *
 * Wrapping rule: API responses are usually objects (or arrays). The MCP
 * spec requires `structuredContent` to be a JSON object — not an array
 * or scalar. So:
 *   - object → return as-is in structuredContent
 *   - array  → wrap as `{ items: [...] }` so it satisfies "object"
 *   - string → no structuredContent (use cases: pure prose responses)
 *   - other  → wrap as `{ value: ... }`
 *
 * This keeps the unstructured text exactly what it was (pretty JSON or
 * the raw string) while making the structured form available alongside.
 */
export function toolSuccess(data: unknown): {
	content: Array<{ type: "text"; text: string }>;
	structuredContent?: Record<string, unknown>;
} {
	const text =
		typeof data === "string" ? data : JSON.stringify(data, null, 2);
	const base = {
		content: [{ type: "text" as const, text }],
	};
	if (data === null || data === undefined || typeof data === "string") {
		return base;
	}
	if (Array.isArray(data)) {
		return { ...base, structuredContent: { items: data } };
	}
	if (typeof data === "object") {
		return { ...base, structuredContent: data as Record<string, unknown> };
	}
	// number | boolean | bigint | symbol — wrap as { value }
	return {
		...base,
		structuredContent: { value: data as unknown },
	};
}

/**
 * Format an error tool response for MCP.
 *
 * Two shapes accepted:
 *   - `string` — backward-compatible. Wrapped as `Error: <message>`.
 *   - `object` (preferred for typed API errors) — JSON-encoded into the
 *     text content under an `error: {code, message, ...details}` envelope
 *     so MCP callers can parse and switch on the typed code (matches
 *     readiness.blockers[].code from PR #62).
 *
 * Customer feedback (2026-05-09): "Free-text errors and structured
 * readiness can't both be the source of truth. Pick one (codes
 * everywhere) and the cost of using the API drops sharply."
 */
export function toolError(
	messageOrPayload: string | { code: string; message: string; [key: string]: unknown },
): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	if (typeof messageOrPayload === "string") {
		return {
			content: [{ type: "text" as const, text: `Error: ${messageOrPayload}` }],
			isError: true,
		};
	}
	return {
		content: [
			{
				type: "text" as const,
				text: JSON.stringify({ error: messageOrPayload }, null, 2),
			},
		],
		isError: true,
	};
}

/**
 * Wrapper that catches errors from tool handlers and formats them as MCP
 * errors. Special-cased for ApiError so the upstream API's typed shape
 * (code + structured `data`) flows through to the MCP caller intact.
 *
 * Shape preserved on ApiError responses:
 *   {
 *     "error": {
 *       "code": "IDENTITY_NOT_VERIFIED",  // matches readiness.blockers[].code
 *       "message": "...",
 *       "status": 409,
 *       "identity": "...", "agentId": "...", "region": "...",
 *       "domainVerified": false,
 *       "remediation": { "hint": "...", "verificationUrl": "..." }
 *     }
 *   }
 */
export function withErrorHandling<
	TArgs extends Record<string, unknown>,
>(
	handler: (
		args: TArgs,
		context: ToolContext,
	) => Promise<{ content: Array<{ type: "text"; text: string }> }>,
	context: ToolContext,
): (args: TArgs) => Promise<{
	content: Array<{ type: "text"; text: string }>;
	isError?: true;
}> {
	return async (args: TArgs) => {
		try {
			return await handler(args, context);
		} catch (error) {
			// Detect ApiError by name (avoids cross-module class-identity
			// issues with bun's module resolution) and surface the
			// upstream typed payload.
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
				const errorMessageFallback =
					typeof errObj.message === "string" ? errObj.message : "API error";
				const message =
					typeof body.message === "string" ? body.message : errorMessageFallback;
				// Spread `data` (orpc's structured details bucket) into the
				// envelope alongside code/message so an LLM can read
				// remediation hints without descending into nested data.
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
			const message =
				error instanceof Error ? error.message : String(error);
			return toolError(message);
		}
	};
}

/**
 * Guard that checks master key availability before executing a tool.
 */
export function requireMasterKeyGuard(context: ToolContext): void {
	if (!context.hasMasterKey) {
		throw new Error(
			"This operation requires ANIMA_MASTER_KEY to be set.",
		);
	}
}

/**
 * Register a tool under multiple names so the LLM can find it via either
 * the namespaced canonical name (`email_send`) or natural-language verb
 * forms (`send_email`). Only the canonical name's description appears
 * verbatim; aliases get a "(alias of <canonical>)" suffix so the model
 * understands they resolve to the same handler.
 *
 * Why aliases at all:
 *   LLMs hallucinate tool names from common-sense templates. When the
 *   user says "send an email", the model often emits `send_email` as
 *   the call. With no alias, that call fails with "tool not found" and
 *   the model has to retry. With the alias, it just works.
 *
 *   We pay a small cost in tool-list bloat (the names show up twice in
 *   the catalog) but accept it because the alternative — model retries
 *   on a wrong-name guess — costs more in latency and tokens per turn.
 *
 * Deprecation flow:
 *   When a tool is renamed (e.g. `anima_email_send` → `email_send`), pass
 *   the old names in `aliases` AND set `deprecate: true`. Aliases will:
 *     - Render with `[DEPRECATED — use <canonical>]` prefix in the
 *       tool description so any consumer browsing tools/list sees the
 *       migration path immediately.
 *     - Log a structured warning to stderr on every invocation so we can
 *       grep server logs for usage and decide when removal is safe.
 *     - Otherwise behave identically to the canonical (same handler).
 *
 *   Removing aliases without a deprecation window is a breaking change for
 *   every consumer that pinned to the old name in code, prompts, or docs
 *   — exactly the kind of paper cut that erodes trust in early-product
 *   APIs. Always go through this helper for renames.
 */
// biome-ignore lint/suspicious/noExplicitAny: Mirrors McpServer.registerTool's overloaded signature; preserving stricter inference here would require copying ~80 lines of generics from the SDK.
export function registerToolWithAliases(
	server: McpServer,
	canonical: string,
	aliases: readonly string[],
	config: {
		/**
		 * Optional human-readable display label per MCP spec 2025-11-25.
		 * Clients that support `title` show this in UI (Cursor, Claude Code);
		 * clients that don't fall back to `canonical`. Applied to the
		 * canonical registration only — aliases keep their own derivation.
		 */
		title?: string;
		description: string;
		// biome-ignore lint/suspicious/noExplicitAny: Same — Zod-shape passthrough.
		inputSchema: any;
		/**
		 * Optional JSON Schema (Zod-shape form, same convention as
		 * `inputSchema`) describing the structured tool output. When set,
		 * the canonical + every alias get the same schema, and the MCP SDK
		 * validates `structuredContent` against it on the wire. See
		 * `output-schemas.ts` for reusable shapes.
		 */
		// biome-ignore lint/suspicious/noExplicitAny: Same — Zod-shape passthrough.
		outputSchema?: any;
		/**
		 * Behavioral hints surfaced to MCP clients (readOnlyHint,
		 * destructiveHint, idempotentHint, openWorldHint). Passed through
		 * to both canonical + alias registrations so deprecated aliases
		 * keep the same client-side behavior gates as the canonical.
		 */
		// biome-ignore lint/suspicious/noExplicitAny: Pass-through; ToolAnnotations is structural.
		annotations?: any;
		/**
		 * When true, the listed aliases are treated as deprecated names
		 * being kept around temporarily (after a rename) rather than
		 * permanent natural-language alternatives. Aliases get a
		 * `[DEPRECATED]` description prefix and log a warning on use.
		 */
		deprecate?: boolean;
	},
	// biome-ignore lint/suspicious/noExplicitAny: Same.
	handler: any,
): void {
	server.registerTool(
		canonical,
		{
			...(config.title ? { title: config.title } : {}),
			description: config.description,
			inputSchema: config.inputSchema,
			...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
			...(config.annotations ? { annotations: config.annotations } : {}),
		},
		handler,
	);
	for (const alias of aliases) {
		const description = config.deprecate
			? `[DEPRECATED — use \`${canonical}\`] ${config.description} This alias is kept for backward compatibility and will be removed in a future release.`
			: `${config.description} (alias of \`${canonical}\`)`;

		// biome-ignore lint/suspicious/noExplicitAny: Same — handler signature passthrough.
		const wrappedHandler: any = config.deprecate
			? // biome-ignore lint/suspicious/noExplicitAny: Same.
				(...args: any[]) => {
					// stderr (not stdout) so it doesn't clobber stdio MCP framing
					// and so it shows up clearly in Cloud Run logs separately from
					// normal trace output.
					console.warn(
						`[deprecated-tool] alias "${alias}" was invoked — migrate callers to "${canonical}". The alias will be removed in a future release.`,
					);
					return handler(...args);
				}
			: handler;

		server.registerTool(
			alias,
			{
				description,
				inputSchema: config.inputSchema,
				...(config.outputSchema ? { outputSchema: config.outputSchema } : {}),
				...(config.annotations ? { annotations: config.annotations } : {}),
			},
			wrappedHandler,
		);
	}
}
