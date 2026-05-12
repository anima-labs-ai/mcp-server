import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	withErrorHandling,
	toolSuccess,
	requireMasterKeyGuard,
} from "../../../shared/index.js";

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | undefined {
	return typeof value === "object" && value !== null
		? (value as UnknownRecord)
		: undefined;
}

function extractOrgId(accountPayload: unknown): string | undefined {
	const account = asRecord(accountPayload);
	if (!account) return undefined;

	if (typeof account.orgId === "string") return account.orgId;

	const org = asRecord(account.org);
	if (org && typeof org.id === "string") return org.id;

	return undefined;
}

function detectWarnings(content: string): Array<{ type: string; severity: string; detail: string }> {
	const warnings: Array<{ type: string; severity: string; detail: string }> = [];

	if (/\b\d{3}-\d{2}-\d{4}\b/.test(content)) {
		warnings.push({
			type: "PII_DETECTED",
			severity: "HIGH",
			detail: "Detected SSN-like pattern in content.",
		});
	}

	if (/\b(?:\d[ -]*?){13,16}\b/.test(content)) {
		warnings.push({
			type: "PII_DETECTED",
			severity: "HIGH",
			detail: "Detected potential payment card number pattern.",
		});
	}

	if (/\bAKIA[0-9A-Z]{16}\b/.test(content) || /\bsk_(?:live|test)_[A-Za-z0-9]{10,}\b/.test(content)) {
		warnings.push({
			type: "PII_DETECTED",
			severity: "HIGH",
			detail: "Detected potential credential or API key pattern.",
		});
	}

	if (/ignore previous instructions|jailbreak|developer mode|\[SYSTEM\]/i.test(content)) {
		warnings.push({
			type: "INJECTION_DETECTED",
			severity: "MEDIUM",
			detail: "Detected potential prompt-injection language.",
		});
	}

	return warnings;
}

export function registerSecurityTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	const securityApproveInput = z.object({
		orgId: z.string().describe("Organization ID owning the pending message."),
		messageId: z.string().describe("Pending message ID to review."),
		action: z
			.enum(["approve", "reject"])
			.describe("Review decision to apply to the pending message."),
		reason: z
			.string()
			.optional()
			.describe("Optional review rationale, especially useful on rejection."),
	});
	const securityListEventsInput = z.object({
		orgId: z.string().describe("Organization ID to list events from."),
		agentId: z
			.string()
			.optional()
			.describe("Optional agent ID filter for narrowing event scope."),
		eventType: z
			.string()
			.optional()
			.describe("Optional security event type filter, such as PII_DETECTED."),
		limit: z
			.number()
			.int()
			.positive()
			.optional()
			.describe("Optional maximum number of events to return."),
		cursor: z
			.string()
			.optional()
			.describe("Optional pagination cursor from a previous response."),
	});
	const securityGetPolicyInput = z.object({
		orgId: z.string().describe("Organization ID owning the agent."),
		agentId: z.string().describe("Agent ID whose security policy should be read."),
	});
	const securityUpdatePolicyInput = z.object({
		orgId: z.string().describe("Organization ID owning the agent."),
		agentId: z.string().describe("Agent ID whose security policy should be updated."),
		scanLevel: z
			.string()
			.optional()
			.describe("Optional scan level, typically off, basic, or strict."),
		injectionScanEnabled: z
			.boolean()
			.optional()
			.describe("Optional toggle for prompt-injection detection checks."),
		autoApproveBelow: z
			.string()
			.optional()
			.describe("Optional approval threshold, such as medium, high, or none."),
		allowedDomains: z
			.array(z.string())
			.optional()
			.describe("Optional explicit allow-list of outbound domains."),
		blockedPatterns: z
			.array(z.string())
			.optional()
			.describe("Optional deny-list of content patterns to block."),
	});
	const securityScanContentInput = z.object({
		orgId: z.string().describe("Organization ID to scan content for."),
		content: z.string().describe("Content payload to scan for potential risks."),
		channel: z
			.string()
			.optional()
			.describe("Optional intended channel, such as EMAIL or SMS."),
	});

	server.registerTool(
		"security_approve",
		{
			title: "Approve Security",
			description: "Approve or reject a message that is waiting in pending-review state. Use this to unblock compliant outbound content or explicitly reject risky messages.",
			inputSchema: securityApproveInput.shape,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post(
				`/v1/orgs/${args.orgId}/messages/${args.messageId}/approve`,
				{
					action: args.action,
					reason: args.reason,
				},
				{ useMasterKey: true },
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"security_list_events",
		{
			title: "List Security Events",
			description: "List security events for an organization with optional agent and event-type filters. Use this for incident triage, compliance review, and audit timelines.",
			inputSchema: securityListEventsInput.shape,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.agentId) params.set("agentId", args.agentId);
			if (args.eventType) params.set("type", args.eventType);
			if (args.limit !== undefined) params.set("limit", String(args.limit));
			if (args.cursor) params.set("cursor", args.cursor);

			const basePath = `/v1/orgs/${args.orgId}/security/events`;
			const path = params.toString() ? `${basePath}?${params}` : basePath;
			const result = await context.client.get(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"security_get_policy",
		{
			title: "Get Security Policy",
			description: "Fetch the active security policy for an agent, including scan level and domain constraints. Use this before changing enforcement behavior or diagnosing blocked messages.",
			inputSchema: securityGetPolicyInput.shape,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get(
				`/v1/orgs/${args.orgId}/agents/${args.agentId}/security-policy`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"security_update_policy",
		{
			title: "Update Security Policy",
			description: "Update an agent security policy to tune scanning strictness, domain allow-lists, and blocking patterns. Use this to harden or relax outbound message controls.",
			inputSchema: securityUpdatePolicyInput.shape,
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const { orgId, agentId, ...policy } = args;
			const result = await context.client.put(
				`/v1/orgs/${orgId}/agents/${agentId}/security-policy`,
				{
					orgId,
					agentId,
					policy,
				},
				{ useMasterKey: true },
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"security_scan_content",
		{
			title: "Scan Security Content",
			description: "Dry-run scan message content for likely PII or injection issues without sending any outbound message. Use this as a preflight safety check before calling message send tools.",
			inputSchema: securityScanContentInput.shape,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			let recentEvents: unknown = [];
			try {
				const eventsPath = `/v1/orgs/${args.orgId}/security/events?limit=10`;
				recentEvents = await context.client.get(eventsPath);
			} catch {
				// Security events endpoint may not be available; continue with scan
			}

			const warnings = detectWarnings(args.content);
			return toolSuccess({
				dryRun: true,
				channel: args.channel ?? "EMAIL",
				passed: warnings.length === 0,
				warnings,
				recentSecurityEvents: recentEvents,
				note:
					"This tool performs a local heuristic scan and supplements results with recent security events for context. No outbound message is sent.",
			});
		}, options.context),
	);
}
