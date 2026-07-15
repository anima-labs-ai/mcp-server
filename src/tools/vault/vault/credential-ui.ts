// Branded MCP-App UI for the `ui` tier of vault_credential_request_create.
//
// Served as `ui://anima/credential-request` (`text/html;profile=mcp-app`) and
// linked from the tool via `_meta.ui.resourceUri`. An MCP-Apps host (Claude
// Desktop) renders it inline via the official SEP-1865 protocol
// (`@modelcontextprotocol/ext-apps` `App` client, inlined below — no CDN). The
// tool RESULT (render-data: fillToken + field schema + vaultUrl) arrives on
// `ontoolresult`; the human fills the branded form; on save the secret is
// submitted with `callServerTool(vault_credential_request_fill)` (host-bridged,
// so no cross-origin fetch/CSP) — it never enters the model's context. After
// saving, the widget locks and offers a link into the Anima vault.
//
// Visual language matches the Anima platform: #09090b/#0a0a0a blacks, #22c55e
// green, sharp corners, mono type, a dot-grid + green-glow background.
import { readFileSync } from "node:fs";

export const CREDENTIAL_UI_RESOURCE = "ui://anima/credential-request";

/** The ext-apps App SDK, transformed to expose `globalThis.__ANIMA_EXTAPPS`. */
const SDK_JS = readFileSync(
	new URL("./credential-ui-sdk.js", import.meta.url),
	"utf8",
);

const WIDGET_JS = `
(async () => {
  const dbg = (m) => { try { console.log("[anima-vault]", m); } catch (e) {} };
  const SECRET = /pass|secret|totp|token|key|code|cvv|pin|ssn|private|credential/i;
  const state = { requestId: null, fillToken: null, fillEndpoint: null, vaultUrl: null };
  let app = null;

  // Read the request status from whatever shape callServerTool hands back: a full
  // CallToolResult (structuredContent / content[] text) OR the structured object
  // itself (some hosts unwrap it). Failing to read any of these must not look like
  // "not fulfilled" — that would redraw the entry form over a completed request.
  function statusOf(result) {
    if (!result) return undefined;
    let s = result.structuredContent
      || (result.result && result.result.structuredContent)
      || (typeof result.status === "string" ? result : null);
    if (!s) {
      const content = result.content || (result.result && result.result.content);
      if (Array.isArray(content)) {
        const t = content.find((c) => c && c.type === "text");
        if (t) { try { s = JSON.parse(t.text); } catch {} }
      }
    }
    return s && s.status;
  }

  // Ask the server for the request's live status. Returns the status string, or
  // null if it can't be determined (transient error → caller draws the form so a
  // genuinely open request stays fillable).
  async function liveStatus(requestId) {
    if (!app || !requestId) return null;
    try {
      const r = await app.callServerTool({ name: "vault_credential_request_status", arguments: { requestId } });
      return statusOf(r) || null;
    } catch (e) { dbg("status check: " + (e && e.message)); return null; }
  }

  function draw(message, schema) {
    const dash = (message || "").indexOf(" \\u2014 ");
    document.getElementById("title").textContent = dash > 0 ? message.slice(0, dash) : (message || "Provide a credential");
    document.getElementById("reason").textContent = dash > 0 ? message.slice(dash + 3) : "";
    const form = document.getElementById("form");
    form.textContent = "";
    const props = (schema && schema.properties) || {};
    const required = (schema && schema.required) || [];
    for (const key of Object.keys(props)) {
      const spec = props[key] || {};
      const secret = SECRET.test(key);
      const field = document.createElement("div"); field.className = "field";
      const lab = document.createElement("label");
      lab.textContent = (spec.title || key) + (required.indexOf(key) < 0 ? " · optional" : "");
      const inp = document.createElement("input");
      inp.type = secret ? "password" : "text"; inp.id = "f_" + key; inp.name = key;
      inp.autocomplete = secret ? "new-password" : "off"; inp.spellcheck = false;
      inp.placeholder = secret ? "••••••••••••" : "";
      field.appendChild(lab); field.appendChild(inp);
      if (spec.description) { const p = document.createElement("p"); p.className = "desc"; p.textContent = spec.description; field.appendChild(p); }
      form.appendChild(field);
    }
    document.getElementById("actions").classList.remove("hidden");
  }

  async function ingest(payload) {
    const sc = payload && (payload.structuredContent || (payload.result && payload.result.structuredContent));
    let data = sc;
    if (!data && payload && Array.isArray(payload.content)) {
      const t = payload.content.find((c) => c.type === "text");
      if (t) { try { data = JSON.parse(t.text); } catch {} }
    }
    if (!data) { dbg("no data in result: " + JSON.stringify(payload).slice(0, 160)); return; }
    dbg("data ok: " + JSON.stringify(data).slice(0, 140));
    state.requestId = data.requestId || null;
    state.fillToken = data.fillToken || null;
    state.fillEndpoint = data.fillEndpoint || null;
    state.vaultUrl = data.vaultUrl || null;
    // Revisiting a past chat re-renders the widget with the ORIGINAL
    // AWAITING_INPUT data on a fresh DOM, so reconcile against the request's LIVE
    // status before drawing: fulfilled → locked "saved"; a dead request
    // (expired/cancelled/declined) → a clear closed state, never a live-looking
    // entry form; only a still-open (or unknown) request draws the form.
    const status = await liveStatus(state.requestId);
    if (status === "FULFILLED") { dbg("already fulfilled \\u2192 saved"); saved(); return; }
    if (status === "EXPIRED" || status === "CANCELLED" || status === "DECLINED") {
      dbg("request closed: " + status); closed(status); return;
    }
    draw(data.message, data.requestedSchema);
  }

  // Saved terminal state: lock the widget (form gone, no re-entry) + vault link.
  function saved() {
    document.getElementById("card").classList.add("hidden");
    document.getElementById("done").classList.remove("hidden");
    const btn = document.getElementById("openVault");
    if (state.vaultUrl) { btn.classList.remove("hidden"); }
  }

  // Closed terminal state: the request expired / was cancelled / declined, so the
  // fill link is dead. Show a clear "no longer active" message instead of a live-
  // looking entry form (nothing was stored → no vault link).
  function closed(status) {
    document.getElementById("card").classList.add("hidden");
    const done = document.getElementById("done");
    const label = status === "EXPIRED" ? "expired" : status === "DECLINED" ? "was declined" : "was cancelled";
    const check = done.querySelector(".check"); if (check) check.classList.add("hidden");
    const t = done.querySelector(".t"); if (t) t.textContent = "Request no longer active";
    const s = done.querySelector(".s"); if (s) s.textContent = "This credential request " + label + ". Ask your agent to send a new one.";
    document.getElementById("openVault").classList.add("hidden");
    done.classList.remove("hidden");
  }

  document.getElementById("submit").addEventListener("click", async () => {
    const content = {};
    document.querySelectorAll("#form input").forEach((i) => { if (i.value) content[i.name] = i.value; });
    if (!content.password && document.getElementById("f_password")) { dbg("password required"); return; }
    const btn = document.getElementById("submit"); btn.disabled = true; btn.textContent = "Saving…";
    if (!app) { dbg("ERROR: not connected"); btn.disabled = false; btn.textContent = "Save to vault"; return; }
    try {
      await app.callServerTool({ name: "vault_credential_request_fill", arguments: { fillToken: state.fillToken || "", values: content } });
      dbg("saved via callServerTool"); saved();
    } catch (e) {
      dbg("callServerTool error: " + (e && e.message));
      if (state.fillEndpoint) {
        try { const r = await fetch(state.fillEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(content) }); dbg("fetch fallback: " + r.status); if (r.ok) { saved(); return; } } catch (e2) { dbg("fetch fallback error: " + (e2 && e2.message)); }
      }
      btn.disabled = false; btn.textContent = "Save to vault";
    }
  });
  document.getElementById("decline").addEventListener("click", () => { document.getElementById("actions").classList.add("hidden"); document.getElementById("form").classList.add("hidden"); });
  document.getElementById("openVault").addEventListener("click", async () => {
    if (!state.vaultUrl) return;
    try { if (app && app.openLink) { await app.openLink({ url: state.vaultUrl }); return; } } catch (e) { dbg("openLink: " + (e && e.message)); }
    try { window.open(state.vaultUrl, "_blank"); } catch {}
  });

  try {
    const api = window.__ANIMA_EXTAPPS;
    if (!api || !api.App) { dbg("FATAL: SDK global missing"); return; }
    dbg("SDK inlined ok");
    app = new api.App({ name: "anima-credential-form", version: "1.0.0" }, {}, { autoResize: true });
    app.ontoolinput = () => {};
    app.ontoolresult = (p) => ingest(p);
    await app.connect();
    dbg("connected to host");
    try {
      const ctx = app.getHostContext && app.getHostContext();
      const modes = (ctx && ctx.availableDisplayModes) || [];
      if (modes.includes("fullscreen")) await app.requestDisplayMode({ mode: "fullscreen" });
    } catch (e) { dbg("displayMode: " + (e && e.message)); }
    const report = () => { try { app.sendSizeChanged({ width: document.documentElement.scrollWidth || 460, height: document.documentElement.scrollHeight || 440 }); } catch (e) {} };
    report();
    try { new ResizeObserver(report).observe(document.documentElement); } catch {}
  } catch (e) { dbg("connect error: " + (e && e.message)); }
})();
`;

export const CREDENTIAL_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root {
    color-scheme: dark;
    --bg: #09090b; --surface: #0c0c0e; --input: #0a0a0a;
    --fg: #fafafa; --muted: #888888; --dim: #555555;
    --accent: #22c55e; --accent-hi: #4ade80; --accent-mut: rgba(34,197,94,0.10);
    --line: rgba(255,255,255,0.10); --line-soft: rgba(255,255,255,0.07);
    --mono: ui-monospace, "Geist Mono", "SF Mono", SFMono-Regular, Menlo, Consolas, monospace;
    --sans: "Inter", ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px; font: 14px/1.5 var(--sans); color: var(--fg);
    background:
      radial-gradient(ellipse 620px 280px at 50% -12%, rgba(34,197,94,0.10), transparent 70%),
      radial-gradient(circle, rgba(255,255,255,0.05) 1px, transparent 1px) 0 0 / 22px 22px,
      var(--bg);
  }
  .wrap { max-width: 468px; margin: 0 auto; }
  .card {
    position: relative; background: var(--surface); border: 1px solid var(--line-soft);
    padding: 22px; overflow: hidden;
  }
  /* corner tick accents */
  .card::before, .card::after { content: ""; position: absolute; width: 10px; height: 10px; border-color: var(--accent); border-style: solid; opacity: .5; }
  .card::before { top: -1px; left: -1px; border-width: 1px 0 0 1px; }
  .card::after { bottom: -1px; right: -1px; border-width: 0 1px 1px 0; }
  .brand { display: flex; align-items: center; gap: 8px; font: 600 11px var(--mono); letter-spacing: 2px; color: var(--accent); text-transform: uppercase; }
  .dot { width: 7px; height: 7px; background: var(--accent); box-shadow: 0 0 8px var(--accent); animation: pulse 1.8s ease-in-out infinite; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: .35; } }
  h1 { font: 650 18px var(--sans); margin: 12px 0 3px; letter-spacing: -.2px; }
  .reason { color: var(--muted); font-size: 13px; margin: 0 0 6px; }
  .field { margin-top: 16px; }
  label { display: block; font: 600 10.5px var(--mono); letter-spacing: 1.2px; text-transform: uppercase; color: var(--muted); margin-bottom: 6px; }
  .desc { color: var(--dim); font-size: 11px; margin: 4px 0 0; }
  input {
    width: 100%; padding: 11px 12px; border: 1px solid var(--line); background: var(--input);
    color: var(--fg); font: 13px var(--mono); outline: none; transition: border-color .12s, box-shadow .12s;
  }
  input::placeholder { color: #2c2c2c; }
  input:focus { border-color: rgba(34,197,94,0.5); box-shadow: 0 0 0 3px var(--accent-mut); }
  .row { display: flex; gap: 10px; margin-top: 22px; }
  .btn { flex: 1; padding: 11px 12px; border: 1px solid var(--line); background: #111; color: var(--fg); font: 700 11px var(--mono); letter-spacing: 1px; text-transform: uppercase; cursor: pointer; transition: all .12s; }
  .btn.ghost:hover { border-color: var(--accent); color: var(--accent); }
  .btn.primary { background: var(--accent); border-color: var(--accent); color: #04140b; }
  .btn.primary:hover { background: var(--accent-hi); border-color: var(--accent-hi); }
  .btn:disabled { opacity: .6; cursor: default; }
  .safe { margin-top: 14px; font: 10.5px var(--mono); letter-spacing: .3px; color: var(--dim); text-align: center; }
  /* saved state */
  .done { text-align: center; padding: 30px 22px; }
  .done .check { width: 46px; height: 46px; margin: 24px auto 16px; display: grid; place-items: center; color: var(--accent); border: 1px solid rgba(34,197,94,0.3); background: var(--accent-mut); font-size: 22px; }
  .done .t { font: 650 16px var(--sans); }
  .done .s { color: var(--muted); font-size: 12.5px; margin: 6px 0 20px; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="wrap">
    <div class="card" id="card">
      <div class="brand"><span class="dot"></span>Anima Vault</div>
      <h1 id="title">Provide a credential</h1>
      <p class="reason" id="reason">Connecting…</p>
      <form id="form"></form>
      <div class="row hidden" id="actions">
        <button type="button" class="btn ghost" id="decline">Cancel</button>
        <button type="button" class="btn primary" id="submit">Save to vault</button>
      </div>
      <p class="safe">Entered directly into your vault — the agent never sees it.</p>
    </div>
    <div class="card done hidden" id="done">
      <div class="brand" style="justify-content:center"><span class="dot"></span>Anima Vault</div>
      <div class="check"><svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 13l4 4L19 7"/></svg></div>
      <div class="t">Saved to your vault</div>
      <div class="s">The agent can use it now — but never sees the value.</div>
      <button type="button" class="btn primary hidden" id="openVault">Open in Anima Vault →</button>
    </div>
  </div>
<script>${SDK_JS}</script>
<script>${WIDGET_JS}</script>
</body>
</html>`;
