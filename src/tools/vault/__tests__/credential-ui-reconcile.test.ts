import { describe, expect, test } from "bun:test";
import { CREDENTIAL_UI_HTML } from "../vault/credential-ui.js";

class FakeClassList {
	readonly values = new Set<string>();

	add(value: string) {
		this.values.add(value);
	}

	remove(value: string) {
		this.values.delete(value);
	}

	contains(value: string) {
		return this.values.has(value);
	}
}

class FakeElement {
	readonly classList = new FakeClassList();
	readonly children: FakeElement[] = [];
	readonly selectors = new Map<string, FakeElement>();
	textContent = "";
	className = "";
	type = "";
	id = "";
	name = "";
	value = "";
	placeholder = "";
	autocomplete = "";
	spellcheck = false;
	disabled = false;

	addEventListener() {}

	appendChild(child: FakeElement) {
		this.children.push(child);
	}

	querySelector(selector: string) {
		return this.selectors.get(selector) ?? null;
	}
}

function createDocument() {
	const elements = Object.fromEntries(
		["submit", "decline", "openVault", "card", "done", "title", "reason", "form", "actions"].map(
			(id) => [id, new FakeElement()],
		),
	) as Record<string, FakeElement>;
	for (const id of ["openVault", "done", "actions"]) elements[id].classList.add("hidden");
	for (const selector of [".check", ".t", ".s"]) {
		elements.done.selectors.set(selector, new FakeElement());
	}

	return {
		elements,
		document: {
			documentElement: { scrollWidth: 460, scrollHeight: 440 },
			getElementById: (id: string) => elements[id] ?? null,
			querySelectorAll: () => [],
			createElement: () => new FakeElement(),
		},
	};
}

function widgetScript(): string {
	const scripts = Array.from(CREDENTIAL_UI_HTML.matchAll(/<script>([\s\S]*?)<\/script>/g));
	expect(scripts).toHaveLength(2);
	return scripts[1]?.[1] ?? "";
}

async function renderWidget(liveResult: unknown) {
	const { elements, document } = createDocument();
	let statusCalls = 0;
	const renderData = {
		requestId: "request-1",
		fillToken: "fill-token",
		vaultUrl: "https://console.useanima.sh/vault/agent-1",
		message: "Enter Login — Needed for invoices",
		requestedSchema: { properties: {} },
	};

	class FakeApp {
		ontoolresult?: (payload: unknown) => Promise<void>;

		async connect() {
			await this.ontoolresult?.({ structuredContent: renderData });
		}

		async callServerTool(request: { name: string }) {
			if (request.name !== "vault_credential_request_status") return {};
			statusCalls += 1;
			if (liveResult instanceof Error) throw liveResult;
			return liveResult;
		}

		getHostContext() {
			return { availableDisplayModes: [] };
		}

		sendSizeChanged() {}
	}

	const run = new Function(
		"window",
		"document",
		"ResizeObserver",
		"fetch",
		"console",
		widgetScript(),
	);
	run(
		{ __ANIMA_EXTAPPS: { App: FakeApp }, open() {} },
		document,
		class ResizeObserver {
			observe() {}
		},
		async () => ({ ok: false, status: 500 }),
		{ log() {} },
	);
	await Bun.sleep(0);

	return { elements, statusCalls };
}

/**
 * Revisiting a chat gives the widget stale AWAITING_INPUT render-data. These
 * tests execute the exact shipped widget script and prove that live server state,
 * not the stale payload, selects the rendered state.
 */
describe("credential-request widget: live-status reconciliation", () => {
	test("a fulfilled live request locks instead of redrawing the stale form", async () => {
		const { elements, statusCalls } = await renderWidget({ status: "FULFILLED" });

		expect(statusCalls).toBe(1);
		expect(elements.card.classList.contains("hidden")).toBe(true);
		expect(elements.done.classList.contains("hidden")).toBe(false);
		expect(elements.actions.classList.contains("hidden")).toBe(true);
		expect(elements.openVault.classList.contains("hidden")).toBe(false);
	});

	test("every dead live status renders a closed state with no form or vault link", async () => {
		for (const status of ["EXPIRED", "CANCELLED", "DECLINED"]) {
			const { elements } = await renderWidget({ structuredContent: { status } });
			expect(elements.card.classList.contains("hidden")).toBe(true);
			expect(elements.done.classList.contains("hidden")).toBe(false);
			expect(elements.actions.classList.contains("hidden")).toBe(true);
			expect(elements.openVault.classList.contains("hidden")).toBe(true);
			expect(elements.done.selectors.get(".check")?.classList.contains("hidden")).toBe(true);
			expect(elements.done.selectors.get(".t")?.textContent).toBe("Request no longer active");
		}
	});

	test("an open or temporarily unknown live status keeps the request fillable", async () => {
		for (const result of [{ status: "PENDING" }, new Error("status unavailable")]) {
			const { elements } = await renderWidget(result);
			expect(elements.card.classList.contains("hidden")).toBe(false);
			expect(elements.done.classList.contains("hidden")).toBe(true);
			expect(elements.actions.classList.contains("hidden")).toBe(false);
		}
	});
});
