// Branded MCP-App UI for the `ui` tier of vault_credential_request_create.
//
// Served as the `ui://anima/credential-request` resource
// (`text/html;profile=mcp-app`) and linked from the tool via
// `_meta.ui.resourceUri`. An MCP-App host (Claude Desktop) renders it inline in
// a sandboxed iframe and drives it over postMessage:
//
//   host → app:  { type: "elicitation",        seq, params }   (params = the
//                 elicitation/create payload: message + requestedSchema)
//   app  → host: { type: "elicitationResult",  seq, result }   (result =
//                 { action: "accept", content } | { action: "decline" })
//
// The human types the secret HERE; the app returns it to the host, which hands
// it back to the server as the elicitation result — the server POSTs it to the
// token-gated fill endpoint. The value never reaches the agent/LLM, and the app
// makes NO network calls of its own (no CSP connect-src needed).

export const CREDENTIAL_UI_RESOURCE = "ui://anima/credential-request";

/** Static, self-contained page. Per-request fields arrive via the host's
 *  `elicitation` message (requestedSchema), so the HTML itself is generic. */
export const CREDENTIAL_UI_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 20px;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0b0f0d; color: #e8ece9;
  }
  .card {
    max-width: 460px; margin: 0 auto;
    background: #11161300; border: 1px solid #1f2a24; border-radius: 14px; padding: 22px 22px 18px;
  }
  .brand { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
  .dot { width: 9px; height: 9px; border-radius: 50%; background: #00e08a; box-shadow: 0 0 10px #00e08a88; }
  .brand span { font-weight: 600; letter-spacing: .2px; color: #00e08a; font-size: 13px; }
  h1 { font-size: 17px; margin: 6px 0 2px; font-weight: 650; }
  .reason { color: #9aa8a0; font-size: 13px; margin: 0 0 16px; }
  label { display: block; font-size: 12px; color: #b8c4bd; margin: 14px 0 5px; font-weight: 550; }
  .desc { color: #7f8d85; font-size: 11.5px; margin: 3px 0 0; }
  input {
    width: 100%; padding: 10px 12px; border-radius: 9px;
    border: 1px solid #26332c; background: #0e1411; color: #eef2ef; font-size: 14px; outline: none;
  }
  input:focus { border-color: #00e08a; box-shadow: 0 0 0 3px #00e08a22; }
  .row { display: flex; gap: 10px; margin-top: 20px; }
  button {
    flex: 1; padding: 11px; border-radius: 9px; border: 0; font-size: 14px; font-weight: 600; cursor: pointer;
  }
  .submit { background: #00e08a; color: #04140d; }
  .submit:hover { background: #1ceb9b; }
  .decline { background: transparent; color: #9aa8a0; border: 1px solid #26332c; }
  .decline:hover { border-color: #3a4a41; color: #cdd6d1; }
  .safe { margin-top: 14px; font-size: 11px; color: #6f7d75; text-align: center; }
  .ok { text-align: center; padding: 26px 8px; }
  .ok .check { width: 42px; height: 42px; border-radius: 50%; background: #00e08a1a; color: #00e08a; display: grid; place-items: center; font-size: 22px; margin: 0 auto 12px; }
  .hidden { display: none; }
</style>
</head>
<body>
  <div class="card">
    <div class="brand"><div class="dot"></div><span>ANIMA VAULT</span></div>
    <h1 id="title">Provide a credential</h1>
    <p class="reason" id="reason"></p>
    <form id="form"></form>
    <div class="row" id="actions">
      <button type="button" class="decline" id="decline">Decline</button>
      <button type="button" class="submit" id="submit">Save to vault</button>
    </div>
    <p class="safe">🔒 Entered directly into your vault — the agent never sees it.</p>
  </div>
  <div class="card hidden" id="done">
    <div class="ok"><div class="check">✓</div><div>Saved to your vault. The agent can now use it.</div></div>
  </div>
<script>
(function () {
  var SECRET = /pass|secret|totp|token|key|code|cvv|pin|ssn|private|credential/i;
  var seq = null;
  var el = function (id) { return document.getElementById(id); };

  function render(params) {
    var msg = (params && params.message) || "Provide a credential";
    // message is "Enter <name> — <reason>"; split for title/subtitle.
    var dash = msg.indexOf(" — ");
    el("title").textContent = dash > 0 ? msg.slice(0, dash) : msg;
    el("reason").textContent = dash > 0 ? msg.slice(dash + 3) : "";
    var schema = (params && params.requestedSchema) || { properties: {} };
    var required = schema.required || [];
    var form = el("form");
    form.innerHTML = "";
    Object.keys(schema.properties || {}).forEach(function (key) {
      var spec = schema.properties[key] || {};
      var secret = SECRET.test(key);
      var lab = document.createElement("label");
      lab.textContent = (spec.title || key) + (required.indexOf(key) < 0 ? " (optional)" : "");
      var inp = document.createElement("input");
      inp.type = secret ? "password" : "text";
      inp.id = "f_" + key; inp.name = key;
      inp.autocomplete = secret ? "new-password" : "off";
      form.appendChild(lab); form.appendChild(inp);
      if (spec.description) { var d = document.createElement("p"); d.className = "desc"; d.textContent = spec.description; form.appendChild(d); }
    });
  }

  function reply(result) {
    if (seq == null) return;
    parent.postMessage({ type: "elicitationResult", seq: seq, result: result }, "*");
    if (result.action === "accept") { el("done").classList.remove("hidden"); el("done").previousElementSibling; document.querySelector(".card").classList.add("hidden"); }
  }

  el("submit").addEventListener("click", function () {
    var content = {};
    document.querySelectorAll("#form input").forEach(function (i) { if (i.value) content[i.name] = i.value; });
    reply({ action: "accept", content: content });
  });
  el("decline").addEventListener("click", function () { reply({ action: "decline" }); });

  window.addEventListener("message", function (e) {
    var d = e.data || {};
    if (d.type === "elicitation") { seq = d.seq; render(d.params); }
    // mcp-ui.com hosts deliver render-data differently; support it defensively.
    if (d.type === "ui-lifecycle-iframe-render-data" && d.payload && d.payload.renderData) {
      render(d.payload.renderData);
    }
  });

  // Announce readiness to whichever host is embedding us.
  parent.postMessage({ type: "getEnvironment" }, "*");
  parent.postMessage({ type: "ui-lifecycle-iframe-ready" }, "*");
})();
</script>
</body>
</html>`;
