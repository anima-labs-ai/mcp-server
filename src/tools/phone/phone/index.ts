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

function toPhoneStatusList(payload: unknown): Array<{
	phoneNumber: string;
	status: string;
	capabilities: string[];
}> {
	const root = asRecord(payload);
	const candidates = [
		payload,
		root?.items,
		root?.numbers,
		root?.data,
	];

	for (const candidate of candidates) {
		if (!Array.isArray(candidate)) continue;

		return candidate
			.map((entry) => asRecord(entry))
			.filter((entry): entry is UnknownRecord => Boolean(entry))
			.map((entry) => {
				const phoneNumber =
					typeof entry.phoneNumber === "string"
						? entry.phoneNumber
						: typeof entry.number === "string"
							? entry.number
							: "unknown";
				// API doesn't expose a top-level `status` for phone numbers.
				// Derive from tenDlcStatus (SMS-registration state) when
				// present, otherwise treat any provisioned number as
				// "active" — the previous "unknown" was misleading because
				// every number is in fact provisioned and operational.
				const status =
					typeof entry.status === "string"
						? entry.status
						: typeof entry.tenDlcStatus === "string"
							? entry.tenDlcStatus.toLowerCase()
							: phoneNumber !== "unknown"
								? "active"
								: "unknown";
				// API returns capabilities as an object {sms, mms, voice}
				// with boolean values, not a string array — converting an
				// object to Array.isArray returned false and silently
				// produced [].
				const capabilities = (() => {
					if (Array.isArray(entry.capabilities)) {
						return entry.capabilities.filter(
							(value): value is string => typeof value === "string",
						);
					}
					const capObject = asRecord(entry.capabilities);
					if (!capObject) return [];
					return Object.entries(capObject)
						.filter(([, v]) => v === true)
						.map(([k]) => k);
				})();

				return { phoneNumber, status, capabilities };
			});
	}

	return [];
}

const phoneSearchSchema = z.object({
	countryCode: z
		.string()
		.optional()
		.describe("ISO 3166-1 alpha-2 country code to search in (default US)."),
	areaCode: z
		.string()
		.optional()
		.describe("Optional local area code filter for matching numbers."),
	capabilities: z
		.array(z.enum(["sms", "mms", "voice"]))
		.optional()
		.describe("Optional required capabilities for the phone numbers."),
	limit: z
		.number()
		.int()
		.positive()
		.optional()
		.describe("Optional maximum number of available results to return (max 50)."),
});

const phoneProvisionSchema = z.object({
	agentId: z
		.string()
		.describe("Agent ID to assign the provisioned phone number to."),
	countryCode: z
		.string()
		.optional()
		.describe("ISO 3166-1 alpha-2 country code for number selection (default US)."),
	areaCode: z
		.string()
		.optional()
		.describe("Preferred area code for the phone number."),
	capabilities: z
		.array(z.enum(["sms", "mms", "voice"]))
		.optional()
		.describe("Optional capability list such as sms, mms, or voice for the number."),
});

const phoneReleaseSchema = z.object({
	agentId: z
		.string()
		.describe("Agent ID that currently owns the phone number."),
	phoneNumber: z
		.string()
		.describe("E.164 formatted phone number to release."),
});

const phoneSendSmsSchema = z.object({
	agentId: z
		.string()
		.describe("Agent ID sending the SMS message."),
	to: z
		.string()
		.describe("Destination phone number in E.164 format."),
	body: z
		.string()
		.describe("Text message body to send (max 1600 characters)."),
	mediaUrls: z
		.array(z.string())
		.optional()
		.describe("Optional URLs of media attachments for MMS (max 10)."),
});

export function registerPhoneTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"phone_search",
		{
			title: "Search Phone",
			description: "Search available phone numbers for provisioning by geography or digit pattern. Use this to find suitable numbers before provisioning.",
			inputSchema: phoneSearchSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			if (args.countryCode) params.set("countryCode", args.countryCode);
			if (args.areaCode) params.set("areaCode", args.areaCode);
			if (args.capabilities) {
				for (const cap of args.capabilities) {
					params.append("capabilities[]", cap);
				}
			}
			if (args.limit !== undefined) params.set("limit", String(args.limit));

			const path = params.toString() ? `/v1/phone/search?${params}` : "/v1/phone/search";
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"phone_provision",
		{
			title: "Provision Phone",
			description: "Provision a selected phone number for the agent and assign optional capabilities. Use this after choosing a number from phone_search.",
			inputSchema: phoneProvisionSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const body: Record<string, unknown> = { agentId: args.agentId };
			if (args.countryCode) body.countryCode = args.countryCode;
			if (args.areaCode) body.areaCode = args.areaCode;
			if (args.capabilities) body.capabilities = args.capabilities;
			const result = await context.client.post<unknown>("/v1/phone/provision", body);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"phone_release",
		{
			title: "Release Phone",
			description: "Release a previously provisioned phone number so it is no longer assigned. Use this when cleaning up unused or temporary numbers.",
			inputSchema: phoneReleaseSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>("/v1/phone/release", args);
			return toolSuccess(result);
		}, options.context),
	);

	const phoneListSchema = z.object({
		agentId: z
			.string()
			.describe("Agent ID whose phone numbers to list."),
	});

	server.registerTool(
		"phone_list",
		{
			title: "List Phone",
			description: "List all phone numbers assigned to a specific agent. Use this to review active inventory and assigned capabilities.",
			inputSchema: phoneListSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams({ agentId: args.agentId });
			const result = await context.client.get<unknown>(`/v1/phone/numbers?${params}`);
			return toolSuccess(result);
		}, options.context),
	);


	server.registerTool(
		"phone_send_sms",
		{
			title: "Send Phone SMS",
			description: "Send an SMS or MMS message to a destination phone number. Use this for outbound notifications or conversational messaging.",
			inputSchema: phoneSendSmsSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const body: Record<string, unknown> = {
				agentId: args.agentId,
				to: args.to,
				body: args.body,
			};
			if (args.mediaUrls && args.mediaUrls.length > 0) {
				body.mediaUrls = args.mediaUrls;
			}
			const result = await context.client.post<unknown>("/v1/phone/send-sms", body);
			return toolSuccess(result);
		}, options.context),
	);

	// voice_list_voices used to be registered here as a duplicate of
	// voice_catalog (identical params, identical /v1/voice/catalog endpoint).
	// It now lives in tools/phone/voice/index.ts as a deprecated alias of
	// voice_catalog, registered via registerToolWithAliases with the
	// `[DEPRECATED — use voice_catalog]` description prefix + stderr warning
	// on every invocation. Will be removed once log usage goes quiet.

	const phoneStatusSchema = z.object({
		agentId: z
			.string()
			.describe("Agent ID to check phone status for."),
	});

	server.registerTool(
		"phone_status",
		{
			title: "Phone Status",
			description: "Get a status-oriented view of provisioned numbers including capability flags. Use this to verify readiness and operational state for messaging workflows.",
			inputSchema: phoneStatusSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams({ agentId: args.agentId });
			const result = await context.client.get<unknown>(`/v1/phone/numbers?${params}`);
			const items = toPhoneStatusList(result);
			return toolSuccess({
				count: items.length,
				items,
			});
		}, options.context),
	);
}
