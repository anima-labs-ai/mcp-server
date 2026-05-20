import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import { objectOutput, toolSuccess, withErrorHandling } from "../../../shared/index.js";

// 2026-05-20: utility group reduced to two self-introspection tools.
// Anything message-shaped (messages_check, tasks_check, spam_manage,
// pending_manage), inter-agent (agent_message, agent_call), MCP-stateful
// (followups_check, email_wait), generic-debug (health_check), or
// meta-discovery (anima_discover) was dropped to keep this group focused
// on "what is my workspace?" reads.
//
// Earlier removals: whoami + workspace_health + me_update folded into
// account_overview (me_update had a design bug — see prior commits).
// Concepts + List_Capabilities removed 2026-05-13 (static JSON, not tool
// material). setup_email_domain + send_test_email removed 2026-05-13 as
// dupes of domain_add + email_send.

/**
 * Deploy identity surfaced via account_overview.mcpServer.
 *
 * Customer-suggested debugging affordance: when iterating tightly with
 * an agent, "did my fix actually land?" is the highest-value first
 * hypothesis after a no-op test result. Surfacing the running deploy's
 * commit SHA + Cloud Run revision turns that 5-minute conversation
 * into a one-tool-call check (call account_overview, compare commitSha
 * against `git rev-parse HEAD`).
 *
 * Sources:
 *   - BUILD_SHA / BUILD_ID — set in cloudbuild.yaml on every deploy
 *   - K_REVISION / K_SERVICE — Cloud Run injects automatically
 *   - startedAt — captured at module load (one process lifetime per pod)
 *
 * Falls back to "dev" / "local" when running outside Cloud Run, so the
 * field is always present and never noisy.
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

const noInput = z.object({});

const usageOverviewInput = z.object({
	period: z
		.string()
		.regex(/^\d{4}-\d{2}$/)
		.optional()
		.describe(
			"Billing period in YYYY-MM format (e.g. '2026-05'). Defaults to the current calendar month in UTC.",
		),
});

/**
 * Map workspace-health error codes to the canonical MCP tool that
 * resolves them. Kept here (not on the API) because the relevant tool
 * name is an MCP-layer concern — other API consumers (CLI, SDKs, the
 * dashboard) have their own remediation surfaces. Forward-compatible:
 * codes not in this map pass through with the original {code, hint}
 * shape only, so adding a new blocker on the API side doesn't break
 * account_overview responses.
 */
const BLOCKER_REMEDIATION: Record<string, { tool: string; toolHint: string }> = {
	NO_VERIFIED_DOMAIN: {
		tool: "domain_verify",
		toolHint:
			"After publishing the DNS records (domain_dns_records), call domain_verify to ask SES to re-check.",
	},
	// ORG_SUSPENDED intentionally has no tool — the only remediation is
	// to contact support@useanima.sh, which is a human action.
};

function registerAccountOverviewTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"account_overview",
		{
			title: "Account Overview",
			description:
				"Single-call workspace snapshot: organization context, credential identity, send-capability flags (canSendEmail / canSendSms), inventory counts (agents, domains, phones), active blockers (each carrying the canonical MCP tool that resolves it), and the running MCP server's deploy identity (commitSha, revision, buildId, startedAt). Strict superset of the legacy whoami + workspace_health pair. Use before any non-trivial workflow to answer 'who am I, can I do X right now, and which deploy is serving me?' in one round-trip — no real send needed to find out.",
			inputSchema: noInput.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		withErrorHandling(async (_args, context) => {
			// Two parallel reads: /orgs/me gives the full org profile
			// (slug, keyRotatedAt, createdAt) while /orgs/me/workspace-health
			// gives status, capabilities, inventory, blockers, and the
			// auth-context block that whoami used to surface.
			const [org, health] = await Promise.all([
				context.client.get<Record<string, unknown>>("/v1/orgs/me"),
				context.client.get<Record<string, unknown>>(
					"/v1/orgs/me/workspace-health",
				),
			]);

			// Defensive: contract says blockers is an array, but don't crash
			// the whole response if a future contract change drops the field.
			const rawBlockers = Array.isArray(health.blockers)
				? (health.blockers as Array<{ code: string; hint: string }>)
				: [];

			const enrichedBlockers = rawBlockers.map((b) => {
				const remediation = BLOCKER_REMEDIATION[b.code];
				if (!remediation) return b;
				return { ...b, tool: remediation.tool, toolHint: remediation.toolHint };
			});

			return toolSuccess({
				...health,
				blockers: enrichedBlockers,
				organization: {
					id: org.id,
					name: org.name,
					slug: org.slug,
					tier: org.tier,
					keyRotatedAt: org.keyRotatedAt,
					createdAt: org.createdAt,
				},
				mcpServer: getMcpServerInfo(),
			});
		}, options.context),
	);
}

function registerUsageOverviewTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"usage_overview",
		{
			title: "Usage Overview",
			description:
				"Usage rollup for a billing period. Returns counters keyed by usage type (e.g. 'email_sent', 'sms_sent', 'voice_call_minutes') plus the latest update timestamp. Defaults to the current calendar month in UTC when `period` is omitted. Read-only, callable by any authenticated credential — scoped to the caller's org. Use to answer 'where am I against my tier limits?' without paying for per-event detail (UsageEvent is operator-tier).",
			inputSchema: usageOverviewInput.shape,
			outputSchema: objectOutput(),
			annotations: { readOnlyHint: true, destructiveHint: false },
		},
		withErrorHandling<z.infer<typeof usageOverviewInput>>(
			async (args, context) => {
				const params = new URLSearchParams();
				if (args.period) params.set("period", args.period);
				const qs = params.toString();
				const url = qs ? `/v1/orgs/me/usage?${qs}` : "/v1/orgs/me/usage";
				const result = await context.client.get(url);
				return toolSuccess(result);
			},
			options.context,
		),
	);
}

export function registerUtilityTools(options: ToolRegistrationOptions): void {
	registerAccountOverviewTool(options);
	registerUsageOverviewTool(options);
}
