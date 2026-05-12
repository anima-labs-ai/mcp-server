#!/usr/bin/env bun
/**
 * Add `title:` field to every snake_case tool registration that doesn't
 * already have one. Title is derived from the canonical name:
 *
 *   - Split on `_`
 *   - If a known verb appears in position > 0, hoist it to the front so
 *     the title reads as natural English ("Send Email" not "Email Send",
 *     "Get Vault Credential" not "Vault Get Credential")
 *   - Capitalize each word, expanding known acronyms (DID, DNS, API, ...)
 *
 * The MCP spec 2025-11-25 exposes `title` as a top-level field on tool
 * definitions; clients render it in pickers / UIs while the protocol
 * identifier stays as `name`. Purely additive change — clients that
 * don't support `title` ignore it and fall back to `name`.
 *
 * Run with:
 *   bun run scripts/add-titles.ts --dry   # show what would change
 *   bun run scripts/add-titles.ts          # apply
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ROOT = new URL("../src/tools", import.meta.url).pathname;

// Verbs that should be hoisted to the front of the title when they appear
// at position > 0 in the snake_case name. Order doesn't matter; membership
// is what counts.
const VERBS = new Set([
	"send", "get", "list", "create", "update", "delete", "search", "verify",
	"add", "remove", "set", "approve", "reject", "test", "fetch", "pay",
	"freeze", "unfreeze", "sync", "reload", "scan", "audit", "validate",
	"register", "unlist", "rotate", "exchange", "provision", "release",
	"deprovision", "share", "revoke", "discover", "resolve", "forward",
	"reply", "move", "mark", "drain", "generate", "cancel",
	"submit", "lookup", "manage", "check", "setup", "call",
	"wait", "message", "find", "view", "show", "open", "close", "pause",
	"resume", "start", "stop", "complete", "expire", "renew",
	"track", "untrack", "deliver", "upload", "download", "invoke",
]);

// Display overrides for words that aren't a simple capitalize. Common
// acronyms become all-caps; protocols/brand names keep their canonical
// casing (e.g. x402 lowercase, OAuth mixed-case).
const DISPLAY: Record<string, string> = {
	did: "DID",
	dns: "DNS",
	api: "API",
	sms: "SMS",
	mms: "MMS",
	url: "URL",
	oauth: "OAuth",
	totp: "TOTP",
	otp: "OTP",
	dkim: "DKIM",
	spf: "SPF",
	mx: "MX",
	tls: "TLS",
	ses: "SES",
	id: "ID",
	ws: "WS",
	wss: "WSS",
	sse: "SSE",
	tcp: "TCP",
	udp: "UDP",
	http: "HTTP",
	https: "HTTPS",
	json: "JSON",
	yaml: "YAML",
	xml: "XML",
	csv: "CSV",
	tsv: "TSV",
	pdf: "PDF",
	html: "HTML",
	css: "CSS",
	js: "JS",
	ts: "TS",
	rpc: "RPC",
	jwt: "JWT",
	uuid: "UUID",
	crud: "CRUD",
	rest: "REST",
	graphql: "GraphQL",
	ipv4: "IPv4",
	ipv6: "IPv6",
	saml: "SAML",
	scim: "SCIM",
	ldap: "LDAP",
	iam: "IAM",
	sso: "SSO",
	fips: "FIPS",
	hsm: "HSM",
	kms: "KMS",
	x402: "x402",
	a2a: "A2A",
};

function cap(word: string): string {
	const override = DISPLAY[word.toLowerCase()];
	if (override) return override;
	return word.charAt(0).toUpperCase() + word.slice(1);
}

function toTitle(name: string): string {
	const parts = name.split("_");
	if (parts.length === 1) return cap(parts[0]);

	// Special case: webhook_deliveries_list → "List Webhook Deliveries"
	// Generic logic handles this; "list" gets hoisted because it's a verb.

	const verbIdx = parts.findIndex((p) => VERBS.has(p));
	if (verbIdx <= 0) {
		// Either no verb found, or verb is already at the front — leave as-is.
		return parts.map(cap).join(" ");
	}
	const verb = parts[verbIdx];
	const rest = [...parts.slice(0, verbIdx), ...parts.slice(verbIdx + 1)];
	return cap(verb) + " " + rest.map(cap).join(" ");
}

async function walk(dir: string, files: string[] = []): Promise<string[]> {
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		if (entry.name === "__tests__" || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			await walk(full, files);
		} else if (
			entry.name.endsWith(".ts") &&
			!entry.name.endsWith(".test.ts")
		) {
			files.push(full);
		}
	}
	return files;
}

interface Change {
	name: string;
	title: string;
	line: number;
}

/**
 * Find every tool registration in `content` and return the ones that
 * need a title inserted. Returns insertion points (character offsets +
 * the title string to splice in).
 */
function findInsertions(content: string): Array<{ offset: number; insertion: string; change: Change }> {
	const out: Array<{ offset: number; insertion: string; change: Change }> = [];

	// Pattern 1: server.registerTool(
	//              "name",
	//              {
	const RT = /server\.registerTool\(\s*\n\s*"([a-z][a-z0-9_]*)"\s*,\s*\n(\s*)\{/g;
	// Pattern 2: registerToolWithAliases(
	//              server,
	//              "name",
	//              [...],
	//              {
	const RTWA =
		/registerToolWithAliases\(\s*\n\s*server\s*,\s*\n\s*"([a-z][a-z0-9_]*)"\s*,\s*\n\s*\[[^\]]*\]\s*,\s*\n(\s*)\{/g;

	for (const pattern of [RT, RTWA]) {
		// Reset lastIndex; matchAll handles it
		for (const match of content.matchAll(pattern)) {
			const name = match[1];
			const baseIndent = match[2] ?? "";
			const matchStart = match.index ?? 0;
			const matchEnd = matchStart + match[0].length;

			// Look ahead ~600 chars to find the closing `}` of the config and
			// check whether `title:` is already there. We bound the lookahead
			// so we don't accidentally match a `title:` in a much later
			// registration's config.
			const lookahead = content.slice(matchEnd, matchEnd + 600);
			// Find the first `}` that's a sibling (not inside a nested object).
			// Simple heuristic: scan until depth returns to 0.
			let depth = 1;
			let configEnd = -1;
			for (let i = 0; i < lookahead.length; i++) {
				const ch = lookahead[i];
				if (ch === "{") depth++;
				else if (ch === "}") {
					depth--;
					if (depth === 0) {
						configEnd = i;
						break;
					}
				}
			}
			const configBody = configEnd >= 0 ? lookahead.slice(0, configEnd) : lookahead;
			if (/\btitle\s*:/.test(configBody)) continue; // already has title

			const innerIndent = `${baseIndent}\t`;
			const title = toTitle(name);
			const insertion = `\n${innerIndent}title: ${JSON.stringify(title)},`;
			const line = content.slice(0, matchEnd).split("\n").length;

			out.push({
				offset: matchEnd, // right after the `{`
				insertion,
				change: { name, title, line },
			});
		}
	}

	// Sort descending so splices don't shift earlier offsets.
	out.sort((a, b) => b.offset - a.offset);
	return out;
}

async function processFile(file: string, dryRun: boolean): Promise<Change[]> {
	const content = await readFile(file, "utf-8");
	const insertions = findInsertions(content);
	if (insertions.length === 0) return [];

	if (dryRun) return insertions.map((i) => i.change);

	let next = content;
	for (const { offset, insertion } of insertions) {
		next = next.slice(0, offset) + insertion + next.slice(offset);
	}
	await writeFile(file, next, "utf-8");
	return insertions.map((i) => i.change);
}

async function main(): Promise<void> {
	const dryRun = process.argv.includes("--dry");
	const files = await walk(ROOT);

	const byFile: Array<{ file: string; changes: Change[] }> = [];
	for (const file of files) {
		const changes = await processFile(file, dryRun);
		if (changes.length > 0) {
			byFile.push({ file, changes });
		}
	}

	let total = 0;
	for (const { file, changes } of byFile) {
		console.log(`\n${file.replace(`${new URL("..", import.meta.url).pathname}/`, "")}`);
		for (const c of changes) {
			console.log(`  L${c.line}  ${c.name}  →  "${c.title}"`);
			total++;
		}
	}
	console.log(`\n${dryRun ? "[DRY RUN] Would add" : "Added"} ${total} title field(s) across ${byFile.length} file(s).`);
}

await main();
