import { describe, test, expect } from "bun:test";
import { ApiClient, type ToolRegistrationOptions } from "../../../shared/index.js";
import { registerEmailTools } from "../email/index.js";

// ---------------------------------------------------------------------------
// Attachment pass-through on email_send (competitive-parity item C6,
// founder checklist row 7: "no silent-drop 200s anywhere"). The MCP layer
// accepts `attachments` in its input schema — these tests pin that the
// array reaches the POST /v1/email/send body byte-for-byte. If a refactor
// drops the field, the API would still 200 (attachments are optional
// server-side) and the recipient would silently get no file; this suite is
// the tripwire for that class of bug on the MCP surface.
// ---------------------------------------------------------------------------

interface CapturedCall {
	path: string;
	body: Record<string, unknown>;
}

function captureEmailSend(): {
	handler: (args: Record<string, unknown>) => Promise<unknown>;
	calls: CapturedCall[];
} {
	const client = new ApiClient({ baseUrl: "http://localhost:3100", apiKey: "test-key" });
	const calls: CapturedCall[] = [];
	// biome-ignore lint/suspicious/noExplicitAny: test double for one method.
	(client as any).post = async (path: string, body: Record<string, unknown>) => {
		calls.push({ path, body });
		return { id: "msg_1", status: "SENT" };
	};

	let handler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
	const fakeServer = {
		registerTool(
			name: string,
			_config: unknown,
			h: (args: Record<string, unknown>) => Promise<unknown>,
		) {
			if (name === "email_send") handler = h;
		},
	};
	registerEmailTools({
		// biome-ignore lint/suspicious/noExplicitAny: minimal fake — only registerTool is used.
		server: fakeServer as any,
		context: { client, hasMasterKey: false },
	} as ToolRegistrationOptions);
	if (!handler) throw new Error("email_send was not registered");
	return { handler, calls };
}

const BASE_ARGS = {
	agentId: "clxagent00000000000000000",
	to: ["user@example.com"],
	subject: "Report attached",
	body: "See attachment.",
};

describe("email_send attachment pass-through", () => {
	test("inline base64 attachment reaches POST /v1/email/send verbatim", async () => {
		const { handler, calls } = captureEmailSend();
		const attachments = [
			{
				filename: "report.pdf",
				contentType: "application/pdf",
				content: "JVBERi0xLjQK", // base64 bytes
			},
		];

		await handler({ ...BASE_ARGS, attachments });

		expect(calls).toHaveLength(1);
		expect(calls[0].path).toBe("/v1/email/send");
		expect(calls[0].body.attachments).toEqual(attachments);
	});

	test("url attachment and contentId (inline cid) pass through verbatim", async () => {
		const { handler, calls } = captureEmailSend();
		const attachments = [
			{ url: "https://example.com/logo.png", contentId: "logo", filename: "logo.png" },
		];

		await handler({ ...BASE_ARGS, attachments });

		expect(calls[0].body.attachments).toEqual(attachments);
	});

	test("no attachments key at all when the caller sends none", async () => {
		const { handler, calls } = captureEmailSend();

		await handler({ ...BASE_ARGS });

		expect(calls).toHaveLength(1);
		expect("attachments" in calls[0].body).toBe(false);
	});

	test("empty attachments array is omitted, not sent as []", async () => {
		const { handler, calls } = captureEmailSend();

		await handler({ ...BASE_ARGS, attachments: [] });

		expect("attachments" in calls[0].body).toBe(false);
	});
});
