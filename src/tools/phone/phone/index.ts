/**
 * Phone Number MCP Tools
 *
 * 3 tools for phone-number management. The "phone number" resource is
 * distinct from the SMS messaging surface (see tools/phone/sms/) and from
 * the voice-call surface (see tools/phone/voice/) — this group is purely
 * about the lifecycle of E.164 numbers attached to an agent.
 *
 *   - phone_number_list:      list numbers assigned to an agent
 *   - phone_number_provision: provision a new number from the carrier pool
 *   - phone_number_release:   release a number back to the carrier
 */

import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	deleteOutput,
	listOutput,
	objectOutput,
	requireMasterKeyGuard,
	toolSuccess,
	withErrorHandling,
} from "../../../shared/index.js";

const phoneNumberListSchema = z.object({
	agentId: z
		.string()
		.describe("Agent whose phone numbers to list."),
});

const phoneNumberProvisionSchema = z.object({
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
		.describe("Optional capability list (sms, mms, voice) the number must support."),
});

const phoneNumberReleaseSchema = z.object({
	agentId: z
		.string()
		.describe("Agent ID that currently owns the phone number."),
	phoneNumber: z
		.string()
		.describe("E.164 formatted phone number to release."),
});

export function registerPhoneTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"phone_number_list",
		{
			title: "List Phone Numbers",
			description:
				"List phone numbers assigned to an agent. Each result includes status and capability flags (sms/mms/voice).",
			inputSchema: phoneNumberListSchema.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams({ agentId: args.agentId });
			const result = await context.client.get<unknown>(`/v1/phone/numbers?${params}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"phone_number_provision",
		{
			title: "Provision Phone Number",
			description:
				"Provision a new phone number from the carrier pool and assign it to an agent. Note: provisioning a number costs money on the underlying carrier; do not call speculatively. Use countryCode / areaCode / capabilities to constrain selection.",
			inputSchema: phoneNumberProvisionSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: false,
				openWorldHint: true,
			},
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
		"phone_number_release",
		{
			title: "Release Phone Number",
			description:
				"Release a previously provisioned phone number back to the carrier pool. Use this when cleaning up unused numbers. Released numbers cannot be recovered.",
			inputSchema: phoneNumberReleaseSchema.shape,
			outputSchema: deleteOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>("/v1/phone/release", args);
			return toolSuccess(result);
		}, options.context),
	);
}
