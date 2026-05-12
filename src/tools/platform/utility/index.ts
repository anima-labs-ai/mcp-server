import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	registerToolWithAliases,
	requireMasterKeyGuard,
	toolError,
	toolSuccess,
	withErrorHandling,
} from "../../../shared/index.js";
import { drainFollowUps } from "../../../shared/pending-followup.js";

const noInput = z.object({});

/**
 * Deploy identity exposed via Who_Am_I and Check_Health.
 *
 * Customer-suggested debugging affordance: when iterating tightly with an
 * agent, "did my fix actually land?" is the highest-value first hypothesis
 * after a no-op test result. Surfacing the running deploy's commit SHA +
 * Cloud Run revision turns that 5-minute conversation into a one-tool-call
 * check (call Who_Am_I, compare commitSha against `git rev-parse HEAD`).
 *
 * Sources:
 *   - BUILD_SHA / BUILD_ID — set in cloudbuild.yaml on every deploy
 *   - K_REVISION / K_SERVICE — Cloud Run injects automatically
 *   - startedAt — captured at module load (one process lifetime per pod)
 *
 * Falls back to "dev" / "local" when running outside Cloud Run (local
 * `bun run dev`), so the field is always present and never noisy.
 */
const STARTED_AT = new Date().toISOString();
function getMcpServerInfo() {
	return {
		commitSha: process.env.BUILD_SHA?.trim() || "dev",
		buildId: process.env.BUILD_ID?.trim() || "local",
		revision: process.env.K_REVISION?.trim() || "local",
		service: process.env.K_SERVICE?.trim() || "mcp-server-local",
		startedAt: STARTED_AT,
	};
}

const managePendingInput = z.object({
	messageId: z.string().describe("Pending message ID"),
	action: z
		.enum(["approve", "reject"])
		.describe("Decision to apply to the pending message"),
	reason: z
		.string()
		.optional()
		.describe("Optional explanation for approval or rejection"),
});

const messageAgentInput = z.object({
	agentName: z.string().min(1).describe("Name of the target agent"),
	subject: z.string().min(1).describe("Email subject"),
	body: z.string().min(1).describe("Email body"),
	priority: z
		.enum(["normal", "high", "urgent"])
		.optional()
		.describe("Optional message priority"),
});

const checkMessagesInput = z.object({
	unreadOnly: z
		.boolean()
		.optional()
		.describe("Only return unread inbound messages"),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Maximum number of messages to return"),
});

const waitForEmailInput = z.object({
	timeout: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Timeout in seconds (default 60, max 300)"),
	from: z.string().optional().describe("Optional sender match filter"),
	subject: z.string().optional().describe("Optional subject match filter"),
});

const callAgentInput = z.object({
	agentName: z.string().min(1).describe("Name of the target agent"),
	message: z.string().min(1).describe("Message body to send"),
	timeout: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Timeout in seconds for waiting on reply (default 30)"),
});

const updateMetadataInput = z.object({
	metadata: z.record(z.string()).describe("Metadata key-value pairs to set"),
});

const setupEmailDomainInput = z.object({
	domain: z.string().min(1).describe("Custom domain to configure"),
});

const sendTestEmailInput = z.object({
	to: z.string().min(1).describe("Recipient email address for test message"),
});

const manageSpamInput = z.object({
	action: z.enum(["list", "report", "not_spam"]),
	messageId: z.string().optional(),
});

const checkTasksInput = z.object({
	status: z.string().optional().describe("Optional task status filter"),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Max number of inbound messages to return (default 20)"),
});

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		return null;
	}
	return value as JsonObject;
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

function asArray(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

function getAgentsFromResponse(payload: unknown): JsonObject[] {
	if (Array.isArray(payload)) {
		return payload
			.map((entry) => asObject(entry))
			.filter((entry): entry is JsonObject => entry !== null);
	}

	const root = asObject(payload);
	if (!root) return [];

	const items = asArray(root.items);
	return items
		.map((entry) => asObject(entry))
		.filter((entry): entry is JsonObject => entry !== null);
}

function resolveAgentEmail(agent: JsonObject): string | undefined {
	const directEmail = asString(agent.email);
	if (directEmail) return directEmail;

	const identities = asArray(agent.identities);
	for (const identity of identities) {
		const identityObject = asObject(identity);
		if (!identityObject) continue;

		const email =
			asString(identityObject.email) ??
			asString(identityObject.address) ??
			asString(identityObject.value);
		if (email) return email;
	}

	return undefined;
}

function pickMessageFields(message: unknown): JsonObject {
	const messageObject = asObject(message) ?? {};
	return {
		id: messageObject.id,
		from: messageObject.from,
		subject: messageObject.subject,
		status: messageObject.status,
		unread: messageObject.unread,
		receivedAt: messageObject.receivedAt ?? messageObject.createdAt,
	};
}

function isMessageMatch(
	message: unknown,
	from?: string,
	subject?: string,
): boolean {
	const messageObject = asObject(message);
	if (!messageObject) return false;

	const messageFrom = asString(messageObject.from) ?? "";
	const messageSubject = asString(messageObject.subject) ?? "";

	const fromMatches = from
		? messageFrom.toLowerCase().includes(from.toLowerCase())
		: true;
	const subjectMatches = subject
		? messageSubject.toLowerCase().includes(subject.toLowerCase())
		: true;

	return fromMatches && subjectMatches;
}

function parseMessageTimestamp(message: unknown): number {
	const messageObject = asObject(message);
	if (!messageObject) return 0;

	const dateValue =
		asString(messageObject.receivedAt) ?? asString(messageObject.createdAt);
	if (!dateValue) return 0;

	const parsed = Date.parse(dateValue);
	return Number.isNaN(parsed) ? 0 : parsed;
}

function findAgentByName(
	payload: unknown,
	agentName: string,
): JsonObject | undefined {
	const normalizedName = agentName.toLowerCase();
	const agents = getAgentsFromResponse(payload);
	return agents.find((agent) => {
		const candidateName =
			asString(agent.name) ?? asString(agent.agentName) ?? "";
		return candidateName.toLowerCase() === normalizedName;
	});
}

function registerDiscoverTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	const discoverInput = z.object({
		intent: z
			.string()
			.min(3)
			.describe(
				"Plain-English description of what you want to do, e.g. 'send a follow-up email to a customer who replied' or 'place a call to their phone'.",
			),
		limit: z
			.number()
			.int()
			.positive()
			.max(20)
			.optional()
			.describe("Max number of tools to return (default 5)."),
	});

	server.registerTool(
		"anima_discover",
		{
			description:
				"Find the right Anima MCP tool for an intent in plain English. Use this when you don't remember the exact tool name. Returns a ranked list of {name, description, why} so you can pick. Falls back to keyword matching when the platform's pgvector index is unavailable.",
			inputSchema: discoverInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		withErrorHandling(async (args, context) => {
			// Server-side endpoint backed by pgvector; falls back to fuzzy
			// keyword search if the embedding generator is unavailable.
			const limit = args.limit ?? 5;
			const url = `/v1/mcp/discover?intent=${encodeURIComponent(args.intent)}&limit=${limit}`;
			try {
				const result = await context.client.get<{
					matches: Array<{
						name: string;
						description: string;
						score: number;
						why: string;
					}>;
				}>(url);
				return toolSuccess({
					intent: args.intent,
					matches: result.matches,
					hint:
						result.matches.length > 0
							? `Top match: \`${result.matches[0]?.name}\`. Call its schema with tools/list to see the input shape.`
							: "No close matches. Try a more specific intent or use tools/list to browse the catalog.",
				});
			} catch (error) {
				// If the discover endpoint isn't deployed yet (404), gracefully
				// degrade: return a static hint pointing to tools/list.
				if (error instanceof Error && error.message.includes("404")) {
					return toolSuccess({
						intent: args.intent,
						matches: [],
						hint: "Discovery service not yet enabled. Use tools/list to browse the full catalog of 190+ tools.",
					});
				}
				return toolError(
					`Discovery failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			}
		}, options.context),
	);
}

// 2026-05-12: renamed Who Am I / Check Health / Workspace Health from
// space-separated names to lower_snake_case to fix MCP SDK identifier
// warnings ("Tool name contains spaces, which may cause parsing issues").
// Each keeps the old space-name AND the underscore-normalized form
// ("Who_Am_I") as deprecated aliases — clients pin to one or the other
// depending on their tools/list normalization rules, so both must
// remain callable until usage logs go quiet.
// Added MCP-spec `title` field so clients render the human-readable
// label in pickers — customer feedback: "names should be human like
// `email_send` → `Send Email`".

function registerWhoAmITool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"who_am_i",
		["Who Am I", "Who_Am_I"],
		{
			title: "Who Am I",
			description:
				"Return identity details for the current API credential, plus the running MCP server's deploy identity (commitSha, revision, buildId). Use to verify which account and scope you're operating under AND which version of the MCP server is actually serving you. The mcpServer block answers 'did my fix actually land?' in one call — compare commitSha against the merge commit you expected to deploy.",
			inputSchema: noInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling(async (_args, context) => {
			const result = await context.client.get<Record<string, unknown>>("/v1/orgs/me");
			return toolSuccess({
				...result,
				mcpServer: getMcpServerInfo(),
			});
		}, options.context),
	);
}

function registerCheckHealthTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"check_health",
		["Check Health", "Check_Health"],
		{
			title: "Check Health",
			description:
				"Check API health status from the server health endpoint, plus the MCP server's deploy identity. Returns api={...} (upstream API health) and mcpServer={commitSha, revision, buildId, startedAt}. Use this before troubleshooting tool failures to confirm BOTH service availability AND that you're hitting the deploy you think you are.",
			inputSchema: noInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling(async (_args, context) => {
			const result = await context.client.get<Record<string, unknown>>("/health");
			return toolSuccess({
				api: result,
				mcpServer: getMcpServerInfo(),
			});
		}, options.context),
	);
}

/**
 * Map workspace-health error codes to the canonical MCP tool that resolves
 * them. Kept here (not on the API) because the relevant tool name is an
 * MCP-layer concern — other API consumers (CLI, SDKs, the dashboard) have
 * their own remediation surfaces. Forward-compatible: codes not in this
 * map pass through with the original {code, hint} shape only, so adding
 * a new blocker on the API side doesn't break Workspace_Health responses.
 *
 * Customer feedback: "Concepts already documents typed_error_codes.
 * Workspace_Health blockers should carry the next tool to call, not just
 * a hint string — closes the gap between diagnosis and remediation."
 */
const BLOCKER_REMEDIATION: Record<
	string,
	{ tool: string; toolHint: string }
> = {
	NO_VERIFIED_EMAIL_IDENTITY: {
		tool: "agent_email_identity_add",
		toolHint:
			"Call agent_email_identity_add with an address on a workspace-verified domain. The verification worker flips identities to verified within ~60s of SES confirming.",
	},
	NO_VERIFIED_DOMAIN: {
		tool: "domain_verify",
		toolHint:
			"After publishing the DNS records (domain_dns_records), call domain_verify to ask SES to re-check.",
	},
	// ORG_SUSPENDED intentionally has no tool — the only remediation is to
	// contact support@useanima.sh, which is a human action, not an MCP call.
};

function registerWorkspaceHealthTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"workspace_health",
		["Workspace Health", "Workspace_Health"],
		{
			title: "Workspace Health",
			description:
				"Workspace-level self-diagnosis: returns canSendEmail, canSendSms, current credential context, inventory counts (agents, domains, phones), and a list of typed blockers. Each blocker carries `tool` (the canonical MCP tool that resolves it) and `toolHint` (how to call it) when an automated remediation exists — so you can go from diagnosis to action in one round-trip. Callable by ANY authenticated credential — agent-key, master, or admin:full OAuth — no escalation required. Use this before non-trivial workflows to check 'can I do X right now?' without paying a real send/call to find out. Closes the gap that check_health (server-only health) and who_am_i (identity only) leave open.",
			inputSchema: noInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling(async (_args, context) => {
			const result = await context.client.get<Record<string, unknown>>(
				"/v1/orgs/me/workspace-health",
			);

			// Defensive: the API contract says blockers is an array, but we
			// shouldn't crash the whole response if a future contract change
			// drops the field or returns null. Preserve everything else.
			const rawBlockers = Array.isArray(result.blockers)
				? (result.blockers as Array<{ code: string; hint: string }>)
				: [];

			const enrichedBlockers = rawBlockers.map((b) => {
				const remediation = BLOCKER_REMEDIATION[b.code];
				if (!remediation) return b;
				return { ...b, tool: remediation.tool, toolHint: remediation.toolHint };
			});

			return toolSuccess({ ...result, blockers: enrichedBlockers });
		}, options.context),
	);
}

function registerConceptsTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"Concepts",
		{
			description:
				"Return a short conceptual map of the Anima platform: how Agents, EmailIdentities, PhoneIdentities, Domains, Inboxes, Pods, and DIDs relate. Useful for cold-started agents that need to reason about resource lifecycles before making writes. Returns a JSON doc — no API call, instant.",
			inputSchema: noInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		withErrorHandling(async (_args, _context) => {
			return toolSuccess({
				resources: {
					Organization: {
						summary: "The top-level tenant (workspace). Owns everything else.",
						owns: ["Agent", "Domain", "ApiKey"],
						auth: "Master key (mk_), or a Clerk session for an org owner/admin, or an OAuth token with admin:full scope.",
					},
					Agent: {
						summary:
							"An autonomous actor inside an Org. Holds its own ApiKey (ak_), DID, EmailIdentities, PhoneIdentities, optional Pod.",
						owns: ["EmailIdentity", "PhoneIdentity", "VaultIdentity", "Inbox"],
						lifecycle: "agent_create → agent_update → (rotate_key | delete)",
						auth_tier:
							"Agents have agent-level auth (their own ak_ key). Master operations (delete, etc.) require the org's master key or admin:full OAuth.",
					},
					EmailIdentity: {
						summary: "An email address an Agent can send from / receive at.",
						relationships: {
							belongs_to: "Agent",
							inherits_verification_from: "Domain",
						},
						readiness:
							"`verified` flips to true when the parent Domain is verified (PR #62 + email-identity-verification-worker). The Layer 3 send pre-flight refuses outbound on unverified identities.",
						lifecycle:
							"agent_create implicitly creates one on the platform default (agents.useanima.sh). agent_email_identity_add attaches more on workspace-verified domains.",
					},
					PhoneIdentity: {
						summary:
							"A phone number an Agent can send SMS / make voice calls from.",
						belongs_to: "Agent",
						lifecycle:
							"phone_provision → (10DLC if SMS US) → phone_send_sms / voice_create_call → phone_release",
					},
					Domain: {
						summary:
							"A workspace-level email domain (e.g. brawz.ai). Verified via DNS records before any agent can attach an EmailIdentity on it.",
						belongs_to: "Organization",
						verification:
							"DNS-based (TXT + DKIM + SPF + MX). Tracked on the Domain row; cascaded to EmailIdentities by the email-identity-verification worker.",
					},
					Inbox: {
						summary:
							"Receiving address for inbound mail. Auto-created with each Agent on the same address as the primary EmailIdentity.",
					},
					Pod: {
						summary:
							"A sandboxed runtime an Agent can launch to execute code (HTTP requests, scripts, etc.).",
						belongs_to: "Agent",
					},
					DID: {
						summary:
							"Decentralized Identifier (W3C). Each Agent gets one (`did:anima:<orgId>:<agentId>`) at create time with an Ed25519 keypair. Used for verifiable credentials and agent-to-agent auth.",
						belongs_to: "Agent",
					},
					Domain_vs_EmailIdentity:
						"Domain is the workspace-level DNS-verified entity (e.g. brawz.ai). EmailIdentity is the per-agent address on that domain (e.g. digest@brawz.ai). One Domain → many EmailIdentity rows; verification status cascades down.",
				},
				typical_flows: {
					"send first email": [
						"agent_create with desired name (auto-creates @agents.useanima.sh EmailIdentity)",
						"Workspace_Health → check canSendEmail",
						"if false: agent_email_identity_add with a workspace-verified-domain address (e.g. hello@brawz.ai)",
						"agent_email_identity_set_primary on the new identity",
						"email_send (pre-flight will accept the now-verified primary)",
					],
					"attach a custom domain": [
						"domain_add brawz.ai (creates Domain row)",
						"domain_dns_records → publish records at DNS provider",
						"domain_verify (loops until SES confirms)",
						"agent_email_identity_add on any agent for an address on brawz.ai",
					],
					"diagnose 'cannot send' error": [
						"Workspace_Health → look at blockers[]",
						"if IDENTITY_NOT_VERIFIED: wait for the email-identity-verification worker (60s loop) or call agent_email_identity_verify to inspect current state",
						"if DOMAIN_NOT_VERIFIED: re-check DNS, call domain_verify",
					],
				},
				typed_error_codes: {
					MASTER_KEY_REQUIRED:
						"403. Use a master key, sign in as org owner/admin via Clerk, or grant admin:full scope on your OAuth token.",
					IDENTITY_NOT_VERIFIED:
						"409. Send pre-flight rejected because the chosen identity isn't verified yet. Check details.domainVerified — if true, just one identity; if false, fix the domain first.",
					DOMAIN_NOT_VERIFIED:
						"409. agent_create or agent_email_identity_add refused a custom-domain identity because the parent domain isn't verified for the workspace.",
					IDEMPOTENCY_BODY_MISMATCH:
						"409. Reused an Idempotency-Key with a different request body. Use a fresh key for new requests.",
				},
				docs: "https://docs.useanima.sh",
				adr: "https://github.com/anima-labs-ai/anima/blob/main/docs/adr/0001-agent-creation-readiness-model.md",
			});
		}, options.context),
	);
}

function registerListCapabilitiesTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"List_Capabilities",
		{
			description:
				"Return what the CURRENT credential can do — auth tier + tool families that work for that tier. Calls /v1/orgs/me to learn the credential context, then attaches a static catalog of tool families bucketed by required auth tier (anyAuth / agentOrMaster / masterOnly). Saves exploratory calls — instead of trial-and-error on 'is this master-only?' the LLM gets the answer up front. Pair with Workspace_Health for capability state (canSendEmail etc.).",
			inputSchema: noInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		withErrorHandling(async (_args, context) => {
			// Source of truth for which credential is calling — same call as Who_Am_I.
			const orgInfo = await context.client
				.get<{ id: string; name: string; tier: string }>("/v1/orgs/me")
				.catch(() => null);

			// Static catalog. Updated when new tool families ship. Categorized
			// by the AUTH TIER required server-side, not by feature area —
			// LLMs ask "can I call this?" much more than "is this email or
			// phone?".
			//
			// Buckets:
			//   - any_auth: anyone with a valid Bearer token (master, agent,
			//     OAuth) can call. Read-only diagnostics + scoped reads.
			//   - agent_or_master: agent-key callers can act on themselves;
			//     master and admin:full OAuth can act on any agent.
			//   - master_only: requires master key, Clerk privileged role, or
			//     admin:full OAuth scope.
			return toolSuccess({
				credential: orgInfo
					? { orgId: orgInfo.id, orgName: orgInfo.name, tier: orgInfo.tier }
					: { error: "Could not resolve credential — token may be invalid" },
				note: "tools/list returns the full registered set. This response groups them by required auth tier so you don't have to discover that empirically.",
				any_auth: {
					description:
						"Read-only or self-diagnosis. Agent-bound credentials work too.",
					families: [
						"Who_Am_I",
						"Check_Health",
						"Workspace_Health",
						"Concepts",
						"List_Capabilities",
					],
				},
				agent_or_master: {
					description:
						"Acts on resources owned by an agent. Agent-key callers can only see/touch their own agent; master + admin:full OAuth can touch any agent in the org.",
					families: [
						"agent_get",
						"agent_list / List_Agents",
						"list_addresses / get_address / create_address / update_address / validate_address",
						"phone_list / phone_status / phone_search / phone_send_sms",
						"email_list / email_get / email_search / email_send / email_reply / email_forward (and message_* aliases)",
						"vault_list_credentials / vault_get_credential / vault_search / vault_status / vault_oauth_*",
						"voice_list_calls / voice_get_call / voice_get_transcript / voice_get_summary",
						"webhook tools (List_Webhooks, Get_Webhook, Webhook_Stats, ...)",
						"Pod tools (List_Pods, Create_Pod, ...)",
					],
				},
				master_only: {
					description:
						"Requires master tier. Throws MASTER_KEY_REQUIRED 403 with a remediation hint pointing at admin:full OAuth or a mk_ key.",
					families: [
						"agent_create / agent_update / agent_delete / agent_rotate_key",
						"agent_email_identity_add / agent_email_identity_set_primary / agent_email_identity_verify / agent_email_identity_delete",
						"org_create / org_update / org_delete / org_rotate_key / org_list",
						"domain_add / domain_verify / domain_delete",
						"phone_provision / phone_release",
						"security_update_policy",
						"vault_create_credential / vault_delete_credential / vault_share_credential",
						"create_webhook / update_webhook / delete_webhook",
					],
				},
				oauth_scopes: {
					description:
						"For OAuth (oat_) tokens: which scopes unlock which tool families.",
					"admin:full": "All master_only tools + everything below",
					"email:read / email:send_as": "Email read / send tools",
					"phone:read_sms / phone:send_sms": "Phone read / send tools",
					"vault:read_credential:{label} / vault:read_all": "Vault read tools",
					"addresses:read": "Address read tools",
					"webhooks:subscribe": "Webhook subscribe tools",
				},
			});
		}, options.context),
	);
}

// 2026-05-09: removed registerListAgentsTool. The "List Agents"
// platform utility was a duplicate of agent_list (registered in
// agent/agent/index.ts) — same handler, same data, both surfaced in
// the catalog as separate tools. agent_list is the canonical name in
// snake_case matching the rest of the agent_* tool family.

// 2026-05-12: renamed 11 utility tools from space-separated names to
// lower_snake_case. Same pattern as the Pod / Webhook migrations:
// canonical snake_case + title (the old space form) + both legacy
// alias forms (space + underscore-normalized) marked `deprecate: true`.

function registerManagePendingTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"manage_pending",
		["Manage Pending", "Manage_Pending"],
		{
			title: "Manage Pending",
			description:
				"Approve or reject a pending message requiring manual decision. Use this to unblock held messages with an explicit action and optional reason.",
			inputSchema: managePendingInput.shape,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
			},
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof managePendingInput>>(
			async (args, context) => {
				const result = await context.client.post(
					`/v1/messages/${args.messageId}/approve`,
					{
						action: args.action,
						reason: args.reason,
					},
				);
				return toolSuccess(result);
			},
			options.context,
		),
	);
}

function registerCheckFollowupsTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"check_followups",
		["Check Followups", "Check_Followups"],
		{
			title: "Check Followups",
			description:
				"Drain and return queued follow-up reminders for blocked messages. Use this to poll reminders generated by the pending follow-up scheduler.",
			inputSchema: noInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling(async () => {
			const result = drainFollowUps();
			return toolSuccess(result);
		}, options.context),
	);
}

function registerMessageAgentTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"message_agent",
		["Message Agent", "Message_Agent"],
		{
			title: "Message Agent",
			description: "Send an email message to another agent by agent name.",
			inputSchema: messageAgentInput.shape,
			annotations: { readOnlyHint: false, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof messageAgentInput>>(
			async (args, context) => {
				const agents = await context.client.get("/v1/agents");
				const targetAgent = findAgentByName(agents, args.agentName);
				if (!targetAgent) {
					return toolError(`Agent not found: ${args.agentName}`);
				}

				const targetEmail = resolveAgentEmail(targetAgent);
				if (!targetEmail) {
					return toolError(
						`No email identity found for agent: ${args.agentName}`,
					);
				}

				const result = await context.client.post("/v1/messages/email", {
					to: targetEmail,
					subject: args.subject,
					body: args.body,
					priority: args.priority,
				});
				return toolSuccess(result);
			},
			options.context,
		),
	);
}

function registerCheckMessagesTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"check_messages",
		["Check Messages", "Check_Messages"],
		{
			title: "Check Messages",
			description:
				"Check inbound messages with optional unread-only filtering and compact formatting.",
			inputSchema: checkMessagesInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof checkMessagesInput>>(async (args, context) => {
			// API enum is uppercase (MessageDirectionSchema in @anima/contracts).
			// Lowercase "inbound" trips the zod validator → "Input validation
			// failed" with no further detail.
			const params = new URLSearchParams();
			params.set("direction", "INBOUND");
			if (args.unreadOnly) params.set("unreadOnly", "true");
			if (args.limit) params.set("limit", String(args.limit));

			const messagesResponse = await context.client.get<{ items?: unknown[] }>(
				`/v1/messages?${params.toString()}`,
			);
			const messages = asArray(messagesResponse.items).map((message) =>
				pickMessageFields(message),
			);
			return toolSuccess({ items: messages, count: messages.length });
		}, options.context),
	);
}

function registerWaitForEmailTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"wait_for_email",
		["Wait for Email", "Wait_for_Email"],
		{
			title: "Wait for Email",
			description:
				"Poll inbound messages until a matching email arrives or timeout expires.",
			inputSchema: waitForEmailInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof waitForEmailInput>>(async (args, context) => {
			const startTime = Date.now();
			const timeout = (args.timeout ?? 60) * 1000;
			const maxTimeout = 300000;
			const effectiveTimeout = Math.min(timeout, maxTimeout);

			while (Date.now() - startTime < effectiveTimeout) {
				const messagesResponse = await context.client.get<{ items: unknown[] }>(
					"/v1/messages?direction=inbound&limit=5",
				);
				const messages = asArray(messagesResponse.items);
				const match = messages.find((message) =>
					isMessageMatch(message, args.from, args.subject),
				);

				if (match) {
					return toolSuccess(match);
				}

				await new Promise((resolve) => setTimeout(resolve, 5000));
			}

			return toolError("Timeout waiting for email");
		}, options.context),
	);
}

function registerCallAgentTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"call_agent",
		["Call Agent", "Call_Agent"],
		{
			title: "Call Agent",
			description:
				"Send a synchronous request to another agent and wait for reply.",
			inputSchema: callAgentInput.shape,
			annotations: { readOnlyHint: false, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof callAgentInput>>(async (args, context) => {
			const agents = await context.client.get("/v1/agents");
			const targetAgent = findAgentByName(agents, args.agentName);
			if (!targetAgent) {
				return toolError(`Agent not found: ${args.agentName}`);
			}

			const targetEmail = resolveAgentEmail(targetAgent);
			if (!targetEmail) {
				return toolError(
					`No email identity found for agent: ${args.agentName}`,
				);
			}

			const requestSentAt = Date.now();
			await context.client.post("/v1/messages/email", {
				to: targetEmail,
				subject: `Sync call from ${args.agentName}`,
				body: args.message,
				priority: "high",
			});

			const timeoutMs = (args.timeout ?? 30) * 1000;
			while (Date.now() - requestSentAt < timeoutMs) {
				const response = await context.client.get<{ items: unknown[] }>(
					"/v1/messages?direction=inbound&limit=10",
				);
				const items = asArray(response.items);
				const reply = items.find((message) => {
					const messageObject = asObject(message);
					if (!messageObject) return false;
					const from = asString(messageObject.from) ?? "";
					const fromMatches = from
						.toLowerCase()
						.includes(targetEmail.toLowerCase());
					const isNew = parseMessageTimestamp(message) >= requestSentAt;
					return fromMatches && isNew;
				});

				if (reply) {
					return toolSuccess(reply);
				}

				await new Promise((resolve) => setTimeout(resolve, 5000));
			}

			return toolError("Timeout waiting for agent reply");
		}, options.context),
	);
}

function registerUpdateMetadataTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"update_metadata",
		["Update Metadata", "Update_Metadata"],
		{
			title: "Update Metadata",
			description: "Update metadata for the current agent identity.",
			inputSchema: updateMetadataInput.shape,
			annotations: { readOnlyHint: false, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof updateMetadataInput>>(async (args, context) => {
			// Resolve the "current agent" via OAuth userinfo. For agent-bound
			// oat_* grants (`anima.agentId` non-null) this returns the
			// delegated agent's ID. For user-bound grants and non-OAuth
			// credentials there is no implicit "current agent" — point the
			// caller at agent_update with an explicit ID instead of guessing.
			const userinfo = await context.client
				.get("/v1/oauth/userinfo")
				.catch(() => null);
			const userinfoObject = asObject(userinfo);
			const animaContext = asObject(userinfoObject?.anima);
			const agentId = asString(animaContext?.agentId);

			if (!agentId) {
				return toolError(
					"No 'current agent' bound to this credential. Use agent_update with an explicit agent ID instead.",
				);
			}

			const result = await context.client.patch(`/v1/agents/${agentId}`, {
				metadata: args.metadata,
			});
			return toolSuccess(result);
		}, options.context),
	);
}

function registerSetupEmailDomainTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"setup_email_domain",
		["Setup Email Domain", "Setup_Email_Domain"],
		{
			title: "Setup Email Domain",
			description:
				"Configure a custom email domain for account setup workflows.",
			inputSchema: setupEmailDomainInput.shape,
			annotations: { readOnlyHint: false, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof setupEmailDomainInput>>(async (args, context) => {
			requireMasterKeyGuard(options.context);
			const result = await context.client.post("/v1/domains", {
				domain: args.domain,
			});
			return toolSuccess(result);
		}, options.context),
	);
}

function registerSendTestEmailTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"send_test_email",
		["Send Test Email", "Send_Test_Email"],
		{
			title: "Send Test Email",
			description: "Send a simple test email for setup verification.",
			inputSchema: sendTestEmailInput.shape,
			annotations: { readOnlyHint: false, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof sendTestEmailInput>>(async (args, context) => {
			requireMasterKeyGuard(options.context);
			const result = await context.client.post("/v1/email/send", {
				to: args.to,
				subject: "Test from Anima",
				body: "Test from Anima",
			});
			return toolSuccess(result);
		}, options.context),
	);
}

function registerManageSpamTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"manage_spam",
		["Manage Spam", "Manage_Spam"],
		{
			title: "Manage Spam",
			description: "List, report, and unmark spam messages.",
			inputSchema: manageSpamInput.shape,
			annotations: { readOnlyHint: false, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof manageSpamInput>>(async (args, context) => {
			if (args.action === "list") {
				// MessageStatusSchema doesn't include a "SPAM" value — spam
				// detection is folded into BLOCKED (security-policy gate).
				// Use BLOCKED so the listing actually returns; downstream
				// callers filter further by metadata if they need only spam.
				const result = await context.client.get("/v1/messages?status=BLOCKED");
				return toolSuccess(result);
			}

			if (!args.messageId) {
				return toolError(
					"messageId is required when action is report or not_spam",
				);
			}

			if (args.action === "report") {
				const result = await context.client.post(
					`/v1/messages/${args.messageId}/spam`,
					{},
				);
				return toolSuccess(result);
			}

			const result = await context.client.post(
				`/v1/messages/${args.messageId}/not-spam`,
				{},
			);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerCheckTasksTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	registerToolWithAliases(
		server,
		"check_tasks",
		["Check Tasks", "Check_Tasks"],
		{
			title: "Check Tasks",
			description:
				"Fetch task-assignment messages filtered by metadata type and optional status.",
			inputSchema: checkTasksInput.shape,
			annotations: { readOnlyHint: true, destructiveHint: false },
			deprecate: true,
		},
		withErrorHandling<z.infer<typeof checkTasksInput>>(async (args, context) => {
			// API expects uppercase INBOUND (MessageDirectionSchema). The
			// `metadata.type=task` filter isn't a supported query param —
			// MessageListInput in @anima/contracts has no metadata filter,
			// so the API rejects the whole call with "Input validation
			// failed". Drop it; callers that want true task-only filtering
			// can post-process the inbound results client-side.
			//
			// Default limit=20 matches MessageListInput's pagination default
			// upstream. Without this cap a busy inbox returned ~900KB of
			// full message bodies + raw email headers and overflowed the
			// MCP response token budget.
			const params = new URLSearchParams();
			params.set("direction", "INBOUND");
			params.set("limit", String(args.limit ?? 20));
			if (args.status) params.set("status", args.status);

			const result = await context.client.get(
				`/v1/messages?${params.toString()}`,
			);
			return toolSuccess(result);
		}, options.context),
	);
}

export function registerUtilityTools(options: ToolRegistrationOptions): void {
	registerDiscoverTool(options);
	registerWhoAmITool(options);
	registerCheckHealthTool(options);
	registerWorkspaceHealthTool(options);
	registerConceptsTool(options);
	registerListCapabilitiesTool(options);
	registerManagePendingTool(options);
	registerCheckFollowupsTool(options);
	registerMessageAgentTool(options);
	registerCheckMessagesTool(options);
	registerWaitForEmailTool(options);
	registerCallAgentTool(options);
	registerUpdateMetadataTool(options);
	registerSetupEmailDomainTool(options);
	registerSendTestEmailTool(options);
	registerManageSpamTool(options);
	registerCheckTasksTool(options);
}
