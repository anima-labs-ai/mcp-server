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
 */
export function toolSuccess(
	data: unknown,
): { content: Array<{ type: "text"; text: string }> } {
	const text =
		typeof data === "string" ? data : JSON.stringify(data, null, 2);
	return {
		content: [{ type: "text" as const, text }],
	};
}

/**
 * Format an error tool response for MCP.
 */
export function toolError(
	message: string,
): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	return {
		content: [{ type: "text" as const, text: `Error: ${message}` }],
		isError: true,
	};
}

/**
 * Wrapper that catches errors from tool handlers and formats them as MCP errors.
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
