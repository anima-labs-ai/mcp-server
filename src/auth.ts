// mcp-server/src/auth.ts
import type { IncomingMessage } from "node:http";
import { ApiClient } from "./shared/index.js";
import { parseBearerToken } from "./transport/http.js";
import type { McpAuthContext, McpAuthError } from "./transport/http.js";

const VALID_KEY_PREFIXES = ["ak_", "mk_", "sk_live_", "sk_test_"];

export function makeAuthenticator(apiUrl: string): (req: IncomingMessage) => Promise<McpAuthContext> {
  return async function authenticate(req): Promise<McpAuthContext> {
    const token = parseBearerToken(req);
    if (!token) {
      const err: McpAuthError = { status: 401, message: "Missing Authorization header" };
      throw err;
    }
    if (!VALID_KEY_PREFIXES.some((p) => token.startsWith(p))) {
      const err: McpAuthError = { status: 401, message: "Invalid API key format" };
      throw err;
    }
    const client = new ApiClient({ baseUrl: apiUrl, apiKey: token });
    let orgId = "default";
    try {
      const orgs = await client.get<Array<{ id: string }>>("/orgs");
      if (Array.isArray(orgs) && orgs[0]?.id) orgId = orgs[0].id;
    } catch {
      const err: McpAuthError = { status: 401, message: "Invalid or expired API key" };
      throw err;
    }
    return { apiKeyId: token, orgId, client };
  };
}
