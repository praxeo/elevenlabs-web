export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/transcribe" && request.method === "POST") {
      return handleTranscribe(request, env);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // "Shared mode" is on only when BOTH a shared key and an access code are
      // configured as Worker secrets. The flag is injected into the page so the
      // UI knows whether to show the access-code field. Served no-store, so it
      // is never cached.
      const sharedMode = Boolean(env && env.ELEVENLABS_API_KEY && env.APP_PASSPHRASE);
      return new Response(
        INDEX_HTML.replace("__SHARED_MODE__", sharedMode ? "true" : "false"),
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        }
      );
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  },
};

async function handleTranscribe(request, env) {
  try {
    const incoming = await request.formData();

    // Key resolution: a client-provided key always wins (bring-your-own). When
    // none is given, fall back to the shared server key — but only if a matching
    // access code is supplied. Setting a server key WITHOUT an access code leaves
    // shared mode off (fail-safe: the shared key is never exposed un-gated).
    const clientKey  = String(incoming.get("api_key") || "").trim();
    const serverKey  = (env && env.ELEVENLABS_API_KEY) || "";
    const serverPass = (env && env.APP_PASSPHRASE) || "";

    let apiKey = clientKey;
    if (!apiKey && serverKey && serverPass) {
      const given = String(incoming.get("passphrase") || "");
      if (!safeEqual(given, serverPass)) {
        return json({ error: "Invalid or missing access code." }, 401);
      }
      apiKey = serverKey;
    }

    const file = incoming.get("file");

    if (!apiKey) {
      return json({ error: "No ElevenLabs API key available (none provided, and no shared key/access code configured)." }, 400);
    }
    if (!file || typeof file === "string") return json({ error: "No audio file uploaded." }, 400);
    if (file.size < 1024) return json({ error: "Recording too short or empty." }, 400);
    if (file.size > 25 * 1024 * 1024) return json({ error: "Recording too large." }, 413);

    const form = new FormData();

    // ── Fixed dictation config: English, short-form, single speaker ──
    form.append("model_id", "scribe_v2");
    form.append("file", file, "recording.webm");
    form.append("file_format", String(incoming.get("file_format") || "other"));   // ← CHANGED to respect client hint
    form.append("language_code", "en");     // English only -> skip auto-detection
    form.append("diarize", "false");
    form.append("num_speakers", "1");
    form.append("temperature", "0");

    form.append(
      "timestamps_granularity",
      String(incoming.get("timestamps_granularity") || "none")
    );

    // no_verbatim: default TRUE (clean dictation). Only false if client opts out.
    const noVerbatim = incoming.get("no_verbatim") !== "false";
    form.append("no_verbatim", String(noVerbatim));

    // tag_audio_events: default FALSE (clean clinical text).
    form.append("tag_audio_events", String(incoming.get("tag_audio_events") === "true"));

    // ── Keyterms: ElevenLabs expects a LIST OF STRINGS. ──
    // Append each as its own "keyterms" field (how the SDK serializes a list).
    // NEVER join into one string — that created a single giant keyterm and
    // tripped the "at most 4 spaces" validation error.
    let keyterms = [];
    try {
      keyterms = JSON.parse(String(incoming.get("keyterms_json") || "[]"));
    } catch {
      keyterms = [];
    }

    const seen = new Set();
    keyterms = (Array.isArray(keyterms) ? keyterms : [])
      .filter((t) => typeof t === "string")
      // strip forbidden chars (< > { } [ ] \) and collapse whitespace ("after normalisation")
      .map((t) => t.trim().replace(/[<>{}\[\]\\]/g, "").replace(/\s+/g, " "))
      .filter(Boolean)
      // docs: <50 chars, <=5 words each
      .filter((t) => t.length < 50 && t.split(" ").length <= 5)
      .filter((t) => {
        const k = t.toLowerCase();
        if (seen.has(k)) return false;
        seen.add(k);
        return true;
      })
      .slice(0, 1000);

    for (const term of keyterms) {
      form.append("keyterms", term);   // one field per keyterm == list of strings
    }

    const eleven = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });

    const responseText = await eleven.text();

    return new Response(responseText, {
      status: eleven.status,
      headers: {
        "content-type":
          eleven.headers.get("content-type") || "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return json(
      { error: "Worker transcription proxy failed.", message: err?.message || String(err) },
      500
    );
  }
}

// Constant-time string compare for the access code (avoids leaking match
// progress via timing). Length check is fine for this threat model.
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>ElevenLabs Scribe v2 Dictation</title>
  <style>
    :root {
      --bg: #0b0d10;
      --panel: #151922;
      --panel2: #10141b;
      --text: #eef2f6;
      --muted: #9aa4b2;
      --line: #2a3140;
      --accent: #7dd3fc;
      --danger: #f87171;
      --ok: #86efac;
      --warn: #fde68a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      background: var(--bg); color: var(--text); line-height: 1.35;
    }
    main { max-width: 1000px; margin: 0 auto; padding: 22px; }
    h1 { font-size: 22px; margin: 0 0 14px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 14px; }
    @media (min-width: 850px) { .grid { grid-template-columns: 380px 1fr; } }
    .card {
      background: var(--panel); border: 1px solid var(--line);
      border-radius: 14px; padding: 14px;
    }
    label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 6px; }
    textarea, input, select {
      width: 100%; background: var(--panel2); color: var(--text);
      border: 1px solid var(--line); border-radius: 10px; padding: 10px;
      font-size: 14px; outline: none;
    }
    input[type="range"] { padding: 0; }
    textarea { min-height: 120px; resize: vertical; }
    button {
      border: 1px solid var(--line); background: var(--panel2); color: var(--text);
      padding: 10px 12px; border-radius: 10px; font-size: 14px; cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary { background: #0c4a6e; border-color: #0369a1; }
    button.danger { background: #5f1717; border-color: #991b1b; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .row > * { flex: 1; }
    .row button { flex: 0 0 auto; }
    .status {
      font-size: 13px; color: var(--muted); margin-top: 10px;
      min-height: 18px; white-space: pre-wrap;
    }
    .status.ok { color: var(--ok); }
    .status.warn { color: var(--warn); }
    .status.err { color: var(--danger); }
    .big {
      font-size: 18px; white-space: pre-wrap; min-height: 180px;
      background: var(--panel2); border: 1px solid var(--line);
      border-radius: 12px; padding: 14px;
    }
    .hint { color: var(--muted); font-size: 13px; }
    .history-item { border-top: 1px solid var(--line); padding: 12px 0; }
    .history-meta { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .history-text { white-space: pre-wrap; font-size: 14px; }
    .checkbox {
      display: flex; gap: 8px; align-items: center;
      color: var(--muted); font-size: 13px; margin-top: 10px;
    }
    .checkbox input { width: auto; }
    .meterwrap {
      position: relative; height: 14px; background: var(--panel2);
      border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-top: 8px;
    }
    #meterBar { position: absolute; left: 0; top: 0; bottom: 0; width: 0%; background: var(--ok); }
    #openMark  { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--danger); left: 0%; }
    #closeMark { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--warn);   left: 0%; }
    #gateState {
      display: inline-block; margin-left: 8px; font-size: 12px; padding: 1px 8px;
      border-radius: 999px; border: 1px solid var(--line); color: var(--muted);
    }
    #gateState.open { color: #0b0d10; background: var(--ok); border-color: var(--ok); }
    .sliderval { color: var(--text); font-size: 12px; }
    .legend { font-size: 11px; color: var(--muted); margin-top: 4px; }
    .legend .dr { color: var(--danger); }
    .legend .dy { color: var(--warn); }
    details.help {
      margin-top: 14px; border: 1px solid var(--line); border-radius: 10px;
      background: var(--panel2); padding: 0 12px;
    }
    details.help > summary {
      cursor: pointer; padding: 12px 0; font-size: 13px; color: var(--accent);
      list-style: none; user-select: none;
    }
    details.help > summary::-webkit-details-marker { display: none; }
    details.help > summary::before { content: "▸ "; }
    details.help[open] > summary::before { content: "▾ "; }
    details.help .body { padding: 0 0 12px; font-size: 13px; color: var(--text); }
    details.help h3 { font-size: 13px; margin: 12px 0 4px; color: var(--accent); }
    details.help p { margin: 4px 0; color: var(--muted); }
    details.help table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
    details.help td { border-top: 1px solid var(--line); padding: 6px 4px; vertical-align: top; }
    details.help td:first-child { color: var(--text); white-space: nowrap; padding-right: 10px; }
    details.help td:last-child { color: var(--muted); }
    details.help .tag { color: var(--danger); }
    details.help .tag.y { color: var(--warn); }
    kbd {
      background: #0f172a; border: 1px solid var(--line); border-radius: 6px;
      padding: 2px 6px; font-size: 12px; color: var(--text);
    }
  </style>
</head>

<body>
<main>
  <h1>ElevenLabs Scribe v2 Dictation</h1>

  <div class="grid">
    <section class="card">
      <div id="accessCodeRow" style="display:none">
        <label for="accessCode">Access code</label>
        <input id="accessCode" type="password" placeholder="access code" autocomplete="off" />
      </div>

      <label for="apiKey" id="apiKeyLabel">ElevenLabs API key (optional)</label>
      <input id="apiKey" type="password" placeholder="xi-api-key" autocomplete="off" />

      <label class="checkbox">
        <input type="checkbox" id="saveApiKey" />
        Remember on this browser
      </label>

      <div class="row" style="margin-top: 10px;">
        <button id="forgetKeyBtn">Forget key</button>
      </div>

      <div class="row" style="margin-top: 14px;">
        <button id="recordBtn" class="primary">Start recording</button>
        <button id="clearBtn">Clear history</button>
      </div>

      <label>Mic level <span id="gateState">closed</span></label>
      <div class="meterwrap">
        <div id="meterBar"></div>
        <div id="closeMark"></div>
        <div id="openMark"></div>
      </div>
      <div class="legend">
        <span class="dr">red = OPEN threshold</span> (speech must exceed) &nbsp;|&nbsp;
        <span class="dy">yellow = CLOSE threshold</span> (gate holds open until below this)
      </div>

      <label for="gateOpen">Open threshold <span class="sliderval" id="gateOpenVal"></span></label>
      <input id="gateOpen" type="range" min="0" max="0.12" step="0.001" value="0.030" />

      <label for="gateClose">Close threshold <span class="sliderval" id="gateCloseVal"></span></label>
      <input id="gateClose" type="range" min="0" max="0.12" step="0.001" value="0.008" />

      <label for="highpass">High‑pass filter <span class="sliderval" id="highpassVal"></span></label>
      <input id="highpass" type="range" min="0" max="200" step="5" value="85" />

      <label class="checkbox">
        <input type="checkbox" id="noiseSuppress" />
        Browser noise suppression
      </label>

      <!-- ───────── Built‑in tutorial ───────── -->
      <details class="help">
        <summary>How do these filter settings work? (tap to learn)</summary>
        <div class="body">
          <p>Think of the gate as a <strong>bouncer for your mic</strong>. The whole
          goal is to create a <em>gap</em> between how loud YOUR voice is and how loud
          the room is, then only let your voice through.</p>

          <h3>The mic level meter</h3>
          <p>The green bar shows live loudness. Two marks sit on it:
          <span class="tag">red = Open</span> and <span class="tag y">yellow = Close</span>.
          The pill next to "Mic level" shows the gate's live state (OPEN / closed)
          while you record.</p>

          <h3>Open threshold (red)</h3>
          <p>How loud a sound must be to <strong>start</strong> recording. Set it just
          ABOVE where background noise/voices peak, so the room can't open the gate
          but your speech easily does.</p>

          <h3>Close threshold (yellow)</h3>
          <p>Once open, the gate stays open until your level drops BELOW this (plus a
          short hold). Set it LOW — your word‑endings and quiet syllables are much
          softer than word‑beginnings, and a low Close keeps them from being chopped.
          The space between yellow and red is the "safe zone" that rejects borderline
          background speech.</p>

          <h3>High‑pass filter</h3>
          <p>Cuts low rumble (HVAC, desk thumps, footsteps) BEFORE the gate sees it,
          so that junk can't falsely trip the gate open. 85 Hz is the sweet spot.
          Raise toward 120 Hz for a rumbly room; set to 0 to disable. Don't go above
          ~150 Hz or your voice starts sounding thin.</p>

          <h3>2‑minute tuning routine</h3>
          <p>1. Record, stay silent — see how far the room pushes the meter.<br>
          2. Set <span class="tag">red</span> just above that point.<br>
          3. Speak normally — confirm you shoot well past red and the pill flips OPEN.<br>
          4. Set <span class="tag y">yellow</span> low, in the gap.<br>
          5. Talk a long, pausey sentence — the pill should stay OPEN the whole way.</p>

          <h3>Symptom cheat‑sheet</h3>
          <table>
            <tr><td>Word beginnings cut off</td><td>Open too high → lower red</td></tr>
            <tr><td>Words drop mid‑sentence</td><td>Close too high → lower yellow</td></tr>
            <tr><td>Background still transcribed</td><td>Open too low → raise red</td></tr>
            <tr><td>Gate flickers open/closed</td><td>Gap too narrow → raise red, lower yellow</td></tr>
            <tr><td>Nothing records at all</td><td>Both above your voice → drag both toward 0</td></tr>
          </table>

          <p><strong>Golden rule:</strong> the wider the gap between your voice and the
          room on the meter, the better this works — and the #1 way to widen it is the
          mic itself (close, low gain, point the back of a cardioid at the noise).
          The sliders clean up what's left.</p>
        </div>
      </details>

      <div class="status" id="status">
        CapsLock via AHK: hold to record, release to stop. Browser beeps when text is
        ready on the clipboard — keep this tab focused until the beep, then switch
        windows and Ctrl+V.
      </div>

      <label for="keyterms">Context / vocabulary keyterms</label>
      <textarea id="keyterms" placeholder="One term per line. Examples:
tachycardia
ascites
right lower quadrant"></textarea>

      <div class="hint" id="keytermHint">
        Scribe v2 biases toward these terms. One per line, each &lt;50 chars, ≤5 words.
        <strong>Keyterms add ~20 % to cost.</strong> 0 terms.
      </div>

      <label for="timestamps">Timestamps</label>
      <select id="timestamps">
        <option value="none" selected>none</option>
        <option value="word">word</option>
        <option value="character">character</option>
      </select>

      <label class="checkbox">
        <input type="checkbox" id="noVerbatim" checked />
        Remove filler words / false starts
      </label>

      <label class="checkbox">
        <input type="checkbox" id="tagEvents" />
        Tag audio events
      </label>

      <label class="checkbox">
        <input type="checkbox" id="autoCopy" checked />
        Auto‑copy transcript to clipboard
      </label>

      <label class="checkbox">
        <input type="checkbox" id="stripNewlines" checked />
        Strip newlines (collapse to spaces)
      </label>

      <label class="checkbox">
        <input type="checkbox" id="trailingSpace" checked />
        Trailing space (for consecutive dictations)
      </label>

      <label class="checkbox">
        <input type="checkbox" id="startBeep" checked />
        Beep when recording starts
      </label>

      <label>Notes</label>
      <div class="hint">
        English‑only, Scribe v2. Mic is kept warm between dictations for instant start.
        The browser sends your API key and audio to your Worker, which calls ElevenLabs
        server‑side to avoid CORS.
      </div>
    </section>

    <section class="card">
      <div class="row">
        <button id="copyBtn">Copy latest</button>
        <button id="downloadBtn">Download .txt</button>
      </div>

      <label>Last recorded audio</label>
      <audio id="audioPreview" controls style="width:100%; margin-bottom:10px;"></audio>

      <div class="row">
        <button id="downloadAudioBtn">Download audio</button>
      </div>

      <label>Latest transcript</label>
      <div id="latest" class="big"></div>

      <div class="row" style="margin-top:14px;">
        <button id="toggleHistoryBtn">Show saved transcripts</button>
      </div>
      <div id="history" style="display:none;"></div>
    </section>
  </div>
</main>

<script>
(() => {
  // Injected by the Worker at serve time (see fetch handler). True when a shared
  // server key + access code are configured; the access-code field is shown and
  // an API key is no longer required to dictate.
  const SHARED_MODE      = (__SHARED_MODE__);

  const apiKeyEl         = document.getElementById("apiKey");
  const apiKeyLabelEl    = document.getElementById("apiKeyLabel");
  const accessCodeEl     = document.getElementById("accessCode");
  const accessCodeRow    = document.getElementById("accessCodeRow");
  const saveApiKeyEl     = document.getElementById("saveApiKey");
  const forgetKeyBtn     = document.getElementById("forgetKeyBtn");

  const recordBtn        = document.getElementById("recordBtn");
  const clearBtn         = document.getElementById("clearBtn");
  const copyBtn          = document.getElementById("copyBtn");
  const downloadBtn      = document.getElementById("downloadBtn");
  const downloadAudioBtn = document.getElementById("downloadAudioBtn");
  const toggleHistoryBtn = document.getElementById("toggleHistoryBtn");

  const statusEl         = document.getElementById("status");
  const latestEl         = document.getElementById("latest");
  const historyEl        = document.getElementById("history");
  const audioPreviewEl   = document.getElementById("audioPreview");

  const keytermsEl       = document.getElementById("keyterms");
  const keytermHintEl    = document.getElementById("keytermHint");
  const timestampsEl     = document.getElementById("timestamps");
  const noVerbatimEl     = document.getElementById("noVerbatim");
  const tagEventsEl      = document.getElementById("tagEvents");
  const autoCopyEl       = document.getElementById("autoCopy");
  const noiseSuppressEl  = document.getElementById("noiseSuppress");
  const startBeepEl      = document.getElementById("startBeep");
  const stripNewlinesEl  = document.getElementById("stripNewlines");
  const trailingSpaceEl  = document.getElementById("trailingSpace");

  const gateOpenEl       = document.getElementById("gateOpen");
  const gateCloseEl      = document.getElementById("gateClose");
  const gateOpenValEl    = document.getElementById("gateOpenVal");
  const gateCloseValEl   = document.getElementById("gateCloseVal");
  const highpassEl       = document.getElementById("highpass");
  const highpassValEl    = document.getElementById("highpassVal");

  const meterBar         = document.getElementById("meterBar");
  const openMark         = document.getElementById("openMark");
  const closeMark        = document.getElementById("closeMark");
  const gateStateEl      = document.getElementById("gateState");

  let mediaRecorder = null;
  let chunks = [];
  let recording = false;
  let sending = false;
  let stopRequested = false;
  let latestText = "";
  let lastAudioBlob = null;
  let lastAudioUrl = null;

  // ── Persistent (warm) audio graph ──
  let stream = null;
  let audioCtx = null;
  let hpFilter = null;
  let analyserNode = null;
  let gateNode = null;
  let destNode = null;
  let gateTimer = null;
  let gateBuf = null;
  let gateIsOpen = false;
  let gateLastOpen = 0;
  let lastMeterPct = -1;

  let historyVisible = false;

  const METER_MAX    = 0.12;
  const HOLD_SECONDS = 0.4;

  // Written to the clipboard when a dictation fails/produces nothing, so the
  // AHK side returns instantly instead of waiting out its ClipWait timeout.
  const DICTATION_SENTINEL = "##DICTATION_FAILED##";

  const STORE_KEY              = "scribe_v2_transcripts_v9";
  const SETTINGS_KEY           = "scribe_v2_settings_v9";
  const API_KEY_STORAGE_KEY    = "elevenlabs_api_key_browser_v9";
  const ACCESS_CODE_STORAGE_KEY = "scribe_v2_access_code_v9";

  /* ───── Audio cue helpers ───── */

  function beep(freq, ms, when) {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.06;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime + (when || 0);
      osc.start(t0);
      osc.stop(t0 + ms / 1000);
      setTimeout(() => ctx.close(), ((when || 0) + ms / 1000) * 1000 + 60);
    } catch (e) {}
  }

  function startBeep() { if (startBeepEl.checked) beep(760, 130); }
  function doneBeep()  { if (startBeepEl.checked) { beep(1046, 90, 0); beep(1568, 130, 0.10); } }
  function failBeep()  { if (startBeepEl.checked) beep(300, 280); }

  /* ───── Text cleanup ───── */

  function cleanTranscript(raw) {
    let t = raw;
    if (stripNewlinesEl.checked) {
      t = t.replace(/[\\r\\n]+/g, " ");
    }
    t = t.replace(/ +/g, " ").trim();
    if (trailingSpaceEl.checked && t.length > 0) t += " ";
    return t;
  }

  function setStatus(msg, cls) {
    statusEl.className = "status " + (cls || "");
    statusEl.textContent = msg;
  }

  // One term PER LINE. Whitespace collapsed; forbidden chars stripped;
  // <=5 words / <50 chars each.
  function parseKeyterms(raw) {
    return raw
      .split(/[\\r\\n]+/)
      .map((s) => s.trim().replace(/\\s+/g, " ").replace(/[<>{}\\[\\]\\\\]/g, ""))
      .filter(Boolean)
      .filter((s) => s.length < 50 && s.split(" ").length <= 5)
      .slice(0, 1000);
  }

  function updateKeytermHint() {
    const n = parseKeyterms(keytermsEl.value).length;
    keytermHintEl.innerHTML =
      "Scribe v2 biases toward these terms. One per line, each &lt;50 chars, ≤5 words. " +
      "<strong>Keyterms add ~20 % to cost.</strong> " + n + " term" + (n === 1 ? "" : "s") + ".";
  }

  /* ───── Gate UI helpers ───── */

  function enforceGateOrder(changed) {
    let open = Number(gateOpenEl.value);
    let close = Number(gateCloseEl.value);
    if (open < close) {
      if (changed === "open") gateCloseEl.value = String(open);
      else gateOpenEl.value = String(close);
    }
  }

  function updateGateLabels() {
    gateOpenValEl.textContent  = "(" + Number(gateOpenEl.value).toFixed(3) + ")";
    gateCloseValEl.textContent = "(" + Number(gateCloseEl.value).toFixed(3) + ")";
    highpassValEl.textContent  =
      Number(highpassEl.value) > 0 ? "(" + highpassEl.value + " Hz)" : "(off)";
    openMark.style.left  = Math.min(100, (Number(gateOpenEl.value)  / METER_MAX) * 100) + "%";
    closeMark.style.left = Math.min(100, (Number(gateCloseEl.value) / METER_MAX) * 100) + "%";
  }

  function setGateStateUI(isOpen) {
    gateStateEl.textContent = isOpen ? "OPEN" : "closed";
    gateStateEl.className  = isOpen ? "open" : "";
  }

  /* ───── Persistence (debounced) ───── */

  let saveTimer = null;
  function saveSettings() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSettingsNow, 250);
  }

  function saveSettingsNow() {
    const s = {
      keyterms:       keytermsEl.value,
      timestamps:     timestampsEl.value,
      noVerbatim:     noVerbatimEl.checked,
      tagEvents:      tagEventsEl.checked,
      autoCopy:       autoCopyEl.checked,
      saveApiKey:     saveApiKeyEl.checked,
      noiseSuppress:  noiseSuppressEl.checked,
      startBeep:      startBeepEl.checked,
      stripNewlines:  stripNewlinesEl.checked,
      trailingSpace:  trailingSpaceEl.checked,
      gateOpen:       gateOpenEl.value,
      gateClose:      gateCloseEl.value,
      highpass:       highpassEl.value,
      historyVisible: historyVisible,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));

    if (saveApiKeyEl.checked) {
      localStorage.setItem(API_KEY_STORAGE_KEY, apiKeyEl.value.trim());
      if (accessCodeEl) localStorage.setItem(ACCESS_CODE_STORAGE_KEY, accessCodeEl.value.trim());
    } else {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
      localStorage.removeItem(ACCESS_CODE_STORAGE_KEY);
    }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.keyterms) keytermsEl.value = s.keyterms;
      if (s.timestamps) timestampsEl.value = s.timestamps;
      if (typeof s.noVerbatim    === "boolean") noVerbatimEl.checked    = s.noVerbatim;
      if (typeof s.tagEvents     === "boolean") tagEventsEl.checked     = s.tagEvents;
      if (typeof s.autoCopy      === "boolean") autoCopyEl.checked      = s.autoCopy;
      if (typeof s.saveApiKey    === "boolean") saveApiKeyEl.checked    = s.saveApiKey;
      if (typeof s.noiseSuppress === "boolean") noiseSuppressEl.checked = s.noiseSuppress;
      if (typeof s.startBeep     === "boolean") startBeepEl.checked     = s.startBeep;
      if (typeof s.stripNewlines === "boolean") stripNewlinesEl.checked = s.stripNewlines;
      if (typeof s.trailingSpace === "boolean") trailingSpaceEl.checked = s.trailingSpace;
      if (s.gateOpen  !== undefined) gateOpenEl.value  = s.gateOpen;
      if (s.gateClose !== undefined) gateCloseEl.value = s.gateClose;
      if (s.highpass  !== undefined) highpassEl.value  = s.highpass;
      if (typeof s.historyVisible === "boolean") historyVisible = s.historyVisible;

      if (saveApiKeyEl.checked) {
        const k = localStorage.getItem(API_KEY_STORAGE_KEY);
        if (k) apiKeyEl.value = k;
        const ac = localStorage.getItem(ACCESS_CODE_STORAGE_KEY);
        if (ac && accessCodeEl) accessCodeEl.value = ac;
      }
    } catch (e) {}
  }

  function getHistory() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); }
    catch (e) { return []; }
  }

  function setHistory(items) {
    localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, 100)));
    renderHistory();
  }

  function addHistory(text, meta) {
    const items = getHistory();
    const entry = { text: text, createdAt: new Date().toISOString() };
    if (meta) {
      if (meta.language_code !== undefined) entry.language_code = meta.language_code;
      if (meta.language_probability !== undefined) entry.language_probability = meta.language_probability;
    }
    items.unshift(entry);
    setHistory(items);
  }

  function applyHistoryVisibility() {
    const items = getHistory();
    historyEl.style.display = historyVisible ? "block" : "none";
    toggleHistoryBtn.textContent =
      (historyVisible ? "Hide saved transcripts" : "Show saved transcripts") +
      " (" + items.length + ")";
  }

  function renderHistory() {
    applyHistoryVisibility();
    if (!historyVisible) return;

    const items = getHistory();
    historyEl.innerHTML = "";

    if (!items.length) {
      historyEl.innerHTML = '<div class="hint">No transcripts yet.</div>';
      return;
    }

    for (const item of items) {
      const div = document.createElement("div");
      div.className = "history-item";

      const meta = document.createElement("div");
      meta.className = "history-meta";
      meta.textContent = new Date(item.createdAt).toLocaleString();

      const text = document.createElement("div");
      text.className = "history-text";
      text.textContent = item.text;

      const row = document.createElement("div");
      row.className = "row";
      row.style.marginTop = "8px";

      const copy = document.createElement("button");
      copy.textContent = "Copy";
      copy.onclick = () => copyText(item.text);

      row.append(copy);
      div.append(meta, text, row);
      historyEl.append(div);
    }
  }

  /* ───── Clipboard ───── */

  async function clipboardWrite(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { /* fall through */ }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  async function copyText(text) {
    const ok = await clipboardWrite(text);
    setStatus(ok ? "Copied to clipboard."
                 : "Clipboard copy failed — keep this tab focused, then click 'Copy latest'.",
              ok ? "ok" : "err");
    return ok;
  }

  // Silent clipboard write of the failure marker (no status spam).
  async function writeSentinel() {
    await clipboardWrite(DICTATION_SENTINEL);
  }

  /* ───── Silence trimming helpers ───── */

  async function trimSilence(blob, threshold = 0.005, minKeepSamples = 0) {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    try { await ctx.resume(); } catch (_) {}

    const arrayBuf = await blob.arrayBuffer();
    const audioBuf = await ctx.decodeAudioData(arrayBuf);
    const channel = audioBuf.getChannelData(0);

    let start = 0;
    let end = channel.length;

    for (let i = 0; i < channel.length; i++) {
      if (Math.abs(channel[i]) >= threshold) { start = i; break; }
    }
    for (let i = channel.length - 1; i >= 0; i--) {
      if (Math.abs(channel[i]) >= threshold) { end = i + 1; break; }
    }

    start = Math.max(0, Math.min(start, channel.length - minKeepSamples));
    end = Math.max(end, minKeepSamples, start + 1);

    const trimmed = ctx.createBuffer(1, end - start, audioBuf.sampleRate);
    trimmed.copyToChannel(channel.subarray(start, end), 0);

    const wav = encodeWAV(trimmed);
    ctx.close();
    return new Blob([wav], { type: "audio/wav" });
  }

  function encodeWAV(buffer) {
    const numChannels = 1;
    const sampleRate = buffer.sampleRate;
    const length = buffer.length;
    const dataLen = length * 2;
    const buf = new ArrayBuffer(44 + dataLen);
    const view = new DataView(buf);

    writeStr(view, 0, "RIFF");
    view.setUint32(4, 36 + dataLen, true);
    writeStr(view, 8, "WAVE");
    writeStr(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * 2, true);
    view.setUint16(32, numChannels * 2, true);
    view.setUint16(34, 16, true);
    writeStr(view, 36, "data");
    view.setUint32(40, dataLen, true);

    const samples = buffer.getChannelData(0);
    let offset = 44;
    for (let i = 0; i < length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
      offset += 2;
    }
    return buf;
  }

  function writeStr(view, offset, str) {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  }

  /* ───── Warm audio graph: mic → high‑pass → analyser + hysteresis gate → recorder ─────
     Built ONCE and kept alive so the hotkey only has to start a MediaRecorder. */

  async function ensureAudio() {
    if (stream && audioCtx && audioCtx.state !== "closed" && destNode) {
      if (audioCtx.state === "suspended") {
        try { await audioCtx.resume(); } catch (e) {}
      }
      return true;
    }

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: noiseSuppressEl.checked,
        autoGainControl: false,
        sampleRate: 48000,
      },
    });

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch (e) {}
    }

    const source = audioCtx.createMediaStreamSource(stream);

    hpFilter = audioCtx.createBiquadFilter();
    hpFilter.type = "highpass";
    hpFilter.frequency.value = Number(highpassEl.value) || 0;
    hpFilter.Q.value = 0.707;

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 1024;

    gateNode = audioCtx.createGain();
    gateNode.gain.value = 0;

    destNode = audioCtx.createMediaStreamDestination();

    source.connect(hpFilter);
    hpFilter.connect(analyserNode);
    hpFilter.connect(gateNode);
    gateNode.connect(destNode);

    gateBuf = new Float32Array(analyserNode.fftSize);
    gateIsOpen = false;
    gateLastOpen = 0;
    lastMeterPct = -1;
    setGateStateUI(false);

    if (gateTimer) clearInterval(gateTimer);
    gateTimer = setInterval(() => {
      if (!analyserNode || !audioCtx) return;

      analyserNode.getFloatTimeDomainData(gateBuf);
      let sum = 0;
      for (let i = 0; i < gateBuf.length; i++) sum += gateBuf[i] * gateBuf[i];
      const rms = Math.sqrt(sum / gateBuf.length);

      const pct = Math.min(100, (rms / METER_MAX) * 100);
      if (Math.abs(pct - lastMeterPct) > 0.5) {
        meterBar.style.width = pct + "%";
        lastMeterPct = pct;
      }

      const openT  = Number(gateOpenEl.value);
      const closeT = Number(gateCloseEl.value);
      const now    = audioCtx.currentTime;

      if (!gateIsOpen) {
        if (rms > openT) {
          gateIsOpen = true;
          gateLastOpen = now;
          gateNode.gain.setTargetAtTime(1, now, 0.02);
          setGateStateUI(true);
        }
      } else {
        if (rms > closeT) {
          gateLastOpen = now;
        } else if (now - gateLastOpen > HOLD_SECONDS) {
          gateIsOpen = false;
          gateNode.gain.setTargetAtTime(0, now, 0.12);
          setGateStateUI(false);
        }
      }
    }, 30);

    return true;
  }

  function releaseAudio() {
    if (gateTimer) { clearInterval(gateTimer); gateTimer = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); }
    if (stream) { for (const track of stream.getTracks()) track.stop(); }
    stream = null; audioCtx = null; hpFilter = null; analyserNode = null;
    gateNode = null; destNode = null; gateBuf = null; gateIsOpen = false;
    lastMeterPct = -1;
    meterBar.style.width = "0%";
    setGateStateUI(false);
  }

  async function tryWarmOnLoad() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: "microphone" });
        if (st.state === "granted") ensureAudio().catch(() => {});
      }
    } catch (e) {}
  }

  /* ───── Record / stop / transcribe ───── */

  async function startRecording() {
    if (recording || sending) return;
    stopRequested = false;

    const apiKey = apiKeyEl.value.trim();
    if (!apiKey && !(SHARED_MODE && accessCodeEl.value.trim())) {
      await writeSentinel();
      if (SHARED_MODE) {
        setStatus("Enter the access code first.", "err");
        accessCodeEl.focus();
      } else {
        setStatus("Enter your ElevenLabs API key first.", "err");
        apiKeyEl.focus();
      }
      failBeep();
      return;
    }

    saveSettingsNow();

    try {
      await ensureAudio();
      if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume();
      if (!audioCtx || audioCtx.state !== "running") {
        await writeSentinel();
        setStatus("Audio not running (state: " + (audioCtx ? audioCtx.state : "none") +
                  "). Click the page once, then try again.", "err");
        failBeep();
        return;
      }
    } catch (e) {
      await writeSentinel();
      setStatus("Microphone unavailable: " + (e && e.message ? e.message : e), "err");
      failBeep();
      return;
    }

    chunks = [];

    const preferred = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
    ].find((type) => MediaRecorder.isTypeSupported(type));

    const opts = { audioBitsPerSecond: 16000 };   // 16 kbps – enough for speech
    if (preferred) opts.mimeType = preferred;

    try {
      mediaRecorder = new MediaRecorder(destNode.stream, opts);
    } catch (e) {
      await writeSentinel();
      setStatus("MediaRecorder failed in this browser.", "err");
      failBeep();
      return;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      recording = false;
      recordBtn.textContent = "Start recording";
      recordBtn.classList.remove("danger");
      await transcribeBlob();
    };

    mediaRecorder.start();
    recording = true;
    recordBtn.textContent = "Stop recording";
    recordBtn.classList.add("danger");
    setStatus("Recording...", "ok");
    startBeep();

    if (stopRequested) {
      stopRequested = false;
      stopRecording();
    }
  }

  function stopRecording() {
    if (!recording || !mediaRecorder) {
      stopRequested = true;
      return;
    }
    setStatus("Stopping and sending audio...", "warn");
    mediaRecorder.stop();
  }

  async function transcribeBlob() {
    if (!chunks.length) {
      await writeSentinel();
      setStatus("No audio captured.", "err");
      failBeep();
      return;
    }

    const apiKey = apiKeyEl.value.trim();
    if (!apiKey && !(SHARED_MODE && accessCodeEl.value.trim())) {
      await writeSentinel();
      setStatus(SHARED_MODE ? "Missing access code." : "Missing API key.", "err");
      failBeep();
      return;
    }

    sending = true;
    recordBtn.disabled = true;
    setStatus("Trimming and transcribing...", "warn");   // Updated status text

    // ── Trim silence and convert to WAV before sending ──
    const mimeType = (chunks[0] && chunks[0].type) || "audio/webm";
    let blob = new Blob(chunks, { type: mimeType });
    let fileFormat = "other";    // fallback format
    let fileName = "recording.webm";

    try {
      blob = await trimSilence(blob, 0.005, 0);
      fileFormat = "wav";
      fileName = "recording.wav";
      // double‑check the trimmed blob isn't too tiny (might happen with very soft speech)
      if (blob.size < 1024) throw new Error("Trimmed audio too short");
    } catch (e) {
      // If trimming fails (e.g. decode error), fall back to original blob
      console.warn("Trim failed, sending original audio", e);
      blob = new Blob(chunks, { type: mimeType });
      fileFormat = "other";
      fileName = "recording.webm";
    }
    // ── End of trimming block ──

    lastAudioBlob = blob;
    if (lastAudioUrl) URL.revokeObjectURL(lastAudioUrl);
    lastAudioUrl = URL.createObjectURL(blob);
    audioPreviewEl.src = lastAudioUrl;

    const form = new FormData();
    if (apiKey) form.append("api_key", apiKey);                       // BYO key overrides
    if (SHARED_MODE) form.append("passphrase", accessCodeEl.value.trim());
    form.append("file", blob, fileName);
    form.append("file_format", fileFormat);                           // tell the Worker what format
    form.append("timestamps_granularity", timestampsEl.value);
    form.append("no_verbatim", String(noVerbatimEl.checked));
    form.append("tag_audio_events", String(tagEventsEl.checked));

    const keyterms = parseKeyterms(keytermsEl.value);
    form.append("keyterms_json", JSON.stringify(keyterms));

    try {
      const res = await fetch("/api/transcribe", { method: "POST", body: form });
      const raw = await res.text();
      let data;
      try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; }

      if (!res.ok) {
        throw new Error(
          (data && data.detail && data.detail.message) ||
          (data && data.message) ||
          (data && data.error) ||
          raw || "Unknown transcription error"
        );
      }

      const rawText = data.text || data.transcript || "";
      const cleaned = cleanTranscript(rawText);

      // Empty / silent recording: signal failure instead of copying nothing.
      if (!cleaned.trim()) {
        await writeSentinel();
        setStatus("No speech detected.", "warn");
        failBeep();
        return;
      }

      latestText = cleaned;
      latestEl.textContent = cleaned;

      addHistory(rawText, {
        language_code: data.language_code,
        language_probability: data.language_probability,
      });

      if (autoCopyEl.checked) {
        const copied = await copyText(cleaned);
        setStatus(
          copied ? "Transcript saved & copied. Done!"
                 : "Transcript saved — copy FAILED (keep tab focused; use 'Copy latest').",
          copied ? "ok" : "warn"
        );
      } else {
        setStatus("Transcript saved.", "ok");
      }

      doneBeep();
    } catch (err) {
      await writeSentinel();
      setStatus("Transcription failed: " + (err && err.message ? err.message : String(err)), "err");
      failBeep();
    } finally {
      sending = false;
      recordBtn.disabled = false;
      recordBtn.textContent = "Start recording";
      recordBtn.classList.remove("danger");
    }
  }

  /* ───── Event wiring ───── */

  recordBtn.onclick = () => {
    if (recording) stopRecording();
    else startRecording();
  };

  forgetKeyBtn.onclick = () => {
    apiKeyEl.value = "";
    if (accessCodeEl) accessCodeEl.value = "";
    saveApiKeyEl.checked = false;
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    localStorage.removeItem(ACCESS_CODE_STORAGE_KEY);
    saveSettingsNow();
    setStatus(SHARED_MODE ? "Saved access code / key removed from this browser." : "API key removed from this browser.", "ok");
  };

  clearBtn.onclick = () => {
    localStorage.removeItem(STORE_KEY);
    latestText = "";
    latestEl.textContent = "";
    renderHistory();
    setStatus("History cleared.");
  };

  copyBtn.onclick = () => { if (latestText) copyText(latestText); };

  toggleHistoryBtn.onclick = () => {
    historyVisible = !historyVisible;
    saveSettingsNow();
    renderHistory();
  };

  downloadBtn.onclick = () => {
    const items = getHistory();
    const body = items.map((i) => {
      return "=== " + new Date(i.createdAt).toLocaleString() + " ===\\n" + i.text;
    }).join("\\n\\n");

    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    a.download = "scribe-v2-transcripts.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  downloadAudioBtn.onclick = () => {
    if (!lastAudioBlob) {
      setStatus("No audio recorded yet.", "warn");
      return;
    }
    const a = document.createElement("a");
    const url = URL.createObjectURL(lastAudioBlob);
    a.href = url;
    a.download = "last-recording.webm";
    a.click();
    URL.revokeObjectURL(url);
  };

  gateOpenEl.addEventListener("input", () => {
    enforceGateOrder("open"); updateGateLabels(); saveSettings();
  });
  gateCloseEl.addEventListener("input", () => {
    enforceGateOrder("close"); updateGateLabels(); saveSettings();
  });
  highpassEl.addEventListener("input", () => {
    if (hpFilter) hpFilter.frequency.value = Number(highpassEl.value) || 0;
    updateGateLabels();
    saveSettings();
  });
  keytermsEl.addEventListener("input", updateKeytermHint);

  noiseSuppressEl.addEventListener("change", () => {
    releaseAudio();
    tryWarmOnLoad();
  });

  for (const el of [
    apiKeyEl, saveApiKeyEl, keytermsEl, timestampsEl,
    noVerbatimEl, tagEventsEl, autoCopyEl, startBeepEl,
    stripNewlinesEl, trailingSpaceEl,
  ]) {
    el.addEventListener("change", saveSettings);
    el.addEventListener("input", saveSettings);
  }

  document.addEventListener("keydown", (e) => {
    if (e.repeat) return;
    if (e.code === "F13") {
      e.preventDefault();
      if (!recording && !sending) startRecording();
      return;
    }
    if (e.code === "F14") {
      e.preventDefault();
      if (recording || stopRequested) stopRecording();
      return;
    }
  });

  window.addEventListener("beforeunload", () => {
    try { releaseAudio(); } catch (e) {}
  });

  if (SHARED_MODE) {
    accessCodeRow.style.display = "";
    if (apiKeyLabelEl) apiKeyLabelEl.textContent = "ElevenLabs API key (optional — shared access in use)";
    apiKeyEl.placeholder = "optional — leave blank to use the access code";
  }

  loadSettings();
  updateGateLabels();
  updateKeytermHint();
  renderHistory();
  tryWarmOnLoad();
})();
</script>
</body>
</html>`;
