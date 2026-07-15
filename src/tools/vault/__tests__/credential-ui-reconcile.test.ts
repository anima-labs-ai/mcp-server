import { describe, expect, test } from "bun:test";
import { CREDENTIAL_UI_HTML } from "../vault/credential-ui.js";

/**
 * The branded `ui`-tier widget re-renders with its ORIGINAL `AWAITING_INPUT`
 * render-data (on a fresh DOM) whenever a past chat is revisited. If it drew the
 * entry form unconditionally it would re-prompt "enter credentials" for a request
 * that was already fulfilled — or is now dead — which is exactly the reported bug
 * (#1). So on every render it MUST reconcile against the request's LIVE status.
 *
 * The widget body is an inlined <script> string (browser context, not type-
 * checked and not runnable under `bun test` without a DOM + ext-apps host), so
 * these are presence/regression guards on the shipped HTML: they fail loudly if
 * the reconciliation is weakened or removed. Real end-to-end behaviour is
 * verified in the MCP host (Claude Desktop / claude.ai).
 */
describe("credential-request widget: live-status reconciliation", () => {
	test("queries live status before drawing (not just the stale render-data)", () => {
		expect(CREDENTIAL_UI_HTML).toContain("liveStatus");
		expect(CREDENTIAL_UI_HTML).toContain("vault_credential_request_status");
	});

	test("a fulfilled request locks to the saved state", () => {
		expect(CREDENTIAL_UI_HTML).toContain('"FULFILLED"');
		expect(CREDENTIAL_UI_HTML).toContain("saved()");
	});

	test("dead requests show a closed state, never the entry form", () => {
		// Every terminal, non-fulfilled status must route away from draw().
		for (const status of ['"EXPIRED"', '"CANCELLED"', '"DECLINED"']) {
			expect(CREDENTIAL_UI_HTML).toContain(status);
		}
		expect(CREDENTIAL_UI_HTML).toContain("function closed(");
	});

	test("statusOf tolerates a host that hands back an unwrapped structured result", () => {
		// Some hosts pass callServerTool the structured object directly rather than a
		// full CallToolResult; reading only structuredContent/content[] would then
		// look like "not fulfilled" and wrongly redraw the form.
		expect(CREDENTIAL_UI_HTML).toContain('typeof result.status === "string"');
	});
});
