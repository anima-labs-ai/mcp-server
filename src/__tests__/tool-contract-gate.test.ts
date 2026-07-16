/**
 * Tool ↔ contract CI gates (spec items M2 + M3).
 *
 * WHY THIS EXISTS: the hosted MCP server shipped tools backed by endpoints
 * that did not exist (`sms_thread_*` originally, the credential-request
 * window) and tool params the API never accepted (`email_list`'s
 * folder/offset, `phone_call_list`'s numberId/search, `domain_list`'s
 * cursor/limit) — all invisible to green tests because zod-strip makes
 * fictional params silent no-ops for LLM callers: the tool "works" and
 * quietly does the wrong thing. These gates make both classes a red CI, not
 * a customer discovery.
 *
 * The contract source of truth is scripts/contracts-snapshot.json —
 * generated from `@anima/contracts` (the exact router apps/api mounts under
 * /v1) by scripts/generate-contracts-snapshot.ts and committed, so this
 * suite runs self-contained in CI. If a gate failure points at a route you
 * KNOW just landed in anima main, refresh the snapshot (bun run
 * gen:contracts-snapshot <anima-checkout>) in the same PR.
 */

import { describe, expect, test } from "bun:test";

import snapshot from "../../scripts/contracts-snapshot.json";
import { ApiClient } from "../shared/index.js";
import { TOOL_ROUTES } from "../shared/tool-routes.js";
import { ALL_TOOL_REGISTRARS } from "../tools/all/factory.js";

// ---------------------------------------------------------------------------
// Exempt (non-REST-contract) routes. Adding a new exemption requires editing
// BOTH tool-routes.ts and this pinned set — deliberate friction so "ws:" /
// "app:" prefixes can never become a quiet bypass of the M2 gate.
// ---------------------------------------------------------------------------
const ALLOWED_EXEMPT_ROUTES = new Set([
	// Live voice call protocol — WebSocket, not REST (apps/api ws-voice.ts).
	"ws:/ws/voice",
	// Public single-use credential fill route — deliberately outside the /v1
	// contract router (token-addressed, no API-key auth).
	"app:POST /vault/fill/{token}",
]);

interface RegisteredTool {
	name: string;
	inputProps: string[];
}

/** Register every production registrar against a capturing fake server. */
function collectRegisteredTools(): RegisteredTool[] {
	const tools: RegisteredTool[] = [];
	const fakeServer = {
		registerTool(name: string, config: { inputSchema?: Record<string, unknown> }) {
			tools.push({ name, inputProps: Object.keys(config.inputSchema ?? {}).sort() });
		},
		// Vault registers an MCP-App HTML resource alongside its tools.
		registerResource() {},
	};
	const client = new ApiClient({ baseUrl: "http://localhost:3100", apiKey: "test-key" });
	for (const register of ALL_TOOL_REGISTRARS) {
		register({
			// biome-ignore lint/suspicious/noExplicitAny: minimal capture double.
			server: fakeServer as any,
			context: { client, hasMasterKey: true },
		});
	}
	return tools;
}

const registeredTools = collectRegisteredTools();
const registeredByName = new Map(registeredTools.map((t) => [t.name, t]));

const snapshotRoutes = snapshot.routes as Record<
	string,
	{ props: string[]; nested: Record<string, string[]> }
>;

/** Contract-accepted property names for a tool: the union over its declared
 *  contract routes of top-level input props plus one level of nested-object
 *  props (the API groups filter/pagination params into nested objects that
 *  MCP tools legitimately flatten). */
function contractPropsFor(decl: (typeof TOOL_ROUTES)[string]): Set<string> {
	const props = new Set<string>();
	for (const route of decl.routes) {
		if (route.startsWith("ws:") || route.startsWith("app:")) continue;
		const entry = snapshotRoutes[route];
		if (!entry) continue; // M2 test reports this separately.
		for (const prop of entry.props) props.add(prop);
		for (const children of Object.values(entry.nested)) {
			for (const child of children) props.add(child);
		}
	}
	return props;
}

describe("contract snapshot sanity", () => {
	test("snapshot is present, attributed, and plausibly complete", () => {
		expect(snapshot.generatedFrom.repo).toBe("anima-labs-ai/anima");
		expect(snapshot.generatedFrom.commit).toMatch(/^[0-9a-f]{40}$/);
		// The contract had 252 routes at snapshot time; a sudden collapse
		// means the generator broke, not that the API shrank 10x.
		expect(Object.keys(snapshotRoutes).length).toBeGreaterThan(150);
	});
});

describe("tool registry completeness", () => {
	test("every registered tool declares its backing routes in TOOL_ROUTES", () => {
		const missing = registeredTools
			.map((t) => t.name)
			.filter((name) => !(name in TOOL_ROUTES));
		expect(
			missing,
			`Tools registered without a TOOL_ROUTES declaration: ${missing.join(", ")}. ` +
				"Add each to src/shared/tool-routes.ts — composed tools declare every primitive route they call.",
		).toEqual([]);
	});

	test("TOOL_ROUTES has no stale entries for tools that no longer register", () => {
		const stale = Object.keys(TOOL_ROUTES).filter((name) => !registeredByName.has(name));
		expect(
			stale,
			`TOOL_ROUTES entries with no registered tool: ${stale.join(", ")}. Remove them.`,
		).toEqual([]);
	});

	test("every tool declares at least one route", () => {
		const empty = Object.entries(TOOL_ROUTES)
			.filter(([, decl]) => decl.routes.length === 0)
			.map(([name]) => name);
		expect(empty).toEqual([]);
	});
});

describe("M2 — every tool maps to a live contract route", () => {
	test("all declared contract routes exist in @anima/contracts", () => {
		const failures: string[] = [];
		for (const [tool, decl] of Object.entries(TOOL_ROUTES)) {
			for (const route of decl.routes) {
				if (route.startsWith("ws:") || route.startsWith("app:")) continue;
				if (!(route in snapshotRoutes)) {
					failures.push(`${tool} → "${route}"`);
				}
			}
		}
		expect(
			failures,
			`Tools declaring routes that do not exist in the contract:\n  ${failures.join("\n  ")}\n` +
				"Either the tool is backed by a fictional endpoint (fix or remove the tool), " +
				"the declared path has a typo, or the route just landed in anima main and the " +
				"snapshot needs a refresh (bun run gen:contracts-snapshot).",
		).toEqual([]);
	});

	test("exempt (ws:/app:) routes are exactly the pinned allowed set", () => {
		const declaredExempt = new Set<string>();
		for (const decl of Object.values(TOOL_ROUTES)) {
			for (const route of decl.routes) {
				if (route.startsWith("ws:") || route.startsWith("app:")) declaredExempt.add(route);
			}
		}
		expect([...declaredExempt].sort()).toEqual([...ALLOWED_EXEMPT_ROUTES].sort());
	});
});

describe("M3 — tool params are a subset of the backing contract schema", () => {
	test("every tool inputSchema property is contract-accepted or explicitly client-side", () => {
		const failures: string[] = [];
		for (const tool of registeredTools) {
			const decl = TOOL_ROUTES[tool.name];
			if (!decl) continue; // completeness test reports this.
			const contractRoutes = decl.routes.filter(
				(r) => !r.startsWith("ws:") && !r.startsWith("app:"),
			);
			// Tools backed ONLY by exempt routes have no REST schema to check
			// against (their protocols live outside @anima/contracts).
			if (contractRoutes.length === 0) continue;
			const accepted = contractPropsFor(decl);
			const clientSide = new Set(decl.clientSideParams ?? []);
			for (const prop of tool.inputProps) {
				if (!accepted.has(prop) && !clientSide.has(prop)) {
					failures.push(`${tool.name}.${prop}`);
				}
			}
		}
		expect(
			failures,
			`Tool params no backing route accepts:\n  ${failures.join("\n  ")}\n` +
				"zod-strip means the API silently ignores these — the LLM believes the " +
				"param worked while nothing happened. Either the param is fictional " +
				"(remove it) or it is consumed client-side (add it to that tool's " +
				"clientSideParams in src/shared/tool-routes.ts with a justification comment).",
		).toEqual([]);
	});

	test("clientSideParams allowlists cannot rot: no stale, no redundant entries", () => {
		const problems: string[] = [];
		for (const [name, decl] of Object.entries(TOOL_ROUTES)) {
			const tool = registeredByName.get(name);
			if (!tool) continue; // staleness test reports this.
			const schemaProps = new Set(tool.inputProps);
			const accepted = contractPropsFor(decl);
			for (const param of decl.clientSideParams ?? []) {
				if (!schemaProps.has(param)) {
					problems.push(
						`${name}.${param}: allowlisted but not in the tool schema (stale — remove it)`,
					);
				} else if (accepted.has(param)) {
					problems.push(
						`${name}.${param}: allowlisted but the contract accepts it (redundant — remove it)`,
					);
				}
			}
		}
		expect(problems, problems.join("\n")).toEqual([]);
	});
});
