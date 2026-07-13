// Branded MCP-App UI for the `ui` tier of vault_credential_request_create.
//
// Served as `ui://anima/credential-request` (`text/html;profile=mcp-app`) and
// linked from the tool via `_meta.ui.resourceUri`. An MCP-Apps host (Claude
// Desktop) renders it inline and drives it with the official SEP-1865 protocol
// via the `@modelcontextprotocol/ext-apps` `App` client (inlined below — no
// CDN, self-contained). The tool RESULT (our render-data: fill endpoint + field
// schema) arrives on `ontoolresult`; the human fills the branded form; the app
// POSTs the secret straight to the token-gated fill endpoint — the value never
// returns through the agent/host.
//
// The App reports its content height to the host (`autoResize` + an explicit
// ResizeObserver → `sendSizeChanged`); without that the host renders the iframe
// at 0px (blank).
import { readFileSync } from "node:fs";

export const CREDENTIAL_UI_RESOURCE = "ui://anima/credential-request";

/** The ext-apps App SDK, transformed to expose `globalThis.__ANIMA_EXTAPPS`. */
const SDK_JS = readFileSync(
	new URL("./credential-ui-sdk.js", import.meta.url),
	"utf8",
);

const WIDGET_JS = `
(async () => {
  const dbg = (m) => { const d = document.getElementById("debug"); if (d) { d.textContent += "\\n" + m; d.scrollTop = d.scrollHeight; } };
  const SECRET = /pass|secret|totp|token|key|code|cvv|pin|ssn|private|credential/i;
  const state = { fillEndpoint: null, fillToken: null };
  let app = null;

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
      const lab = document.createElement("label");
      lab.textContent = (spec.title || key) + (required.indexOf(key) < 0 ? " (optional)" : "");
      const inp = document.createElement("input");
      inp.type = secret ? "password" : "text"; inp.id = "f_" + key; inp.name = key;
      form.appendChild(lab); form.appendChild(inp);
      if (spec.description) { const p = document.createElement("p"); p.className = "desc"; p.textContent = spec.description; form.appendChild(p); }
    }
    document.getElementById("actions").classList.remove("hidden");
  }

  function ingest(payload) {
    const sc = payload && (payload.structuredContent || (payload.result && payload.result.structuredContent));
    let data = sc;
    if (!data && payload && Array.isArray(payload.content)) {
      const t = payload.content.find((c) => c.type === "text");
      if (t) { try { data = JSON.parse(t.text); } catch {} }
    }
    if (!data) { dbg("no data in result: " + JSON.stringify(payload).slice(0, 160)); return; }
    dbg("data ok: " + JSON.stringify(data).slice(0, 160));
    state.fillEndpoint = data.fillEndpoint || null;
    state.fillToken = data.fillToken || null;
    draw(data.message, data.requestedSchema);
  }

  function done() { document.getElementById("form").classList.add("hidden"); document.getElementById("actions").classList.add("hidden"); document.getElementById("done").classList.remove("hidden"); }

  document.getElementById("submit").addEventListener("click", async () => {
    const content = {};
    document.querySelectorAll("#form input").forEach((i) => { if (i.value) content[i.name] = i.value; });
    if (!app) { dbg("ERROR: not connected"); return; }
    // Submit through the host bridge (callTool) — NOT a cross-origin fetch, which
    // the widget CSP blocks. The secret reaches the vault via the app-only fill
    // tool; it never enters the model's context.
    try {
      await app.callServerTool({ name: "vault_credential_request_fill", arguments: { fillToken: state.fillToken || "", values: content } });
      dbg("saved via callServerTool");
      done();
    } catch (e) {
      dbg("callServerTool error: " + (e && e.message));
      // Fallback: direct POST (works where the host permits it, e.g. prod https).
      if (state.fillEndpoint) {
        try { const r = await fetch(state.fillEndpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(content) }); dbg("fetch fallback: " + r.status); if (r.ok) done(); }
        catch (e2) { dbg("fetch fallback error: " + (e2 && e2.message)); }
      }
    }
  });
  document.getElementById("decline").addEventListener("click", () => { document.getElementById("actions").classList.add("hidden"); });

  try {
    const api = window.__ANIMA_EXTAPPS;
    if (!api || !api.App) { dbg("FATAL: SDK global missing"); return; }
    dbg("SDK inlined ok");
    app = new api.App({ name: "anima-credential-form", version: "1.0.0" }, {}, { autoResize: true });
    app.ontoolinput = () => {};
    app.ontoolresult = (p) => ingest(p);
    await app.connect();
    dbg("connected to host");
    // Ask the host to show the widget prominently (best-effort — hosts may ignore).
    try {
      const ctx = app.getHostContext && app.getHostContext();
      const modes = (ctx && ctx.availableDisplayModes) || [];
      if (modes.includes("fullscreen")) await app.requestDisplayMode({ mode: "fullscreen" });
    } catch (e) { dbg("displayMode: " + (e && e.message)); }
    const report = () => { try { app.sendSizeChanged({ width: document.documentElement.scrollWidth || 460, height: document.documentElement.scrollHeight || 400 }); } catch (e) { dbg("size err: " + (e && e.message)); } };
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
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 18px; font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; background: #0b0f0d; color: #e8ece9; }
  .card { max-width: 460px; margin: 0 auto; border: 1px solid #1f2a24; border-radius: 14px; padding: 20px; }
  .brand { display: flex; align-items: center; gap: 8px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #00e08a; box-shadow: 0 0 10px #00e08a88; }
  .brand span { font-weight: 600; letter-spacing: .2px; color: #00e08a; font-size: 13px; }
  h1 { font-size: 17px; margin: 8px 0 2px; font-weight: 650; }
  .reason { color: #9aa8a0; font-size: 13px; margin: 0 0 14px; }
  label { display: block; font-size: 12px; color: #b8c4bd; margin: 14px 0 5px; font-weight: 550; }
  .desc { color: #7f8d85; font-size: 11.5px; margin: 3px 0 0; }
  input { width: 100%; padding: 10px 12px; border-radius: 9px; border: 1px solid #26332c; background: #0e1411; color: #eef2ef; font-size: 14px; outline: none; }
  input:focus { border-color: #00e08a; box-shadow: 0 0 0 3px #00e08a22; }
  .row { display: flex; gap: 10px; margin-top: 20px; }
  button { flex: 1; padding: 11px; border-radius: 9px; border: 0; font-size: 14px; font-weight: 600; cursor: pointer; }
  .submit { background: #00e08a; color: #04140d; }
  .decline { background: transparent; color: #9aa8a0; border: 1px solid #26332c; }
  .safe { margin-top: 14px; font-size: 11px; color: #6f7d75; text-align: center; }
  .ok { text-align: center; padding: 24px 8px; color: #00e08a; }
  .hidden { display: none; }
  #debug { margin-top: 16px; padding: 8px 10px; border-radius: 8px; background: #0e1411; border: 1px dashed #26332c; color: #7f8d85; font: 11px/1.45 ui-monospace, Menlo, monospace; white-space: pre-wrap; word-break: break-all; max-height: 150px; overflow: auto; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand"><div class="dot"></div><span>ANIMA VAULT</span></div>
    <h1 id="title">Provide a credential</h1>
    <p class="reason" id="reason">Connecting…</p>
    <form id="form"></form>
    <div class="row hidden" id="actions">
      <button type="button" class="decline" id="decline">Cancel</button>
      <button type="button" class="submit" id="submit">Save to vault</button>
    </div>
    <div class="ok hidden" id="done">✓ Saved to your vault. The agent never sees it.</div>
    <p class="safe">🔒 Entered directly into your vault — the agent never sees it.</p>
    <div id="debug">debug ready…</div>
  </div>
<script>${SDK_JS}</script>
<script>${WIDGET_JS}</script>
</body>
</html>`;
