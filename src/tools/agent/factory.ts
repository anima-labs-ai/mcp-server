import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INFO as CORE_SERVER_INFO, type ApiClient, type ToolRegistrationOptions } from "../../shared/index.js";
import { registerAgentTools } from "./agent/index.js";
import { registerOrganizationTools } from "./organization/index.js";
import { registerIdentityTools } from "./identity/index.js";
import { registerRegistryTools } from "./registry/index.js";
import { registerA2aTools } from "./a2a/index.js";

const SERVER_INFO = {
	...CORE_SERVER_INFO,
	name: "anima-mcp-agent",
	version: "0.1.0",
	description: "Anima MCP Server — Agent, organization, identity, registry, and A2A tools",
};

export function buildAgentServer(client: ApiClient): McpServer {
	const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
	const context: ToolRegistrationOptions = {
		server,
		context: { client, hasMasterKey: client.hasMasterKey() },
	};
	registerAgentTools(context);
	registerOrganizationTools(context);
	registerIdentityTools(context);
	registerRegistryTools(context);
	registerA2aTools(context);
	return server;
}
