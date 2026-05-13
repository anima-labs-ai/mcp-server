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

const addressTypeEnum = z.enum(["BILLING", "SHIPPING", "MAILING", "REGISTERED"]);

const createAddressSchema = z.object({
	agentId: z
		.string()
		.describe("ID of the agent to associate the address with."),
	type: addressTypeEnum.describe("Address type: BILLING, SHIPPING, MAILING, or REGISTERED."),
	label: z
		.string()
		.optional()
		.describe("Optional human-readable label for this address."),
	street1: z
		.string()
		.describe("Primary street address line."),
	street2: z
		.string()
		.optional()
		.describe("Secondary street address line (apt, suite, etc.)."),
	city: z
		.string()
		.describe("City name."),
	state: z
		.string()
		.describe("State or province code."),
	postalCode: z
		.string()
		.describe("Postal or ZIP code."),
	country: z
		.string()
		.describe("ISO country code (e.g. US, GB)."),
});

const listAddressesSchema = z.object({
	agentId: z
		.string()
		.describe("Agent ID to list addresses for."),
	type: addressTypeEnum
		.optional()
		.describe("Optional filter by address type."),
});

const getAddressSchema = z.object({
	id: z
		.string()
		.describe("Address ID to retrieve."),
	agentId: z
		.string()
		.describe("Agent ID that owns the address."),
});

const updateAddressSchema = z.object({
	id: z
		.string()
		.describe("Address ID to update."),
	agentId: z
		.string()
		.describe("Agent ID that owns the address."),
	type: addressTypeEnum
		.optional()
		.describe("Updated address type."),
	label: z
		.string()
		.optional()
		.describe("Updated label."),
	street1: z
		.string()
		.optional()
		.describe("Updated primary street address."),
	street2: z
		.string()
		.optional()
		.describe("Updated secondary street address."),
	city: z
		.string()
		.optional()
		.describe("Updated city."),
	state: z
		.string()
		.optional()
		.describe("Updated state or province."),
	postalCode: z
		.string()
		.optional()
		.describe("Updated postal code."),
	country: z
		.string()
		.optional()
		.describe("Updated country code."),
});

const deleteAddressSchema = z.object({
	id: z
		.string()
		.describe("Address ID to delete."),
	agentId: z
		.string()
		.describe("Agent ID that owns the address."),
});

const validateAddressSchema = z.object({
	id: z
		.string()
		.describe("Address ID to validate."),
	agentId: z
		.string()
		.describe("Agent ID that owns the address."),
});

export function registerAddressTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"create_address",
		{
			title: "Create Address",
			description: "Create a new postal address for an agent. Use this to register billing, shipping, mailing, or registered addresses.",
			inputSchema: createAddressSchema.shape,
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
			const result = await context.client.post<unknown>("/v1/addresses", args);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"list_addresses",
		{
			title: "List Addresses",
			description: "List all addresses for an agent, optionally filtered by type. Use this to review the agent's registered addresses.",
			inputSchema: listAddressesSchema.shape,
			outputSchema: listOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const params = new URLSearchParams();
			params.set("agentId", args.agentId);
			if (args.type) params.set("type", args.type);
			const path = `/v1/addresses?${params}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"get_address",
		{
			title: "Get Address",
			description: "Get full details for a specific address by ID. Use this to inspect a single address record.",
			inputSchema: getAddressSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/addresses/${encodeURIComponent(args.id)}?agentId=${encodeURIComponent(args.agentId)}`;
			const result = await context.client.get<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"update_address",
		{
			title: "Update Address",
			description: "Update fields on an existing address. Use this to correct or change address details.",
			inputSchema: updateAddressSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const { id, ...body } = args;
			const path = `/v1/addresses/${encodeURIComponent(id)}`;
			const result = await context.client.put<unknown>(path, body);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"delete_address",
		{
			title: "Delete Address",
			description: "Delete an address from an agent. Use this to remove addresses that are no longer needed.",
			inputSchema: deleteAddressSchema.shape,
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
			const path = `/v1/addresses/${encodeURIComponent(args.id)}`;
			const result = await context.client.delete<unknown>(path);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"validate_address",
		{
			title: "Validate Address",
			description: "Validate an existing address against postal standards. Use this to verify address accuracy before shipping or official registration.",
			inputSchema: validateAddressSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const path = `/v1/addresses/${encodeURIComponent(args.id)}/validate`;
			const result = await context.client.post<unknown>(path, { agentId: args.agentId });
			return toolSuccess(result);
		}, options.context),
	);
}
