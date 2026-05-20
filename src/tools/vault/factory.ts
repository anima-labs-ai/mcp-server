import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INFO as CORE_SERVER_INFO, type ApiClient, type ToolRegistrationOptions } from "../../shared/index.js";
import { registerVaultTools } from "./vault/index.js";

const SERVER_INFO = {
	...CORE_SERVER_INFO,
	name: "anima-mcp-vault",
	version: "0.1.0",
	description: "Anima MCP Server — Vault credential CRUD",
};

// OAuth-link tools dropped 2026-05-20 alongside the vault group trim
// (vault_oauth_list_apps / create_link / link_status / list_accounts /
// disconnect / require_auth). OAuth credential capture is handled by
// the credential-broker now (separate surface, not in the vault tool group).

export function buildVaultServer(client: ApiClient): McpServer {
	const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
	const context: ToolRegistrationOptions = {
		server,
		context: { client, hasMasterKey: client.hasMasterKey() },
	};
	registerVaultTools(context);
	return server;
}
