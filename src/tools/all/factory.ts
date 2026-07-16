import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
	SERVER_INFO as CORE_SERVER_INFO,
	type ApiClient,
	type ToolRegistrationOptions,
} from "../../shared/index.js";

// Agent domain
import { registerAgentTools } from "../agent/agent/index.js";

// Email domain
import { registerEmailTools } from "../email/email/index.js";
import { registerDomainTools } from "../email/domain/index.js";
import { registerInboxTools } from "../email/inbox/index.js";

// Phone domain
import { registerPhoneTools } from "../phone/phone/index.js";
import { registerSmsTools } from "../phone/sms/index.js";
import { registerPhoneCallTools } from "../phone/phone_call/index.js";

// Platform domain
import { registerWorkspaceTools } from "../platform/workspace/index.js";
import { registerWebhookTools } from "../platform/webhook/index.js";

// Vault domain
import { registerVaultTools } from "../vault/vault/index.js";

// Extension domain
import { registerExtensionTools } from "../extension/extension/index.js";

const SERVER_INFO = {
	...CORE_SERVER_INFO,
	name: "anima-mcp",
	version: "0.1.0",
	description:
		"Anima MCP Server — unified endpoint exposing all Anima tools (agent, email, phone, platform, vault, extension).",
};

/**
 * Every tool registrar that makes up the unified `/mcp` endpoint, in
 * registration order. Exported (not inlined in buildAllToolsServer) so the
 * tool↔contract CI gate (src/__tests__/tool-contract-gate.test.ts) walks
 * the exact same list as production — a registrar added here is
 * automatically covered by the gate, one added only here or only there is
 * a test failure.
 */
export const ALL_TOOL_REGISTRARS: ReadonlyArray<
	(options: ToolRegistrationOptions) => void
> = [
	// Agent
	registerAgentTools,
	// Email
	registerEmailTools,
	registerDomainTools,
	registerInboxTools,
	// Phone
	registerPhoneTools,
	registerSmsTools,
	registerPhoneCallTools,
	// Platform
	registerWorkspaceTools,
	registerWebhookTools,
	// Vault
	registerVaultTools,
	// Extension
	registerExtensionTools,
];

/**
 * Registers every Anima tool group onto a single McpServer. Used by the
 * `/mcp` endpoint that clients use for a one-URL install experience.
 *
 * For scoped / tailored access, clients can hit per-domain paths instead
 * (/agent, /email, /phone, /platform, /vault, /extension) — each of those
 * registers only that domain's tools.
 */
export function buildAllToolsServer(client: ApiClient): McpServer {
	const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
	const context: ToolRegistrationOptions = {
		server,
		context: { client, hasMasterKey: client.hasMasterKey() },
	};

	for (const register of ALL_TOOL_REGISTRARS) {
		register(context);
	}

	return server;
}
