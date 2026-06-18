import { KEYTERM_PRESETS } from './keyterms.js';

// Durable Object: one room per session code. The Worker posts transcript events
// here (fire-and-forget); desktop listeners receive them over a WebSocket.
// Resilience contract with the client:
//   - answers {"message_type":"ping"} with a pong (zombie-socket detection);
//   - retains the most recent phone_delivery and replays it to (re)connecting
//     listeners within the replay window (clients dedupe by delivery_id);
//   - acks /broadcast with the listener count, so the phone can fail loudly
//     when nobody was listening instead of assuming success.
const DELIVERY_REPLAY_WINDOW_MS = 2 * 60 * 1000;

export class SessionRoom {
  constructor(state, env) {
    this.listeners = new Map(); // id -> WebSocket
    this.lastDelivery = null;   // { body, ts } — most recent phone_delivery
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();
      const id = crypto.randomUUID();
      this.listeners.set(id, server);
      server.addEventListener("close", () => this.listeners.delete(id));
      server.addEventListener("error", () => this.listeners.delete(id));
      server.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg && msg.message_type === "ping") {
            server.send(JSON.stringify({ message_type: "pong" }));
          }
        } catch {}
      });
      // A delivery that raced a listener drop must still reach the desktop.
      if (this.lastDelivery && Date.now() - this.lastDelivery.ts < DELIVERY_REPLAY_WINDOW_MS) {
        try { server.send(this.lastDelivery.body); } catch {}
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "GET" && url.pathname.endsWith("/latest")) {
      const fresh = this.lastDelivery && Date.now() - this.lastDelivery.ts < DELIVERY_REPLAY_WINDOW_MS;
      const body = fresh
        ? '{"ok":true,"age_ms":' + (Date.now() - this.lastDelivery.ts) + ',"delivery":' + this.lastDelivery.body + '}'
        : '{"ok":true,"delivery":null}';
      return new Response(body, { headers: { "content-type": "application/json" } });
    }

    if (request.method === "POST" && url.pathname.endsWith("/broadcast")) {
      const message = await request.text();
      let isDelivery = false;
      try { isDelivery = JSON.parse(message).message_type === "phone_delivery"; } catch {}
      if (isDelivery) this.lastDelivery = { body: message, ts: Date.now() };
      let delivered = 0;
      for (const [id, ws] of this.listeners) {
        try { ws.send(message); delivered++; } catch { this.listeners.delete(id); }
      }
      return new Response(JSON.stringify({ ok: true, listeners: delivered }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }
}

// AudioWorklet pump module, served at /pcm-pump.js as a REAL same-origin script.
// This replaced a Blob-URL worklet that failed in production: some browsers
// resolve audioCtx.audioWorklet.addModule(blobUrl) WITHOUT actually registering
// the processor ("The node name 'pcm-pump' is not defined in
// AudioWorkletGlobalScope"), silently forcing the deprecated main-thread
// ScriptProcessor fallback — which starves under UI load and drops audio frames,
// the true root cause of slow/garbled realtime across every engine (batch was
// immune: MediaRecorder is off-thread). A real same-origin URL with a JS MIME
// type is the reliable way to load a worklet. The processor name ('pcm-pump')
// and frame size (4096) MUST match the client (PUMP_FRAME_SAMPLES). It buffers
// 128-sample render quanta into 4096-sample frames on the audio render thread and
// posts owned (transferred) copies to the main thread.
const PCM_PUMP_WORKLET_JS =
  "class PcmPump extends AudioWorkletProcessor {" +
  "constructor(){super();this._buf=new Float32Array(4096);this._n=0;}" +
  "process(inputs){" +
  "var input=inputs[0];" +
  "if(input&&input[0]){var ch=input[0];" +
  "for(var i=0;i<ch.length;i++){this._buf[this._n++]=ch[i];" +
  "if(this._n>=this._buf.length){var out=this._buf.slice(0);this.port.postMessage(out,[out.buffer]);this._n=0;}}}" +
  "return true;}}" +
  "registerProcessor('pcm-pump',PcmPump);";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/transcribe") {
      // One path, two protocols: a WebSocket upgrade reaches the realtime
      // proxy, a plain POST reaches the batch proxy. Backward compatible
      // with both pre-merge clients.
      if (request.headers.get("Upgrade") === "websocket") {
        return handleTranscribeRealtime(request, env);
      }
      if (request.method === "POST") {
        return handleTranscribeBatch(request, env);
      }
      return new Response("Expected WebSocket upgrade or POST", { status: 400 });
    }

    // TEMPORARY realtime-accuracy diagnostic (capability-gated; remove later).
    if (url.pathname === "/api/nova-probe") {
      return handleNovaProbe(request, env);
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // Shared mode is on when both the master API key and a passphrase are set
      const sharedMode = Boolean(env && env.ELEVENLABS_API_KEY && env.APP_PASSPHRASE);
      return new Response(
        INDEX_HTML
          .replace("__SHARED_MODE__", sharedMode ? "true" : "false")
          // Function replacer: a plain string replacement would interpret
          // $-sequences inside the JSON as replacement patterns.
          .replace("__KEYTERM_PRESETS__", () => KEYTERM_PRESETS_CLIENT_JSON),
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        }
      );
    }

    if (url.pathname === "/manifest.webmanifest") {
      return new Response(JSON.stringify(MANIFEST), {
        headers: {
          "content-type": "application/manifest+json",
          "cache-control": "public, max-age=3600",
          // Some clinical/proxy middleboxes and extensions 302-redirect static
          // assets (adding params like ?_sm_byp=…); a redirected fetch is held
          // to CORS, so advertise it openly to keep the manifest loadable.
          "access-control-allow-origin": "*",
        },
      });
    }

    if (url.pathname === "/icon-192.png" || url.pathname === "/icon-512.png") {
      const b64 = url.pathname === "/icon-192.png" ? ICON_192_B64 : ICON_512_B64;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // AudioWorklet pump module — served as a real same-origin script so the
    // worklet actually registers (the Blob-URL form silently failed to register
    // on some browsers, forcing the starving ScriptProcessor fallback).
    if (url.pathname === "/pcm-pump.js") {
      return new Response(PCM_PUMP_WORKLET_JS, {
        headers: {
          "content-type": "text/javascript; charset=utf-8",
          "cache-control": "public, max-age=3600",
          "access-control-allow-origin": "*",
        },
      });
    }

    // Phone mic session relay via Durable Object
    if (url.pathname.startsWith("/api/session/")) {
      const parts = url.pathname.split("/"); // ["","api","session",code,?action]
      const code = (parts[3] || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!code || code.length < 4 || code.length > 8) {
        return new Response("Invalid session code", { status: 400 });
      }
      if (!env || !env.SESSION_ROOM) {
        return new Response("Session rooms not available", { status: 503 });
      }
      const stub = env.SESSION_ROOM.get(env.SESSION_ROOM.idFromName(code));
      // Desktop listener: WebSocket upgrade
      if (request.headers.get("Upgrade") === "websocket") {
        return stub.fetch(request);
      }
      // Phone delivery: relay final authoritative text to desktop listeners
      if (request.method === "POST" && parts[4] === "deliver") {
        const body = await request.text();
        return stub.fetch("https://session-room/broadcast", {
          method: "POST",
          body: body,
        });
      }
      // Native pollers (e.g. the AHK script): read the held delivery without
      // joining the room — lets a native app write the clipboard with no
      // browser-focus requirement.
      if (request.method === "GET" && parts[4] === "latest") {
        return stub.fetch("https://session-room/latest");
      }
      return new Response("Not found", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  },
};

// ─── Deepgram Nova-3 realtime STT (Cloudflare Workers AI) ───
// The realtime engine (and hybrid's live-feedback leg) streams to Deepgram
// Nova-3 hosted ON Workers AI (@cf/deepgram/nova-3) via the env.AI binding, so
// audio never leaves Cloudflare (no external hop — the whole point of the swap).
// Batch and the hybrid accuracy refine still go to ElevenLabs (handleTranscribeBatch).
// The client's pump produces 16 kHz s16le mono PCM; Deepgram takes raw binary PCM.
//
// VERIFY-ON-LIVE (from the doc research): Cloudflare publishes the {websocket:true}
// run form and the medical `mode` enum, but does NOT publish nova-3's STREAMING
// frame shape (only its batch output schema) and `sample_rate` is absent from
// nova-3's input schema. So the translator below is defensive across the three
// plausible frame shapes and surfaces an unrecognized first frame loudly, so the
// real wire shape (and whether sample_rate/mode took) is caught on the first test
// rather than silently producing a blank or wrong chart.
const NOVA3_MODEL = "@cf/deepgram/nova-3";

// Decode a base64 string to raw bytes (Deepgram wants binary PCM frames).
function b64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Client frame vocabulary -> Deepgram backend frames. The client sends every audio
// frame through one chokepoint: {message_type:"input_audio_chunk", audio_base_64, commit}.
// Deepgram wants raw PCM bytes as binary WS frames; the final flush (commit) is
// signalled with ONLY {"type":"CloseStream"} — Deepgram-on-Workers-AI rejects other
// control variants (it returned "unknown variant `Finalize`/`KeepAlive`, expected
// `CloseStream`"), and CloseStream alone ends input so Deepgram returns finals +
// Metadata then closes. Returns an array whose items are Uint8Array (audio) or a
// JSON control string. If the control frame is somehow not honored, the client's
// FINAL_WAIT_MS close path is the backstop — a missed finalize can't lose text.
export function novaClientToBackend(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return []; }
  if (!m || m.message_type !== "input_audio_chunk") return [];
  const out = [];
  if (typeof m.audio_base_64 === "string" && m.audio_base_64.length) {
    out.push(b64ToBytes(m.audio_base_64));
  }
  if (m.commit) {
    out.push(JSON.stringify({ type: "CloseStream" }));
  }
  return out;
}

// Deepgram streaming responses -> client frame vocabulary. Defensive across the
// THREE plausible on-wire shapes (Cloudflare does not publish the nova-3 streaming
// envelope): (A) native Deepgram Results {type:"Results", is_final, speech_final,
// from_finalize, channel.alternatives[0].transcript}; (B) batch-style
// {results.channels[0].alternatives[0].transcript}; (C) Flux-style {event, transcript}.
// Emits a running partial_transcript as text accrues, and a committed_transcript at
// finalize / Metadata / end-of-turn. ANY frame carrying a string error takes the
// loud {error} path. An UNRECOGNIZED first frame is surfaced loudly (test-build
// diagnostic) so the real shape is observed instead of yielding a silent blank.
export function makeNova3ToClient(tier) {
  let finalText = "";       // accumulated final (locked) text
  let startedSent = false;
  let sawText = false;      // have we emitted any transcript frame?
  let probed = false;       // have we surfaced the unknown-shape diagnostic?
  return function translate(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return []; }
    if (!m || typeof m !== "object") return [];
    const out = [];

    if (!startedSent) {
      startedSent = true;
      // config.tier surfaces which Nova-3 config opened (medical/general/minimal)
      // so the live status can show whether the medical model is actually active.
      out.push(JSON.stringify({ message_type: "session_started", config: { tier: tier || "" } }));
    }

    // Loud error path — any error-shaped frame.
    if (typeof m.error === "string" && m.error) {
      out.push(JSON.stringify({ message_type: "error", error: "Nova-3 " + m.error })); return out;
    }
    if (typeof m.type === "string" && /error|fatal/i.test(m.type)) {
      out.push(JSON.stringify({ message_type: "error", error: "Nova-3 " + (m.description || m.message || m.reason || m.type) })); return out;
    }

    // Metadata = end of stream after CloseStream -> emit the ONE committed_transcript
    // that locks the note in (mirrors how the Soniox path committed once on
    // `finished`). Committing here, NOT on every speech_final, is what prevents the
    // client (which APPENDS each committed_transcript) from duplicating cumulative
    // text into "hello hello world".
    if (m.type === "Metadata") {
      if (finalText) out.push(JSON.stringify({ message_type: "committed_transcript", text: finalText }));
      return out;
    }

    // Benign Deepgram lifecycle frames — ignore (Connected is the handshake frame
    // sent first; SpeechStarted/UtteranceEnd are streaming events we don't need).
    if (m.type === "Connected" || m.type === "SpeechStarted" || m.type === "UtteranceEnd") return out;

    // Transcript frame. Don't gate on type==="Results" — accept ANY frame carrying a
    // channel.alternatives[0] (Cloudflare's own example keys off this, not the type).
    // is_final segments accumulate into finalText; the running partial_transcript
    // (finalText + the live interim tail) is the live view. committed_transcript is
    // emitted ONCE, on Metadata, so there is no append-duplication.
    const alt0 = m.channel && Array.isArray(m.channel.alternatives) && m.channel.alternatives[0];
    if (alt0) {
      sawText = true;
      const t = (alt0.transcript || "").trim();
      if (m.is_final === true) {
        if (t) finalText = finalText ? finalText + " " + t : t;
        out.push(JSON.stringify({ message_type: "partial_transcript", text: finalText }));
      } else {
        out.push(JSON.stringify({ message_type: "partial_transcript", text: (finalText ? finalText + " " : "") + t }));
      }
      return out;
    }

    // (B) batch-style envelope (results.channels[]) — defensive; show the text as a
    // running partial (committed still comes once via Metadata / the close backstop).
    if (m.results && m.results.channels && m.results.channels[0] &&
        m.results.channels[0].alternatives && m.results.channels[0].alternatives[0]) {
      sawText = true;
      finalText = m.results.channels[0].alternatives[0].transcript || finalText;
      out.push(JSON.stringify({ message_type: "partial_transcript", text: finalText }));
      return out;
    }

    // (C) Flux-style turn protocol (event/transcript) — defensive.
    if (typeof m.event === "string" && typeof m.transcript === "string") {
      sawText = true;
      const tt = m.transcript.trim();
      if (m.event === "EndOfTurn") { if (tt) finalText = finalText ? finalText + " " + tt : tt; out.push(JSON.stringify({ message_type: "partial_transcript", text: finalText })); }
      else out.push(JSON.stringify({ message_type: "partial_transcript", text: (finalText ? finalText + " " : "") + tt }));
      return out;
    }

    // Any other unknown frame: ignore it (do NOT fabricate text, do NOT fail loudly).
    // The discovery diagnostic is retired now that the real protocol is known
    // (Connected -> Results… -> Metadata); a stray unknown frame must not kill a
    // dictation. Log server-side for visibility.
    try { if (!probed) { probed = true; console.log("nova3 unhandled frame:", raw.slice(0, 200)); } } catch (e) {}
    return out;
  };
}

// ===== Soniox stt-rt-v5 realtime (opt-in via ?rt=soniox) — sub-second word-by-word
// token streaming, the fastest live-feedback option. Uses SONIOX_API_KEY (set as a
// secret). Auth + config are the FIRST JSON frame (the Worker sends it, not the
// client); audio is raw BINARY PCM; the commit flush is an empty string =
// end-of-audio. The client frame vocabulary is preserved via the translators. =====
const SONIOX_WS_URL = "https://stt-rt.soniox.com/transcribe-websocket";
const SONIOX_MODEL = "stt-rt-v5";

// Client input_audio_chunk -> Soniox: base64 audio -> raw binary PCM frame; on
// commit, an empty string signals end-of-audio (Soniox then flushes finals +
// `finished` and closes). Exported for tests.
export function sonioxClientToBackend(raw) {
  let m;
  try { m = JSON.parse(raw); } catch { return []; }
  if (!m || m.message_type !== "input_audio_chunk") return [];
  const out = [];
  if (typeof m.audio_base_64 === "string" && m.audio_base_64.length) {
    out.push(b64ToBytes(m.audio_base_64));
  }
  if (m.commit) out.push(""); // empty string = end-of-audio
  return out;
}

// Soniox responses -> client (the normalized frame vocabulary). Soniox streams
// token objects with an is_final flag: final tokens are confirmed (sent once),
// non-final are provisional (resent each response). Accumulate confirmed text and
// emit, each response, a partial_transcript of confirmed + provisional tail; on
// `finished` emit a committed_transcript with the confirmed text so the client
// locks it in. Control markers (<end>/<fin>) are dropped. Any error_code becomes a
// loud {error}. Exported for tests.
export function makeSonioxToClient() {
  let finalText = "";
  let startedSent = false;
  return function translate(raw) {
    let m;
    try { m = JSON.parse(raw); } catch { return []; }
    if (!m || typeof m !== "object") return [];
    const out = [];
    if (!startedSent) {
      startedSent = true;
      out.push(JSON.stringify({ message_type: "session_started", config: {} }));
    }
    if (m.error_code) {
      out.push(JSON.stringify({
        message_type: "error",
        error: "Soniox " + String(m.error_code) + (m.error_message ? " - " + m.error_message : ""),
      }));
      return out;
    }
    let newFinal = "", nonFinal = "";
    if (Array.isArray(m.tokens)) {
      for (const t of m.tokens) {
        if (!t || typeof t.text !== "string") continue;
        if (/^\s*<[^>]+>\s*$/.test(t.text)) continue; // drop <end>/<fin> markers
        if (t.is_final) newFinal += t.text; else nonFinal += t.text;
      }
    }
    finalText += newFinal;
    out.push(JSON.stringify({ message_type: "partial_transcript", text: finalText + nonFinal }));
    if (m.finished) out.push(JSON.stringify({ message_type: "committed_transcript", text: finalText }));
    return out;
  };
}

async function handleTranscribeRealtime(request, env) {
  // Realtime STT uses WebSockets. Verify handshake upgrade
  if (request.headers.get("Upgrade") !== "websocket") {
    return new Response("Expected WebSocket upgrade", { status: 400 });
  }

  // Create client/server pair early so we can safely report errors back to the browser UI
  const [clientWs, workerWs] = new WebSocketPair();

  // Helper to accept client socket and send a JSON error frame before closing
  const returnWsError = (errorMsg) => {
    workerWs.accept();
    workerWs.send(JSON.stringify({ message_type: "error", error: errorMsg }));
    workerWs.close(1008, "handshake_failed");
    return new Response(null, { status: 101, webSocket: clientWs });
  };

  try {
    const url = new URL(request.url);

    // Realtime is Deepgram Nova-3 on Workers AI (env.AI) — there is NO third-party
    // STT key. The only access gate is the shared-mode passphrase (so the billed AI
    // binding can't be driven anonymously). Single-tenant deploys (no APP_PASSPHRASE)
    // need no realtime credential — there is no key to protect.
    const serverPass = ((env && env.APP_PASSPHRASE) || "").trim();
    if (serverPass) {
      const given = String(url.searchParams.get("passphrase") || "").trim();
      if (!safeEqual(given, serverPass)) {
        return returnWsError("Unauthorized passphrase");
      }
    }
    if (!env || !env.AI) {
      return returnWsError("Workers AI binding (AI) is not configured");
    }

    // Phone mic relay: if a session code is present, relay transcript events to
    // the DO room so a desktop listener sees them in real time (fire-and-forget).
    const sessionCode = (url.searchParams.get("session") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    const doStub = (sessionCode && sessionCode.length >= 4 && env && env.SESSION_ROOM)
      ? env.SESSION_ROOM.get(env.SESSION_ROOM.idFromName(sessionCode))
      : null;

    // Keyterms (medical proper nouns / drug names) bias recognition. On the
    // in-process binding (default) Workers AI exposes `keyterm` as a SINGLE cfg
    // string, so terms are space-joined there. On the AI Gateway / native
    // Deepgram query-string transports the CORRECT form is a REPEATED keyterm
    // query param per term (Deepgram keyterm prompting), built as ktQuery below.
    let keyterms = [];
    try { keyterms = JSON.parse(url.searchParams.get("keyterms_json") || "[]"); } catch { keyterms = []; }
    // maxTerms 300 so the Soniox path (large context budget) can bias on the full
    // preset list; the EL realtime branch re-sanitizes to its 50/20 cap, and the
    // Soniox branch applies an 8000-char total-context budget guard. The Nova
    // binding/gateway paths just space-join or repeat what fits.
    const cleanedKeyterms = sanitizeKeyterms(keyterms, { maxChars: 50, maxWords: 10, maxTerms: 300 });
    const ktQuery = cleanedKeyterms.map((t) => "&keyterm=" + encodeURIComponent(t)).join("");

    // Binding (default) nova-3 config — the SECOND arg of env.AI.run (NOT a query
    // string, NOT a post-open frame). PROVEN (live param-probe): the Workers AI
    // nova-3 binding 500s on boolean/number values — every value must be a STRING
    // ("true", "16000", ...). The binding schema has NO sample_rate property (only
    // Flux's does); whether it FORWARDS sample_rate to Deepgram is the open
    // question /api/nova-probe settles, and the leading suspect for
    // "slow=clean/fast=garbled". mode:"medical" 500s on the binding — Deepgram
    // streaming has no `mode` param; the clinical model is model=nova-3-medical,
    // reachable only via the gateway/native transports below. endpointing:"false"
    // keeps continuous PTT speech from being auto-split; CloseStream finalizes.
    const SR = "16000";
    const liveCfg = {
      encoding: "linear16",
      sample_rate: SR,
      language: "en-US",
      interim_results: "true",
      smart_format: "true",
      punctuate: "true",
      numerals: "true",
      endpointing: "false",
    };
    if (cleanedKeyterms.length) liveCfg.keyterm = cleanedKeyterms.join(" ");

    // Realtime transport selector (?rt=). DEFAULT/auto = ElevenLabs Scribe v2
    // Realtime — probe-verified batch-quality accuracy and prompt finalize, and
    // it uses the EXISTING ELEVENLABS_API_KEY (no new credential). The Workers-AI
    // Nova-3 binding was relegated because its managed layer floored interim
    // cadence at ~1/sec and garbled real noisy-mic speech. Transports:
    //   auto / rt=soniox -> Soniox stt-rt-v5 (DEFAULT — fastest live feedback:
    //            ~0.8s first word, word-by-word; uses SONIOX_API_KEY).
    //   rt=el / rt=scribe -> ElevenLabs Scribe v2 Realtime (uses ELEVENLABS_API_KEY).
    //   rt=binding / rt=nova -> @cf/deepgram/nova-3 on the env.AI binding.
    //   rt=flux -> @cf/deepgram/flux on the binding.
    //   rt=gw  -> AI Gateway "workers-ai" nova-3 (needs CF_AIG_* secrets).
    //   rt=dgw -> AI Gateway "deepgram" passthrough to nova-3-medical (needs
    //            CF_AIG_* + DEEPGRAM_API_KEY).
    // auto falls back Soniox -> ElevenLabs -> binding by which key is present.
    // EL is a near-IDENTITY passthrough (the client vocabulary was modeled on EL's
    // protocol); Soniox uses sonioxClientToBackend/makeSonioxToClient; Nova/gateway
    // use novaClientToBackend/makeNova3ToClient.
    const rt = String(url.searchParams.get("rt") || "auto").toLowerCase();
    const elKey = ((env && env.ELEVENLABS_API_KEY) || "").trim();
    const sonioxKey = ((env && env.SONIOX_API_KEY) || "").trim();
    // Default (auto) prefers Soniox; EL only takes auto if no Soniox key.
    const useEl = (rt === "el" || rt === "scribe" || (rt === "auto" && !sonioxKey)) && !!elKey;
    const acct = ((env && env.CF_ACCOUNT_ID) || "").trim();
    const gwName = ((env && env.CF_AIG_GATEWAY) || "").trim();
    const aigToken = ((env && env.CF_AIG_TOKEN) || "").trim();
    const dgKey = ((env && env.DEEPGRAM_API_KEY) || "").trim();

    let backendWs = null, usedTier = "", diags = [], elPassthrough = false, sonioxMode = false;

    if (useEl) {
      // ElevenLabs Scribe v2 Realtime. commit_strategy=manual: one final per PTT
      // push (we drive the commit at release), no VAD mid-utterance splitting.
      const elTerms = sanitizeKeyterms(keyterms, { maxChars: 20, maxWords: 5, maxTerms: 50 });
      const noVerbatim = url.searchParams.get("no_verbatim") !== "false";
      const elp = new URLSearchParams();
      elp.append("model_id", "scribe_v2_realtime");
      elp.append("audio_format", "pcm_16000");
      elp.append("language_code", "en");
      elp.append("commit_strategy", "manual");
      elp.append("include_timestamps", "false");
      elp.append("no_verbatim", String(noVerbatim));
      for (const t of elTerms) elp.append("keyterms", t);
      const elUrl = "https://api.elevenlabs.io/v1/speech-to-text/realtime?" + elp.toString();
      try {
        const resp = await fetch(elUrl, { headers: { Upgrade: "websocket", "xi-api-key": elKey } });
        if (resp && resp.webSocket) { backendWs = resp.webSocket; usedTier = "elevenlabs"; elPassthrough = true; }
        else {
          diags.push("el:status=" + (resp && resp.status));
          try { if (resp && typeof resp.clone === "function") diags.push((await resp.clone().text()).slice(0, 120)); } catch (e) {}
        }
      } catch (e) { diags.push("el:threw " + ((e && e.message) || String(e)).slice(0, 80)); }
    } else if (rt === "soniox" || (rt === "auto" && sonioxKey)) {
      // Soniox stt-rt-v5 (DEFAULT) — sub-second token streaming. Auth + config ride
      // the first JSON frame (sent in the piping branch); handshake is a bare upgrade.
      if (!sonioxKey) { diags.push("soniox: SONIOX_API_KEY not set"); }
      else {
        try {
          const resp = await fetch(SONIOX_WS_URL, { headers: { Upgrade: "websocket" } });
          if (resp && resp.webSocket) { backendWs = resp.webSocket; usedTier = "soniox"; sonioxMode = true; }
          else {
            diags.push("soniox:status=" + (resp && resp.status));
            try { if (resp && typeof resp.clone === "function") diags.push((await resp.clone().text()).slice(0, 120)); } catch (e) {}
          }
        } catch (e) { diags.push("soniox:threw " + ((e && e.message) || String(e)).slice(0, 80)); }
      }
    } else if (rt === "gw" || rt === "dgw") {
      // Outbound WebSocket from a Worker: fetch() with an Upgrade header, then read
      // resp.webSocket (NOT `new WebSocket`). Native query params take real strings.
      if (!acct || !gwName || !aigToken) {
        return returnWsError("Gateway transport rt=" + rt + " needs CF_ACCOUNT_ID + CF_AIG_GATEWAY + CF_AIG_TOKEN secrets");
      }
      const baseQs = "encoding=linear16&sample_rate=16000&channels=1&language=en-US&interim_results=true&endpointing=false&smart_format=true&punctuate=true&numerals=true";
      let gwUrl, headers;
      if (rt === "gw") {
        gwUrl = "https://gateway.ai.cloudflare.com/v1/" + acct + "/" + gwName +
          "/workers-ai?model=" + encodeURIComponent("@cf/deepgram/nova-3") + "&" + baseQs + ktQuery;
        headers = { Upgrade: "websocket", "cf-aig-authorization": "Bearer " + aigToken };
        usedTier = "gw-nova3";
      } else {
        if (!dgKey) return returnWsError("rt=dgw needs DEEPGRAM_API_KEY secret");
        gwUrl = "https://gateway.ai.cloudflare.com/v1/" + acct + "/" + gwName +
          "/deepgram/v1/listen?model=nova-3-medical&" + baseQs + ktQuery;
        headers = { Upgrade: "websocket", "cf-aig-authorization": "Bearer " + aigToken, "Authorization": "Token " + dgKey };
        usedTier = "dgw-medical";
      }
      try {
        const resp = await fetch(gwUrl, { headers });
        if (resp && resp.webSocket) backendWs = resp.webSocket;
        else {
          diags.push(usedTier + ":status=" + (resp && resp.status));
          try { if (resp && typeof resp.clone === "function") diags.push((await resp.clone().text()).slice(0, 80)); } catch (e) {}
        }
      } catch (e) { diags.push(usedTier + ":threw " + ((e && e.message) || String(e)).slice(0, 60)); }
    } else {
      // Binding transports (default + flux), all-string cfg.
      const tiers = (rt === "flux")
        ? [{ label: "flux", model: "@cf/deepgram/flux", cfg: { encoding: "linear16", sample_rate: SR, eot_threshold: "0.8", eot_timeout_ms: "8000" } }]
        : [
            { label: "live", model: NOVA3_MODEL, cfg: liveCfg },
            // Safety fallback: the proven-minimal config (finals only) if the full one ever fails.
            { label: "bare", model: NOVA3_MODEL, cfg: { encoding: "linear16", sample_rate: SR } },
          ];
      for (const t of tiers) {
        let r = null;
        try { r = await env.AI.run(t.model, t.cfg, { websocket: true }); }
        catch (e) { diags.push(t.label + ":threw " + (e?.message || String(e)).slice(0, 60)); continue; }
        if (r && r.webSocket) { backendWs = r.webSocket; usedTier = t.label; break; }
        let d = t.label + ":status=" + (r && r.status);
        try { if (r && typeof r.clone === "function") { const b = await r.clone().text(); d += " " + b.slice(0, 70); } } catch (e) {}
        diags.push(d);
      }
    }
    try { console.log("realtime connect:", usedTier || "NONE", "rt=" + rt, "|", diags.join(" || ")); } catch (e) {}
    if (!backendWs) {
      return returnWsError("Realtime connect failed [" + diags.join(" | ") + "]");
    }

    backendWs.accept();
    workerWs.accept();

    // Once the client's commit flush is forwarded we latch input closed so a late
    // ~85 ms pump frame can't reopen the stream mid-finalize. The PTT audio is
    // continuous (pre-gate), so no KeepAlive is needed before the held release.
    let inputEnded = false;

    if (elPassthrough) {
      // ElevenLabs realtime: the client vocabulary IS EL's native protocol, so
      // forward JSON both ways (near-identity). The client's empty-audio
      // {commit:true} flush IS EL's commit — forward as-is, then latch. Drop
      // previous_text (cross-press drift; EL also rejects it past the first chunk).
      workerWs.addEventListener("message", (event) => {
        if (inputEnded) return;
        let raw = event.data, isCommit = false;
        try {
          const m = JSON.parse(event.data);
          if (m && m.message_type === "input_audio_chunk") {
            if (m.commit) isCommit = true;
            if (m.previous_text) { delete m.previous_text; raw = JSON.stringify(m); }
          }
        } catch (e) {}
        try { backendWs.send(raw); } catch (e) {}
        if (isCommit) inputEnded = true;
      });
      // EL -> browser: frames already match the client vocabulary (session_started /
      // partial_transcript / committed_transcript / error) — forward raw, and mirror
      // into the phone room for live desktop feedback.
      backendWs.addEventListener("message", (event) => {
        try { workerWs.send(event.data); } catch (e) {}
        if (doStub) {
          doStub.fetch("https://session-room/broadcast", { method: "POST", body: event.data })
                .catch(() => {});
        }
      });
    } else if (sonioxMode) {
      // Soniox: config-first (auth + audio format + medical context terms), raw
      // BINARY PCM audio, empty-string end-of-audio on commit. Tokens translate
      // back to the client vocabulary via makeSonioxToClient.
      // Accuracy-tuned for PTT medical dictation:
      //  - enable_endpoint_detection:false — PTT supplies the explicit end-of-audio
      //    (empty-string commit), so semantic endpointing would only finalize
      //    mid-sentence on natural pauses and lose right-context (Soniox docs: early
      //    finalization degrades accuracy).
      //  - language_hints_strict — stronger English signal (docs: recommended for prod).
      //  - richer general context — domain/specialty/setting/style biasing.
      // Soniox context has a HARD ~10000-char total budget; trim terms first
      // (cleanedKeyterms is already ordered custom>presets>always-on) to stay under,
      // or the WS handshake fails loudly.
      const sonioxGeneral = [
        { key: "domain", value: "Healthcare" },
        { key: "specialty", value: "Wound care and emergency medicine" },
        { key: "setting", value: "Clinician dictation of a patient note" },
        { key: "style", value: "Medical terminology, drug names, abbreviations" },
      ];
      const sonioxTerms = [];
      let sonioxBudget = 8000; // headroom under the 10000-char hard limit (general text counts too)
      for (const t of cleanedKeyterms) {
        if (sonioxBudget - (t.length + 1) < 0) break;
        sonioxTerms.push(t);
        sonioxBudget -= t.length + 1;
      }
      const sonioxConfig = {
        api_key: sonioxKey,
        model: SONIOX_MODEL,
        audio_format: "pcm_s16le",
        sample_rate: 16000,
        num_channels: 1,
        language_hints: ["en"],
        language_hints_strict: true,
        enable_endpoint_detection: false,
        context: sonioxTerms.length ? { general: sonioxGeneral, terms: sonioxTerms } : { general: sonioxGeneral },
      };
      try { backendWs.send(JSON.stringify(sonioxConfig)); } catch (e) {}
      const toClient = makeSonioxToClient();
      workerWs.addEventListener("message", (event) => {
        if (inputEnded) return;
        for (const frame of sonioxClientToBackend(event.data)) {
          try { backendWs.send(frame); } catch (e) {}
        }
        try {
          const m = JSON.parse(event.data);
          if (m && m.message_type === "input_audio_chunk" && m.commit) inputEnded = true;
        } catch (e) {}
      });
      backendWs.addEventListener("message", (event) => {
        for (const frame of toClient(event.data)) {
          try { workerWs.send(frame); } catch (e) {}
          if (doStub) {
            doStub.fetch("https://session-room/broadcast", { method: "POST", body: frame })
                  .catch(() => {});
          }
        }
      });
    } else {
      const toClient = makeNova3ToClient(usedTier);
      // Browser -> Deepgram: decode base64 audio -> raw binary PCM; on commit send
      // CloseStream (novaClientToBackend). Latch closed after commit.
      workerWs.addEventListener("message", (event) => {
        if (inputEnded) return;
        for (const frame of novaClientToBackend(event.data)) {
          try { backendWs.send(frame); } catch (e) {}
        }
        try {
          const m = JSON.parse(event.data);
          if (m && m.message_type === "input_audio_chunk" && m.commit) {
            inputEnded = true;
          }
        } catch (e) {}
      });
      // Deepgram -> browser: translate result frames into the client frame vocabulary
      // (and mirror into the phone room for live desktop feedback).
      backendWs.addEventListener("message", (event) => {
        for (const frame of toClient(event.data)) {
          try { workerWs.send(frame); } catch (e) {}
          if (doStub) {
            doStub.fetch("https://session-room/broadcast", { method: "POST", body: frame })
                  .catch(() => {});
          }
        }
      });
    }

    workerWs.addEventListener("close", () => {
      try { backendWs.close(); } catch (e) {}
    });

    backendWs.addEventListener("close", (event) => {
      // An abnormal close mid-dictation is a real drop — surface it loudly so it's
      // diagnosable. A normal 1000 close (after finals) carries no error.
      const code = event && event.code;
      if (code && code !== 1000 && code !== 1005) {
        const reason = (event && event.reason) ? (": " + event.reason) : "";
        const who = usedTier === "elevenlabs" ? "ElevenLabs" : usedTier === "soniox" ? "Soniox" : "Nova-3";
        try { workerWs.send(JSON.stringify({ message_type: "error", error: who + " closed the realtime socket (" + code + ")" + reason })); } catch (e) {}
      }
      try { workerWs.close(); } catch (e) {}
      if (doStub) {
        doStub.fetch("https://session-room/broadcast", {
          method: "POST",
          body: JSON.stringify({ message_type: "phone_session_end" }),
        }).catch(() => {});
      }
    });

    return new Response(null, {
      status: 101,
      webSocket: clientWs,
    });
  } catch (err) {
    return returnWsError(`Worker initialization failed: ${err?.message || String(err)}`);
  }
}

// ===== DIAGNOSTIC: realtime STT probe (TEMPORARY — remove after the realtime
// accuracy investigation concludes). Capability-gated by the env.PROBE_KEY
// secret (set out-of-band via `wrangler secret put PROBE_KEY`, NEVER committed),
// so it does not need APP_PASSPHRASE and cannot be driven anonymously despite
// using the billed AI binding. If PROBE_KEY is unset the endpoint is disabled.
// It streams caller-supplied 16 kHz s16le PCM to a chosen Workers AI streaming
// model at a controllable cadence/sample_rate/encoding, sends CloseStream, and
// returns the transcripts — letting us A/B whether sample_rate is honored,
// whether real-time vs blast cadence matters, and nova-3 vs flux, no mic. =====

// Minimal server-side 44-byte RIFF/WAVE header (mono s16le) — for the
// self-describing-container test (does prepending a header make Deepgram
// auto-detect the rate, sidestepping a dropped sample_rate?).
function wavHeaderBytes(dataLen, sampleRate) {
  const h = new ArrayBuffer(44);
  const v = new DataView(h);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + dataLen, true); ws(8, "WAVE");
  ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, "data"); v.setUint32(40, dataLen, true);
  return new Uint8Array(h);
}

async function handleNovaProbe(request, env) {
  try {
    const url = new URL(request.url);
    // Gate: accept the dedicated PROBE_KEY secret OR the existing APP_PASSPHRASE
    // (the same credential that already gates shared-mode realtime/batch). This
    // keeps the billed AI binding from being driven anonymously WITHOUT minting a
    // new secret — a holder of the app passphrase can run the probe directly.
    const given = String(url.searchParams.get("key") || "");
    const probeKey = ((env && env.PROBE_KEY) || "").trim();
    const appPass = ((env && env.APP_PASSPHRASE) || "").trim();
    const okKey = (probeKey && safeEqual(given, probeKey)) || (appPass && safeEqual(given, appPass));
    if (!probeKey && !appPass) return json({ error: "probe: disabled (no PROBE_KEY or APP_PASSPHRASE set)" }, 404);
    if (!okKey) return json({ error: "probe: bad or missing key" }, 403);
    if (request.method !== "POST") return json({ error: "probe: POST a JSON body" }, 400);
    if (!env || !env.AI) return json({ error: "probe: no AI binding" }, 500);

    const body = await request.json();
    const model = String(body.model || "@cf/deepgram/nova-3");
    const cfgIn = (body.cfg && typeof body.cfg === "object") ? body.cfg : { encoding: "linear16", sample_rate: "16000" };
    const cfg = {};                 // binding 500s on non-string values
    for (const k of Object.keys(cfgIn)) cfg[k] = String(cfgIn[k]);
    const frameBytes = Math.max(2, (body.frame_bytes | 0) || 2730);   // ~85 ms @16k s16le
    const cadenceMs  = (body.cadence_ms == null) ? 85 : (body.cadence_ms | 0); // 0 = blast
    const deadlineMs = Math.min(60000, (body.deadline_ms | 0) || 20000);
    const prependWav = !!body.prepend_wav;
    const wavRate    = (body.wav_rate | 0) || 16000;

    let pcm;
    try {
      const bin = atob(String(body.pcm_base64 || ""));
      pcm = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) pcm[i] = bin.charCodeAt(i);
    } catch (e) { return json({ error: "probe: bad pcm_base64" }, 400); }
    if (pcm.length < 1000) return json({ error: "probe: pcm too short (" + pcm.length + " bytes)" }, 400);

    // ===== ElevenLabs Scribe v2 Realtime probe branch (transport:"el") =====
    // Streams the SAME 16k PCM to EL realtime as input_audio_chunk JSON frames and
    // measures first-partial / first-commit latency — to compare EL's responsiveness
    // and accuracy against the Workers-AI binding without a live mic.
    if (String(body.transport || "") === "el") {
      const elKey = ((env && env.ELEVENLABS_API_KEY) || "").trim();
      if (!elKey) return json({ error: "probe el: ELEVENLABS_API_KEY not set" }, 500);
      const elp = new URLSearchParams();
      elp.append("model_id", String(body.model_id || "scribe_v2_realtime"));
      elp.append("audio_format", "pcm_16000");
      elp.append("language_code", "en");
      elp.append("commit_strategy", String(body.commit_strategy || "manual"));
      elp.append("include_timestamps", "false");
      elp.append("no_verbatim", String(body.no_verbatim === true));
      if (Array.isArray(body.keyterms)) for (const t of body.keyterms.slice(0, 50)) elp.append("keyterms", String(t).slice(0, 20));
      const elUrl = "https://api.elevenlabs.io/v1/speech-to-text/realtime?" + elp.toString();
      const t0el = Date.now();
      let er;
      try { er = await fetch(elUrl, { headers: { Upgrade: "websocket", "xi-api-key": elKey } }); }
      catch (e) { return json({ error: "probe el: fetch threw " + (e && e.message || String(e)) }, 502); }
      const ews = er && er.webSocket;
      if (!ews) {
        let d = "status=" + (er && er.status);
        try { if (er && er.clone) d += " " + (await er.clone().text()).slice(0, 200); } catch (e) {}
        return json({ error: "probe el: no webSocket (" + d + ")" }, 502);
      }
      ews.accept();
      const elRaw = [], elPartials = [];
      let committed = "", elClosed = false, elCloseInfo = null, firstPartialAt = 0, firstCommitAt = 0;
      const elDone = new Promise((resolve) => {
        ews.addEventListener("message", (ev) => {
          const s = (typeof ev.data === "string") ? ev.data : "[binary]";
          if (elRaw.length < 80) elRaw.push(s.slice(0, 300));
          let m; try { m = JSON.parse(s); } catch (e) { return; }
          if (!m) return;
          if (m.message_type === "partial_transcript") { if (!firstPartialAt) firstPartialAt = Date.now() - t0el; if (typeof m.text === "string") elPartials.push(m.text); }
          else if (m.message_type === "committed_transcript" || m.message_type === "committed_transcript_with_timestamps") { if (!firstCommitAt) firstCommitAt = Date.now() - t0el; if (m.text) committed += (committed ? " " : "") + m.text; }
        });
        ews.addEventListener("close", (ev) => { elClosed = true; elCloseInfo = { code: ev && ev.code, reason: ev && ev.reason }; resolve(); });
        ews.addEventListener("error", () => resolve());
      });
      const sleepEl = (ms) => new Promise((res) => setTimeout(res, ms));
      const b64 = (u8) => { let s = ""; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); };
      let elFrames = 0;
      for (let off = 0; off < pcm.length; off += frameBytes) {
        const chunk = pcm.subarray(off, Math.min(off + frameBytes, pcm.length));
        try { ews.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: b64(chunk), commit: false, sample_rate: 16000 })); } catch (e) { break; }
        elFrames++;
        if (cadenceMs > 0) await sleepEl(cadenceMs);
      }
      try { ews.send(JSON.stringify({ message_type: "input_audio_chunk", audio_base_64: "", commit: true, sample_rate: 16000 })); } catch (e) {}
      await Promise.race([elDone, sleepEl(deadlineMs)]);
      try { ews.close(); } catch (e) {}
      return json({
        ok: true, transport: "el", model_id: elp.get("model_id"), commit_strategy: elp.get("commit_strategy"),
        frame_bytes: frameBytes, cadence_ms: cadenceMs, pcm_bytes: pcm.length, frames_sent: elFrames, ms: Date.now() - t0el,
        first_partial_ms: firstPartialAt, first_commit_ms: firstCommitAt,
        closed: elClosed, close_info: elCloseInfo,
        final_text: committed, last_partial: elPartials.length ? elPartials[elPartials.length - 1] : "", partial_count: elPartials.length,
        raw_first_frames: elRaw,
      });
    }

    // ===== Soniox stt-rt-v5 probe branch (transport:"soniox") =====
    if (String(body.transport || "") === "soniox") {
      const skey = ((env && env.SONIOX_API_KEY) || "").trim();
      if (!skey) return json({ error: "probe soniox: SONIOX_API_KEY not set" }, 500);
      const t0s = Date.now();
      let sr;
      try { sr = await fetch("https://stt-rt.soniox.com/transcribe-websocket", { headers: { Upgrade: "websocket" } }); }
      catch (e) { return json({ error: "probe soniox: fetch threw " + (e && e.message || String(e)) }, 502); }
      const sws = sr && sr.webSocket;
      if (!sws) {
        let d = "status=" + (sr && sr.status);
        try { if (sr && sr.clone) d += " " + (await sr.clone().text()).slice(0, 200); } catch (e) {}
        return json({ error: "probe soniox: no webSocket (" + d + ")" }, 502);
      }
      sws.accept();
      // Mirror the production Soniox config (endpoint off by default, strict English,
      // rich general context) so probe scores reflect production. ?enable_endpoint_detection
      // can override for A/B.
      const cfg2 = {
        api_key: skey, model: "stt-rt-v5", audio_format: "pcm_s16le", sample_rate: 16000, num_channels: 1,
        language_hints: ["en"], language_hints_strict: true,
        enable_endpoint_detection: (body.enable_endpoint_detection === true),
        context: { general: [
          { key: "domain", value: "Healthcare" },
          { key: "specialty", value: "Wound care and emergency medicine" },
          { key: "setting", value: "Clinician dictation of a patient note" },
          { key: "style", value: "Medical terminology, drug names, abbreviations" },
        ] },
      };
      if (Array.isArray(body.keyterms) && body.keyterms.length) cfg2.context.terms = body.keyterms.map(String);
      try { sws.send(JSON.stringify(cfg2)); } catch (e) {}
      const sRaw = [], sPartials = [];
      let sFinal = "", sClosed = false, sCloseInfo = null, sFirstPartial = 0, sFirstFinal = 0;
      const sDone = new Promise((resolve) => {
        sws.addEventListener("message", (ev) => {
          const s = (typeof ev.data === "string") ? ev.data : "[binary]";
          if (sRaw.length < 80) sRaw.push(s.slice(0, 300));
          let m; try { m = JSON.parse(s); } catch (e) { return; }
          if (!m) return;
          if (m.error_code) { sRaw.push("ERR " + m.error_code + " " + (m.error_message || "")); resolve(); return; }
          let nf = "", prov = "";
          if (Array.isArray(m.tokens)) for (const t of m.tokens) {
            if (!t || typeof t.text !== "string") continue;
            if (/^\s*<[^>]+>\s*$/.test(t.text)) continue;
            if (t.is_final) nf += t.text; else prov += t.text;
          }
          if (nf) { if (!sFirstFinal) sFirstFinal = Date.now() - t0s; sFinal += nf; }
          if ((nf || prov) && !sFirstPartial) sFirstPartial = Date.now() - t0s;
          if (nf || prov) sPartials.push(sFinal + prov);
          if (m.finished) resolve();
        });
        sws.addEventListener("close", (ev) => { sClosed = true; sCloseInfo = { code: ev && ev.code, reason: ev && ev.reason }; resolve(); });
        sws.addEventListener("error", () => resolve());
      });
      const sleepS = (ms) => new Promise((res) => setTimeout(res, ms));
      let sFrames = 0;
      for (let off = 0; off < pcm.length; off += frameBytes) {
        const chunk = pcm.subarray(off, Math.min(off + frameBytes, pcm.length));
        try { sws.send(chunk); } catch (e) { break; }
        sFrames++;
        if (cadenceMs > 0) await sleepS(cadenceMs);
      }
      try { sws.send(""); } catch (e) {} // empty = end-of-audio
      await Promise.race([sDone, sleepS(deadlineMs)]);
      try { sws.close(); } catch (e) {}
      return json({
        ok: true, transport: "soniox", model: "stt-rt-v5", endpoint_detection: cfg2.enable_endpoint_detection,
        frame_bytes: frameBytes, cadence_ms: cadenceMs, pcm_bytes: pcm.length, frames_sent: sFrames, ms: Date.now() - t0s,
        first_partial_ms: sFirstPartial, first_final_ms: sFirstFinal,
        closed: sClosed, close_info: sCloseInfo,
        final_text: sFinal, last_partial: sPartials.length ? sPartials[sPartials.length - 1] : "", partial_count: sPartials.length,
        raw_first_frames: sRaw,
      });
    }

    const t0 = Date.now();
    let r;
    try { r = await env.AI.run(model, cfg, { websocket: true }); }
    catch (e) { return json({ error: "probe: AI.run threw: " + (e && e.message || String(e)), model, cfg }, 502); }
    if (!r || !r.webSocket) {
      let detail = "status=" + (r && r.status);
      try { if (r && r.clone) detail += " body=" + (await r.clone().text()).slice(0, 200); } catch (e) {}
      return json({ error: "probe: no backend webSocket (" + detail + ")", model, cfg }, 502);
    }
    const be = r.webSocket;
    be.accept();

    const rawFrames = [];
    const partials = [];
    let finalText = "";
    let metadataSeen = false, closed = false, closeInfo = null;

    const done = new Promise((resolve) => {
      be.addEventListener("message", (ev) => {
        const s = (typeof ev.data === "string") ? ev.data : "[binary " + (ev.data && ev.data.byteLength) + "]";
        if (rawFrames.length < 80) rawFrames.push(s.slice(0, 300));
        let m; try { m = JSON.parse(s); } catch (e) { return; }
        if (!m) return;
        if (m.type === "Metadata") { metadataSeen = true; resolve(); return; }
        const alt = m.channel && m.channel.alternatives && m.channel.alternatives[0];
        if (alt) {
          const t = (alt.transcript || "").trim();
          if (m.is_final === true) { if (t) finalText = finalText ? finalText + " " + t : t; }
          else if (t) partials.push(t);
        }
        if (typeof m.transcript === "string" && typeof m.event === "string") { // flux
          const t = m.transcript.trim();
          if (m.event === "EndOfTurn") { if (t) finalText = finalText ? finalText + " " + t : t; }
          else if (t) partials.push(t);
        }
      });
      be.addEventListener("close", (ev) => { closed = true; closeInfo = { code: ev && ev.code, reason: ev && ev.reason }; resolve(); });
      be.addEventListener("error", () => { resolve(); });
    });

    const sleep = (ms) => new Promise((res) => setTimeout(res, ms));
    if (prependWav) { try { be.send(wavHeaderBytes(pcm.length, wavRate)); } catch (e) {} }
    let framesSent = 0;
    for (let off = 0; off < pcm.length; off += frameBytes) {
      const chunk = pcm.subarray(off, Math.min(off + frameBytes, pcm.length));
      try { be.send(chunk); } catch (e) { break; }
      framesSent++;
      if (cadenceMs > 0) await sleep(cadenceMs);
    }
    try { be.send(JSON.stringify({ type: "CloseStream" })); } catch (e) {}
    await Promise.race([done, sleep(deadlineMs)]);
    try { be.close(); } catch (e) {}

    return json({
      ok: true, model, cfg,
      frame_bytes: frameBytes, cadence_ms: cadenceMs, prepend_wav: prependWav, wav_rate: prependWav ? wavRate : null,
      pcm_bytes: pcm.length, frames_sent: framesSent, ms: Date.now() - t0,
      metadata_seen: metadataSeen, closed, close_info: closeInfo,
      final_text: finalText,
      last_partial: partials.length ? partials[partials.length - 1] : "",
      partial_count: partials.length,
      raw_first_frames: rawFrames,
    });
  } catch (err) {
    return json({ error: "probe: " + (err && err.message || String(err)) }, 500);
  }
}

// Batch proxy: receives the recorded audio blob as multipart form data and
// forwards it to ElevenLabs batch Scribe v2. Serves pure batch mode and the
// hybrid mode's accuracy re-transcription pass.
async function handleTranscribeBatch(request, env) {
  try {
    const incoming = await request.formData();

    const clientKey  = String(incoming.get("api_key") || "").trim();
    const serverKey  = (env && env.ELEVENLABS_API_KEY) || "";
    const serverPass = ((env && env.APP_PASSPHRASE) || "").trim();

    let apiKey = clientKey;
    if (!apiKey && serverKey && serverPass) {
      const given = String(incoming.get("passphrase") || "").trim();
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

    form.append("model_id", "scribe_v2");
    form.append("file", file, file.name || "recording.webm");
    form.append("file_format", String(incoming.get("file_format") || "other"));

    form.append("language_code", "en");
    form.append("diarize", "false");
    form.append("num_speakers", "1");
    form.append("temperature", "0");

    form.append(
      "timestamps_granularity",
      String(incoming.get("timestamps_granularity") || "none")
    );

    const noVerbatim = incoming.get("no_verbatim") !== "false";
    form.append("no_verbatim", String(noVerbatim));

    form.append("tag_audio_events", String(incoming.get("tag_audio_events") === "true"));

    let keyterms = [];
    try {
      keyterms = JSON.parse(String(incoming.get("keyterms_json") || "[]"));
    } catch {
      keyterms = [];
    }

    // Batch API caps: 1000 terms, each < 50 chars and <= 5 words.
    for (const term of sanitizeKeyterms(keyterms, { maxChars: 49, maxWords: 5, maxTerms: 1000 })) {
      form.append("keyterms", term);
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

// Shared keyterm scrubber. The realtime and batch APIs accept different
// volumes/lengths, so the limits are parameters; the cleaning pipeline
// (strip risky chars, collapse whitespace, dedupe case-insensitively)
// is identical for both.
function sanitizeKeyterms(list, { maxChars, maxWords, maxTerms }) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((t) => typeof t === "string")
    .map((t) => t.trim().replace(/[<>{}\[\]\\]/g, "").replace(/\s+/g, " "))
    .filter(Boolean)
    .filter((t) => t.length <= maxChars && t.split(" ").length <= maxWords)
    .filter((t) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, maxTerms);
}


// Scrubbed once at module init through the same pipeline the proxies use, so
// the JSON injected into the inline <script> can never carry <> { } [ ] \
// characters that could break out of the page.
const KEYTERM_PRESETS_CLIENT_JSON = JSON.stringify(
  KEYTERM_PRESETS.map((p) => ({
    id: String(p.id),
    label: String(p.label),
    always: Boolean(p.always),
    terms: sanitizeKeyterms(p.terms, { maxChars: 49, maxWords: 5, maxTerms: 1000 }),
  }))
);

// Web app manifest so the page is installable as a standalone app
// (Chrome/Edge: address-bar install icon, or menu -> "Install app").
const MANIFEST = {
  name: "Scribe Dictation",
  short_name: "Dictation",
  description: "Push-to-talk medical dictation via ElevenLabs Scribe v2 (realtime, batch, or hybrid)",
  start_url: "/",
  display: "standalone",
  background_color: "#0b0d10",
  theme_color: "#0b0d10",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
};

const ICON_192_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAEb0lEQVR42u3dPVIbURRE4ZlXLME5iSMiSB2xJhbiNRGRQkREQs4ecILKKkpiZjT/r78T2VUGiVGf1/dKMmqbFbm5u/9sEM/r82O71m23wo5kKdo1Q//+9uKRRnP9+3Y1Gdqlgi/sGCvFHCK0go9kEdo5gi/0WEKGKURopwy/4GNpEcZKUIQfe+M4a2OfXWwFH8ltUIQfyW1QhB/JEhThR7IERfiRLEERfiRLUC75xsBeJBglwMEg4cdeJehqgSL8SJagdM39QA2cy3Qx9yN5HyhGHySPQsXlQTLF6Y/kFtAA0AA/bclAbRxnvQzdmoG9j0FGIOBYAMsvUpdhDQANABAAIACQRWsBRiKHX6eiAWAEAggAEADI4solWJaHp4/Of/P3zy8XigA5ge/6GkIQICL4Xd+LCASICj4RLMHCv+LtEACbDSUJjECRwTcSaQDh1wYEAAjg1NUCBBA2EhBAyEhAAIAATlctQACAANGnqhYgAEAAgAAAAfLmaXsAAQACAAQACAAQACAAQAAQwCUAAQACAAQACAAQACAAQACAAAABAAIABAAIABAAIABAAIAAAAEAAgAEqIK9fg6vzw8mAEAAgAAAAXLmafM/AQACJJ6qTn8CAARIPF2d/gSIDZnwEyA2bMJPAIAAiaeu0/9yrlyCacK3xmfyCr4GiG0D4SdArATCbwSKHIkEnwCRIgg+AaoZi/oIIfAEsCfAEgwQACAAQADAEjwVx8/GpC6mrkGYAOeegnx4+ogLwPdrcfh72nW4Sg09tELEDtD3QUwSxaFgCQZyBNACw3/GlF1AA0ADaIGMFnD6a4BYCSy+BBh0stUUmCE/S9rrABqgcgmc/ASIPuFcGwKMHoX2eIoOvd+pB0PsCDT0Ad+TBEPva3Ir2gEqk8DMT4BZT74tB+yS+5a+E8U3wKUSbEmES++PJwQIMCoIa4sw5vaFnwCTBWJpEcbenvD/x+8F+haMMcGa8z+TTCWY8BNgVgnOBXYLT7sKPwEGBWXKEK65Kwi+HSA2OMKvATbXBoKvAZyk7qsG0AaCTwAiCD4B9j8WLS2D0BMgTgahJ8Bul1Dv0d8mngVaUIq+oRZ+AgAEAAgAEAAgAEAAgAAAAQACAAQACAAQABiGd4N+sbVfdbgE3nSnAUAAgAAAAQACAAQACAAQAKgZL4R94UUhDQAQAIgS4PX5sW2aprn+fetqIIJD1l+fH1sNACMQQACAAECgABZhJC7AGgAa4JwhQK2n/0kBDpUA1M5x1o1AMAJ9N8MYhNqXXw0AnBJACyDl9O9sABKglvD3boBzpgB75lymS9cXaAHUOPr0GoFIgJrD3ymAfQA1zv2DBDg2iATYU/j77LK9GoAEqDH8g0YgEqC28A8SgASoLfyDBSABagp/0zTNqBe8bu7uPw9/fn978WhgN8G/uAG0AWoJ/+gGONUE2gBLBH+K8E8mwDkRyICpQz9V8GcRgAjYS/BnFeAnEUiBPmGfO/iLCDBEBmCp0K8iACmwdthP8Q9NZS5TPi79vAAAAABJRU5ErkJggg==";

const ICON_512_B64 =
  "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";

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="theme-color" content="#0b0d10" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" type="image/png" href="/icon-192.png" />
  <link rel="apple-touch-icon" href="/icon-192.png" />
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
    main { max-width: 1000px; margin: 0 auto; padding: 14px; }
    h1 { font-size: 18px; margin: 0 0 10px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 850px) { .grid { grid-template-columns: 1fr 380px; align-items: start; } }
    .card {
      background: var(--panel); border: 1px solid var(--line);
      border-radius: 14px; padding: 14px;
    }
    label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 6px; }
