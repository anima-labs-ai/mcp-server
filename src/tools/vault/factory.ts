import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INFO as CORE_SERVER_INFO, type ApiClient, type ToolRegistrationOptions } from "../../shared/index.js";
import { registerVaultTools } from "./vault/index.js";
import { registerOAuthTools } from "./vault/oauth.js";

const SERVER_INFO = {
	...CORE_SERVER_INFO,
	name: "anima-mcp-vault",
	version: "0.1.0",
	description: "Anima MCP Server — Vault credential and OAuth tools",
};

export function buildVaultServer(client: ApiClient): McpServer {
	const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
	const context: ToolRegistrationOptions = {
		server,
		context: { client, hasMasterKey: client.hasMasterKey() },
	};
	registerVaultTools(context);
	registerOAuthTools(context);
	return server;
}
