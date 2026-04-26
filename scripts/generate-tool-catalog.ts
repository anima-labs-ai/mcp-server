#!/usr/bin/env bun
/**
 * Generate docs/TOOL_CATALOG.md by walking the codebase and extracting
 * every server.registerTool / registerToolWithAliases call.
 *
 * Why generated, not hand-maintained:
 *   190+ tools. Hand-maintaining a markdown copy means it drifts the
 *   moment a description changes. The generator reads the actual source
 *   so the doc stays in sync — re-run on every release.
 *
 * Run with:
 *   bun run scripts/generate-tool-catalog.ts
 *
 * Output: docs/TOOL_CATALOG.md (committed to the repo).
 */

import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("../src/tools", import.meta.url).pathname;
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const OUTPUT = new URL("../docs/TOOL_CATALOG.md", import.meta.url).pathname;

interface Tool {
	name: string;
	canonical?: string;
	aliases: string[];
	description: string;
	domain: string;
	subdomain: string;
	file: string;
	line: number;
	inputSchemaRef?: string;
	masterKeyRequired?: boolean;
	readOnly?: boolean;
}

async function walk(dir: string, files: string[] = []): Promise<string[]> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "__tests__" || entry.name === "node_modules") continue;
			await walk(full, files);
		} else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
			files.push(full);
		}
	}
	return files;
}

const PLAIN_PATTERN = /server\.registerTool\(\s*["'`]([^"'`]+)["'`]\s*,\s*\{([^}]*)\}/g;
const ALIAS_PATTERN =
	/registerToolWithAliases\(\s*server\s*,\s*["'`]([^"'`]+)["'`]\s*,\s*\[([^\]]*)\]\s*,\s*\{([^}]*)\}/g;

function extractDescription(configBlock: string): string {
	const found = configBlock.match(/description:\s*["'`]([\s\S]+?)["'`]/);
	if (!found) return "";
	return found[1]
		.replace(/\\n/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function extractInputSchema(configBlock: string): string | undefined {
	const found = configBlock.match(/inputSchema:\s*([A-Za-z_][A-Za-z0-9_]*)/);
	return found ? found[1] : undefined;
}

function extractDomain(filePath: string): { domain: string; subdomain: string } {
	const rel = relative(ROOT, filePath);
	const parts = rel.split("/");
	return {
		domain: parts[0] ?? "unknown",
		subdomain: parts[1] === "index.ts" ? "" : parts[1] ?? "",
	};
}

function findAllMatches(content: string, pattern: RegExp): RegExpMatchArray[] {
	const matches: RegExpMatchArray[] = [];
	const iter = content.matchAll(pattern);
	for (const m of iter) matches.push(m);
	return matches;
}

async function extractTools(): Promise<Tool[]> {
	const files = await walk(ROOT);
	const tools: Tool[] = [];

	for (const file of files) {
		const content = await readFile(file, "utf-8");
		const lines = content.split("\n");
		const { domain, subdomain } = extractDomain(file);
		const relFile = relative(REPO_ROOT, file);

		// Aliased registrations first.
		for (const m of findAllMatches(content, ALIAS_PATTERN)) {
			const canonical = m[1];
			const aliasList = m[2]
				.split(",")
				.map((s) => s.trim().replace(/^["'`]|["'`]$/g, ""))
				.filter(Boolean);
			const cfg = m[3];
			const lineNo = content.slice(0, m.index ?? 0).split("\n").length;
			tools.push({
				name: canonical,
				canonical,
				aliases: aliasList,
				description: extractDescription(cfg),
				inputSchemaRef: extractInputSchema(cfg),
				domain,
				subdomain,
				file: relFile,
				line: lineNo,
			});
		}

		// Plain registrations — skip names already captured as aliased canonicals.
		const aliasedNames = new Set(tools.filter((t) => t.canonical).map((t) => t.canonical as string));
		for (const m of findAllMatches(content, PLAIN_PATTERN)) {
			const name = m[1];
			if (aliasedNames.has(name)) continue;
			const cfg = m[2];
			const lineNo = content.slice(0, m.index ?? 0).split("\n").length;
			tools.push({
				name,
				aliases: [],
				description: extractDescription(cfg),
				inputSchemaRef: extractInputSchema(cfg),
				domain,
				subdomain,
				file: relFile,
				line: lineNo,
			});
		}

		// Annotation heuristics — read 8 lines after each registration call to
		// detect master-key guards and read-only hints.
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i];
			if (!line.includes("registerTool(") && !line.includes("registerToolWithAliases(")) continue;
			const window = lines
				.slice(Math.max(0, i - 2), Math.min(lines.length, i + 8))
				.join("\n");
			const nameMatch = line.match(/["'`]([^"'`]+)["'`]/);
			if (!nameMatch) continue;
			const name = nameMatch[1];
			const tool = tools.find((t) => t.name === name);
			if (!tool) continue;
			tool.masterKeyRequired = /requireMasterKeyGuard/.test(window);
			tool.readOnly = /readOnlyHint:\s*true/.test(window);
		}
	}

	return tools;
}

function groupByDomain(tools: Tool[]): Record<string, Tool[]> {
	const out: Record<string, Tool[]> = {};
	for (const t of tools) {
		const key = t.subdomain ? `${t.domain} / ${t.subdomain}` : t.domain;
		if (!out[key]) out[key] = [];
		out[key].push(t);
	}
	for (const k of Object.keys(out)) {
		out[k].sort((a, b) => a.name.localeCompare(b.name));
	}
	return out;
}

function badge(text: string, kind: "warn" | "ok" | "info"): string {
	const colors = { warn: "🔒", ok: "👁", info: "🔗" };
	return `${colors[kind]} ${text}`;
}

function renderToolEntry(tool: Tool): string {
	const lines: string[] = [];
	lines.push(`### \`${tool.name}\``);
	if (tool.aliases.length > 0) {
		const aliasStr = tool.aliases.map((a) => `\`${a}\``).join(", ");
		lines.push(`*Aliases:* ${aliasStr}`);
	}
	const flags: string[] = [];
	if (tool.masterKeyRequired) flags.push(badge("master-key required", "warn"));
	if (tool.readOnly) flags.push(badge("read-only", "ok"));
	if (flags.length > 0) lines.push(flags.join("  ·  "));
	lines.push("");
	lines.push(tool.description || "_(no description in source)_");
	lines.push("");
	if (tool.inputSchemaRef) {
		lines.push(`**Input schema:** \`${tool.inputSchemaRef}\` — see source for fields.`);
	}
	lines.push("");
	lines.push(`**Source:** \`${tool.file}:${tool.line}\``);
	lines.push("");
	return lines.join("\n");
}

function renderDomainSection(domain: string, tools: Tool[]): string {
	const lines: string[] = [];
	lines.push(`## ${domain}`);
	lines.push("");
	lines.push(`${tools.length} tool${tools.length === 1 ? "" : "s"}.`);
	lines.push("");

	lines.push("| Name | Description | Flags |");
	lines.push("|---|---|---|");
	for (const t of tools) {
		const desc =
			t.description.slice(0, 80) + (t.description.length > 80 ? "…" : "");
		const flags: string[] = [];
		if (t.masterKeyRequired) flags.push("🔒mk");
		if (t.readOnly) flags.push("👁ro");
		if (t.aliases.length > 0) flags.push(`+${t.aliases.length}aliases`);
		lines.push(`| \`${t.name}\` | ${desc} | ${flags.join(" ") || "—"} |`);
	}
	lines.push("");

	for (const t of tools) {
		lines.push(renderToolEntry(t));
	}
	return lines.join("\n");
}

async function main() {
	const tools = await extractTools();
	const grouped = groupByDomain(tools);
	const total = tools.length;
	const aliasedCount = tools.filter((t) => t.aliases.length > 0).length;
	const totalCallable = tools.reduce((sum, t) => sum + 1 + t.aliases.length, 0);
	const masterKeyCount = tools.filter((t) => t.masterKeyRequired).length;
	const readOnlyCount = tools.filter((t) => t.readOnly).length;

	const sections = Object.keys(grouped)
		.sort()
		.map((k) => renderDomainSection(k, grouped[k]))
		.join("\n");

	const today = new Date().toISOString().slice(0, 10);
	const md = `# Anima MCP Tool Catalog

*Auto-generated by \`scripts/generate-tool-catalog.ts\`. Re-run after any tool
change to keep this in sync. Do NOT edit by hand.*

**Last generated:** ${today}

## Summary

| Metric | Value |
|---|---|
| Total registered tools | ${total} |
| Tools with aliases | ${aliasedCount} |
| Total callable names (incl. aliases) | ${totalCallable} |
| Master-key required | ${masterKeyCount} |
| Read-only | ${readOnlyCount} |

**Conventions:**
- 🔒 master-key required — caller must auth with an \`mk_\` token, not \`ak_\`
- 👁 read-only — does not mutate state; safe for concurrent / retry use
- 🔗 alias — registered under multiple names; all route to the same handler

**Auth (every tool):**
Tools authenticate via the Bearer token configured in your MCP client. See
[/api-reference](https://useanima.sh/api-reference) for the auth contract.

**How to read this doc:**
- Tools are grouped by domain (email, voice, vault, etc.) and subdomain.
- Each tool's source location is included so you can read the implementation
  to find: exact input field types (Zod schemas), the upstream API endpoint
  it calls, and the response shape it returns.
- "Input schema: \`SchemaName\`" points to a Zod schema — grep the source
  file for that name to see the full field list.

---

${sections}
`;

	if (!existsSync(new URL("../docs", import.meta.url).pathname)) {
		await mkdir(new URL("../docs", import.meta.url).pathname, { recursive: true });
	}
	await writeFile(OUTPUT, md, "utf-8");
	console.log(`Wrote ${OUTPUT}`);
	console.log(`  ${total} tools across ${Object.keys(grouped).length} domains`);
	console.log(`  ${totalCallable} total callable names (with aliases)`);
}

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
