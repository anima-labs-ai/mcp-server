#!/usr/bin/env bun
/**
 * Regenerate scripts/contracts-snapshot.json from a local checkout of the
 * anima monorepo (`@anima/contracts`).
 *
 * The snapshot powers the tool↔contract CI gates (spec items M2 + M3 in
 * OPENSPEC-COMPETITIVE-PARITY-2026-07):
 *   - M2: every MCP tool's declared backing route must exist in the contract.
 *   - M3: every tool inputSchema property must exist in the backing contract
 *     input schema (or be an explicitly allowlisted client-side param).
 *
 * Why a committed snapshot instead of a live dependency on the monorepo:
 * this repo's CI is deliberately self-contained (no ANIMA_REPO_TOKEN
 * secret, no sibling checkout), so anima merges cannot break mcp-server PRs
 * asynchronously. The trade-off is that the snapshot must be refreshed
 * deliberately — same model as the CLI's `.anima-ref` pin. Contract-drift
 * detection against anima HEAD is spec item C12 (daily canary), which needs
 * the account-side ANIMA_REPO_TOKEN secret before it can exist here.
 *
 * Usage:
 *   bun run gen:contracts-snapshot [path-to-anima-checkout]
 *   (default path: ../anima relative to this repo's root, or $ANIMA_REPO_PATH)
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";

const REPO_ROOT = new URL("..", import.meta.url).pathname;
const OUTPUT = resolve(REPO_ROOT, "scripts/contracts-snapshot.json");

const animaPath = resolve(
	process.argv[2] ?? process.env.ANIMA_REPO_PATH ?? resolve(REPO_ROOT, "../anima"),
);
const contractsEntry = resolve(animaPath, "packages/contracts/src/index.ts");

if (!existsSync(contractsEntry)) {
	console.error(
		`Cannot find @anima/contracts at ${contractsEntry}.\n` +
			"Pass the anima checkout path as the first argument or set ANIMA_REPO_PATH.",
	);
	process.exit(1);
}

function git(...args: string[]): string {
	const result = spawnSync("git", ["-C", animaPath, ...args], { encoding: "utf8" });
	return result.status === 0 ? result.stdout.trim() : "";
}

const commit = git("rev-parse", "HEAD") || "unknown";
const dirty = git("status", "--porcelain", "--", "packages/contracts") !== "";
if (dirty) {
	console.warn(
		"WARNING: packages/contracts has uncommitted changes in the anima checkout — " +
			"the recorded commit SHA will not match the snapshot content.",
	);
}

// ---------------------------------------------------------------------------
// Contract introspection. oRPC contract procedures expose their definition
// under the `~orpc` key: `route` carries {method, path} and `inputSchema`
// is the zod schema for the merged input (path params + query/body).
// ---------------------------------------------------------------------------

type ZodLike = {
	_def?: {
		typeName?: string;
		innerType?: ZodLike;
		schema?: ZodLike;
		in?: ZodLike;
		type?: ZodLike;
		shape?: Record<string, ZodLike> | (() => Record<string, ZodLike>);
	};
};

function isProcedure(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && "~orpc" in (value as Record<string, unknown>);
}

/** Unwrap optional/nullable/default/effects wrappers down to the core schema. */
function unwrap(schema: ZodLike | undefined): ZodLike | undefined {
	let current = schema;
	for (let i = 0; i < 16 && current?._def; i++) {
		const t = current._def.typeName;
		if (t === "ZodOptional" || t === "ZodNullable" || t === "ZodDefault") {
			current = current._def.innerType;
		} else if (t === "ZodEffects") {
			current = current._def.schema;
		} else if (t === "ZodPipeline") {
			current = current._def.in;
		} else if (t === "ZodBranded" || t === "ZodReadonly") {
			current = current._def.type;
		} else {
			break;
		}
	}
	return current;
}

function shapeOf(schema: ZodLike | undefined): Record<string, ZodLike> | undefined {
	const core = unwrap(schema);
	if (!core?._def || core._def.typeName !== "ZodObject") return undefined;
	const shape = core._def.shape;
	return typeof shape === "function" ? shape() : shape;
}

interface RouteProps {
	/** Top-level input property names. */
	props: string[];
	/** One level of nesting: property name -> child property names. The API
	 *  groups filter/pagination params into nested objects; MCP tools flatten
	 *  them, so the M3 gate matches against both levels. */
	nested: Record<string, string[]>;
}

function extractProps(schema: ZodLike | undefined): RouteProps {
	const shape = shapeOf(schema);
	if (!shape) return { props: [], nested: {} };
	const props = Object.keys(shape).sort();
	const nested: Record<string, string[]> = {};
	for (const key of props) {
		const childShape = shapeOf(shape[key]);
		if (childShape) nested[key] = Object.keys(childShape).sort();
	}
	return { props, nested };
}

const mod = (await import(contractsEntry)) as Record<string, unknown>;

const routes: Record<string, RouteProps> = {};
const seen = new Set<unknown>();
let procedureCount = 0;

function walk(node: Record<string, unknown>): void {
	if (seen.has(node)) return;
	seen.add(node);
	for (const value of Object.values(node)) {
		if (isProcedure(value)) {
			const def = (value as Record<string, Record<string, unknown>>)["~orpc"];
			const route = (def.route ?? {}) as { method?: string; path?: string };
			if (!route.method || !route.path) continue;
			procedureCount++;
			const key = `${route.method} ${route.path}`;
			if (!(key in routes)) {
				routes[key] = extractProps(def.inputSchema as ZodLike | undefined);
			}
		} else if (value && typeof value === "object" && !Array.isArray(value)) {
			walk(value as Record<string, unknown>);
		}
	}
}

// Walk the root `contract` router — the exact router apps/api mounts under
// /v1, so its leaves are precisely the routes the API serves. (Scanning
// individually-exported `*Contract` routers instead would miss routers that
// are only composed into the root, e.g. emailDraftContract.)
const rootContract = mod.contract;
if (!rootContract || typeof rootContract !== "object") {
	console.error("Could not find the root `contract` export in @anima/contracts.");
	process.exit(1);
}
walk(rootContract as Record<string, unknown>);

if (procedureCount === 0) {
	console.error("No contract procedures found — did the contracts package layout change?");
	process.exit(1);
}

const snapshot = {
	$comment:
		"GENERATED by scripts/generate-contracts-snapshot.ts — do not edit by hand. " +
		"Refresh with: bun run gen:contracts-snapshot <path-to-anima-checkout>",
	generatedFrom: {
		repo: "anima-labs-ai/anima",
		commit,
		generatedAt: new Date().toISOString(),
	},
	routes: Object.fromEntries(Object.entries(routes).sort(([a], [b]) => a.localeCompare(b))),
};

await writeFile(OUTPUT, `${JSON.stringify(snapshot, null, "\t")}\n`);
console.log(
	`Wrote ${OUTPUT}: ${Object.keys(routes).length} routes (${procedureCount} procedures) from anima @ ${commit}${dirty ? " (DIRTY packages/contracts)" : ""}`,
);
