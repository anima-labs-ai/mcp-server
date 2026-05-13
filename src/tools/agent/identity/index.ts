import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	objectOutput,
	toolSuccess,
	withErrorHandling,
} from "../../../shared/index.js";

const agentIdSchema = z.object({
	agentId: z.string().describe("ID of the agent."),
});

const resolveDidSchema = z.object({
	did: z
		.string()
		.describe("The DID to resolve (e.g. did:web:example.com)."),
});

export function registerIdentityTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"get_did",
		{
			title: "Get DID",
			description:
				"Get the DID document for an agent. Use this to retrieve an agent's decentralized identifier.",
			inputSchema: agentIdSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(
				`/v1/agents/${encodeURIComponent(args.agentId)}/did`,
			);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"resolve_did",
		{
			title: "Resolve DID",
			description:
				"Resolve a DID to its DID document. Use this to look up any DID regardless of which agent owns it.",
			inputSchema: resolveDidSchema.shape,
			outputSchema: objectOutput(),
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true,
			},
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(
				`/v1/identity/did/${encodeURIComponent(args.did)}`,
			);
			return toolSuccess(result);
		}, options.context),
	);
}
