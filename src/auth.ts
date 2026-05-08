// mcp-server/src/auth.ts
import type { IncomingMessage } from "node:http";
import { ApiClient } from "./shared/index.js";
import { parseBearerToken } from "./transport/http.js";
import type { McpAuthContext, McpAuthError } from "./transport/http.js";

// Known token prefixes. This is a registry for observability, NOT a hard
// gate — `apps/api` (auth.ts:resolveAuth) is authoritative on whether a
// token is valid. Adding a new token type to the API does not require
// updating this list, but listing it here means we don't emit a "saw an
// unknown prefix" warning every time the new type shows up in the wild.
//
//   ak_       agent API keys
//   mk_       master API keys
//   sk_live_  live secret keys
//   sk_test_  test secret keys
//   oat_      OAuth 2.1 access tokens (Anima Connect; Wave 3J.2)
//   stk_      scoped tokens
const KNOWN_PREFIXES = ["ak_", "mk_", "sk_live_", "sk_test_", "oat_", "stk_"];

// Real Anima tokens cap around ~70 chars (oat_ + 32-byte base64url is 47).
// Bound at 256 so we don't pay an API round-trip just to learn that a
// multi-MB Bearer string is bogus. This is the only fast-fail check.
const MAX_TOKEN_LENGTH = 256;

export function makeAuthenticator(apiUrl: string): (req: IncomingMessage) => Promise<McpAuthContext> {
  return async function authenticate(req): Promise<McpAuthContext> {
    const token = parseBearerToken(req);
    if (!token) {
      const err: McpAuthError = { status: 401, message: "Missing Authorization header" };
      throw err;
    }
    if (token.length > MAX_TOKEN_LENGTH) {
      const err: McpAuthError = { status: 401, message: "Token exceeds maximum length" };
      throw err;
    }
    if (!KNOWN_PREFIXES.some((p) => token.startsWith(p))) {
      // Unknown prefix — let the API decide, but log so we notice when a
      // new token type ships and this list needs updating.
      const head = token.slice(0, Math.min(token.indexOf("_") + 1, 8)) || token.slice(0, 4);
      console.warn(`[mcp-auth] unknown token prefix "${head}" — passing through to API`);
    }
    // Pass the token as BOTH apiKey and masterKey. The `hasMasterKey()` check
    // and `requireMasterKeyGuard` were designed for local CLI usage where
    // `ANIMA_MASTER_KEY` was a separate env var distinct from the
    // per-request `ANIMA_API_KEY`. In the cloud-deployed mcp.useanima.sh
    // scenario, every request carries one Bearer token and the API
    // (apps/api/src/middleware/auth.ts:resolveAuth) is the only thing that
    // can decide whether that token has master authority — a user-bound
    // `oat_*` token resolves to `keyType: "master"`, an agent-bound one
    // resolves to `keyType: "agent"`, an `sk_live_` to scoped permissions.
    // Optimistically advertise master capability here so client-side guards
    // don't pre-empt; if the API rejects with 403 the caller gets the real
    // permission error instead of a misleading "ANIMA_MASTER_KEY required".
    const client = new ApiClient({ baseUrl: apiUrl, apiKey: token, masterKey: token });
    let orgId = "default";
    try {
      const orgs = await client.get<Array<{ id: string }>>("/v1/orgs");
      if (Array.isArray(orgs) && orgs[0]?.id) orgId = orgs[0].id;
    } catch {
      const err: McpAuthError = { status: 401, message: "Invalid or expired credentials" };
      throw err;
    }
    return { apiKeyId: token, orgId, client };
  };
}
