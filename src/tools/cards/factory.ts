import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SERVER_INFO as CORE_SERVER_INFO, type ApiClient, type ToolRegistrationOptions } from "../../shared/index.js";
import { registerCardTools } from "./cards/index.js";
import { registerWalletTools } from "./wallet/index.js";
import { registerFundingTools } from "./funding/index.js";
import { registerInvoiceTools } from "./invoice/index.js";
import { registerBrowserPaymentsTools } from "./browser-payments/index.js";
import { registerX402Tools } from "./x402/index.js";

const SERVER_INFO = {
	...CORE_SERVER_INFO,
	name: "anima-mcp-cards",
	version: "0.1.0",
	description: "Anima MCP Server — Cards, wallet, funding, invoice, browser-payments, and x402 tools",
};

export function buildCardsServer(client: ApiClient): McpServer {
	const server = new McpServer(SERVER_INFO, { capabilities: { tools: {} } });
	const context: ToolRegistrationOptions = {
		server,
		context: { client, hasMasterKey: client.hasMasterKey() },
	};
	registerCardTools(context);
	registerWalletTools(context);
	registerFundingTools(context);
	registerInvoiceTools(context);
	registerBrowserPaymentsTools(context);
	registerX402Tools(context);
	return server;
}
