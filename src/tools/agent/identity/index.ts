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

	server.tool(
		"get_did",
		"Get the DID document for an agent. Use this to retrieve an agent's decentralized identifier.",
		agentIdSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/agents/${encodeURIComponent(args.agentId)}/did`);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"resolve_did",
		"Resolve a DID to its DID document. Use this to look up any DID regardless of which agent owns it.",
		resolveDidSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/identity/did/${encodeURIComponent(args.did)}`);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"rotate_keys",
		"Rotate the cryptographic keys for an agent's DID. Use this to update key material for security.",
		agentIdSchema.shape,
		withErrorHandling(async (args, context) => {
			requireMasterKeyGuard(context);
			const result = await context.client.post<unknown>(`/agents/${encodeURIComponent(args.agentId)}/did/rotate`);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"list_credentials",
		"List all verifiable credentials for an agent. Use this to see what credentials an agent holds.",
		agentIdSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/agents/${encodeURIComponent(args.agentId)}/credentials`);
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"verify_credential",
		"Verify a JWT-encoded verifiable credential. Use this to check if a credential is valid and authentic.",
		verifyCredentialSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.post<unknown>("/identity/verify", { jwtVc: args.jwtVc });
			return toolSuccess(result);
		}, options.context),
	);

	server.tool(
		"get_agent_card",
		"Get the public agent card for an agent. Use this to retrieve the agent's public profile and capabilities.",
		agentIdSchema.shape,
		withErrorHandling(async (args, context) => {
			const result = await context.client.get<unknown>(`/agents/${encodeURIComponent(args.agentId)}/card`);
			return toolSuccess(result);
		}, options.context),
	);
}
