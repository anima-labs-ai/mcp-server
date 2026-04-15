import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	requireMasterKeyGuard,
	toolError,
	withErrorHandling,
	toolSuccess,
} from "../../../shared/index.js";
import { drainFollowUps } from "../../../shared/pending-followup.js";

const noInput = z.object({});

const listAgentsInput = z.object({
	cursor: z.string().optional().describe("Pagination cursor from a previous response"),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Maximum number of agents to return"),
});

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
	unreadOnly: z.boolean().optional().describe("Only return unread inbound messages"),
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

function isMessageMatch(message: unknown, from?: string, subject?: string): boolean {
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

function findAgentByName(payload: unknown, agentName: string): JsonObject | undefined {
	const normalizedName = agentName.toLowerCase();
	const agents = getAgentsFromResponse(payload);
	return agents.find((agent) => {
		const candidateName = asString(agent.name) ?? asString(agent.agentName) ?? "";
		return candidateName.toLowerCase() === normalizedName;
	});
}

function registerWhoAmITool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"Who Am I",
		"Return identity details for the current API credential. Use this to verify which account and scope the MCP server is operating under.",
		noInput.shape,
		{ readOnlyHint: true, destructiveHint: false },
		withErrorHandling(async (_args, context) => {
			const result = await context.client.get("/accounts/me");
			return toolSuccess(result);
		}, options.context),
	);
}

function registerCheckHealthTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"Check Health",
		"Check API health status from the server health endpoint. Use this before troubleshooting tool failures to confirm service availability.",
		noInput.shape,
		{ readOnlyHint: true, destructiveHint: false },
		withErrorHandling(async (_args, context) => {
			const result = await context.client.get("/health");
			return toolSuccess(result);
		}, options.context),
	);
}

function registerListAgentsTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"List Agents",
		"List available agents with optional pagination. Use this as a discovery utility to inspect agent inventory before selecting one.",
		listAgentsInput.shape,
		{ readOnlyHint: true, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.cursor) params.set("cursor", args.cursor);
			if (args.limit) params.set("limit", String(args.limit));
			const path = params.toString() ? `/agents?${params.toString()}` : "/agents";
			const result = await context.client.get(path);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerManagePendingTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"Manage Pending",
		"Approve or reject a pending message requiring manual decision. Use this to unblock held messages with an explicit action and optional reason.",
		managePendingInput.shape,
		{ readOnlyHint: false, destructiveHint: false, idempotentHint: true },
		withErrorHandling(async (args, context) => {
			const result = await context.client.post(
				`/messages/${args.messageId}/approve`,
				{
					action: args.action,
					reason: args.reason,
				},
			);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerCheckFollowupsTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"Check Followups",
		"Drain and return queued follow-up reminders for blocked messages. Use this to poll reminders generated by the pending follow-up scheduler.",
		noInput.shape,
		{ readOnlyHint: true, destructiveHint: false },
		withErrorHandling(async () => {
			const result = drainFollowUps();
			return toolSuccess(result);
		}, options.context),
	);
}

function registerMessageAgentTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"Message Agent",
		"Send an email message to another agent by agent name.",
		messageAgentInput.shape,
		{ readOnlyHint: false, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const agents = await context.client.get("/agents");
			const targetAgent = findAgentByName(agents, args.agentName);
			if (!targetAgent) {
				return toolError(`Agent not found: ${args.agentName}`);
			}

			const targetEmail = resolveAgentEmail(targetAgent);
			if (!targetEmail) {
				return toolError(`No email identity found for agent: ${args.agentName}`);
			}

			const result = await context.client.post("/messages/email", {
				to: targetEmail,
				subject: args.subject,
				body: args.body,
				priority: args.priority,
			});
			return toolSuccess(result);
		}, options.context),
	);
}

function registerCheckMessagesTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"Check Messages",
		"Check inbound messages with optional unread-only filtering and compact formatting.",
		checkMessagesInput.shape,
		{ readOnlyHint: true, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			params.set("direction", "inbound");
			if (args.unreadOnly) params.set("unreadOnly", "true");
			if (args.limit) params.set("limit", String(args.limit));

			const messagesResponse = await context.client.get<{ items?: unknown[] }>(
				`/messages?${params.toString()}`,
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

	server.tool(
		"Wait for Email",
		"Poll inbound messages until a matching email arrives or timeout expires.",
		waitForEmailInput.shape,
		{ readOnlyHint: true, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const startTime = Date.now();
			const timeout = (args.timeout ?? 60) * 1000;
			const maxTimeout = 300000;
			const effectiveTimeout = Math.min(timeout, maxTimeout);

			while (Date.now() - startTime < effectiveTimeout) {
				const messagesResponse = await context.client.get<{ items: unknown[] }>(
					"/messages?direction=inbound&limit=5",
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

	server.tool(
		"Call Agent",
		"Send a synchronous request to another agent and wait for reply.",
		callAgentInput.shape,
		{ readOnlyHint: false, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const agents = await context.client.get("/agents");
			const targetAgent = findAgentByName(agents, args.agentName);
			if (!targetAgent) {
				return toolError(`Agent not found: ${args.agentName}`);
			}

			const targetEmail = resolveAgentEmail(targetAgent);
			if (!targetEmail) {
				return toolError(`No email identity found for agent: ${args.agentName}`);
			}

			const requestSentAt = Date.now();
			await context.client.post("/messages/email", {
				to: targetEmail,
				subject: `Sync call from ${args.agentName}`,
				body: args.message,
				priority: "high",
			});

			const timeoutMs = (args.timeout ?? 30) * 1000;
			while (Date.now() - requestSentAt < timeoutMs) {
				const response = await context.client.get<{ items: unknown[] }>(
					"/messages?direction=inbound&limit=10",
				);
				const items = asArray(response.items);
				const reply = items.find((message) => {
					const messageObject = asObject(message);
					if (!messageObject) return false;
					const from = asString(messageObject.from) ?? "";
					const fromMatches = from.toLowerCase().includes(targetEmail.toLowerCase());
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

	server.tool(
		"Update Metadata",
		"Update metadata for the current agent identity.",
		updateMetadataInput.shape,
		{ readOnlyHint: false, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const whoami = await context.client.get("/accounts/me");
			const whoamiObject = asObject(whoami);
			const agentId =
				asString(whoamiObject?.id) ??
				asString(asObject(whoamiObject?.agent)?.id) ??
				asString(whoamiObject?.agentId);

			if (!agentId) {
				return toolError("Could not determine current agent ID");
			}

			const result = await context.client.patch(`/agents/${agentId}`, {
				metadata: args.metadata,
			});
			return toolSuccess(result);
		}, options.context),
	);
}

function registerSetupEmailDomainTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"Setup Email Domain",
		"Configure a custom email domain for account setup workflows.",
		setupEmailDomainInput.shape,
		{ readOnlyHint: false, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(options.context);
			const result = await context.client.post("/domains", { domain: args.domain });
			return toolSuccess(result);
		}, options.context),
	);
}

function registerSendTestEmailTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"Send Test Email",
		"Send a simple test email for setup verification.",
		sendTestEmailInput.shape,
		{ readOnlyHint: false, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(options.context);
			const result = await context.client.post("/email/send", {
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

	server.tool(
		"Manage Spam",
		"List, report, and unmark spam messages.",
		manageSpamInput.shape,
		{ readOnlyHint: false, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			if (args.action === "list") {
				const result = await context.client.get("/messages?status=SPAM");
				return toolSuccess(result);
			}

			if (!args.messageId) {
				return toolError("messageId is required when action is report or not_spam");
			}

			if (args.action === "report") {
				const result = await context.client.post(`/messages/${args.messageId}/spam`, {});
				return toolSuccess(result);
			}

			const result = await context.client.post(
				`/messages/${args.messageId}/not-spam`,
				{},
			);
			return toolSuccess(result);
		}, options.context),
	);
}

function registerCheckTasksTool(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.tool(
		"Check Tasks",
		"Fetch task-assignment messages filtered by metadata type and optional status.",
		checkTasksInput.shape,
		{ readOnlyHint: true, destructiveHint: false },
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			params.set("direction", "inbound");
			params.set("metadata.type", "task");
			if (args.status) params.set("status", args.status);

			const result = await context.client.get(`/messages?${params.toString()}`);
			return toolSuccess(result);
		}, options.context),
	);
}

export function registerUtilityTools(options: ToolRegistrationOptions): void {
	registerWhoAmITool(options);
	registerCheckHealthTool(options);
	registerListAgentsTool(options);
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
