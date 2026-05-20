import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INFO as CORE_SERVER_INFO, type ApiClient, type ToolRegistrationOptions } from "../../shared/index.js";
import { registerAgentTools } from "./agent/index.js";

const SERVER_INFO = {
	...CORE_SERVER_INFO,
	name: "anima-mcp-agent",
	version: "0.1.0",
	description: "Anima MCP Server — Agent tools",
};

export function buildAgentServer(client: ApiClient): McpServer {
	const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
	const context: ToolRegistrationOptions = {
		server,
		context: { client, hasMasterKey: client.hasMasterKey() },
	};
	registerAgentTools(context);
	return server;
}
