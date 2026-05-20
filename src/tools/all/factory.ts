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

// Phone domain
import { registerPhoneTools } from "../phone/phone/index.js";
import { registerSmsTools } from "../phone/sms/index.js";
import { registerPhoneCallTools } from "../phone/phone_call/index.js";

// Platform domain
import { registerWorkspaceTools } from "../platform/workspace/index.js";
import { registerWebhookTools } from "../platform/webhook/index.js";

// Vault domain
import { registerVaultTools } from "../vault/vault/index.js";

const SERVER_INFO = {
	...CORE_SERVER_INFO,
	name: "anima-mcp",
	version: "0.1.0",
	description:
		"Anima MCP Server — unified endpoint exposing all Anima tools (agent, email, phone, platform, vault).",
};

/**
 * Registers every Anima tool group onto a single McpServer. Used by the
 * `/mcp` endpoint that clients use for a one-URL install experience.
 *
 * For scoped / tailored access, clients can hit per-domain paths instead
 * (/agent, /email, /phone, /platform, /vault) — each of those
 * registers only that domain's tools.
 */
export function buildAllToolsServer(client: ApiClient): McpServer {
	const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
	const context: ToolRegistrationOptions = {
		server,
		context: { client, hasMasterKey: client.hasMasterKey() },
	};

	// Agent
	registerAgentTools(context);

	// Email
	registerEmailTools(context);
	registerDomainTools(context);

	// Phone
	registerPhoneTools(context);
	registerSmsTools(context);
	registerPhoneCallTools(context);

	// Platform
	registerWorkspaceTools(context);
	registerWebhookTools(context);

	// Vault
	registerVaultTools(context);

	return server;
}
