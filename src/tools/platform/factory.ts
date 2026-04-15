import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INFO as CORE_SERVER_INFO, type ApiClient, type ToolRegistrationOptions } from "../../shared/index.js";
import { registerUtilityTools } from "./utility/index.js";
import { registerWebhookTools } from "./webhook/index.js";
import { registerPodTools } from "./pod/index.js";

const SERVER_INFO = {
	...CORE_SERVER_INFO,
	name: "anima-mcp-platform",
	version: "0.1.0",
	description:
		"Manage email, phone, SMS, webhooks, and agent infrastructure for AI agents directly from Claude. Anima is the unified identity platform for autonomous agents.",
};

export function buildPlatformServer(client: ApiClient): McpServer {
	const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
	const context: ToolRegistrationOptions = {
		server,
		context: { client, hasMasterKey: client.hasMasterKey() },
	};
	registerUtilityTools(context);
	registerWebhookTools(context);
	registerPodTools(context);
	return server;
}
