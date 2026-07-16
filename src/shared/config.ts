/**
 * MCP Server Configuration
 *
 * Environment-based configuration and constants for the MCP server.
 */

/** Tool names that require master key access */
export const MASTER_KEY_TOOLS = new Set([
	"agent_delete",
	"domain_create",
	"domain_delete",
	"domain_verify",
	// Inbox mutations mirror the API's requireMaster gate
	// (apps/api/src/routes/handlers/inbox.ts). inbox_list / inbox_get are
	// any-key. If D2 (agent-key inbox creation) lands, drop inbox_create
	// here AND remove its requireMasterKeyGuard call together.
	"inbox_create",
	"inbox_update",
	"inbox_delete",
]);

/** Raw base64-encoded Anima sparkle icon (96x96 PNG, ~4 KB) */
export const ANIMA_ICON_PNG_BASE64 =
	"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";

/** Data URI version for MCP serverInfo.icons */
const ANIMA_ICON_DATA_URI = `data:image/png;base64,${ANIMA_ICON_PNG_BASE64}`;

/** Server metadata (not `as const` — MCP SDK expects mutable icon arrays) */
export const SERVER_INFO = {
	name: "anima-mcp",
	title: "Anima",
	version: "2.0.0",
	description:
		"Manage email, phone, SMS, webhooks, and agent infrastructure for AI agents directly from Claude. Anima is the unified identity platform for autonomous agents.",
	websiteUrl: "https://useanima.sh",
	icons: [
		// Order matters: clients that pick the first workable icon get the
		// HTTPS URL (lazy-fetched, cached by client) before the inline data
		// URI fallback. Largest size first — clients downscale as needed.
		{
			src: "https://console.useanima.sh/icon-512.png",
			mimeType: "image/png",
			sizes: ["512x512"],
		},
		{
			src: "https://console.useanima.sh/icon-192.png",
			mimeType: "image/png",
			sizes: ["192x192"],
		},
		{
			src: "https://mcp.useanima.sh/icon.png",
			mimeType: "image/png",
			sizes: ["96x96"],
		},
		// Inline data URI as last-resort fallback so the icon is always
		// available even if the client cannot fetch external URLs.
		{
			src: ANIMA_ICON_DATA_URI,
			mimeType: "image/png",
			sizes: ["96x96"],
		},
	],
};

/** Default configuration values */
export const DEFAULTS = {
	apiUrl: "http://127.0.0.1:3100",
	mcpPort: 8014,
	requestTimeoutMs: 30_000,
	maxListLimit: 100,
	defaultListLimit: 20,
} as const;

/** Configuration loaded from environment */
export interface McpConfig {
	apiUrl: string;
	apiKey: string;
	masterKey?: string;
	httpMode: boolean;
	httpPort: number;
}

/** Load MCP configuration from environment variables and CLI args.
 *  Cloud Run sets PORT env var — when present, auto-enables HTTP mode. */
export function loadConfig(args: string[] = process.argv): McpConfig {
	const portEnv = process.env.PORT ?? process.env.MCP_PORT;
	const portArg = args.find((a) => a.startsWith("--port="));

	const httpPort = portArg
		? Number.parseInt(portArg.split("=")[1], 10)
		: portEnv
			? Number.parseInt(portEnv, 10)
			: DEFAULTS.mcpPort;

	// Auto-enable HTTP mode when PORT is set (Cloud Run convention) or --http flag
	const httpMode = args.includes("--http") || !!process.env.PORT;

	return {
		apiUrl: process.env.ANIMA_API_URL ?? DEFAULTS.apiUrl,
		apiKey: process.env.ANIMA_API_KEY ?? "",
		masterKey: process.env.ANIMA_MASTER_KEY,
		httpMode,
		httpPort,
	};
}
