/**
 * Voice WebSocket client.
 *
 * Thin typed wrapper around the bidirectional `/ws/voice` endpoint exposed
 * by `apps/api/src/plugins/ws-voice.ts`. Used by the `voice_call` MCP tool
 * to drive live phone calls — the tool sends `call.create`, waits for
 * `call.transcription` events with `isFinal: true`, asks Claude what to
 * say via MCP elicitation, then sends `call.speak`. The protocol details
 * are authoritative in ws-voice.ts; this file mirrors them and adds a
 * promise-based `next()` so the tool can `await` each event linearly.
 *
 * Auth: the bearer token is passed as `?apiKey=` query param (supported
 * by the ws-voice plugin's auth handler). Bun's WebSocket constructor
 * also accepts a `headers` option for Authorization, but the query-param
 * path is portable to any WS client implementation and the connection is
 * server-to-server (MCP server → Anima API), so query-param leakage
 * concerns don't apply the same way they do for user-facing URLs.
 */

// ── Server → client message types (mirrors apps/api/src/plugins/ws-voice.ts) ──

export type VoiceServerMessage =
	| { type: "pong" }
	| { type: "call.ringing"; requestId?: string; callId: string }
	| {
			type: "call.started";
			requestId?: string;
			callId: string;
			from: string;
			to: string;
			tier: "basic" | "premium";
			direction: "INBOUND" | "OUTBOUND";
	  }
	| {
			type: "call.transcription";
			callId: string;
			speaker: "agent" | "caller";
			text: string;
			isFinal: boolean;
			confidence?: number;
			turnId?: string;
	  }
	| { type: "call.speak.ended"; callId: string; text: string }
	| {
			type: "call.interrupted";
			callId: string;
			spokenUntil: string;
			newTranscription: string;
	  }
	| {
			type: "call.ended";
			callId: string;
			reason: string;
			duration: number;
			tier: string;
	  }
	| {
			type: "call.error";
			code: string;
			message: string;
			callId?: string;
			requestId?: string;
	  }
	| {
			type: "call.incoming";
			callId: string;
			from: string;
			to: string;
			phoneIdentityId: string;
			defaultTier: string;
			defaultVoice?: unknown;
	  }
	| { type: "call.reconnected"; callId: string; state: string };

// ── Client → server message types ──

export type VoiceClientMessage =
	| { type: "ping" }
	| {
			type: "call.create";
			requestId: string;
			to: string;
			tier?: "basic" | "premium";
			voice?: { voiceId?: string };
			greeting?: string;
			fromNumber?: string;
			/** Required when the WS auth is user-bound (no agentId in the auth
			 *  context, e.g. master key or user-bound Anima Connect grant) —
			 *  selects which of the org's agents to bind the conn to. The API
			 *  rejects with AGENT_MISMATCH if the conn is already bound to a
			 *  different agent. */
			agentId?: string;
	  }
	| { type: "call.speak"; callId: string; text: string; turnId?: string }
	| { type: "call.speak.cancel"; callId: string }
	| { type: "call.hangup"; callId: string; reason?: string };

export interface VoiceSocketOptions {
	/** HTTP base URL of the Anima API; `ws(s)://...` is derived. */
	apiBaseUrl: string;
	/** Bearer token (passed as `?apiKey=` query param). */
	apiKey: string;
	/** Override the WS endpoint URL entirely (skips derivation). */
	wsUrlOverride?: string;
	/** Abort signal — closing the socket on abort. */
	signal?: AbortSignal;
}

// ── Implementation ──

/**
 * Connection-level error from the WebSocket close handshake.
 *
 * The /ws/voice plugin uses 4001/4002 for auth/limit failures (see
 * apps/api/src/plugins/ws-voice.ts:816,831). Surfacing the code so the
 * tool can distinguish "bad credential" from "connection refused".
 */
export class VoiceSocketError extends Error {
	constructor(
		public readonly code: number,
		message: string,
	) {
		super(message);
		this.name = "VoiceSocketError";
	}
}

export class VoiceSocket {
	private readonly ws: WebSocket;
	private readonly queue: VoiceServerMessage[] = [];
	private readonly waiters: Array<
		(value: VoiceServerMessage | null) => void
	> = [];
	private closed = false;
	private closeCode: number | null = null;
	private closeReason: string | null = null;

	private constructor(ws: WebSocket, signal?: AbortSignal) {
		this.ws = ws;

		ws.addEventListener("message", (e: MessageEvent) => {
			const raw =
				typeof e.data === "string"
					? e.data
					: e.data instanceof ArrayBuffer
						? new TextDecoder().decode(e.data)
						: String(e.data);
			let parsed: VoiceServerMessage;
			try {
				parsed = JSON.parse(raw) as VoiceServerMessage;
			} catch {
				// Malformed payload — skip. We don't currently log it because
				// the upstream protocol is stable and any parse failure points
				// at infra-level corruption that won't recover by logging here.
				return;
			}
			this.deliver(parsed);
		});

		ws.addEventListener("close", (e: CloseEvent) => {
			this.closed = true;
			this.closeCode = e.code;
			this.closeReason = e.reason ?? null;
			// Wake every pending waiter with null so iterators exit cleanly.
			while (this.waiters.length > 0) {
				const waiter = this.waiters.shift();
				waiter?.(null);
			}
		});

		ws.addEventListener("error", () => {
			// Browser/Bun WebSocket "error" events carry no useful payload —
			// the meaningful detail comes through the subsequent "close" event
			// with its code+reason. Leaving this empty is intentional; do not
			// set `closed = true` here because some implementations fire both
			// error+close and we want the close handler to be authoritative.
		});

		if (signal) {
			if (signal.aborted) {
				this.close(1000, "aborted");
			} else {
				signal.addEventListener(
					"abort",
					() => {
						this.close(1000, "aborted");
					},
					{ once: true },
				);
			}
		}
	}

	private deliver(msg: VoiceServerMessage): void {
		const waiter = this.waiters.shift();
		if (waiter) {
			waiter(msg);
			return;
		}
		this.queue.push(msg);
	}

	/**
	 * Resolve when the underlying WebSocket reaches the OPEN state. Throws
	 * `VoiceSocketError` if the connection fails before that — typically a
	 * 4001 (bad token) or 4002 (connection limit) close from /ws/voice.
	 */
	private async waitOpen(): Promise<void> {
		// WebSocket.OPEN is the spec constant 1. We compare to 1 directly to
		// avoid depending on a static field that some bundlers strip during
		// dead-code elimination.
		if (this.ws.readyState === 1) return;
		await new Promise<void>((resolve, reject) => {
			const onOpen = () => {
				this.ws.removeEventListener("open", onOpen);
				this.ws.removeEventListener("close", onClose);
				resolve();
			};
			const onClose = (e: CloseEvent) => {
				this.ws.removeEventListener("open", onOpen);
				this.ws.removeEventListener("close", onClose);
				reject(
					new VoiceSocketError(
						e.code,
						`WebSocket closed before open: code=${e.code} reason=${e.reason || "(none)"}`,
					),
				);
			};
			this.ws.addEventListener("open", onOpen);
			this.ws.addEventListener("close", onClose);
		});
	}

	/**
	 * Open a connection to /ws/voice and resolve when it's ready to send.
	 */
	static async open(opts: VoiceSocketOptions): Promise<VoiceSocket> {
		const wsUrl = opts.wsUrlOverride ?? buildVoiceWsUrl(opts.apiBaseUrl, opts.apiKey);
		const ws = new WebSocket(wsUrl);
		const socket = new VoiceSocket(ws, opts.signal);
		await socket.waitOpen();
		return socket;
	}

	/**
	 * Wait for the next server message. Resolves to `null` when the socket
	 * has closed (clean exit signal — iterate `while ((msg = await next()))`).
	 * Optional `timeoutMs` resolves to `null` if no message arrives in time;
	 * the socket stays open.
	 */
	async next(timeoutMs?: number): Promise<VoiceServerMessage | null> {
		if (this.queue.length > 0) {
			// biome-ignore lint/style/noNonNullAssertion: length-guarded
			return this.queue.shift()!;
		}
		if (this.closed) return null;

		return new Promise<VoiceServerMessage | null>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const waiter = (msg: VoiceServerMessage | null) => {
				if (timer) clearTimeout(timer);
				resolve(msg);
			};
			if (timeoutMs && timeoutMs > 0) {
				timer = setTimeout(() => {
					const idx = this.waiters.indexOf(waiter);
					if (idx >= 0) this.waiters.splice(idx, 1);
					resolve(null);
				}, timeoutMs);
			}
			this.waiters.push(waiter);
		});
	}

	/** Send a typed client message. Throws if the socket is closed. */
	send(msg: VoiceClientMessage): void {
		if (this.ws.readyState !== 1) {
			throw new VoiceSocketError(
				this.closeCode ?? 0,
				`Cannot send ${msg.type}: WebSocket not open (state=${this.ws.readyState})`,
			);
		}
		this.ws.send(JSON.stringify(msg));
	}

	/** Close the socket. No-op if already closed. */
	close(code = 1000, reason = "normal_closure"): void {
		if (this.closed) return;
		try {
			this.ws.close(code, reason);
		} catch {
			// Some runtimes throw if called too early — we still want the
			// state to flip to closed so iterators exit; the close handler
			// won't fire in that case, so manually flush waiters.
			this.closed = true;
			while (this.waiters.length > 0) {
				const waiter = this.waiters.shift();
				waiter?.(null);
			}
		}
	}

	get isClosed(): boolean {
		return this.closed;
	}

	get closeInfo(): { code: number | null; reason: string | null } {
		return { code: this.closeCode, reason: this.closeReason };
	}
}

/**
 * Derive the WebSocket URL from the HTTP API base URL.
 *
 * `https://api.useanima.sh` → `wss://api.useanima.sh/ws/voice?apiKey=...`
 * `http://127.0.0.1:3100`  → `ws://127.0.0.1:3100/ws/voice?apiKey=...`
 *
 * The ws-voice plugin accepts the bearer token either via Authorization
 * header (preferred) or `?apiKey=`/`?token=` query param. We use the query
 * param so this works across WS client implementations that don't expose
 * custom-header support.
 */
export function buildVoiceWsUrl(apiBaseUrl: string, apiKey: string): string {
	const wsBase = apiBaseUrl
		.replace(/^http:\/\//, "ws://")
		.replace(/^https:\/\//, "wss://")
		.replace(/\/$/, "");
	return `${wsBase}/ws/voice?apiKey=${encodeURIComponent(apiKey)}`;
}
