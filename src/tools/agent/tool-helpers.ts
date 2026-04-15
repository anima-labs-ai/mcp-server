// Re-export from ../../shared/index.js — shim so tool files keep ../../tool-helpers.js imports
export {
	requiresMasterKey,
	toolSuccess,
	toolError,
	withErrorHandling,
	requireMasterKeyGuard,
	type ToolContext,
	type ToolRegistrationOptions,
	type DomainRegistrar,
} from "../../shared/index.js";
