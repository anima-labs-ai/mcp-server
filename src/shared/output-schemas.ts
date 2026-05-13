/**
 * Reusable Zod output schemas for MCP tool responses.
 *
 * MCP spec 2025-11-25 says: if a tool declares `outputSchema`, the server
 * MUST return `structuredContent` conforming to it. `toolSuccess` handles
 * the structuredContent side; these helpers provide the schema side.
 *
 * Most Anima API responses fall into a small number of shapes:
 *   - single resource:     { id, ... }                     → objectOutput()
 *   - paginated list:      { items, cursor?, total? }      → listOutput()
 *   - send / create:       { id?, messageId?, status? }    → sendOutput()
 *   - delete:              {} or { deleted: true }         → deleteOutput()
 *   - action / state ack:  variable                        → objectOutput()
 *
 * All schemas are `.passthrough()` — extra fields from the API don't fail
 * validation. The point of declaring a schema isn't to lock the response
 * down (that would couple the MCP layer to API drift); it's to tell the
 * client "this returns an object with at least these top-level fields,"
 * which is enough for permission UIs, downstream tool-chaining, and
 * structured-content rendering.
 *
 * For tools where the response shape is well-known and stable, prefer
 * defining a tighter inline Zod schema rather than reaching for one of
 * these — the tighter the schema, the more useful the type info to the
 * LLM.
 */

import { z } from "zod";

/**
 * Permissive object response. Use when the API returns any JSON object
 * and the shape isn't worth pinning down in this layer (most CRUD
 * GET/POST/PATCH endpoints).
 */
export function objectOutput() {
	return z.object({}).passthrough().shape;
}

/**
 * Standard list / paginated response. `items` is the data array;
 * cursor/total/has_more/next_offset cover the common pagination shapes
 * across Anima's API and the MCP best-practices guide. `toolSuccess`
 * wraps top-level arrays into `{ items: [...] }` so list endpoints that
 * return raw arrays still match.
 */
export function listOutput() {
	return z
		.object({
			items: z.array(z.unknown()).optional(),
			cursor: z.string().nullable().optional(),
			total: z.number().optional(),
			has_more: z.boolean().optional(),
			next_offset: z.number().optional(),
			count: z.number().optional(),
		})
		.passthrough().shape;
}

/**
 * Send / create response. Most send and create endpoints return either
 * `id` or `messageId` (or both) plus a status. Permissive on the rest.
 */
export function sendOutput() {
	return z
		.object({
			id: z.string().optional(),
			messageId: z.string().optional(),
			status: z.string().optional(),
		})
		.passthrough().shape;
}

/**
 * Delete response. Most delete endpoints return either empty `{}`,
 * `{ deleted: true }`, or the deleted resource — all match this shape.
 */
export function deleteOutput() {
	return z
		.object({
			deleted: z.boolean().optional(),
			id: z.string().optional(),
		})
		.passthrough().shape;
}

/**
 * Status / health response. Used for whoami, check_health, vault_status,
 * phone_status, link_status — any tool whose return is a state snapshot.
 */
export function statusOutput() {
	return z
		.object({
			status: z.string().optional(),
			ok: z.boolean().optional(),
		})
		.passthrough().shape;
}
