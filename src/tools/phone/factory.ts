import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INFO as CORE_SERVER_INFO, type ApiClient, type ToolRegistrationOptions } from "../../shared/index.js";
import { registerPhoneTools } from "./phone/index.js";
import { registerPhoneCallTools } from "./phone_call/index.js";
import { registerSmsTools } from "./sms/index.js";

const SERVER_INFO = {
	...CORE_SERVER_INFO,
	name: "anima-mcp-phone",
	version: "0.1.0",
	description: "Anima MCP Server — Phone number, SMS, and phone call tools",
};

export function buildPhoneServer(client: ApiClient): McpServer {
	const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
	const context: ToolRegistrationOptions = {
		server,
		context: { client, hasMasterKey: client.hasMasterKey() },
	};
	registerPhoneTools(context);
	registerSmsTools(context);
	registerPhoneCallTools(context);
	return server;
}
