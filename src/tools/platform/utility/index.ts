import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	listOutput,
	objectOutput,
	statusOutput,
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
			title: "Discover Anima",
			description:
				"Find the right Anima MCP tool for an intent in plain English. Use this when you don't remember the exact tool name. Returns a ranked list of {name, description, why} so you can pick. Falls back to keyword matching when the platform's pgvector index is unavailable.",
			inputSchema: discoverInput.shape,
			outputSchema: objectOutput(),
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

	server.registerTool(
		"whoami",
		{
			title: "Who Am I",
			description:
				"Return identity details for the current API credential, plus the running MCP server's deploy identity (commitSha, revision, buildId). Use to verify which account and scope you're operating under AND which version of the MCP server is actually serving you. The mcpServer block answers 'did my fix actually land?' in one call — compare commitSha against the merge commit you expected to deploy.",
			inputSchema: noInput.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
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

	server.registerTool(
		"check_health",
		{
			title: "Check Health",
			description:
				"Check API health status from the server health endpoint, plus the MCP server's deploy identity. Returns api={...} (upstream API health) and mcpServer={commitSha, revision, buildId, startedAt}. Use this before troubleshooting tool failures to confirm BOTH service availability AND that you're hitting the deploy you think you are.",
			inputSchema: noInput.shape,
			outputSchema: statusOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
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

	server.registerTool(
		"workspace_health",
		{
			title: "Workspace Health",
			description:
				"Workspace-level self-diagnosis: returns canSendEmail, canSendSms, current credential context, inventory counts (agents, domains, phones), and a list of typed blockers. Each blocker carries `tool` (the canonical MCP tool that resolves it) and `toolHint` (how to call it) when an automated remediation exists — so you can go from diagnosis to action in one round-trip. Callable by ANY authenticated credential — agent-key, master, or admin:full OAuth — no escalation required. Use this before non-trivial workflows to check 'can I do X right now?' without paying a real send/call to find out. Closes the gap that check_health (server-only health) and who_am_i (identity only) leave open.",
			inputSchema: noInput.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
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

// Concepts + List_Capabilities removed 2026-05-13: PascalCase identifiers
// that the MCP SDK flagged on every server boot ("Tool name contains
// invalid characters"), and the content was static hardcoded JSON that
// doesn't justify a tool slot. Documentation lives at docs.useanima.sh.

function registerManagePendingTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"manage_pending",
		{
			title: "Manage Pending",
			description:
				"Approve or reject a pending message requiring manual decision. Use this to unblock held messages with an explicit action and optional reason.",
			inputSchema: managePendingInput.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
			},
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

	server.registerTool(
		"check_followups",
		{
			title: "Check Followups",
			description:
				"Drain and return queued follow-up reminders for blocked messages. Use this to poll reminders generated by the pending follow-up scheduler.",
			inputSchema: noInput.shape,
			outputSchema: listOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		withErrorHandling(async () => {
			const result = drainFollowUps();
			return toolSuccess(result);
		}, options.context),
	);
}

function registerMessageAgentTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"message_agent",
		{
			title: "Message Agent",
			description: "Send an email message to another agent by agent name.",
			inputSchema: messageAgentInput.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: false, destructiveHint: false },
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

	server.registerTool(
		"check_messages",
		{
			title: "Check Messages",
			description:
				"Check inbound messages with optional unread-only filtering and compact formatting.",
			inputSchema: checkMessagesInput.shape,
			outputSchema: listOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
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

	server.registerTool(
		"wait_for_email",
		{
			title: "Wait for Email",
			description:
				"Poll inbound messages until a matching email arrives or timeout expires.",
			inputSchema: waitForEmailInput.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
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

	server.registerTool(
		"call_agent",
		{
			title: "Call Agent",
			description:
				"Send a synchronous request to another agent and wait for reply.",
			inputSchema: callAgentInput.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: false, destructiveHint: false },
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

	server.registerTool(
		"update_metadata",
		{
			title: "Update Metadata",
			description: "Update metadata for the current agent identity.",
			inputSchema: updateMetadataInput.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: false, destructiveHint: false },
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

// setup_email_domain + send_test_email removed 2026-05-13: pure duplicates
// of domain_add and email_send. Use those canonical tools instead.

function registerManageSpamTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"manage_spam",
		{
			title: "Manage Spam",
			description: "List, report, and unmark spam messages.",
			inputSchema: manageSpamInput.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: false, destructiveHint: false },
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

	server.registerTool(
		"check_tasks",
		{
			title: "Check Tasks",
			description:
				"Fetch task-assignment messages filtered by metadata type and optional status.",
			inputSchema: checkTasksInput.shape,
			outputSchema: listOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
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
	registerManagePendingTool(options);
	registerCheckFollowupsTool(options);
	registerMessageAgentTool(options);
	registerCheckMessagesTool(options);
	registerWaitForEmailTool(options);
	registerCallAgentTool(options);
	registerUpdateMetadataTool(options);
	registerManageSpamTool(options);
	registerCheckTasksTool(options);
}
