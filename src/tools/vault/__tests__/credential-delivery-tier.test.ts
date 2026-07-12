import { describe, test, expect } from "bun:test";
import { selectCredentialDeliveryTier } from "../vault/index.js";

/**
 * `selectCredentialDeliveryTier` picks how a human is asked for a secret, from
 * the connecting client's DECLARED capabilities. Ordering is by UX quality for
 * a *credential* (branded + masked wins), falling back to the most universal:
 *
 *   ui    — client renders our own branded MCP-App UI inline (best)
 *   url   — client shows a native dialog linking to our branded fill page
 *   form  — client renders a generic inline elicitation form (unbranded)
 *   email — no interactive surface; email the single-use fill link
 *
 * The WHY these tests encode: the tool must never send a client a mode it did
 * not advertise (that's a protocol violation that fails at runtime), and a
 * credential is better captured on our branded/masked surface than a generic
 * form — so `url` outranks `form` even though `form` is inline.
 */
describe("selectCredentialDeliveryTier", () => {
	test("client that advertises the io.modelcontextprotocol/ui extension → ui", () => {
		expect(
			selectCredentialDeliveryTier({
				extensions: { "io.modelcontextprotocol/ui": { mimeTypes: ["text/html;profile=mcp-app"] } },
			}),
		).toBe("ui");
	});

	test("ui wins even when the client also supports elicitation", () => {
		expect(
			selectCredentialDeliveryTier({
				extensions: { "io.modelcontextprotocol/ui": {} },
				elicitation: { form: {}, url: {} },
			}),
		).toBe("ui");
	});

	test("url-mode elicitation → url (native link dialog to our page)", () => {
		expect(selectCredentialDeliveryTier({ elicitation: { url: {} } })).toBe("url");
	});

	test("form+url → url (branded page beats a generic form for a secret)", () => {
		expect(selectCredentialDeliveryTier({ elicitation: { form: {}, url: {} } })).toBe("url");
	});

	test("form-only elicitation → form (generic inline)", () => {
		expect(selectCredentialDeliveryTier({ elicitation: { form: {} } })).toBe("form");
	});

	test("bare legacy elicitation {} (predates sub-modes) → form", () => {
		expect(selectCredentialDeliveryTier({ elicitation: {} })).toBe("form");
	});

	test("no interactive capability → email", () => {
		expect(selectCredentialDeliveryTier({})).toBe("email");
		expect(selectCredentialDeliveryTier(undefined)).toBe("email");
	});
});
