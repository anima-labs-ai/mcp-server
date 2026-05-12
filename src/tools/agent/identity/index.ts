import { z } from "zod";
import type { ToolRegistrationOptions } from "../../../shared/index.js";
import {
	withErrorHandling,
	toolSuccess,
	requireMasterKeyGuard,
} from "../../../shared/index.js";

const agentIdSchema = z.object({
	agentId: z
		.string()
		.describe("ID of the agent."),
});

const resolveDidSchema = z.object({
	did: z
		.string()
		.describe("The DID to resolve (e.g. did:web:example.com)."),
});

const verifyCredentialSchema = z.object({
	jwtVc: z
		.string()
		.describe("JWT-encoded verifiable credential to verify."),
});

export function registerIdentityTools(options: ToolRegistrationOptions): void {
	const { server } = options;

	server.registerTool(
		"get_did",
		{
			title: "Get DID",
			description: "Get the DID document for an agent. Use this to retrieve an agent's decentralized identifier.",
			inputSchema: agentIdSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/agents/${encodeURIComponent(args.agentId)}/did`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"resolve_did",
		{
			title: "Resolve DID",
			description: "Resolve a DID to its DID document. Use this to look up any DID regardless of which agent owns it.",
			inputSchema: resolveDidSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/identity/did/${encodeURIComponent(args.did)}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"rotate_keys",
		{
			title: "Rotate Keys",
			description: "Rotate the cryptographic keys for an agent's DID. Use this to update key material for security.",
			inputSchema: agentIdSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>(`/v1/agents/${encodeURIComponent(args.agentId)}/did/rotate`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"list_credentials",
		{
			title: "List Credentials",
			description: "List all verifiable credentials for an agent. Use this to see what credentials an agent holds.",
			inputSchema: agentIdSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/agents/${encodeURIComponent(args.agentId)}/credentials`);
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"verify_credential",
		{
			title: "Verify Credential",
			description: "Verify a JWT-encoded verifiable credential. Use this to check if a credential is valid and authentic.",
			inputSchema: verifyCredentialSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/v1/identity/verify", { jwtVc: args.jwtVc });
			return toolSuccess(result);
		}, options.context),
	);

	server.registerTool(
		"get_agent_card",
		{
			title: "Get Agent Card",
			description: "Get the public agent card for an agent. Use this to retrieve the agent's public profile and capabilities.",
			inputSchema: agentIdSchema.shape,
		},
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/v1/agents/${encodeURIComponent(args.agentId)}/card`);
			return toolSuccess(result);
		}, options.context),
	);
}
