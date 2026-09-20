// mcp-server/src/auth.ts
import type { IncomingMessage } from "node:http";
import { ApiClient, ApiError } from "./shared/index.js";
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
const AUTH_FAILURE_STATUSES = new Set([401, 403]);
const INVALID_CREDENTIALS_MESSAGE = "Invalid or expired credentials";

type OrgRecord = { id: string };
type OrgListResponse = OrgRecord[] | { items?: OrgRecord[] };

function getOrgIdFromOrgRecord(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const candidate = (payload as { id?: unknown }).id;
  return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

function getOrgIdFromOrgList(payload: unknown): string | undefined {
  if (Array.isArray(payload)) {
    return getOrgIdFromOrgRecord(payload[0]);
  }
  if (!payload || typeof payload !== "object") return undefined;
  const items = (payload as { items?: unknown }).items;
  return Array.isArray(items) ? getOrgIdFromOrgRecord(items[0]) : undefined;
}

function isAuthFailure(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    AUTH_FAILURE_STATUSES.has(error.status)
  );
}

function formatProbeError(error: unknown): string {
  if (error instanceof ApiError) return `status=${error.status}`;
  if (error instanceof Error) return error.message;
  return "unknown-error";
}

async function resolveOrgId(client: ApiClient, allowFailOpen: boolean): Promise<string> {
  const authFailures: unknown[] = [];
  const probes: Array<{
    path: string;
    extractOrgId: (payload: unknown) => string | undefined;
  }> = [
    { path: "/v1/orgs/me", extractOrgId: getOrgIdFromOrgRecord },
    { path: "/v1/orgs", extractOrgId: getOrgIdFromOrgList },
  ];

  for (const probe of probes) {
    try {
      const payload = await client.get<unknown>(probe.path);
      return probe.extractOrgId(payload) ?? "default";
    } catch (error) {
      if (isAuthFailure(error)) {
        authFailures.push(error);
        continue;
      }
      console.warn(
        `[mcp-auth] probe ${probe.path} failed (${formatProbeError(error)}); treating credentials as still valid`,
      );
    }
  }

  if (authFailures.length > 0 || !allowFailOpen) {
    const err: McpAuthError = { status: 401, message: INVALID_CREDENTIALS_MESSAGE };
    throw err;
  }

  return "default";
}

export function makeAuthenticator(apiUrl: string): (req: IncomingMessage) => Promise<McpAuthContext> {
  return async function authenticate(req): Promise<McpAuthContext> {
    const token = parseBearerToken(req);
    if (!token) {
      // No credentials: hand back an anonymous context rather than refusing.
      // The transport confines such a session to introspection (see
      // ANONYMOUS_METHODS) — it can learn what tools exist, and call none of
      // them. The client carries no key, so even a bug that let a tool run
      // would reach the API unauthenticated and be refused there too.
      //
      // This exists because a 401 on `initialize` makes the server opaque to
      // every directory and client that wants to show its tool list.
      return {
        apiKeyId: "anonymous",
        orgId: "anonymous",
        client: new ApiClient({ baseUrl: apiUrl, apiKey: "" }),
        anonymous: true,
      };
    }
    if (token.length > MAX_TOKEN_LENGTH) {
      const err: McpAuthError = { status: 401, message: "Token exceeds maximum length" };
      throw err;
    }
    const hasKnownPrefix = KNOWN_PREFIXES.some((p) => token.startsWith(p));
    if (!hasKnownPrefix) {
      // Unknown prefix — still pass through to the API, but do not fail-open
      // on transport blips because we have no confidence this is a real token
      // family. This keeps arbitrary bearer strings from authenticating during
      // transient upstream incidents.
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
    // Known token families (ak_/mk_/oat_/...) are allowed to fail open when
    // auth probes hit non-auth upstream errors; unknown prefixes must still
    // prove validity with at least one successful probe.
    const orgId = await resolveOrgId(client, hasKnownPrefix);
    return { apiKeyId: token, orgId, client };
  };
}
