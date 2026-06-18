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
// plausible frame shapes and surfaces an UNRECOGNIZED first frame loudly, so the
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
    const cleanedKeyterms = sanitizeKeyterms(keyterms, { maxChars: 50, maxWords: 10, maxTerms: 100 });
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

    // Realtime transport selector (?rt=). DEFAULT/auto = the proven in-process
    // env.AI binding (current behavior, unchanged). Opt-in alternatives reach an
    // HONORED sample_rate (the prime suspect for the pace-garble):
    //   rt=flux -> @cf/deepgram/flux on the SAME binding (its schema REQUIRES
    //             sample_rate, so CF forwards it) — no new credential.
    //   rt=gw   -> AI Gateway "workers-ai" URL for @cf/deepgram/nova-3 with
    //             sample_rate in the query string — needs CF_AIG_* secrets.
    //   rt=dgw  -> AI Gateway "deepgram" passthrough to nova-3-medical (the
    //             clinical streaming model) — needs CF_AIG_* + DEEPGRAM_API_KEY.
    // Gateway paths stay INERT until their secrets exist, so deploying this
    // changes nothing in production until the operator opts in.
    const rt = String(url.searchParams.get("rt") || "auto").toLowerCase();
    const acct = ((env && env.CF_ACCOUNT_ID) || "").trim();
    const gwName = ((env && env.CF_AIG_GATEWAY) || "").trim();
    const aigToken = ((env && env.CF_AIG_TOKEN) || "").trim();
    const dgKey = ((env && env.DEEPGRAM_API_KEY) || "").trim();

    let backendWs = null, usedTier = "", diags = [];

    if (rt === "gw" || rt === "dgw") {
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

    const toClient = makeNova3ToClient(usedTier);

    // Once end-of-stream is sent we stop forwarding so a late ~85 ms pump frame
    // can't reopen the stream mid-finalize. NOTE: no KeepAlive — Deepgram-on-
    // Workers-AI rejects it ("unknown variant `KeepAlive`"); the PTT audio stream
    // is continuous (pre-gate) so the ~10 s idle close doesn't bite a held button.
    let inputEnded = false;

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

    workerWs.addEventListener("close", () => {
      try { backendWs.close(); } catch (e) {}
    });

    backendWs.addEventListener("close", (event) => {
      // An abnormal close mid-dictation is a real drop — surface it loudly so it's
      // diagnosable. A normal 1000 close (after finals) carries no error.
      const code = event && event.code;
      if (code && code !== 1000 && code !== 1005) {
        const reason = (event && event.reason) ? (": " + event.reason) : "";
        try { workerWs.send(JSON.stringify({ message_type: "error", error: "Nova-3 closed the realtime socket (" + code + ")" + reason })); } catch (e) {}
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
  "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAAOYklEQVR42u3dPVYcWRKA0aIOS8DHwZKFXCytiYWwJixcsLDkyGcPaqvPkRBVlT8vX76IuNec6emBzFLF9yILdHVgM9++//jtKgAs9/76fOUqbMOFNeQBxIEAwLAHEAUCwMA38AEEgQAw8AEQBALA0AdADAgAg/+zXz/f/AkDWOH27l4ICIAxh74hD5AnDirFQIlvtNXgN+wBakRBhRBI/Q22GPyGPkDdGMgcAim/sTWD38AHEAQVQiDVN7R08Bv6AGKgWgik+EYMfgCEQKEAWDL4DX0AWsVA5BAI+4XPHf4GPwBbhEDUCAj3RRv8AAiBYgEwZ/gb/AD0DoFIERDiCzX4ARACxQJg6vA3+AEYKQRGj4Cj4Q8A002dOaP/bbND1onBD4BtQLENgOEPgG1AsQ3AlAtk8AMQdRsw0iZgmA2A4Q9A9m3ASJuA3UvEyh+AapuAEbYBu/6fO/UDUDkE9oyA3R4BGP4AZDb6I4FdAsDwB0AE7BsB3QPA8AdABOwfAV2fPVz6Bg1+ADK79LmAnp8J6LYBMPwBsA14G2YT0CUADH8AGCsCNg8Awx8AxouA48gXAACqRkDoADhXMIY/ACLgbbctwGYBYPgDwLgRsEkAjPjXHgJARFvN1GPvL9TpHwDmzcYtIuA40jcIACKgj6YB4Lk/AGwTAa23AM0CwPAHgDgR0CQAfOgPAPpoNXM3/wyA0z8AjDc7VweA1T8A9I2AFluAVQFg+ANAzAg4urwAUM/iAHD6B4C4W4BFAWD4A0DsCPAIAAAKmh0ATv8AEH8LcOzxhQEAY83aWQHgN/4BwJjmzugmGwCnfwCItQWYHABO/wCQZwuwegPg9A8A8bYAkwLA6R8Acm0BVm0AnP4BIOYW4GIAOP0DQL4twOINgNM/AMTdAhyd/gGg3hZg0QbA6R8AYm8B/GVAAFDQyQCw/geA2M7N8tkbAOt/ABjLktl8dPoHgHpbgFkbAKd/AMixBfAhQAAo6J8AsP4HgFy+mu2TNwDW/wAwtjmz2iMAAChIAABA9QDw/B8Acvo84ydtADz/B4AYps5sjwAAoCABAACVA+DU83/rfwCI5dTs/nPW2wAAQOUNAAAgAAAAAQAApAsAHwAEgFwufRDQBgAAqm4AAAABAAAIAABAAAAAAgAAiOfKjwACQF63d/c2AACAAAAAAQAACAAAQAAAAAIAABAAAIAAAAAGd+0SQG6PLx+L/7dPDzcuIAgAIOugn/vvFAYgAIBEA3/p/7cgAAEAJB36U78uMQACAEg89MUACADA4D/7PQgBEABAgcEvBEAAAIUHvxAAAQAUHvxCAMbjNwGC4e/7BxsAwOCzDQAbAMDwd13ABgAw4GwDwAYAMPxdLxAAgGHmukEUHgGAATb8NfRIAGwAwPB3PQEBAIaV6woIADCkXF9AAIDh5DoDAgAMJdcbEABgGLnuIAAAAAEAOIW6/iAAAMPHfQABAIaOoeN+gAAAAAQAOG3ivoAAAEMG9wcEAAAgAMDpEvcJBAAYKrhfIAAAAAEATpO4byAAAAABAE6RuH8gAAAAAQBOj+4jIAAAQAAATo3uJwgAAEAAAAACAJKzLnZfQQAAAAIAABAAkI41sfsLAgAAEAAAgAAAAAQAxOf5sPsMAgAAEAAAgAAAAAQAACAAAAABABH4ZLj7DQIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAAFR17RIQ2ePLh4vguu/q6eHGRcAGAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAADWunYJiOzp4cZFAFiyAXh/fb766r+4vbt3dQAgsFOz/P31+cojAACouAFwCQBAAAAAAgAAEAAAgAAAAAIHgB8FBIBczv0IoA0AAFTeAAAAAgAAEAAAQNoA8EFAAMjh0gcAbQAAoPoGAAAQAH/xGAAAYpg6s/8KgFOfAwAAYvs84z0CAICCBAAACIDTfA4AAMY2Z1b/EwA+BwAAuXw12z0CAICCZgWAxwAAMKa5M/rLAPAYAAByODXTZz8CsAUAgNin/7MBYAsAADlP/4s2AABAfIsCwGMAABjD0pl8NgA8BgCAmC7N8MWPAGwBACDm6X9SANgCAECu0/+qDYAtAADEPP1PDgBbAADIc/pfvQGwBQCAeKf/WQFgCwAAOU7/TTYAtgAAEOv0PzsAbAEAIP7pv9kGwBYAAOKc/hcFwLnCEAEA0H/4L9nQ+8uAAKCgRQFgCwAAcU//qzYAIgAAYg7/VQEAAMS1KgBsAQAg3um/yQZABABArOHfJADWfAMAwD6zs0kA+A2BANBHq5l77PEF2QIAwPrTf8sDd9NHACIAAMYf/s0DYM03BgCGfz/NA+BSoYgAAJg3G7f4rN0mGwAfCgSAsWfqcY8v2BYAAC7PxC0P1Jt+BkAEAMB4w3/zAFjzjQNA1eHfw+YB4EOBADBv9vX4LF2XDYAIAIBxhn+3ABABADDO8D8cDofuP6737fuP35f+mV8/37xKACgz+HsP/64bgDnfoG0AAIZ/sgAQAQAY/vsO/90CQAQAYPjv+5tzd/+VvVM+E3A4+FwAAHkG/97Df4gAmBMCIgAAp/42jqNcNI8EADD8C24A5mwCbAMAiDT4Rxv+Q20A5l4g2wAADP9EGwDbAAAM/oIbANsAAAz/4huAuZsA2wAA9h78EYZ/mAAQAgAY/IUDYG4ECAEAegz+aMM/ZAAIAQAM/sIBsCQChAAArQZ/5OEfPgDWhIAYAGDpT5FFHvypAkAIAGDwFw6AtSEgBgAM/eyDP3UAtAgBQQBQd+BnHvwlAqBlCIgBgBpDP/vgLxUArUNAFADkGfbVBn/JANg6BsQBwPhDvvLQFwCdQwCA8VQd/AJADAAY+gIAQQBg4AsABAGAgS8AEAUAhr0AQBwAGPLB/QfwL65wpcJThQAAAABJRU5ErkJggg==";

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
    #engineSeg button { flex: 1 1 0; }
    #recordBtn { flex: 1 1 auto; font-weight: 600; }
    #engineSeg button.active {
      border-color: var(--accent); background: #0e2a3a; color: var(--accent);
    }
    .status {
      font-size: 13px; color: var(--muted); margin-top: 10px;
      min-height: 18px; white-space: pre-wrap;
    }
    .status.ok { color: var(--ok); }
    .status.warn { color: var(--warn); }
    .status.err { color: var(--danger); }
    .big {
      font-size: 18px; white-space: pre-wrap; min-height: 140px;
      background: var(--panel2); border: 1px solid var(--line);
      border-radius: 12px; padding: 14px;
    }
    .big:not(:empty) { cursor: pointer; }
    .big.armed { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
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
    .pill {
      display: inline-block; margin-left: 8px; font-size: 12px; padding: 1px 8px;
      border-radius: 999px; border: 1px solid var(--line); color: var(--muted);
    }
    .pill.open { color: #0b0d10; background: var(--ok); border-color: var(--ok); }
    .pill.ok   { color: var(--ok); border-color: var(--ok); }
    .pill.live { color: #0b0d10; background: var(--accent); border-color: var(--accent); }
    .pill.rec  { color: #fff; background: #b91c1c; border-color: #b91c1c; }
    .pill.fail { color: #fff; background: var(--danger); border-color: var(--danger); }
    .pill.warn { color: #0b0d10; background: var(--warn); border-color: var(--warn); }
    .sliderval { color: var(--accent); font-size: 12px; }
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
    .divider { height: 1px; background: var(--line); margin: 18px 0 14px; }
    /* Tiny/minimized app window: shed chrome so record + status + transcript
       stay usable; everything else lives in the collapsible sections. */
    @media (max-width: 600px), (max-height: 600px) {
      main { padding: 8px; }
      h1, #engineHint { display: none; }
      .grid { gap: 8px; }
      .card { padding: 10px; border-radius: 10px; }
      .big { min-height: 72px; font-size: 16px; padding: 10px; }
      textarea { min-height: 80px; }
      label { margin: 8px 0 4px; }
      .checkbox { margin-top: 8px; }
      details.help { margin-top: 8px; }
      .status { margin-top: 6px; }
    }
    /* Big-button dictation layout. Active only while body carries .bigbtn
       (joined to a desktop session, or forced by the per-device override) —
       NEVER keyed on screen size. Additive: a fixed overlay above the normal
       page, so the desktop layout and its tiny-window compactness rules above
       are untouched. */
    #bigUi, #bigReturnBtn { display: none; }
    body.bigbtn main > h1, body.bigbtn main > .grid { display: none; }
    body.bigbtn #bigUi {
      display: flex; flex-direction: column; position: fixed; inset: 0;
      z-index: 40; padding: 14px; gap: 10px; align-items: center;
      background: var(--bg); transition: background-color 0.25s;
    }
    body.bigbtn.bigbtn-settings #bigUi { display: none; }
    body.bigbtn.bigbtn-settings main > .grid { display: grid; }
    body.bigbtn.bigbtn-settings #bigReturnBtn {
      display: block; position: fixed; right: 12px; bottom: 12px; z-index: 41;
      background: #0c4a6e; border-color: #0369a1; font-weight: 600;
    }
    #bigTopRow { width: 100%; display: flex; gap: 8px; align-items: center; flex: 0 0 auto; }
    #bigJoinedBadge { font-family: monospace; letter-spacing: 2px; color: var(--accent); font-size: 14px; flex: 1 1 auto; }
    #bigCenter {
      flex: 1 1 auto; min-height: 0; width: 100%; display: flex;
      flex-direction: column; align-items: center; justify-content: center; gap: 14px;
    }
    #bigState { font-size: 30px; font-weight: 800; letter-spacing: 2px; min-height: 36px; text-align: center; }
    #bigBtn {
      width: min(64vw, 52vh); height: min(64vw, 52vh); border-radius: 50%;
      font-size: 20px; font-weight: 700; letter-spacing: 1px;
      border: 6px solid var(--line); background: var(--panel); color: var(--text);
      touch-action: none; user-select: none; -webkit-user-select: none;
      -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
    }
    #bigHint { font-size: 12px; color: var(--muted); }
    #bigStatus {
      font-size: 14px; color: var(--text); text-align: center;
      min-height: 18px; max-height: 18vh; overflow: auto; white-space: pre-wrap;
    }
    #bigPeek {
      flex: 0 0 auto; width: 100%; background: var(--panel2);
      border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
    }
    #bigPeek.armed { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    /* While recording, the realtime words ARE the feedback (the reason to pick the
       realtime engine on mobile) — accent the strip so it reads as live. */
    #bigPeek.live { border-color: var(--accent); }
    #bigPeekBar { padding: 8px 12px; font-size: 12px; color: var(--muted); cursor: pointer; user-select: none; -webkit-user-select: none; }
    #bigPeek.live #bigPeekBar { color: var(--accent); }
    #bigPeekText { padding: 0 12px 8px; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 20px; }
    #bigPeek.expanded #bigPeekText { white-space: pre-wrap; overflow: auto; text-overflow: clip; max-height: 38vh; cursor: pointer; }
    /* Live view: wrap and grow so the newest words stay on-screen instead of
       scrolling off the right edge of a head-truncated one-liner (the strip
       looked frozen as the note grew). updateBigPeek pins the scroll to the tail. */
    #bigPeek.live #bigPeekText { white-space: pre-wrap; overflow-y: auto; text-overflow: clip; max-height: 30vh; min-height: 48px; }
    /* Whole-screen status: the overlay background IS the at-arm's-length
       indicator, derived from the same transitions that drive the pills. */
    body.bigbtn #bigUi[data-screen="connecting"] { background: #3d3008; }
    body.bigbtn #bigUi[data-screen="rec"]        { background: #420d0d; }
    body.bigbtn #bigUi[data-screen="busy"]       { background: #3d3008; }
    body.bigbtn #bigUi[data-screen="ok"]         { background: #14532d; animation: bigFlash 0.7s ease-out; }
    body.bigbtn #bigUi[data-screen="warn"]       { background: #78350f; }
    body.bigbtn #bigUi[data-screen="fail"]       { background: #7f1d1d; }
    body.bigbtn #bigUi[data-screen="alarm"]      { background: #7f1d1d; animation: bigAlarm 0.5s linear infinite alternate; }
    #bigUi[data-screen="rec"] #bigBtn        { border-color: #ef4444; background: #b91c1c; color: #fff; animation: bigPulse 1.2s ease-in-out infinite; }
    #bigUi[data-screen="connecting"] #bigBtn { border-color: var(--warn); }
    #bigUi[data-screen="busy"] #bigBtn       { border-color: var(--warn); }
    #bigUi[data-screen="ok"] #bigBtn         { border-color: var(--ok); }
    #bigUi[data-screen="warn"] #bigBtn       { border-color: var(--warn); }
    #bigUi[data-screen="fail"] #bigBtn       { border-color: var(--danger); }
    #bigUi[data-screen="alarm"] #bigBtn      { border-color: var(--danger); }
    @keyframes bigPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.55); } 50% { box-shadow: 0 0 0 24px rgba(239,68,68,0); } }
    @keyframes bigFlash { from { background: #22c55e; } }
    @keyframes bigAlarm { from { background: #7f1d1d; } to { background: #450a0a; } }
  </style>
</head>

<body>
<main>
  <h1>ElevenLabs Scribe v2 Dictation</h1>

  <div class="grid">
    <section class="card">
      <div class="row" id="engineSeg">
        <button id="engRealtime" data-engine="realtime" title="Live streaming text is the deliverable">Realtime</button>
        <button id="engBatch" data-engine="batch" title="Upload after release; strongest model, no live text">Batch</button>
        <button id="engHybrid" data-engine="hybrid" title="Live text as feedback + batch accuracy on the clipboard">Hybrid</button>
      </div>
      <div class="hint" id="engineHint" style="margin-top: 6px;"></div>

      <div class="row" style="margin-top: 10px;">
        <button id="recordBtn" class="primary">Start recording</button>
      </div>

      <label>Mic level
        <span id="micPill" class="pill">mic off</span>
        <span id="linkPill" class="pill">link idle</span>
        <span id="gateState" class="pill" title="Local noise gate state (affects the saved audio preview only)">closed</span>
      </label>
      <div class="meterwrap">
        <div id="meterBar"></div>
        <div id="closeMark"></div>
        <div id="openMark"></div>
      </div>

      <div class="status" id="status">
        Ctrl+Space: tap to start/stop, hold to talk (CapsLock via AHK also works).
        Browser beeps when text is ready on the clipboard — keep this tab focused
        until the beep, then switch windows and Ctrl+V.
      </div>

      <label>Latest transcript <span id="appendChip" class="pill" style="display:none;"></span></label>
      <div id="latest" class="big" title="Click to append the next dictation to this text; click again to cancel"></div>

      <div class="row" style="margin-top: 10px;">
        <button id="copyBtn">Copy latest</button>
        <button id="freshBtn" title="Clear the dictation box so the next dictation starts a new note (history is kept)">Clear dictation box</button>
      </div>
    </section>

    <section class="card">
      <details class="help" id="authSection" style="margin-top: 0;">
        <summary id="authSummary">Access</summary>
        <div class="body">
          <div id="passphraseRow" style="display:none">
            <label for="passphrase">Passphrase</label>
            <input id="passphrase" type="password" placeholder="passphrase" autocomplete="off" />
          </div>

          <label for="apiKey" id="apiKeyLabel">ElevenLabs API key (batch / hybrid refine)</label>
          <input id="apiKey" type="password" placeholder="xi-api-key" autocomplete="off" />

          <!-- Realtime now runs on Deepgram Nova-3 via Workers AI (no STT key). This
               legacy field is hidden but kept so saved settings/clear paths still resolve. -->
          <label for="sonioxKey" id="sonioxKeyLabel" style="display:none">Realtime STT key (unused — realtime runs on Workers AI)</label>
          <input id="sonioxKey" type="password" placeholder="unused" autocomplete="off" style="display:none" />

          <label class="checkbox">
            <input type="checkbox" id="saveApiKey" />
            Remember on this browser
          </label>

          <div class="row" style="margin-top: 10px;">
            <button id="forgetKeyBtn">Forget key</button>
          </div>
        </div>
      </details>

      <details class="help" id="optionsSection">
        <summary>Options</summary>
        <div class="body">
          <label class="checkbox" style="margin-top: 4px;">
            <input type="checkbox" id="noVerbatim" checked />
            Remove filler words / false starts
          </label>

          <label class="checkbox">
            <input type="checkbox" id="autoCopy" checked />
            Auto‑copy transcript to clipboard
          </label>

          <label class="checkbox">
            <input type="checkbox" id="appendMode" />
            Append consecutive recordings (don't clear)
          </label>

          <div class="row" id="appendWindowRow" style="margin: 4px 0 0 24px; align-items: center;">
            <span class="hint" style="flex: 0 0 auto;">…only if started within</span>
            <input id="appendWindow" type="number" min="0" max="600" step="5" value="45" style="flex: 0 0 80px;" />
            <span class="hint" style="flex: 0 0 auto;">seconds (0 = always append)</span>
          </div>

          <label class="checkbox">
            <input type="checkbox" id="stripNewlines" checked />
            Strip newlines (collapse to spaces)
          </label>

          <label class="checkbox">
            <input type="checkbox" id="stripEllipses" checked />
            Remove ellipses (pauses become "…" otherwise)
          </label>

          <label class="checkbox">
            <input type="checkbox" id="trailingSpace" checked />
            Trailing space (for consecutive dictations)
          </label>

          <label class="checkbox">
            <input type="checkbox" id="startBeep" checked />
            Start/done beeps (failure alarms always play)
          </label>

          <label for="hotkeyBtn">Push‑to‑talk hotkey</label>
          <div class="row">
            <button id="hotkeyBtn" title="Click, then press the key combo you want">Ctrl + Space</button>
            <button id="hotkeyResetBtn" title="Reset to Ctrl + Space">Reset</button>
          </div>
          <div class="hint" style="margin: 6px 0 12px;">
            Tap = start/stop · Hold = push‑to‑talk · F13/F14 (AutoHotkey) always work
          </div>

          <div class="hint" style="margin: 10px 0 4px; color: var(--text);">Phone mic</div>
          <div class="row" style="margin-bottom: 4px; flex-wrap: wrap; gap: 6px; align-items: center;">
            <button id="phoneStartBtn">Start phone session</button>
            <span id="phoneCodeBadge" style="display:none; font-family: monospace; font-size: 20px; letter-spacing: 3px; color: var(--accent);"></span>
            <button id="phoneStopBtn" style="display:none;">End session</button>
          </div>
          <div class="hint" id="phoneCodeHint" style="display:none; margin-bottom: 6px;"></div>
          <div id="phoneQr" style="display:none; width:148px; line-height:0; border-radius:6px; overflow:hidden; margin: 0 0 8px;"></div>
          <div class="row" style="align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 6px;">
            <span class="hint" style="flex: 0 0 auto;">Join desktop:</span>
            <input id="phoneJoinInput" type="text" maxlength="6" placeholder="ABC123" style="flex: 0 0 72px; font-family: monospace; text-transform: uppercase; text-align: center;" />
            <button id="phoneJoinBtn">Join</button>
            <span id="phoneJoinBadge" style="display:none; color: var(--ok);">Joined</span>
            <button id="phoneLeaveBtn" style="display:none;">Leave</button>
          </div>

          <label for="bigButtonMode">Big-button layout (per device)</label>
          <select id="bigButtonMode">
            <option value="joined" selected>When joined to a desktop session</option>
            <option value="always">Always — solo phone dictation</option>
            <option value="never">Never — e.g. a desktop that joins</option>
          </select>
          <div class="hint" style="margin: 6px 0 4px;">
            Turns this device into a one-button dictation surface. Stored on this device only.
          </div>
        </div>
      </details>

      <details class="help" id="keytermsSection">
        <summary>Context / vocabulary keyterms</summary>
        <div class="body">
          <div id="presetRow"></div>

          <textarea id="keyterms" placeholder="One term per line. Examples:
tachycardia
ascites
right lower quadrant"></textarea>

          <div class="hint" id="keytermHint" style="margin-bottom: 12px;">
            Scribe v2 biases toward these terms. One per line, each &lt;= 20 chars, ≤5 words.
            <strong>Keyterms add ~20 % to cost.</strong> 0 / 50 terms.
          </div>
        </div>
      </details>

      <details class="help" id="advanced">
        <summary>Advanced audio &amp; noise settings</summary>
        <div class="body">
          <div class="legend">
            <span class="dr">red mark on meter = gate OPEN threshold</span> &nbsp;|&nbsp;
            <span class="dy">yellow = CLOSE threshold</span>
          </div>

          <label for="gateOpen">Gate open threshold <span class="sliderval" id="gateOpenVal"></span></label>
          <input id="gateOpen" type="range" min="0" max="0.12" step="0.001" value="0.030" />

          <label for="gateClose">Gate close threshold <span class="sliderval" id="gateCloseVal"></span></label>
          <input id="gateClose" type="range" min="0" max="0.12" step="0.001" value="0.008" />

          <label for="highpass">High‑pass filter <span class="sliderval" id="highpassVal"></span></label>
          <input id="highpass" type="range" min="0" max="200" step="5" value="85" />

          <div class="hint" id="gateHint" style="margin-top: 6px;"></div>

          <div id="vadSection">
            <div class="divider"></div>

            <label style="font-weight: bold; color: var(--accent);">Realtime (Deepgram Nova-3 on Workers AI)</label>
            <div class="hint">Live transcription runs on Deepgram Nova-3 via Cloudflare Workers AI (on the edge — no external hop). Accuracy is tuned via the Keyterms section below, sent as Nova-3 keyterms on every realtime dictation.</div>
          </div>

          <label class="checkbox">
            <input type="checkbox" id="noiseSuppress" />
            Browser noise suppression
          </label>

          <div id="batchOptsSection">
            <label class="checkbox">
              <input type="checkbox" id="tagEvents" />
              Tag audio events ((laughter), (cough), …) — batch transcription only
            </label>

            <label for="timestamps">Timestamps</label>
            <select id="timestamps">
              <option value="none" selected>none</option>
              <option value="word">word</option>
              <option value="character">character</option>
            </select>
          </div>

          <h3>How do these settings work?</h3>
          <p><strong>Local gate</strong>: in batch mode it decides what gets recorded and transcribed; in realtime/hybrid the feed to Scribe is ungated — the gate shapes only the saved preview. Use the Scribe filters to reject background speech.</p>
          <p><strong>Pause limit</strong>: higher (e.g. 2.0s) waits longer before finalizing a segment, giving the AI more context to fix grammar/spelling.</p>
          <p><strong>Noise filter</strong>: higher values ignore quiet hums, whispers, and background chatter.</p>
          <p><strong>Click filter</strong>: higher values stop brief clicks/rustling being read as speech.</p>
        </div>
      </details>

      <details class="help">
        <summary>Last recorded audio &amp; downloads</summary>
        <div class="body">
          <label>Last recorded audio (captured locally)</label>
          <audio id="audioPreview" controls style="width:100%; margin-bottom:10px;"></audio>
          <div class="row">
            <button id="downloadAudioBtn">Download audio</button>
            <button id="downloadBtn">Download transcripts .txt</button>
          </div>
        </div>
      </details>

      <div class="row" style="margin-top: 14px;">
        <button id="toggleHistoryBtn">Show saved transcripts</button>
        <button id="clearBtn">Clear history</button>
      </div>
      <div id="history" style="display:none;"></div>

      <div class="hint" style="margin-top: 14px;">
        English‑only, Scribe v2. Mic stays warm between dictations for instant start.
        Realtime/hybrid stream over a secure WebSocket through the Worker; batch uploads on release.
      </div>
    </section>
  </div>

  <!-- Big-button dictation layout: hidden unless body.bigbtn (see CSS).
       A fixed overlay — the normal page above stays untouched for desktops. -->
  <div id="bigUi" data-screen="idle">
    <div id="bigTopRow">
      <span id="bigJoinedBadge"></span>
      <button id="bigLeaveBtn">Leave</button>
      <button id="bigSettingsBtn" title="Engine, credentials, keyterms and all other settings">Settings</button>
    </div>
    <div id="bigCenter">
      <div id="bigState">READY</div>
      <button id="bigBtn">HOLD TO TALK</button>
      <div id="bigHint">hold = push‑to‑talk &middot; tap = start/stop</div>
      <div id="bigStatus"></div>
    </div>
    <div id="bigPeek">
      <div id="bigPeekBar">Latest transcript — tap to expand</div>
      <div id="bigPeekText"></div>
    </div>
  </div>
  <button id="bigReturnBtn">&#8592; Back to the button</button>
</main>

<script>
(() => {
  const SHARED_MODE      = (__SHARED_MODE__);
  // Deployer-curated keyterm lists (pre-sanitized), injected at serve time.
  const KEYTERM_PRESETS  = (__KEYTERM_PRESETS__);

  const apiKeyEl         = document.getElementById("apiKey");
  const apiKeyLabelEl    = document.getElementById("apiKeyLabel");
  const sonioxKeyEl     = document.getElementById("sonioxKey");
  const sonioxKeyLabelEl = document.getElementById("sonioxKeyLabel");
  const passphraseEl     = document.getElementById("passphrase");
  const passphraseRow    = document.getElementById("passphraseRow");
  const saveApiKeyEl     = document.getElementById("saveApiKey");
  const forgetKeyBtn     = document.getElementById("forgetKeyBtn");

  const recordBtn        = document.getElementById("recordBtn");
  const clearBtn         = document.getElementById("clearBtn");
  const copyBtn          = document.getElementById("copyBtn");
  const freshBtn         = document.getElementById("freshBtn");
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
  const tagEventsEl      = document.getElementById("tagEvents");
  const noVerbatimEl     = document.getElementById("noVerbatim");
  const autoCopyEl       = document.getElementById("autoCopy");
  const appendModeEl     = document.getElementById("appendMode");
  const noiseSuppressEl  = document.getElementById("noiseSuppress");
  const startBeepEl      = document.getElementById("startBeep");
  const stripNewlinesEl  = document.getElementById("stripNewlines");
  const stripEllipsesEl  = document.getElementById("stripEllipses");
  const trailingSpaceEl  = document.getElementById("trailingSpace");

  const gateOpenEl       = document.getElementById("gateOpen");
  const gateCloseEl      = document.getElementById("gateClose");
  const gateOpenValEl    = document.getElementById("gateOpenVal");
  const gateCloseValEl   = document.getElementById("gateCloseVal");
  const highpassEl       = document.getElementById("highpass");
  const highpassValEl    = document.getElementById("highpassVal");

  // Realtime tuning VAD elements

  const meterBar         = document.getElementById("meterBar");
  const openMark         = document.getElementById("openMark");
  const closeMark        = document.getElementById("closeMark");
  const gateStateEl      = document.getElementById("gateState");

  const appendWindowEl   = document.getElementById("appendWindow");
  const appendChipEl     = document.getElementById("appendChip");
  const micPillEl        = document.getElementById("micPill");
  const linkPillEl       = document.getElementById("linkPill");
  const advancedEl       = document.getElementById("advanced");
  const authSectionEl    = document.getElementById("authSection");
  const authSummaryEl    = document.getElementById("authSummary");
  const optionsSectionEl = document.getElementById("optionsSection");
  const keytermsSectionEl = document.getElementById("keytermsSection");
  const presetRowEl       = document.getElementById("presetRow");
  const hotkeyBtn        = document.getElementById("hotkeyBtn");
  const hotkeyResetBtn   = document.getElementById("hotkeyResetBtn");
  const engineSegEl      = document.getElementById("engineSeg");
  const engineHintEl     = document.getElementById("engineHint");
  const vadSectionEl     = document.getElementById("vadSection");
  const batchOptsSectionEl = document.getElementById("batchOptsSection");
  const gateHintEl       = document.getElementById("gateHint");

  // Phone mic session elements
  const phoneStartBtnEl  = document.getElementById("phoneStartBtn");
  const phoneStopBtnEl   = document.getElementById("phoneStopBtn");
  const phoneCodeBadgeEl = document.getElementById("phoneCodeBadge");
  const phoneCodeHintEl  = document.getElementById("phoneCodeHint");
  const phoneQrEl        = document.getElementById("phoneQr");
  const phoneJoinInputEl = document.getElementById("phoneJoinInput");
  const phoneJoinBtnEl   = document.getElementById("phoneJoinBtn");
  const phoneJoinBadgeEl = document.getElementById("phoneJoinBadge");
  const phoneLeaveBtnEl  = document.getElementById("phoneLeaveBtn");

  // Big-button dictation layout elements
  const bigUiEl          = document.getElementById("bigUi");
  const bigBtnEl         = document.getElementById("bigBtn");
  const bigStateEl       = document.getElementById("bigState");
  const bigStatusEl      = document.getElementById("bigStatus");
  const bigJoinedBadgeEl = document.getElementById("bigJoinedBadge");
  const bigLeaveBtnEl    = document.getElementById("bigLeaveBtn");
  const bigSettingsBtnEl = document.getElementById("bigSettingsBtn");
  const bigReturnBtnEl   = document.getElementById("bigReturnBtn");
  const bigPeekEl        = document.getElementById("bigPeek");
  const bigPeekBarEl     = document.getElementById("bigPeekBar");
  const bigPeekTextEl    = document.getElementById("bigPeekText");
  const bigButtonModeEl  = document.getElementById("bigButtonMode");

  let mediaRecorder = null;
  let chunks = [];
  let recording = false;
  let stopping = false;
  let stopRequested = false;
  let latestText = "";
  let lastAudioBlob = null;
  let lastAudioUrl = null;

  // Realtime Variables
  let ws = null;
  let finalizedSegments = [];
  let currentPartial = "";

  // Per-session flow state
  let sessionSeq = 0;          // bumps each recording; stale socket callbacks bail out
  let sessionFinalized = true;
  let userStopped = false;     // distinguishes clean PTT-release from unexpected disconnect
  let stopPhase = null;        // null | "tail" | "awaitFinal"
  let pendingStart = false;    // F13 pressed while previous session was finalizing
  let pendingStartTimer = null; // armed deferred start from maybePendingStart; cancellable until it fires
  let pendingChunks = [];      // base64 audio captured while the WebSocket is still connecting
  let prerollFrames = [];      // ring of raw idle frames; prepended at start so the first word survives
  let sessionPreviousText = ""; // tail of the note being appended to; rides the first chunk as context
  let firstChunkSent = false;  // previous_text may only accompany the FIRST chunk of a socket
  let lastWsError = "";
  let wsOpenAt = 0;
  let recStartedAt = 0;
  let partialCount = 0;
  let speechDetected = false;
  let maxRmsSeen = 0;
  let micAlarmFired = false;
  let sttAlarmFired = false;
  let mutedSince = 0;
  let lastFinalizeAt = 0;
  let connectTimer = null;
  let tailTimer = null;
  let finalDeadlineTimer = null;
  let quietTimer = null;

  // Phone mic session state
  let phoneSessionCode  = "";   // desktop: generated code for the active session
  let phoneSessionWs    = null; // desktop: WebSocket listening for phone transcripts
  let phonePingTimer    = null; // desktop: heartbeat interval while a session is active
  let phoneLastPongAt   = 0;    // desktop: last time the room socket proved it is alive
  let phoneReconnectTimer = null; // desktop: pending reconnect attempt
  let phoneReconnectDelayMs = 0;  // desktop: current reconnect backoff
  let phoneFallbackTimer = null;  // desktop: grace timer before live-text fallback delivery
  let lastDeliveryId    = "";   // desktop: dedupe replayed phone_delivery frames
  let pendingCopyText   = "";   // desktop: delivery whose clipboard write failed; retried on focus
  let joinedSessionCode = "";   // phone: code entered to join a desktop session
  let remoteCommitted   = "";   // desktop: accumulated committed text from phone
  let remoteHasDelivery = false; // desktop: phone_delivery received; suppress fallback

  // Big-button layout state. The screen indicator is DERIVED from the same
  // transitions that drive the status line and pills (recorded below) — the
  // layout adds no session machinery of its own.
  let lastStatusCls     = "";    // class of the most recent setStatus
  let lastMicPillState  = "off"; // most recent setMicPill state
  let lastLinkPillState = "idle"; // most recent setLinkPill state
  let bigBtnEngaged   = false;  // current button press started/queued a dictation
  let bigBtnDownAt    = 0;
  let bigBtnPointerId = null;   // owning pointer; other touches are ignored
  let bigPeekExpanded = false;

  // In-app push-to-talk hotkey (F13/F14 via AHK always work in addition)
  const DEFAULT_HOTKEY = { ctrl: true, alt: false, shift: false, meta: false, code: "Space" };
  let hotkey = Object.assign({}, DEFAULT_HOTKEY);
  let capturingHotkey = false;
  let hotkeyEngaged = false; // current press-cycle started/queued a dictation
  let hotkeyDownAt = 0;

  // Persistent audio nodes
  let stream = null;
  let audioCtx = null;
  let hpFilter = null;
  let analyserNode = null;
  let gateNode = null;
  let destNode = null;
  let recorderNode = null; // Frame pump: AudioWorklet (preferred) or ScriptProcessor (fallback)
  let sinkNode = null;     // Muted sink that keeps the pump node pulled by the graph
  let gateTimer = null;
  let gateBuf = null;
  let micEverGranted = false; // getUserMedia has succeeded this session (iOS has no Permissions API for the mic)
  let wakeLock = null;        // screen wake lock held per dictation: iOS auto-lock reclaims the mic
  let gateIsOpen = false;
  let gateLastOpen = 0;
  let lastMeterPct = -1;

  let historyVisible = false;
  let appendArmed = false; // one-shot: clicking the transcript box arms "append the next dictation"

  // Engine: which transcription path a dictation uses. The selector value is
  // snapshotted into sessionEngine at start, so switching mid-session only
  // affects the NEXT dictation.
  const DEFAULT_ENGINE = "batch";
  let engine = DEFAULT_ENGINE;
  let sessionEngine = DEFAULT_ENGINE;
  let sessionBaseText = "";  // note text this session appends onto (batch/hybrid splice into it)
  let finishing = false;     // a finalize is still uploading/refining; serializes sessions

  // Hybrid: every 16 kHz s16le frame produced for the realtime feed is also
  // captured here (pre-roll, while-connecting, live, tail — captured at the
  // point of production, so frames survive even if the socket never opens).
  // On finalize the buffer becomes a WAV for the batch re-transcription.
  let sessionPcm = [];
  let sessionPcmBytes = 0;
  let sessionPcmTruncated = false;

  const METER_MAX    = 0.12;
  const HOLD_SECONDS = 0.9;
  const DICTATION_SENTINEL = "##DICTATION_FAILED##";

  const CONNECT_TIMEOUT_MS = 5000;  // WebSocket must open within this or the dictation fails loudly
  const TAIL_MS            = 600;   // keep streaming audio this long after PTT release (anti-clipping)
  const FINAL_WAIT_MS      = 2500;  // max wait for the final committed transcript after commit
  const COMMIT_QUIET_MS    = 350;   // close this soon after the last committed transcript arrives
  const PENDING_CHUNK_CAP  = 400;   // ~35s of audio buffered while the socket connects
  const FLATLINE_RMS       = 0.0008; // below this for the whole session = mic is almost certainly dead
  const HOTKEY_TAP_MS      = 400;   // press shorter than this = tap (toggle); longer = hold (PTT)
  const PREROLL_MS         = 400;   // idle audio kept in memory and prepended at start (first-word rescue)
  const PREROLL_FRAME_CAP  = 12;    // hard cap on the pre-roll ring (~1s of frames)
  const PUMP_FRAME_SAMPLES = 4096;  // pump frame size (≈85ms at 48kHz) — matched the old ScriptProcessor so all downstream byte counts hold

  const BATCH_UPLOAD_TIMEOUT_MS = 30000; // pure batch: upload+transcription deadline
  const REFINE_TIMEOUT_MS       = 8000;  // hybrid refine deadline — live text is the fallback

  const SESSION_PCM_CAP_BYTES = 24 * 1024 * 1024; // ~12.5 min @ 32 KB/s; the batch API caps files at 25 MB
  const MIN_REFINE_BYTES      = 16000;            // ~0.5 s of audio; below this the refine is skipped

  // Phone link (desktop listener <-> session room)
  const PHONE_PING_INTERVAL_MS  = 25000; // heartbeat cadence on the listener socket
  const PHONE_PONG_TIMEOUT_MS   = 90000; // no room traffic for this long = zombie socket; force a reconnect (sized for background-tab timer throttling, ~1 tick/min)
  const PHONE_RECONNECT_MAX_MS  = 15000; // reconnect backoff cap
  const PHONE_FALLBACK_GRACE_MS = 10000; // after phone_session_end, wait this long for the authoritative phone_delivery (hybrid refine worst case) before falling back to live text
  const RELAY_TIMEOUT_MS        = 10000; // phone->room delivery ack deadline; a hung relay must fail loudly, and the queued next session waits on the ack

  // Per-API keyterm caps (the Worker re-enforces these server-side too)
  const REALTIME_KEYTERM_MAX_CHARS = 20;
  const REALTIME_KEYTERM_MAX_TERMS = 50;
  const BATCH_KEYTERM_MAX_CHARS    = 49;
  const BATCH_KEYTERM_MAX_TERMS    = 1000;

  const STORE_KEY              = "scribe_v2_transcripts_v9";
  const SETTINGS_KEY           = "scribe_v2_settings_v9";
  const API_KEY_STORAGE_KEY    = "elevenlabs_api_key_browser_v9";
  const SONIOX_KEY_STORAGE_KEY = "soniox_api_key_browser_v9";
  const PASSPHRASE_STORAGE_KEY = "scribe_v2_passphrase_v9";
  // The pre-merge batch app stored the shared access code under this key;
  // read it as a fallback so those users keep their saved code.
  const LEGACY_ACCESS_CODE_KEY = "scribe_v2_access_code_v9";

  /* ───── Audio cues ─────
     Beeps prefer the persistent (already running) AudioContext: a fresh
     AudioContext created while the tab is in the background often starts
     suspended and never sounds — exactly when you most need the cue. */
  // The desktop listener in a phone session never records, so audioCtx may not
  // exist when its cues must sound — beepCtx is warmed from the session-start
  // click (a user gesture) so those beeps stay audible in a background tab.
  let beepCtx = null;
  function warmBeepCtx() {
    try {
      if (!beepCtx) beepCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (beepCtx.state !== "running") beepCtx.resume();
    } catch (e) {}
  }

  function beep(freq, ms, when) {
    try {
      const reuse = (audioCtx && audioCtx.state === "running") ? audioCtx
                  : (beepCtx && beepCtx.state === "running") ? beepCtx : null;
      const ctx = reuse || new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.06;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime + (when || 0);
      osc.start(t0);
      osc.stop(t0 + ms / 1000);
      if (!reuse) setTimeout(() => ctx.close(), ((when || 0) + ms / 1000) * 1000 + 60);
    } catch (e) {}
  }

  // Haptics mirror the beep vocabulary where the device supports it. They
  // ride inside the beep functions so every call site gets both for free —
  // a vibration never replaces a sound, it accompanies it.
  function haptic(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
  }

  // Start/done cues respect the checkbox; failure sounds always play.
  function startBeep() { if (startBeepEl.checked) { beep(760, 130); haptic(30); } }
  function doneBeep()  { if (startBeepEl.checked) { beep(1046, 90, 0); beep(1568, 130, 0.10); haptic([40, 60, 40]); } }
  function failBeep()  { beep(300, 280); haptic([220, 90, 220]); }
  function micAlarmBeep() { beep(330, 170, 0); beep(280, 170, 0.22); beep(240, 260, 0.44); haptic([250, 100, 250, 100, 250]); }
  // Two-tone warn: degraded-but-usable outcomes (e.g. hybrid refine failed,
  // live text delivered instead). Always audible, like failBeep.
  function warnBeep()  { beep(520, 140, 0); beep(520, 140, 0.20); haptic([90, 90, 90]); }

  /* ───── Audio Downsampling & Float conversion helpers ───── */
  function downsampleBuffer(buffer, inputSampleRate, outputSampleRate) {
    if (inputSampleRate === outputSampleRate) return buffer;
    const sampleRateRatio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Float32Array(newLength);
    let offsetResult = 0;
    let offsetInput = 0;
    while (offsetResult < result.length) {
      const nextOffsetInput = Math.round((offsetResult + 1) * sampleRateRatio);
      let accum = 0, count = 0;
      for (let i = offsetInput; i < nextOffsetInput && i < buffer.length; i++) {
        accum += buffer[i];
        count++;
      }
      result[offsetResult] = count > 0 ? accum / count : 0;
      offsetResult++;
      offsetInput = nextOffsetInput;
    }
    return result;
  }

  // Converts float values to 16-bit signed PCM
  function floatTo16BitPCM(input) {
    const output = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) {
      const s = Math.max(-1, Math.min(1, input[i]));
      output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return output.buffer;
  }

  function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
  }

  // Hybrid capture chokepoint: called exactly once per produced frame, at the
  // point of production (audio pump + pre-roll build) — never in the socket
  // send paths, so buffered-then-dropped frames are still captured and
  // nothing is ever captured twice.
  function capturePcm(buf) {
    if (sessionEngine !== "hybrid") return;
    if (sessionPcmBytes + buf.byteLength > SESSION_PCM_CAP_BYTES) {
      sessionPcmTruncated = true;
      return;
    }
    sessionPcm.push(buf);
    sessionPcmBytes += buf.byteLength;
  }

  // Wrap raw s16le PCM in a 44-byte RIFF/WAVE header: the batch engine gets
  // bit-identical audio to what the realtime engine heard, including the
  // pre-roll that no MediaRecorder could have captured.
  function buildWavBlob(buffers, sampleRate) {
    let dataLen = 0;
    for (const b of buffers) dataLen += b.byteLength;
    const header = new ArrayBuffer(44);
    const v = new DataView(header);
    const writeStr = (off, s) => {
      for (let i = 0; i < s.length; i++) v.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, "RIFF");
    v.setUint32(4, 36 + dataLen, true);
    writeStr(8, "WAVE");
    writeStr(12, "fmt ");
    v.setUint32(16, 16, true);             // fmt chunk size
    v.setUint16(20, 1, true);              // PCM
    v.setUint16(22, 1, true);              // mono
    v.setUint32(24, sampleRate, true);
    v.setUint32(28, sampleRate * 2, true); // byte rate (16-bit mono)
    v.setUint16(32, 2, true);              // block align
    v.setUint16(34, 16, true);             // bits per sample
    writeStr(36, "data");
    v.setUint32(40, dataLen, true);
    return new Blob([header].concat(buffers), { type: "audio/wav" });
  }

  /* ───── Text processing ───── */
  function cleanTranscript(raw) {
    let t = raw;
    if (stripEllipsesEl.checked) {
      // Scribe renders dictation pauses as ellipses; strip both forms.
      t = t.replace(/\\u2026/g, " ").replace(/\\.{3,}/g, " ");
    }
    if (stripNewlinesEl.checked) {
      t = t.replace(/[\\r\\n]+/g, " ");
    }
    t = t.replace(/ +/g, " ").trim();
    t = t.replace(/ ([,.;:!?])/g, "$1");
    if (trailingSpaceEl.checked && t.length > 0) t += " ";
    return t;
  }

  function updateLiveDisplay() {
    const combined = finalizedSegments.join(" ") + (currentPartial ? " " + currentPartial : "");
    const cleaned = cleanTranscript(combined);
    latestText = cleaned;
    latestEl.textContent = cleaned;
    updateBigPeek();
  }

  function setStatus(msg, cls) {
    statusEl.className = "status " + (cls || "");
    statusEl.textContent = msg;
    lastStatusCls = cls || "";
    updateBigScreen();
  }

  function setMicPill(state) {
    // state: "off" | "ready" | "rec" | "fail"
    lastMicPillState = state;
    if (state === "rec")        { micPillEl.textContent = "REC";       micPillEl.className = "pill rec"; }
    else if (state === "ready") { micPillEl.textContent = "mic ready"; micPillEl.className = "pill ok"; }
    else if (state === "fail")  { micPillEl.textContent = "MIC FAIL";  micPillEl.className = "pill fail"; }
    else                        { micPillEl.textContent = "mic off";   micPillEl.className = "pill"; }
    updateBigScreen();
  }

  function setLinkPill(state) {
    // state: "idle" | "connecting" | "live" | "fail" | "uploading" | "refining"
    lastLinkPillState = state;
    if (state === "live")            { linkPillEl.textContent = "LIVE";        linkPillEl.className = "pill live"; }
    else if (state === "connecting") { linkPillEl.textContent = "connecting…"; linkPillEl.className = "pill warn"; }
    else if (state === "uploading")  { linkPillEl.textContent = "uploading…";  linkPillEl.className = "pill warn"; }
    else if (state === "refining")   { linkPillEl.textContent = "refining…";   linkPillEl.className = "pill warn"; }
    else if (state === "fail")       { linkPillEl.textContent = "LINK FAIL";   linkPillEl.className = "pill fail"; }
    else                             { linkPillEl.textContent = "link idle";   linkPillEl.className = "pill"; }
    updateBigScreen();
  }

  function updateAppendChip() {
    const hasText = Boolean(latestText && latestText.trim());
    if (!hasText) appendArmed = false; // nothing left to append to
    latestEl.classList.toggle("armed", appendArmed && !recording);
    updateBigPeek(); // big layout mirrors the text + armed state (1s interval keeps it honest)
    if (!hasText || recording) {
      appendChipEl.style.display = "none";
      return;
    }
    if (appendArmed) {
      // One-shot arm from clicking the box — beats the checkbox/window.
      appendChipEl.style.display = "";
      appendChipEl.textContent = "next dictation appends (box clicked)";
      appendChipEl.className = "pill ok";
      return;
    }
    if (!appendModeEl.checked) {
      appendChipEl.style.display = "none";
      return;
    }
    appendChipEl.style.display = "";
    const w = Number(appendWindowEl.value) || 0;
    if (w > 0 && lastFinalizeAt) {
      const remain = Math.ceil((lastFinalizeAt + w * 1000 - Date.now()) / 1000);
      if (remain <= 0) {
        appendChipEl.textContent = "next dictation starts fresh";
        appendChipEl.className = "pill";
      } else {
        appendChipEl.textContent = "next dictation appends (" + remain + "s)";
        appendChipEl.className = "pill ok";
      }
    } else {
      appendChipEl.textContent = "next dictation appends";
      appendChipEl.className = "pill ok";
    }
  }

  /* ───── Engine selector ───── */
  const ENGINE_HINTS = {
    realtime: "Live: text streams onto the screen as you speak and is what lands on the clipboard.",
    batch: "Batch: audio uploads after release — the noise gate decides what gets transcribed. No live text.",
    hybrid: "Hybrid: live text is feedback while you speak; the same audio is re-transcribed by the stronger batch model and THAT lands on the clipboard.",
  };

  function applyEngineUI() {
    if (engineSegEl) {
      const btns = engineSegEl.querySelectorAll("button");
      for (const b of btns) {
        b.className = b.getAttribute("data-engine") === engine ? "active" : "";
      }
    }
    if (engineHintEl) engineHintEl.textContent = ENGINE_HINTS[engine] || "";

    // Per-engine controls: VAD sliders steer the realtime feed; tag-events and
    // timestamp granularity ride the batch API call.
    if (vadSectionEl) vadSectionEl.style.display = engine !== "batch" ? "" : "none";
    if (batchOptsSectionEl) batchOptsSectionEl.style.display = engine !== "realtime" ? "" : "none";

    if (gateHintEl) {
      gateHintEl.textContent = engine === "batch"
        ? "Batch: the gate IS the recording — only audio loud enough to open it gets transcribed."
        : "The live feed to Scribe is ungated; the gate shapes only the saved audio preview.";
    }
    if (gateStateEl) {
      gateStateEl.title = engine === "batch"
        ? "Local noise gate state (decides what gets recorded and transcribed in batch mode)"
        : "Local noise gate state (affects the saved audio preview only)";
    }
  }

  function setEngine(val) {
    if (val !== "realtime" && val !== "batch" && val !== "hybrid") return;
    engine = val;
    applyEngineUI();
    saveSettings();
  }

  /* ───── Access section (API key / passphrase) ─────
     Collapses once credentials exist so the working UI stays compact;
     reopens whenever credentials are missing or forgotten. */
  function hasAuth() {
    if (apiKeyEl.value.trim()) return true;
    if (sonioxKeyEl && sonioxKeyEl.value.trim()) return true;
    return Boolean(SHARED_MODE && passphraseEl.value.trim());
  }

  function updateAuthUI() {
    if (!authSummaryEl) return;
    if (apiKeyEl.value.trim() || (sonioxKeyEl && sonioxKeyEl.value.trim())) {
      authSummaryEl.textContent = "Access — API key set ✓";
    } else if (SHARED_MODE && passphraseEl.value.trim()) {
      authSummaryEl.textContent = "Access — passphrase set ✓";
    } else {
      authSummaryEl.textContent = SHARED_MODE
        ? "Access — enter the passphrase"
        : "Access — enter your API key";
    }
  }

  /* ───── Configurable push-to-talk hotkey ───── */
  function hotkeyLabel(hk) {
    if (!hk || !hk.code) return "none";
    const parts = [];
    if (hk.ctrl)  parts.push("Ctrl");
    if (hk.alt)   parts.push("Alt");
    if (hk.shift) parts.push("Shift");
    if (hk.meta)  parts.push("Win");
    let k = hk.code;
    if (k.indexOf("Key") === 0) k = k.slice(3);
    else if (k.indexOf("Digit") === 0) k = k.slice(5);
    parts.push(k);
    return parts.join(" + ");
  }

  function hotkeyMatches(e) {
    if (!hotkey || !hotkey.code) return false;
    return e.code === hotkey.code &&
           e.ctrlKey  === !!hotkey.ctrl &&
           e.altKey   === !!hotkey.alt &&
           e.shiftKey === !!hotkey.shift &&
           e.metaKey  === !!hotkey.meta;
  }

  function updateHotkeyUI() {
    hotkeyBtn.textContent = capturingHotkey ? "press a key combo… (Esc cancels)" : hotkeyLabel(hotkey);
  }

  // Parses the custom-terms textarea; each call site filters to what its API
  // accepts (realtime: 50 terms <= 20 chars; batch: 1000 terms < 50 chars).
  // Call sites send effectiveKeyterms(), which merges the presets in.
  function parseKeyterms(raw, maxChars, maxTerms) {
    return raw
      .split(/[\\r\\n]+/)
      .map((s) => s.trim().replace(/\\s+/g, " ").replace(/[<>{}\\[\\]\\\\]/g, ""))
      .filter(Boolean)
      .filter((s) => s.length <= maxChars && s.split(" ").length <= 5)
      .slice(0, maxTerms);
  }

  // Preset checkboxes, rendered from the injected KEYTERM_PRESETS at boot —
  // before loadSettings, which re-checks the persisted ones.
  const presetInputs = {}; // preset id -> its checkbox input

  function renderPresetRow() {
    if (!presetRowEl || !Array.isArray(KEYTERM_PRESETS)) return;
    for (const p of KEYTERM_PRESETS) {
      if (p.always) continue; // always-on lists never render — they just apply
      const lab = document.createElement("label");
      lab.className = "checkbox";
      lab.title = p.terms.join(", "); // hover shows what the list biases toward
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("data-preset", p.id);
      cb.addEventListener("change", () => { updateKeytermHint(); saveSettings(); });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(p.label + " (" + p.terms.length + " terms)"));
      presetRowEl.appendChild(lab);
      presetInputs[p.id] = cb;
    }
  }

  // Effective keyterms for one API call: custom terms, then checked presets,
  // then the always-on lists — deduped case-insensitively, capped per API.
  // The order IS the trim priority when the realtime 50-term cap overflows;
  // batch (1000) effectively never trims, so in batch/hybrid the clipboard
  // text benefits from every list even when the live feed had to drop some.
  function effectiveKeyterms(maxChars, maxTerms) {
    const out = [];
    const seen = {};
    const push = (t) => {
      if (typeof t !== "string" || !t) return;
      if (t.length > maxChars || t.split(" ").length > 5) return;
      const k = t.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push(t);
    };
    for (const t of parseKeyterms(keytermsEl.value, maxChars, Infinity)) push(t);
    for (const p of KEYTERM_PRESETS) {
      if (!p.always && presetInputs[p.id] && presetInputs[p.id].checked) {
        for (const t of p.terms) push(t);
      }
    }
    for (const p of KEYTERM_PRESETS) {
      if (p.always) { for (const t of p.terms) push(t); }
    }
    return out.slice(0, maxTerms);
  }

  function updateKeytermHint() {
    let alwaysCount = 0;
    for (const p of KEYTERM_PRESETS) { if (p.always) alwaysCount += p.terms.length; }
    const rtAll = effectiveKeyterms(REALTIME_KEYTERM_MAX_CHARS, Infinity).length;
    const rt = Math.min(rtAll, REALTIME_KEYTERM_MAX_TERMS);
    const bt = effectiveKeyterms(BATCH_KEYTERM_MAX_CHARS, BATCH_KEYTERM_MAX_TERMS).length;
    keytermHintEl.innerHTML =
      "Scribe biases toward these terms (one per line) plus the checked lists" +
      (alwaysCount ? " and " + alwaysCount + " always-on standard terms" : "") + ". " +
      "<strong>Keyterms add ~20 % to cost.</strong> " +
      "Realtime sends " + rt + " / 50 (each &lt;= 20 chars" +
      (rtAll > REALTIME_KEYTERM_MAX_TERMS
        ? "; over the cap your terms win, then presets, then standard" : "") +
      "); batch sends " + bt + " / 1000 (each &lt; 50 chars).";
  }

  /* ───── Gate UI ───── */
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
    gateStateEl.className  = isOpen ? "pill open" : "pill";
  }

  /* ───── Storage / Persistence ───── */
  let saveTimer = null;
  function saveSettings() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSettingsNow, 250);
  }

  function saveSettingsNow() {
    const s = {
      engine:         engine,
      keyterms:       keytermsEl.value,
      presetIds:      Object.keys(presetInputs).filter((id) => presetInputs[id].checked),
      timestamps:     timestampsEl.value,
      tagEvents:      tagEventsEl.checked,
      noVerbatim:     noVerbatimEl.checked,
      autoCopy:       autoCopyEl.checked,
      appendMode:     appendModeEl.checked,
      saveApiKey:     saveApiKeyEl.checked,
      noiseSuppress:  noiseSuppressEl.checked,
      startBeep:      startBeepEl.checked,
      stripNewlines:  stripNewlinesEl.checked,
      stripEllipses:  stripEllipsesEl.checked,
      trailingSpace:  trailingSpaceEl.checked,
      gateOpen:       gateOpenEl.value,
      gateClose:       gateCloseEl.value,
      highpass:       highpassEl.value,
      appendWindow:   appendWindowEl.value,
      advancedOpen:   Boolean(advancedEl && advancedEl.open),
      optionsOpen:    Boolean(optionsSectionEl && optionsSectionEl.open),
      keytermsOpen:   Boolean(keytermsSectionEl && keytermsSectionEl.open),
      hotkey:         hotkey,
      historyVisible: historyVisible,
      // Phone link: survive reloads/PWA kills — the desktop resumes its room,
      // the phone rejoins automatically, and replay dedupe survives the reload.
      phoneSessionCode:  phoneSessionCode,
      joinedSessionCode: joinedSessionCode,
      lastDeliveryId:    lastDeliveryId,
      // iOS has no Permissions API for the mic; persisting the grant is what
      // lets a relaunched PWA re-warm the mic at boot instead of staying cold.
      micGranted:        micEverGranted,
      // Big-button layout override — a PER-DEVICE setting by design (the
      // portable/per-device settings split planned in the roadmap): a phone
      // forced to "always" must not drag a desktop sharing its profile along.
      bigButtonMode:     bigButtonModeEl ? bigButtonModeEl.value : "joined",
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));

    if (saveApiKeyEl.checked) {
      localStorage.setItem(API_KEY_STORAGE_KEY, apiKeyEl.value.trim());
      if (sonioxKeyEl) localStorage.setItem(SONIOX_KEY_STORAGE_KEY, sonioxKeyEl.value.trim());
      if (passphraseEl) localStorage.setItem(PASSPHRASE_STORAGE_KEY, passphraseEl.value.trim());
    } else {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
      localStorage.removeItem(SONIOX_KEY_STORAGE_KEY);
      localStorage.removeItem(PASSPHRASE_STORAGE_KEY);
      localStorage.removeItem(LEGACY_ACCESS_CODE_KEY);
    }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      if (s.engine === "realtime" || s.engine === "batch" || s.engine === "hybrid") engine = s.engine;
      if (s.keyterms) keytermsEl.value = s.keyterms;
      if (Array.isArray(s.presetIds)) {
        // Unknown ids (a preset later renamed/removed) are ignored harmlessly.
        for (const id of s.presetIds) {
          if (presetInputs[id]) presetInputs[id].checked = true;
        }
      }
      if (s.timestamps) timestampsEl.value = s.timestamps;
      if (typeof s.tagEvents     === "boolean") tagEventsEl.checked     = s.tagEvents;
      if (typeof s.noVerbatim    === "boolean") noVerbatimEl.checked    = s.noVerbatim;
      if (typeof s.autoCopy      === "boolean") autoCopyEl.checked      = s.autoCopy;
      if (typeof s.appendMode    === "boolean") appendModeEl.checked    = s.appendMode;
      if (typeof s.saveApiKey    === "boolean") saveApiKeyEl.checked    = s.saveApiKey;
      if (typeof s.noiseSuppress === "boolean") noiseSuppressEl.checked = s.noiseSuppress;
      if (typeof s.startBeep     === "boolean") startBeepEl.checked     = s.startBeep;
      if (typeof s.stripNewlines === "boolean") stripNewlinesEl.checked = s.stripNewlines;
      if (typeof s.stripEllipses === "boolean") stripEllipsesEl.checked = s.stripEllipses;
      if (typeof s.trailingSpace === "boolean") trailingSpaceEl.checked = s.trailingSpace;
      if (s.gateOpen  !== undefined) gateOpenEl.value  = s.gateOpen;
      if (s.gateClose !== undefined) gateCloseEl.value = s.gateClose;
      if (s.highpass  !== undefined) highpassEl.value  = s.highpass;
      if (s.appendWindow !== undefined) appendWindowEl.value = s.appendWindow;
      if (typeof s.advancedOpen === "boolean" && advancedEl) advancedEl.open = s.advancedOpen;
      if (typeof s.optionsOpen === "boolean" && optionsSectionEl) optionsSectionEl.open = s.optionsOpen;
      if (typeof s.keytermsOpen === "boolean" && keytermsSectionEl) keytermsSectionEl.open = s.keytermsOpen;
      if (s.hotkey && typeof s.hotkey.code === "string" && s.hotkey.code) {
        hotkey = {
          ctrl:  !!s.hotkey.ctrl,
          alt:   !!s.hotkey.alt,
          shift: !!s.hotkey.shift,
          meta:  !!s.hotkey.meta,
          code:  s.hotkey.code,
        };
      }
      if (typeof s.historyVisible === "boolean") historyVisible = s.historyVisible;
      if (typeof s.phoneSessionCode  === "string") phoneSessionCode  = s.phoneSessionCode;
      if (typeof s.joinedSessionCode === "string") joinedSessionCode = s.joinedSessionCode;
      if (typeof s.lastDeliveryId    === "string") lastDeliveryId    = s.lastDeliveryId;
      if (s.micGranted === true) micEverGranted = true;
      if (bigButtonModeEl && (s.bigButtonMode === "joined" || s.bigButtonMode === "always" || s.bigButtonMode === "never")) {
        bigButtonModeEl.value = s.bigButtonMode;
      }

      if (saveApiKeyEl.checked) {
        const k = localStorage.getItem(API_KEY_STORAGE_KEY);
        if (k) apiKeyEl.value = k;
        const mk = localStorage.getItem(SONIOX_KEY_STORAGE_KEY);
        if (mk && sonioxKeyEl) sonioxKeyEl.value = mk;
        const p = localStorage.getItem(PASSPHRASE_STORAGE_KEY) ||
                  localStorage.getItem(LEGACY_ACCESS_CODE_KEY);
        if (p && passphraseEl) passphraseEl.value = p;
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
      if (meta.engine) entry.engine = meta.engine;
      if (meta.liveText) entry.liveText = meta.liveText; // hybrid: the realtime rendering, kept for comparison
    }
    items.unshift(entry);
    setHistory(items);
  }

  // Boot restore: show the most recent saved transcript instead of an empty
  // box, and adopt its finalize time so the append window keeps working
  // across reloads. The restored note clears like any other when the next
  // session starts fresh, and click-to-append can extend it.
  function restoreLatestFromHistory() {
    const items = getHistory();
    if (!items.length || !items[0].text || !items[0].text.trim()) return;
    finalizedSegments = [items[0].text.trim()];
    currentPartial = "";
    const t = Date.parse(items[0].createdAt || "");
    if (!isNaN(t)) lastFinalizeAt = t;
    updateLiveDisplay();
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
      meta.textContent = new Date(item.createdAt).toLocaleString() +
        (item.engine ? " · " + item.engine : "");

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
    } catch (e) { }
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

  async function writeSentinel() {
    await clipboardWrite(DICTATION_SENTINEL);
  }

  /* ───── Batch transcription call (pure batch mode + hybrid refine) ───── */
  async function batchTranscribe(blob, fileName, timeoutMs) {
    const form = new FormData();
    const apiKey = apiKeyEl.value.trim();
    if (apiKey) form.append("api_key", apiKey);
    if (SHARED_MODE) form.append("passphrase", passphraseEl.value.trim());
    form.append("file", blob, fileName);
    form.append("file_format", "other");
    form.append("timestamps_granularity", timestampsEl.value);
    form.append("no_verbatim", String(noVerbatimEl.checked));
    form.append("tag_audio_events", String(tagEventsEl.checked));
    form.append("keyterms_json", JSON.stringify(
      effectiveKeyterms(BATCH_KEYTERM_MAX_CHARS, BATCH_KEYTERM_MAX_TERMS)
    ));

    const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const killer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs) : null;

    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        body: form,
        signal: ctrl ? ctrl.signal : undefined,
      });
      const raw = await res.text();
      let data;
      try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; }

      if (!res.ok) {
        const msg = (data && data.detail && data.detail.message) ||
                    (data && data.message) ||
                    (data && data.error) ||
                    raw || "transcription request failed";
        return { ok: false, text: "", error: String(msg) };
      }
      return { ok: true, text: String(data.text || data.transcript || ""), error: "" };
    } catch (err) {
      const aborted = err && err.name === "AbortError";
      return {
        ok: false,
        text: "",
        error: aborted
          ? "timed out after " + Math.round(timeoutMs / 1000) + "s"
          : (err && err.message ? err.message : String(err)),
      };
    } finally {
      if (killer) clearTimeout(killer);
    }
  }

  /* ───── Real-time Audio Graph (mic → highpass → gate → script processor) ───── */
  // Screen wake lock: held from session start to delivery so iOS auto-lock
  // cannot reclaim the mic mid-dictation or suspend the page mid-upload/refine.
  // Unsupported/denied is fine — everything else still works.
  async function acquireWakeLock() {
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch (e) {}
  }
  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }

  function audioGraphHealthy() {
    // A stale graph (e.g. restored from bfcache, device unplugged, tab slept)
    // can leave all variables set while the track is silently dead. Validate
    // the actual track so reopening the app reliably re-engages the mic.
    if (!stream || !audioCtx || audioCtx.state === "closed" || !destNode || !recorderNode) return false;
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState !== "live") return false;
    // iOS interruptions (screen lock, Siri, calls) leave the track "live" but
    // permanently muted — that is a dead mic, rebuild from scratch.
    if (track.muted) return false;
    return true;
  }

  async function ensureAudio() {
    if (audioGraphHealthy()) {
      if (audioCtx.state === "suspended") {
        try { await audioCtx.resume(); } catch (e) {}
      }
      if (audioCtx.state === "running") {
        setMicPill(recording ? "rec" : "ready");
        return true;
      }
      // Context exists but will not run — fall through and rebuild from scratch.
    }

    releaseAudio();

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: noiseSuppressEl.checked,
        autoGainControl: false,
        sampleRate: 48000,
      },
    });
    if (!micEverGranted) {
      micEverGranted = true; // enables the iOS re-warm fallback in tryWarmOnLoad
      saveSettingsNow();     // persisted (micGranted): a relaunched iOS PWA re-warms at boot
    }

    const micTrack = stream.getAudioTracks()[0];
    if (micTrack) {
      micTrack.addEventListener("mute", () => {
        // iOS interruptions (Siri, calls, app switches) mute the track without
        // ending it. Mid-dictation the watchdog handles it loudly; while idle,
        // self-heal so the next dictation does not start on a dead mic. The
        // delay lets transient mutes (iOS often unmutes on its own) pass.
        if (recording || stopping) return;
        setTimeout(() => {
          if (!recording && !stopping && !audioGraphHealthy() &&
              document.visibilityState === "visible") {
            releaseAudio();
            tryWarmOnLoad();
          }
        }, 1200);
      });
      micTrack.addEventListener("ended", () => {
        // OS/device revoked the mic (sleep, unplug, Citrix audio drop).
        if (recording && !sessionFinalized) {
          micAlarmFired = true;
          setMicPill("fail");
          micAlarmBeep();
          setStatus("⚠ Microphone was disconnected mid-dictation — check the device before trusting this text.", "err");
        } else {
          setMicPill("off");
        }
      });
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch (e) {}
    }
    // Diagnostic (one-time): the context takes NO sampleRate option, so
    // audioCtx.sampleRate is the true hardware rate that downsampleBuffer reads.
    // A non-48000 rate (e.g. 44100) still downsamples correctly to 16k, but
    // surface it once so a stealth hardware-rate surprise is never invisible.
    if (!window.__srLogged) {
      window.__srLogged = true;
      try {
        var msg = "[audio] AudioContext sampleRate = " + audioCtx.sampleRate + " Hz (downsampling to 16000)";
        if (audioCtx.sampleRate !== 48000) console.warn(msg + " — not 48000; verify capture"); else console.log(msg);
      } catch (e) {}
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

    sinkNode = audioCtx.createGain();
    sinkNode.gain.value = 0;

    source.connect(hpFilter);
    hpFilter.connect(analyserNode);

    // STT FEED: pre-gate (raw, high-passed) audio -> the realtime pump. Prefer an
    // AudioWorklet: its processor runs on the audio render thread, so main-thread
    // load (UI, the 30 ms gate meter, live DOM, the big-button screen) cannot
    // starve it. The deprecated ScriptProcessorNode ran ON the main thread and on
    // phones dropped buffers under that load — starving Soniox into slow, sparse
    // transcripts (batch was immune: it records off-thread via MediaRecorder).
    // ScriptProcessor stays as the fallback so the capture path is never silently
    // lost if the worklet cannot load.
    recorderNode = await buildPumpNode();
    hpFilter.connect(recorderNode);
    recorderNode.connect(sinkNode);
    sinkNode.connect(audioCtx.destination);

    // LOCAL RECORDING ONLY: keep the noise gate on the playback file.
    hpFilter.connect(gateNode);
    gateNode.connect(destNode);

    gateBuf = new Float32Array(analyserNode.fftSize);
    gateIsOpen = false;
    gateLastOpen = 0;
    lastMeterPct = -1;
    setGateStateUI(false);

    // The frame pump (worklet or ScriptProcessor) is wired in buildPumpNode and
    // delivers each captured frame to handleAudioFrame.

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

      // Recording health watchdog: catch the "dictated into a dead mic"
      // disaster while it is happening, not after.
      if (recording && !stopping) {
        const nowMs = Date.now();
        if (rms > maxRmsSeen) maxRmsSeen = rms;
        if (rms > openT) speechDetected = true;

        const track = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
        const trackDead = !track || track.readyState !== "live";
        if (track && track.muted) {
          if (!mutedSince) mutedSince = nowMs;
        } else {
          mutedSince = 0;
        }

        if (!micAlarmFired) {
          const flatline = nowMs - recStartedAt > 2500 && maxRmsSeen < FLATLINE_RMS;
          const mutedLong = mutedSince && nowMs - mutedSince > 1500;
          if (trackDead || mutedLong || flatline) {
            micAlarmFired = true;
            setMicPill("fail");
            micAlarmBeep();
            setStatus("⚠ MIC NOT CAPTURING — no audio signal detected. Stop, check the microphone, then redictate.", "err");
          }
        }

        if (!sttAlarmFired && speechDetected && wsOpenAt &&
            nowMs - wsOpenAt > 8000 && partialCount === 0) {
          sttAlarmFired = true;
          warnBeep();
          setStatus("⚠ Audio is flowing but no text is coming back — the transcription service may be down.", "warn");
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
    gateNode = null; destNode = null; recorderNode = null; sinkNode = null; gateBuf = null; gateIsOpen = false;
    lastMeterPct = -1;
    meterBar.style.width = "0%";
    setGateStateUI(false);
    setMicPill("off");
  }

  async function tryWarmOnLoad() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: "microphone" });
        if (st.state === "granted") warmWithRetry(0);
        return;
      }
    } catch (e) {}
    // iOS Safari has no Permissions API entry for the microphone — the query
    // above throws, which used to make every re-warm path a silent no-op on
    // iOS. If this device held the mic before (micEverGranted persists as the
    // micGranted settings field, so PWA relaunches count), re-acquiring is
    // prompt-free — re-warm anyway: iOS interruptions routinely kill the
    // track while the page is hidden, and this is what re-engages it.
    if (micEverGranted) warmWithRetry(0);
  }

  // iOS hands the audio session back late after foregrounding: a getUserMedia
  // issued immediately on return can fail and then succeed moments later. A
  // single silent attempt leaves a cold mic until the next manual press, so
  // retry on a short backoff before giving up (loudly).
  let warmRetryTimer = null;
  function warmWithRetry(attempt) {
    if (recording || stopping) return;
    if (warmRetryTimer) { clearTimeout(warmRetryTimer); warmRetryTimer = null; }
    ensureAudio().catch(() => {
      if (attempt >= 2) {
        if (micEverGranted) setStatus("Microphone did not re-engage after returning — tap Start and it will reconnect.", "warn");
        return;
      }
      warmRetryTimer = setTimeout(() => {
        warmRetryTimer = null;
        if (document.visibilityState === "visible") warmWithRetry(attempt + 1);
      }, attempt === 0 ? 700 : 2000);
    });
  }

  /* ───── Stream Audio & Run WebSocket Session ───── */
  function clearSessionTimers() {
    if (connectTimer)       { clearTimeout(connectTimer);       connectTimer = null; }
    if (tailTimer)          { clearTimeout(tailTimer);          tailTimer = null; }
    if (finalDeadlineTimer) { clearTimeout(finalDeadlineTimer); finalDeadlineTimer = null; }
    if (quietTimer)         { clearTimeout(quietTimer);         quietTimer = null; }
  }

  // One captured frame (an owned Float32Array of PUMP_FRAME_SAMPLES, from the
  // worklet's port or the ScriptProcessor fallback). Idle frames feed the
  // pre-roll ring (first-word rescue); live frames downsample -> s16le PCM ->
  // capturePcm (the hybrid refine's exact copy) -> stream. Keeps streaming
  // through the post-release "tail" phase so the last word is not clipped, and
  // buffers chunks while the WebSocket is still connecting so the first word is
  // not lost either.
  function handleAudioFrame(floatSamples) {
    const live = recording && (!stopping || stopPhase === "tail") && ws;
    if (!live) {
      // Idle: keep a short pre-roll ring so the first word — often spoken the
      // instant the key lands, before the session is armed — survives. Held in
      // memory only; sent only if a dictation starts within PREROLL_MS,
      // discarded otherwise. Never-sent frames can't double-transcribe.
      prerollFrames.push({
        t: Date.now(),
        rate: audioCtx ? audioCtx.sampleRate : 48000,
        samples: floatSamples,
      });
      while (prerollFrames.length > PREROLL_FRAME_CAP) prerollFrames.shift();
      return;
    }

    const downsampled = downsampleBuffer(floatSamples, audioCtx.sampleRate, 16000);
    const pcmBuffer = floatTo16BitPCM(downsampled);
    capturePcm(pcmBuffer); // hybrid: keep the exact frame for the batch refine
    const base64Audio = arrayBufferToBase64(pcmBuffer);

    if (ws.readyState === WebSocket.OPEN) {
      flushPendingChunks();
      sendAudioChunk(base64Audio, false);
    } else if (ws.readyState === WebSocket.CONNECTING && pendingChunks.length < PENDING_CHUNK_CAP) {
      pendingChunks.push(base64Audio);
    }
  }

  // The AudioWorklet processor source. It buffers the 128-sample render quanta
  // into PUMP_FRAME_SAMPLES-sized frames (same size the ScriptProcessor used, so
  // every downstream byte count — capturePcm, MIN_REFINE_BYTES — is unchanged)
  // and posts each as an owned (transferred) copy to the main thread. Buffering
  // ON the render thread is the fix: frames are captured even while the main
  // thread is busy (postMessage queues; audio is never dropped). Loaded from a
  // Blob URL so the no-build-step / single-file constraint holds.
  let workletUrl = null;
  function getWorkletUrl() {
    if (workletUrl) return workletUrl;
    const src =
      "class PcmPump extends AudioWorkletProcessor {" +
      "constructor(){super();this._buf=new Float32Array(" + PUMP_FRAME_SAMPLES + ");this._n=0;}" +
      "process(inputs){" +
        "var input=inputs[0];" +
        "if(input&&input[0]){" +
          "var ch=input[0];" +
          "for(var i=0;i<ch.length;i++){" +
            "this._buf[this._n++]=ch[i];" +
            "if(this._n>=this._buf.length){" +
              "var out=this._buf.slice(0);" +
              "this.port.postMessage(out,[out.buffer]);" +
              "this._n=0;" +
            "}" +
          "}" +
        "}" +
        "return true;" +
      "}" +
      "}" +
      "registerProcessor('pcm-pump',PcmPump);";
    workletUrl = URL.createObjectURL(new Blob([src], { type: "application/javascript" }));
    return workletUrl;
  }

  // Build the frame pump: AudioWorklet first (off the main thread), with the
  // deprecated ScriptProcessor as a LAST resort. Both deliver frames to the same
  // handleAudioFrame, so capture/downsample/send/pre-roll behavior is identical.
  //
  // The worklet is loaded from a REAL same-origin URL (/pcm-pump.js) first, then
  // a Blob URL. This order matters: the Blob form was observed to resolve
  // addModule() WITHOUT registering the processor on real browsers ("node name
  // 'pcm-pump' is not defined"), silently dropping to the ScriptProcessor — whose
  // main-thread starvation under UI load drops audio frames and was the true
  // cause of slow/garbled realtime (batch is immune: MediaRecorder is off-thread).
  async function buildPumpNode() {
    if (audioCtx.audioWorklet && typeof AudioWorkletNode === "function") {
      var sources = ["/pcm-pump.js", "blob"];
      for (var i = 0; i < sources.length; i++) {
        try {
          var modUrl = sources[i] === "blob" ? getWorkletUrl() : sources[i];
          await audioCtx.audioWorklet.addModule(modUrl);
          var node = new AudioWorkletNode(audioCtx, "pcm-pump");
          node.port.onmessage = function (e) { handleAudioFrame(e.data); };
          try { console.log("[audio] AudioWorklet pump active (" + sources[i] + ")"); } catch (e2) {}
          return node;
        } catch (err) {
          try { console.warn("[audio] worklet load failed (" + sources[i] + "): " + (err && err.message)); } catch (e2) {}
        }
      }
    }
    // Last resort — deprecated, main-thread, can starve under load.
    try { console.warn("[audio] FALLBACK to ScriptProcessor pump (off-thread worklet unavailable; realtime may degrade under load)"); } catch (e) {}
    var sp = audioCtx.createScriptProcessor(PUMP_FRAME_SAMPLES, 1, 1);
    sp.onaudioprocess = function (e) {
      handleAudioFrame(new Float32Array(e.inputBuffer.getChannelData(0)));
    };
    return sp;
  }

  // Single chokepoint for every audio frame: guarantees the spec-required
  // commit/sample_rate fields and that previous_text rides only the first chunk.
  function sendAudioChunk(base64, commit) {
    if (!ws || ws.readyState !== WebSocket.OPEN) return false;
    const msg = {
      message_type: "input_audio_chunk",
      audio_base_64: base64,
      commit: !!commit,
      sample_rate: 16000
    };
    if (!firstChunkSent && sessionPreviousText) {
      msg.previous_text = sessionPreviousText;
    }
    try { ws.send(JSON.stringify(msg)); } catch (e) { return false; }
    firstChunkSent = true;
    return true;
  }

  function flushPendingChunks() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    while (pendingChunks.length) {
      if (!sendAudioChunk(pendingChunks[0], false)) break;
      pendingChunks.shift();
    }
  }

  function buildPrerollChunks() {
    // Encode the idle frames captured just before this session started.
    // Anything older than PREROLL_MS is stale chatter and dropped.
    const minT = Date.now() - PREROLL_MS;
    const out = [];
    for (const f of prerollFrames) {
      if (f.t <= minT) continue;
      const downsampled = downsampleBuffer(f.samples, f.rate, 16000);
      const pcmBuffer = floatTo16BitPCM(downsampled);
      capturePcm(pcmBuffer); // hybrid: pre-roll belongs in the refine audio too
      out.push(arrayBufferToBase64(pcmBuffer));
    }
    prerollFrames = [];
    return out;
  }

  async function startRecording() {
    if (recording || stopping || finishing) return;
    stopRequested = false;
    pendingStart = false;
    // A direct start supersedes any armed queued start (the timer would no-op
    // against recording=true anyway, but a dead handle must not linger where
    // the release guards read it).
    if (pendingStartTimer) { clearTimeout(pendingStartTimer); pendingStartTimer = null; }

    // Engine-aware credential check. Realtime is Deepgram Nova-3 on Workers AI —
    // NO STT key (the Worker uses env.AI; shared mode gates it on the passphrase).
    // Batch + hybrid's refine still need an ElevenLabs key. In shared mode the
    // passphrase covers everything.
    const apiKey      = apiKeyEl.value.trim();        // ElevenLabs (batch / refine)
    const shared      = SHARED_MODE && passphraseEl.value.trim();
    const needEleven  = (engine === "batch" || engine === "hybrid");
    let missing = null;
    if (!shared) {
      if (needEleven && !apiKey)                       missing = SHARED_MODE ? "pass" : "eleven";
      else if (SHARED_MODE && engine === "realtime")   missing = "pass"; // shared realtime still gates
    }
    if (missing) {
      await writeSentinel();
      if (authSectionEl) authSectionEl.open = true; // surface the collapsed credentials box
      setBigSettingsVisible(true); // the big-button layout hides it otherwise
      if (missing === "pass") {
        setStatus("Enter the shared passphrase first.", "err");
        passphraseEl.focus();
      } else {
        setStatus("Enter your ElevenLabs API key first (used for batch).", "err");
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
        setStatus("Audio not running. Click page once, then try again.", "err");
        failBeep();
        return;
      }
    } catch (e) {
      await writeSentinel();
      setMicPill("fail");
      setStatus("Microphone unavailable: " + (e && e.message ? e.message : e), "err");
      failBeep();
      return;
    }

    // Hold a screen wake lock for the dictation: iOS auto-lock reclaims the
    // microphone and suspends the page mid-upload/refine. Released by
    // deliverFinalText — the single session exit.
    acquireWakeLock();

    // New session bookkeeping; stale callbacks from a previous socket bail out
    const mySession = ++sessionSeq;
    sessionEngine = engine; // snapshot: selector changes only affect the NEXT session
    sessionFinalized = false;
    userStopped = false;
    stopPhase = null;
    sessionPcm = [];
    sessionPcmBytes = 0;
    sessionPcmTruncated = false;
    pendingChunks = buildPrerollChunks(); // first-word rescue: lead with the pre-roll
    firstChunkSent = false;
    lastWsError = "";
    wsOpenAt = 0;
    recStartedAt = Date.now();
    partialCount = 0;
    speechDetected = false;
    maxRmsSeen = 0;
    micAlarmFired = false;
    sttAlarmFired = false;
    mutedSince = 0;
    clearSessionTimers();

    // Continue the current text when armed by clicking the transcript box
    // (one-shot, beats the window), or when append mode is on AND the
    // previous dictation finished recently enough (the append window).
    if (appendArmed) {
      appendArmed = false; // consumed by this session
    } else if (!appendModeEl.checked) {
      finalizedSegments = [];
    } else {
      const w = Number(appendWindowEl.value) || 0;
      if (w > 0 && lastFinalizeAt && Date.now() - lastFinalizeAt > w * 1000) {
        finalizedSegments = [];
      }
    }
    currentPartial = "";
    updateLiveDisplay();

    // The note text this session extends. Batch/hybrid delivery splices the
    // freshly transcribed text onto this base instead of live segments.
    sessionBaseText = finalizedSegments.join(" ");

    // When continuing a note, hand the model the tail of the existing text as
    // context (rides only the first chunk). Fresh notes send nothing — stale
    // context would mislead the model.
    sessionPreviousText = latestText && latestText.trim() ? latestText.trim().slice(-300) : "";

    if (sessionEngine === "batch") {
      // Pure batch: no WebSocket, no pre-roll (the gate-in-path recording
      // cannot splice in pre-gate frames). The post-gate MediaRecorder IS the
      // capture path; upload happens on stop.
      pendingChunks = [];
      startBatchRecording();
      return;
    }

    // Establish Secure Proxy WebSocket Connection through the Cloudflare Worker
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const params = new URLSearchParams();
    // Realtime is Deepgram Nova-3 on Workers AI — no STT key travels from the
    // browser. In shared mode the passphrase gates the Worker's AI binding.
    if (SHARED_MODE) params.append("passphrase", passphraseEl.value.trim());
    params.append("no_verbatim", String(noVerbatimEl.checked));
    params.append("timestamps", timestampsEl.value);

    // Keyterms ride the Nova-3 config as the keyterm field (server-side). Batch
    // gets the full list too, so hybrid's clipboard text benefits on both legs.
    const keyterms = effectiveKeyterms(REALTIME_KEYTERM_MAX_CHARS, REALTIME_KEYTERM_MAX_TERMS);
    params.append("keyterms_json", JSON.stringify(keyterms));

    if (joinedSessionCode) params.append("session", joinedSessionCode);

    // Experimental realtime transport override: ?rt=flux|gw|dgw on the PAGE URL
    // is forwarded to the Worker (absent/auto = the proven nova-3 binding, the
    // default). Lets the operator live-test alternative transports that reach an
    // honored sample_rate without any UI change; an unknown value is ignored.
    try {
      var pageRt = new URLSearchParams(window.location.search).get("rt");
      if (pageRt && /^(flux|gw|dgw|binding|auto)$/.test(pageRt)) params.append("rt", pageRt);
    } catch (e) {}

    const wsUrl = wsProtocol + "//" + window.location.host + "/api/transcribe?" + params.toString();

    try {
      ws = new WebSocket(wsUrl);
    } catch (err) {
      await writeSentinel();
      sessionFinalized = true;
      setLinkPill("fail");
      setStatus("Could not open transcription pipeline.", "err");
      failBeep();
      return;
    }

    setLinkPill("connecting");

    // Fail LOUDLY if the pipe cannot open, before a long dictation is lost.
    connectTimer = setTimeout(() => {
      connectTimer = null;
      if (mySession !== sessionSeq || sessionFinalized) return;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        lastWsError = lastWsError || "could not reach the transcription service";
        setLinkPill("fail");
        try { if (ws) ws.close(); } catch (e) {}
        finalizeSession(true);
      }
    }, CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      if (mySession !== sessionSeq) return;
      wsOpenAt = Date.now();
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      setLinkPill("live");
      flushPendingChunks();
      setStatus("Listening — transcribing live…", "ok");
      if (stopPhase === "awaitFinal") {
        // PTT was released while still connecting: buffered speech was just
        // flushed; give the server a moment to chew on it, then commit.
        setTimeout(() => { if (mySession === sessionSeq) beginCommitPhase(true); }, 400);
      }
    };

    ws.onmessage = async (event) => {
      if (mySession !== sessionSeq) return;
      try {
        const data = JSON.parse(event.data);
        const m_type = data.message_type;

        if (m_type === "session_started") {
          // Nova-3: config.tier shows which config opened (medical/general/minimal).
          const cfg = data.config || {};
          const tier = typeof cfg.tier === "string" ? cfg.tier : "";
          if (!stopping) {
            setStatus("Listening — transcribing live…" + (tier ? " (" + tier + ")" : ""), "ok");
          }
        }
        else if (m_type === "partial_transcript") {
          partialCount++;
          currentPartial = data.text;
          updateLiveDisplay();
        }
        else if (m_type === "committed_transcript" || m_type === "committed_transcript_with_timestamps") {
          partialCount++;
          if (data.text && data.text.trim()) {
            finalizedSegments.push(data.text);
            currentPartial = "";
            updateLiveDisplay();
          }
          if (stopPhase === "awaitFinal") {
            // The final words arrived — close as soon as the server goes quiet
            // instead of waiting out the whole deadline.
            if (quietTimer) clearTimeout(quietTimer);
            quietTimer = setTimeout(() => {
              quietTimer = null;
              if (mySession !== sessionSeq) return;
              try { if (ws) ws.close(); } catch (e) {}
              finalizeSession(false);
            }, COMMIT_QUIET_MS);
          }
        }
        else if (typeof data.error === "string" && data.error) {
          // Covers the whole error-frame family: error, auth_error,
          // quota_exceeded, rate_limited, commit_throttled, input_error,
          // session_time_limit_exceeded, chunk_size_exceeded, … — any frame
          // carrying an error string takes the loud path.
          const tag = (m_type && m_type !== "error") ? (m_type + ": ") : "";
          lastWsError = tag + data.error;
          console.error("Scribe error frame:", lastWsError);
          setStatus("Transcription service error — " + lastWsError, "err");
          failBeep();
        }
      } catch (err) {
        console.error("Error processing message:", err);
      }
    };

    ws.onerror = (err) => {
      if (mySession !== sessionSeq) return;
      console.error("WebSocket Error:", err);
      lastWsError = lastWsError || "pipeline connection error";
      setStatus("Pipeline connection error.", "err");
    };

    ws.onclose = () => {
      if (mySession !== sessionSeq) return;
      console.log("WebSocket connection closed.");
      setLinkPill(sessionFinalized || userStopped ? "idle" : "fail");
      // A close we did not ask for is a failure and must sound like one.
      finalizeSession(!userStopped);
    };

    // Parallel local audio recording for playback bar
    chunks = [];
    const preferred = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
    ].find((type) => MediaRecorder.isTypeSupported(type));

    try {
      const recOpts = { audioBitsPerSecond: 64000 };
      if (preferred) recOpts.mimeType = preferred;
      mediaRecorder = new MediaRecorder(destNode.stream, recOpts);
    } catch (e) {
      console.warn("Local browser playbar preview recorder failed to initiate.");
    }

    if (mediaRecorder) {
      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunks.push(e.data);
      };
      mediaRecorder.start();
    }

    recording = true;
    stopping = false;
    recordBtn.textContent = "Stop recording";
    recordBtn.classList.add("danger");
    setMicPill("rec");
    updateAppendChip();
    startBeep();

    if (stopRequested) {
      stopRequested = false;
      stopRecording();
    }
  }

  // Batch-mode recording: the same post-gate MediaRecorder the other engines
  // use for the preview, made load-bearing. Finalize is driven from onstop so
  // the final dataavailable flush is always in chunks[] before upload.
  function startBatchRecording() {
    setLinkPill("idle");
    chunks = [];

    const preferred = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
    ].find((type) => MediaRecorder.isTypeSupported(type));

    const opts = { audioBitsPerSecond: 64000 };
    if (preferred) opts.mimeType = preferred;

    try {
      mediaRecorder = new MediaRecorder(destNode.stream, opts);
    } catch (e) {
      // In batch mode the recorder IS the capture path — failing it is fatal.
      sessionFinalized = true;
      writeSentinel();
      setStatus("MediaRecorder failed in this browser — batch mode cannot record. Try realtime mode.", "err");
      failBeep();
      return;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      if (sessionFinalized) return;
      finalizeSession(false);
    };
    mediaRecorder.start();

    recording = true;
    stopping = false;
    recordBtn.textContent = "Stop recording";
    recordBtn.classList.add("danger");
    setMicPill("rec");
    updateAppendChip();
    setStatus("Recording — release to upload for transcription…", "ok");
    startBeep();

    if (stopRequested) {
      stopRequested = false;
      stopRecording();
    }
  }

  function stopRecording() {
    if (!recording || stopping) {
      stopRequested = true;
      return;
    }
    userStopped = true;
    stopping = true;

    if (sessionEngine === "batch") {
      // No tail/commit phases: stopping the recorder flushes the last chunk,
      // and its onstop handler drives the finalize/upload.
      stopPhase = null;
      setStatus("Stopping — preparing upload…", "warn");
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        try { mediaRecorder.stop(); } catch (e) { finalizeSession(true); }
      } else {
        finalizeSession(false);
      }
      return;
    }

    stopPhase = "tail";
    setStatus("Finalizing live speech transcript…", "warn");

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      mediaRecorder.stop();
    }

    // Keep streaming audio briefly after PTT release so trailing speech still
    // in the capture pipeline reaches Scribe (this is what used to clip the
    // last word or two), then commit and wait for the final transcript.
    tailTimer = setTimeout(() => {
      tailTimer = null;
      beginCommitPhase(false);
    }, TAIL_MS);
  }

  function beginCommitPhase(fromOpen) {
    if (sessionFinalized) return;
    stopPhase = "awaitFinal";

    if (ws && ws.readyState === WebSocket.OPEN) {
      flushPendingChunks();
      // Final empty chunk with commit: true forces the last segment out
      sendAudioChunk("", true);
      if (finalDeadlineTimer) clearTimeout(finalDeadlineTimer);
      finalDeadlineTimer = setTimeout(() => {
        finalDeadlineTimer = null;
        try { if (ws) ws.close(); } catch (e) {}
        finalizeSession(false);
      }, FINAL_WAIT_MS);
    } else if (ws && ws.readyState === WebSocket.CONNECTING && !fromOpen) {
      // Still connecting: ws.onopen sees stopPhase === "awaitFinal" and calls
      // us back; the connect timeout covers the never-opens case.
    } else {
      finalizeSession(!userStopped);
    }
  }

  async function finalizeSession(unexpected) {
    if (sessionFinalized) return;
    sessionFinalized = true;
    clearSessionTimers();

    // Set BEFORE the button/pill updates below: those trigger the big-screen
    // recalc, and with finishing already true it renders WORKING… through the
    // delivery awaits instead of a stale (possibly green) status — an error
    // path must never flash the success screen.
    finishing = true; // cleared in deliverFinalText — the single delivery exit

    recording = false;
    stopping = false;
    stopPhase = null;
    stopRequested = false;
    recordBtn.textContent = "Start recording";
    recordBtn.classList.remove("danger");
    if (micAlarmFired) setMicPill("fail");
    else setMicPill(audioGraphHealthy() ? "ready" : "off");
    if (!unexpected) setLinkPill("idle");

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.stop(); } catch (e) {}
    }

    if (chunks.length) {
      const blob = new Blob(chunks, { type: (chunks[0] && chunks[0].type) || "audio/webm" });
      lastAudioBlob = blob;
      if (lastAudioUrl) URL.revokeObjectURL(lastAudioUrl);
      lastAudioUrl = URL.createObjectURL(blob);
      audioPreviewEl.src = lastAudioUrl;
    }

    lastFinalizeAt = Date.now();

    if (sessionEngine === "batch") {
      await finishBatchSession(unexpected);
      return;
    }
    if (sessionEngine === "hybrid") {
      await refineAndDeliverHybrid(unexpected);
      return;
    }

    await deliverFinalText(cleanTranscript(latestText), { unexpected: unexpected });
  }

  // Hybrid delivery: the realtime text on screen was live feedback; the same
  // audio — pre-roll, live, tail, exactly as produced for the stream — is
  // re-transcribed by the stronger batch model and THAT lands on the
  // clipboard. If the refine fails, the live text is delivered with an
  // always-audible warn. If the live link died but audio was captured, the
  // refine doubles as a recovery path.
  async function refineAndDeliverHybrid(unexpected) {
    const liveCleaned = cleanTranscript(latestText);
    const pcm = sessionPcm;
    const pcmBytes = sessionPcmBytes;
    const truncated = sessionPcmTruncated;
    sessionPcm = []; // a 20 MB buffer must never outlive its session
    sessionPcmBytes = 0;
    sessionPcmTruncated = false;

    if (pcmBytes < MIN_REFINE_BYTES) {
      // Instant tap / dead mic: nothing worth refining — deliver as realtime would.
      await deliverFinalText(liveCleaned, { unexpected: unexpected });
      return;
    }

    setLinkPill("refining");
    setStatus("Refining via batch transcription…", "warn");

    const wav = buildWavBlob(pcm, 16000);
    const r = await batchTranscribe(wav, "recording.wav", REFINE_TIMEOUT_MS);

    if (truncated && r.ok && r.text && r.text.trim() && liveCleaned.trim()) {
      // The capture buffer capped out, so the refined text is missing the
      // tail. The live text is complete — deliver that instead, loudly.
      setLinkPill("fail");
      await deliverFinalText(liveCleaned, {
        unexpected: unexpected,
        refineFailed: "recording exceeded the refine cap; complete LIVE text delivered instead",
      });
      return;
    }

    if (r.ok && r.text && r.text.trim()) {
      finalizedSegments = sessionBaseText ? [sessionBaseText, r.text] : [r.text];
      currentPartial = "";
      updateLiveDisplay(); // the box swaps live text -> refined text
      setLinkPill(unexpected ? "fail" : "idle");
      const refinedCleaned = cleanTranscript(latestText);
      await deliverFinalText(refinedCleaned, {
        unexpected: unexpected,
        label: "Refined transcript",
        unexpectedMsg: "⚠ Live link lost mid-dictation — audio recovered via batch re-transcription. VERIFY the ending (it may cut off early)!",
        liveText: liveCleaned !== refinedCleaned ? liveCleaned : undefined,
      });
      return;
    }

    if (liveCleaned.trim()) {
      // Refine failed but the live text exists: deliver it, degraded-loudly.
      setLinkPill("fail");
      await deliverFinalText(liveCleaned, {
        unexpected: unexpected,
        refineFailed: r.error || "no text returned",
      });
      return;
    }

    // Neither engine produced text.
    setLinkPill("fail");
    if (r.ok) {
      await deliverFinalText("", { unexpected: unexpected }); // genuine no-speech
    } else {
      lastWsError = "batch refine: " + (r.error || "failed");
      await deliverFinalText("", { unexpected: true });
    }
  }

  // Pure batch delivery: upload the post-gate recording, splice the result
  // onto the note base, and hand off to the shared delivery exit.
  async function finishBatchSession(unexpected) {
    // Rebuild from this session's chunks — lastAudioBlob can be stale from a
    // previous session when nothing was captured in this one.
    const blob = chunks.length
      ? new Blob(chunks, { type: (chunks[0] && chunks[0].type) || "audio/webm" })
      : null;

    if (!blob || blob.size < 1024) {
      // Gate never opened / instant tap: nothing worth uploading.
      await deliverFinalText("", { unexpected: unexpected });
      return;
    }

    const fileName = (blob.type || "").includes("ogg") ? "recording.ogg" : "recording.webm";
    setLinkPill("uploading");
    setStatus("Uploading audio for transcription…", "warn");

    const r = await batchTranscribe(blob, fileName, BATCH_UPLOAD_TIMEOUT_MS);

    if (!r.ok) {
      lastWsError = r.error || "upload failed"; // surfaces in the failure status line
      setLinkPill("fail");
      await deliverFinalText("", { unexpected: true });
      return;
    }

    setLinkPill("idle");

    if (r.text && r.text.trim()) {
      finalizedSegments = sessionBaseText ? [sessionBaseText, r.text] : [r.text];
    } else {
      finalizedSegments = sessionBaseText ? [sessionBaseText] : [];
    }
    currentPartial = "";
    updateLiveDisplay();

    if (!r.text || !r.text.trim()) {
      await deliverFinalText("", { unexpected: unexpected });
      return;
    }

    await deliverFinalText(cleanTranscript(latestText), { unexpected: unexpected, label: "Transcript" });
  }

  // The single delivery exit for every engine: exactly one clipboard outcome
  // and one beep per session ends up here. opts:
  //   unexpected    — the session ended on a failure we did not request
  //   label         — what to call the text in the success status ("Live transcript", …)
  //   unexpectedMsg — engine-specific override for the unexpected status line
  //   refineFailed  — hybrid only: batch refine failed; deliver live text with a warn
  //   liveText      — hybrid only: realtime rendering saved alongside for comparison
  async function deliverFinalText(cleaned, opts) {
    opts = opts || {};
    releaseWakeLock(); // the screen may sleep again once the outcome is delivered
    const label = opts.label || "Live transcript";

    if (!cleaned.trim()) {
      await writeSentinel();
      if (opts.unexpected) {
        setStatus("Dictation FAILED — " + (lastWsError || "connection lost") + ". Nothing was transcribed; sentinel copied.", "err");
      } else if (micAlarmFired) {
        setStatus("No speech detected — the microphone never produced a signal. Check the mic.", "err");
      } else {
        // The sentinel is on the clipboard and the fail beep plays — this IS
        // a failure outcome and must read as one everywhere (incl. the
        // big-button screen), even when the cause is just an accidental tap.
        setStatus("No speech detected — nothing transcribed; sentinel copied.", "err");
      }
      failBeep();
      finishing = false;
      updateBigScreen(); // the outcome status above was computed under finishing=true (busy)
      updateAppendChip();
      maybePendingStart();
      return;
    }

    // Save final clean output to browser storage. A storage failure (quota)
    // must not block the actual deliverable — the clipboard write and beep.
    try {
      addHistory(cleaned, { language_code: "en", engine: sessionEngine, liveText: opts.liveText });
    } catch (e) {}

    let announceRelayOutcome = false; // joined + clean outcome + local copy denied: the relay ack owns the outcome cue

    if (autoCopyEl.checked) {
      const copied = await copyText(cleaned);
      const relayCarries = Boolean(joinedSessionCode && cleaned.trim());
      const cleanOutcome = !opts.unexpected && !micAlarmFired && !opts.refineFailed;
      if (!copied && relayCarries && cleanOutcome) {
        // Joined mode: the deliverable is the DESKTOP clipboard via the
        // relay. iOS denies local clipboard writes outside a user gesture —
        // by delivery time (post upload/refine) there is none — which would
        // brand every successful relay delivery a failure here. The local
        // copy is best-effort; defer the outcome cue to the relay ack below
        // (done on a listener ack, red warn/fail on zero-listeners/relay
        // failure). Exactly one outcome beep either way.
        announceRelayOutcome = true;
        setStatus("Transcript sent to the desktop — confirming delivery… (no local phone copy; tap 'Copy latest' if you need it here)", "warn");
      } else if (!copied) {
        setStatus("Transcript saved but clipboard copy FAILED — do NOT paste yet; click 'Copy latest'.", "err");
        failBeep();
      } else if (opts.unexpected) {
        setStatus(opts.unexpectedMsg || "⚠ Connection lost mid-dictation — PARTIAL transcript copied. Verify it before pasting!", "err");
        failBeep();
      } else if (micAlarmFired) {
        setStatus("⚠ Mic signal dropped during this dictation — verify the text before pasting!", "err");
        failBeep();
      } else if (opts.refineFailed) {
        setStatus("⚠ Batch refine failed — LIVE transcript copied (less accurate). " + opts.refineFailed, "warn");
        warnBeep();
      } else {
        setStatus(label + " saved & copied. Done!", "ok");
        doneBeep();
      }
    } else {
      if (opts.unexpected) {
        setStatus(opts.unexpectedMsg || "⚠ Connection lost mid-dictation — partial transcript saved (not copied).", "err");
        failBeep();
      } else if (opts.refineFailed) {
        setStatus("⚠ Batch refine failed — live transcript saved, not copied. " + opts.refineFailed, "warn");
        warnBeep();
      } else {
        setStatus(label + " saved.", "ok");
        doneBeep();
      }
    }

    finishing = false;
    updateBigScreen(); // the outcome status above was computed under finishing=true (busy)
    updateAppendChip();

    // If this device is acting as a phone mic for a desktop session, relay the
    // authoritative final text so the desktop can deliver it to the clipboard.
    // The room acks with its listener count — a relay nobody received must be
    // loud here, never a false success. A queued next session waits for the
    // ack: its REC screen must not paint over a relay failure before the
    // failure was ever shown.
    if (joinedSessionCode && cleaned.trim()) {
      relayDeliveryToDesktop(cleaned, announceRelayOutcome).finally(maybePendingStart);
    } else {
      maybePendingStart();
    }
  }

  function maybePendingStart() {
    // PTT pressed again while the previous dictation was finalizing —
    // honor it so rapid consecutive dictations are never swallowed.
    if (pendingStart) {
      pendingStart = false;
      if (pendingStartTimer) clearTimeout(pendingStartTimer);
      // A failure outcome gets a beat of screen time before the queued
      // session's REC paints over it — only the failure path pays the delay.
      const delay = lastStatusCls === "err" ? 1500 : 60;
      pendingStartTimer = setTimeout(() => {
        pendingStartTimer = null;
        if (!recording && !stopping && !finishing) startRecording();
      }, delay);
    }
  }

  // A queued start must die when the press that queued it ends without a tap:
  // a hold released during the finalize/queued window, a cancelled pointer,
  // or F14 (CapsLock up). Otherwise the deferred startRecording opens a mic
  // nobody is holding — a silent open mic in a clinical room.
  function cancelQueuedStart() {
    pendingStart = false;
    if (pendingStartTimer) { clearTimeout(pendingStartTimer); pendingStartTimer = null; }
  }

  /* ───── Phone mic session ───── */

  /* Minimal QR encoder (byte mode, EC level M, versions 1-6 auto-selected) so
     the join link can be rendered locally — no external QR service ever sees
     the session code (it is the link's only credential). */
  var QR_EC_BLOCKS = { // version: [ecCodewordsPerBlock, [dataCodewordsPerBlock, ...]]
    1: [10, [16]],
    2: [16, [28]],
    3: [26, [44]],
    4: [18, [32, 32]],
    5: [24, [43, 43]],
    6: [16, [27, 27, 27, 27]],
  };
  var QR_ALIGN = { 2: 18, 3: 22, 4: 26, 5: 30, 6: 34 }; // single alignment pattern center (v2-6)

  function qrGf() { // GF(256) log/antilog tables, poly 0x11d
    var exp = new Array(512), log = new Array(256), x = 1;
    for (var i = 0; i < 255; i++) {
      exp[i] = x; log[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) exp[j] = exp[j - 255];
    return { exp: exp, log: log };
  }

  function qrEcc(data, ecLen, gf) {
    var gen = [1];
    for (var i = 0; i < ecLen; i++) {
      var next = [];
      for (var j = 0; j <= gen.length; j++) next.push(0);
      for (var j = 0; j < gen.length; j++) {
        if (!gen[j]) continue;
        next[j] ^= gen[j];
        next[j + 1] ^= gf.exp[(gf.log[gen[j]] + i) % 255];
      }
      gen = next;
    }
    var res = data.slice();
    for (var i = 0; i < ecLen; i++) res.push(0);
    for (var i = 0; i < data.length; i++) {
      var f = res[i];
      if (!f) continue;
      for (var j = 0; j < gen.length; j++) {
        if (gen[j]) res[i + j] ^= gf.exp[(gf.log[gen[j]] + gf.log[f]) % 255];
      }
    }
    return res.slice(data.length);
  }

  function qrCodewords(text, version) {
    var spec = QR_EC_BLOCKS[version];
    var dataCw = 0;
    for (var i = 0; i < spec[1].length; i++) dataCw += spec[1][i];
    var bits = [];
    var put = function (val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    put(4, 4);                 // byte mode
    put(text.length, 8);       // char count (8 bits for versions 1-9)
    for (var i = 0; i < text.length; i++) put(text.charCodeAt(i) & 0xff, 8);
    put(0, Math.min(4, dataCw * 8 - bits.length)); // terminator
    while (bits.length % 8) bits.push(0);
    var bytes = [];
    for (var i = 0; i < bits.length; i += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      bytes.push(v);
    }
    var pad = [0xec, 0x11], p = 0;
    while (bytes.length < dataCw) bytes.push(pad[(p++) % 2]);
    var gf = qrGf();
    var blocks = [], eccs = [], off = 0;
    for (var i = 0; i < spec[1].length; i++) {
      var blk = bytes.slice(off, off + spec[1][i]);
      off += spec[1][i];
      blocks.push(blk);
      eccs.push(qrEcc(blk, spec[0], gf));
    }
    var out = [], maxLen = 0;
    for (var i = 0; i < blocks.length; i++) maxLen = Math.max(maxLen, blocks[i].length);
    for (var c = 0; c < maxLen; c++) for (var i = 0; i < blocks.length; i++) {
      if (c < blocks[i].length) out.push(blocks[i][c]);
    }
    for (var c = 0; c < spec[0]; c++) for (var i = 0; i < eccs.length; i++) out.push(eccs[i][c]);
    return out;
  }

  function qrMatrix(text) {
    var version = 0;
    for (var v = 1; v <= 6; v++) {
      var spec = QR_EC_BLOCKS[v], cap = 0;
      for (var i = 0; i < spec[1].length; i++) cap += spec[1][i];
      if (text.length <= cap - 2) { version = v; break; } // 12-bit header overhead
    }
    if (!version) return null; // longer than v6-M holds (106 bytes) — caller hides the QR
    var size = 17 + 4 * version;
    var m = [], fn = [];
    for (var r = 0; r < size; r++) { m.push(new Array(size).fill(0)); fn.push(new Array(size).fill(false)); }
    var setFn = function (r, c, val) { m[r][c] = val ? 1 : 0; fn[r][c] = true; };

    var finder = function (r0, c0) {
      for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
        var rr = r0 + dr, cc = c0 + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        var dark = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
                   (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFn(rr, cc, dark);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    for (var i = 8; i < size - 8; i++) { // timing
      if (!fn[6][i]) setFn(6, i, i % 2 === 0);
      if (!fn[i][6]) setFn(i, 6, i % 2 === 0);
    }

    if (QR_ALIGN[version]) { // single alignment pattern for v2-6
      var ap = QR_ALIGN[version];
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
        setFn(ap + dr, ap + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    }

    setFn(size - 8, 8, 1); // dark module
    for (var i = 0; i <= 8; i++) { // reserve format areas (filled per-mask below)
      if (i !== 6) {
        if (!fn[8][i]) setFn(8, i, 0);
        if (!fn[i][8]) setFn(i, 8, 0);
      }
    }
    for (var i = 0; i < 8; i++) {
      if (!fn[8][size - 1 - i]) setFn(8, size - 1 - i, 0);
      if (!fn[size - 1 - i][8]) setFn(size - 1 - i, 8, 0);
    }

    var cw = qrCodewords(text, version);
    var dataBits = [];
    for (var i = 0; i < cw.length; i++) for (var j = 7; j >= 0; j--) dataBits.push((cw[i] >> j) & 1);
    var k = 0, upward = true;
    for (var col = size - 1; col > 0; col -= 2) { // zigzag placement
      if (col === 6) col--;
      for (var i = 0; i < size; i++) {
        var r = upward ? size - 1 - i : i;
        for (var dc = 0; dc < 2; dc++) {
          var c = col - dc;
          if (!fn[r][c]) m[r][c] = dataBits[k++] || 0; // missing = remainder bits (0)
        }
      }
      upward = !upward;
    }

    var maskBit = function (mask, r, c) {
      switch (mask) {
        case 0: return (r + c) % 2 === 0;
        case 1: return r % 2 === 0;
        case 2: return c % 3 === 0;
        case 3: return (r + c) % 3 === 0;
        case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
        case 5: return (r * c) % 2 + (r * c) % 3 === 0;
        case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
        default: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
      }
    };
    var formatBits = function (mask) { // BCH(15,5) of EC level M (00) + mask, XOR 0x5412
      var d = mask, rem = d << 10, g = 0x537;
      for (var i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= g << (i - 10);
      return ((d << 10) | (rem & 0x3ff)) ^ 0x5412;
    };
    var penalty = function (mm) { // adjacency runs + dark ratio: enough to pick a sane mask
      var p = 0, dark = 0;
      for (var r = 0; r < size; r++) {
        var runR = 1, runC = 1;
        for (var c = 0; c < size; c++) {
          if (mm[r][c]) dark++;
          if (c > 0) {
            if (mm[r][c] === mm[r][c - 1]) { runR++; if (runR === 5) p += 3; else if (runR > 5) p++; } else runR = 1;
            if (mm[c][r] === mm[c - 1][r]) { runC++; if (runC === 5) p += 3; else if (runC > 5) p++; } else runC = 1;
          }
        }
      }
      p += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
      return p;
    };

    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var mm = [];
      for (var r = 0; r < size; r++) mm.push(m[r].slice());
      for (var r = 0; r < size; r++) for (var c = 0; c < size; c++) {
        if (!fn[r][c] && maskBit(mask, r, c)) mm[r][c] ^= 1;
      }
      var f = formatBits(mask);
      for (var i = 0; i < 15; i++) {
        var on = ((f >> i) & 1) === 1 ? 1 : 0;
        if (i < 6) mm[i][8] = on;
        else if (i < 8) mm[i + 1][8] = on;
        else mm[size - 15 + i][8] = on;
        if (i < 8) mm[8][size - 1 - i] = on;
        else if (i < 9) mm[8][7] = on;
        else mm[8][14 - i] = on;
      }
      var score = penalty(mm);
      if (score < bestScore) { bestScore = score; best = mm; }
    }
    return best;
  }

  function renderQrSvg(text, el) {
    var mtx = qrMatrix(text);
    if (!mtx) { el.style.display = "none"; el.innerHTML = ""; return false; }
    var n = mtx.length, q = 4; // spec quiet zone
    var d = "";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (mtx[r][c]) d += "M" + (c + q) + " " + (r + q) + "h1v1h-1z";
    }
    var dim = n + q * 2;
    el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" width="148" height="148" shape-rendering="crispEdges"><rect width="' + dim + '" height="' + dim + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
    el.style.display = "";
    return true;
  }

  function generateSessionCode() {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/l ambiguity
    var arr = new Uint8Array(6);
    crypto.getRandomValues(arr);
    var code = "";
    for (var i = 0; i < 6; i++) code += chars[arr[i] % chars.length];
    return code;
  }

  function setPhoneLinkUI(connected) {
    if (!phoneCodeBadgeEl || !phoneSessionCode) return;
    phoneCodeBadgeEl.textContent = connected ? phoneSessionCode : phoneSessionCode + " ⚠";
    phoneCodeBadgeEl.style.color = connected ? "var(--accent)" : "var(--danger)";
    phoneCodeBadgeEl.title = connected ? "" : "Link to the session room dropped — reconnecting";
  }

  function startPhoneSession() {
    if (phoneSessionCode) return; // already active (possibly mid-reconnect)
    phoneSessionCode   = generateSessionCode();
    remoteCommitted    = "";
    remoteHasDelivery  = false;
    lastDeliveryId     = "";
    pendingCopyText    = "";
    phoneReconnectDelayMs = 0;

    // This click is a user gesture: warm the beep context now so this tab's
    // success/failure cues stay audible later, when it is behind Citrix/Cerner.
    warmBeepCtx();

    beginPhoneSession("Phone session ready. Code: " + phoneSessionCode);
    saveSettingsNow(); // session survives a reload — see restorePhoneLink
  }

  // Shared by startPhoneSession and the boot-time resume: shows the session UI,
  // opens the listener socket, and arms the heartbeat.
  function beginPhoneSession(statusMsg) {
    phoneCodeBadgeEl.style.display = "";
    setPhoneLinkUI(true);
    phoneStopBtnEl.style.display = "";
    phoneStartBtnEl.style.display = "none";
    if (phoneCodeHintEl) {
      phoneCodeHintEl.textContent = "Scan the QR with the phone camera, or open this page on the phone and enter the code above.";
      phoneCodeHintEl.style.display = "";
    }
    if (phoneQrEl) {
      var joinUrl = window.location.origin + "/?join=" + phoneSessionCode;
      phoneQrEl.setAttribute("data-join-url", joinUrl);
      renderQrSvg(joinUrl, phoneQrEl);
    }
    connectPhoneSessionWs();
    phoneLastPongAt = Date.now();
    if (!phonePingTimer) phonePingTimer = setInterval(phoneHeartbeat, PHONE_PING_INTERVAL_MS);
    setStatus(statusMsg, "ok");
  }

  // Boot restore: the codes persist in settings so an iOS PWA kill or a tab
  // reload cannot break the pairing. The desktop reconnects to the same room
  // (the room replays a delivery it missed; lastDeliveryId also persists, so
  // the replay cannot double-copy); the phone simply keeps relaying to the
  // code it had.
  function restorePhoneLink() {
    // QR join: the desktop's QR encodes /?join=<code> — joining by scan is the
    // same one-tap action as entering the code, and it persists the same way.
    var joinParam = "";
    try {
      joinParam = (new URLSearchParams(window.location.search).get("join") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    } catch (e) {}
    if (joinParam && joinParam.length >= 4 && joinParam.length <= 8) {
      joinedSessionCode = joinParam;
      saveSettingsNow();
      try { history.replaceState(null, "", window.location.pathname); } catch (e) {}
      setStatus("Joined session " + joinParam + " (scanned). Start recording to send audio to the desktop.", "ok");
    }
    if (phoneSessionCode) {
      beginPhoneSession("Phone session resumed (code " + phoneSessionCode + ").");
      // No user gesture at boot, so beepCtx cannot be warmed yet — arm it on
      // the first interaction instead, or the listener's cues stay silent.
      var warm = function() { warmBeepCtx(); };
      document.addEventListener("pointerdown", warm, { once: true });
      document.addEventListener("keydown", warm, { once: true });
    }
    if (joinedSessionCode) {
      if (phoneJoinInputEl) phoneJoinInputEl.value = joinedSessionCode;
      if (phoneJoinBadgeEl) phoneJoinBadgeEl.style.display = "";
      if (phoneLeaveBtnEl)  phoneLeaveBtnEl.style.display = "";
    }
  }

  function connectPhoneSessionWs() {
    var code = phoneSessionCode;
    if (!code) return;
    var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    var ws = new WebSocket(proto + "//" + window.location.host + "/api/session/" + code);
    phoneSessionWs = ws;

    ws.onopen = function() {
      if (phoneSessionWs !== ws || phoneSessionCode !== code) return;
      phoneReconnectDelayMs = 0;
      phoneLastPongAt = Date.now();
      setPhoneLinkUI(true);
    };
    ws.onmessage = function(evt) {
      if (phoneSessionWs !== ws) return;
      phoneLastPongAt = Date.now(); // any room frame proves the link is alive
      try { handlePhoneSessionMessage(JSON.parse(evt.data)); } catch(e) {}
    };
    ws.onclose = function() {
      if (phoneSessionWs !== ws) return;
      phoneSessionWs = null;
      if (phoneSessionCode) schedulePhoneReconnect();
    };
    ws.onerror = function() { /* onclose always follows and reconnects */ };
  }

  function phoneHeartbeat() {
    if (!phoneSessionCode) return;
    var ws = phoneSessionWs;
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ message_type: "ping" })); } catch (e) {}
    if (Date.now() - phoneLastPongAt > PHONE_PONG_TIMEOUT_MS) {
      // NAT/idle timeouts can kill the socket without ever firing onclose —
      // the link looks open but is deaf. Force the close; onclose reconnects.
      try { ws.close(); } catch (e) {}
    }
  }

  function schedulePhoneReconnect() {
    setPhoneLinkUI(false);
    setStatus("⚠ Phone link dropped — reconnecting… (code " + phoneSessionCode + " stays valid)", "err");
    warnBeep();
    phoneReconnectDelayMs = Math.min(phoneReconnectDelayMs ? phoneReconnectDelayMs * 2 : 1000, PHONE_RECONNECT_MAX_MS);
    phoneReconnectTimer = setTimeout(function() {
      phoneReconnectTimer = null;
      if (phoneSessionCode && !phoneSessionWs) connectPhoneSessionWs();
    }, phoneReconnectDelayMs);
  }

  function stopPhoneSession() {
    phoneSessionCode = ""; // cleared first so the onclose below does not reconnect
    if (phonePingTimer)      { clearInterval(phonePingTimer); phonePingTimer = null; }
    if (phoneReconnectTimer) { clearTimeout(phoneReconnectTimer); phoneReconnectTimer = null; }
    if (phoneFallbackTimer)  { clearTimeout(phoneFallbackTimer); phoneFallbackTimer = null; }
    if (phoneSessionWs) {
      var ws = phoneSessionWs;
      phoneSessionWs = null;
      try { ws.close(); } catch (e) {}
    }
    remoteCommitted   = "";
    remoteHasDelivery = false;
    pendingCopyText   = "";
    lastDeliveryId    = "";
    phoneCodeBadgeEl.style.display = "none";
    phoneStopBtnEl.style.display = "none";
    phoneStartBtnEl.style.display = "";
    if (phoneCodeHintEl) phoneCodeHintEl.style.display = "none";
    if (phoneQrEl) { phoneQrEl.style.display = "none"; phoneQrEl.innerHTML = ""; }
    saveSettingsNow(); // forget the persisted session
    setStatus("Phone session ended.", "");
  }

  // Deliver text that arrived from the phone to this desktop's clipboard.
  // degraded = live-text fallback (the authoritative delivery never came).
  function deliverRemoteText(text, degraded) {
    latestText = text;
    latestEl.textContent = text;
    addHistory(text, { language_code: "en", engine: "remote" });
    if (!autoCopyEl.checked) {
      if (degraded) { setStatus("⚠ Phone delivery never arrived — LIVE transcript saved, not copied. Verify it!", "warn"); warnBeep(); }
      else          { setStatus("Phone transcript received.", "ok"); doneBeep(); }
      return;
    }
    copyText(text).then(function(ok) {
      if (ok) {
        pendingCopyText = "";
        if (degraded) { setStatus("⚠ Phone delivery never arrived — LIVE transcript copied instead (less accurate). Verify it!", "warn"); warnBeep(); }
        else          { setStatus("Phone transcript copied. Done!", "ok"); doneBeep(); }
      } else {
        // Clipboard writes need document focus, and this tab is usually behind
        // Citrix/Cerner when a delivery lands. Hold the text; retry on refocus.
        pendingCopyText = text;
        setStatus("⚠ Phone transcript received but clipboard copy FAILED — click this window and it will copy itself. Do NOT paste before that!", "err");
        failBeep();
      }
    });
  }

  // Retry a held delivery the moment this tab can write the clipboard again.
  window.addEventListener("focus", function() {
    if (!pendingCopyText) return;
    var text = pendingCopyText;
    copyText(text).then(function(ok) {
      if (!ok || pendingCopyText !== text) return;
      pendingCopyText = "";
      setStatus("Phone transcript copied. Done!", "ok");
      doneBeep();
    });
  });

  function handlePhoneSessionMessage(msg) {
    if (!msg || !msg.message_type) return;

    if (msg.message_type === "pong") return; // heartbeat reply; onmessage already timestamped it

    if (msg.message_type === "session_started") {
      setStatus("Phone connected. Listening... (Code: " + phoneSessionCode + ")", "ok");
      return;
    }

    if (msg.message_type === "partial_transcript") {
      var partial = (msg.transcript || msg.text || "").trim();
      var combined = remoteCommitted + (remoteCommitted && partial ? " " : "") + partial;
      latestText = cleanTranscript(combined);
      latestEl.textContent = latestText;
      return;
    }

    if (msg.message_type === "committed_transcript" ||
        msg.message_type === "committed_transcript_with_timestamps") {
      var seg = (msg.transcript || msg.text || "").trim();
      if (seg) remoteCommitted += (remoteCommitted ? " " : "") + seg;
      latestText = cleanTranscript(remoteCommitted);
      latestEl.textContent = latestText;
      return;
    }

    if (msg.message_type === "phone_delivery") {
      // The room replays the last delivery to (re)connecting listeners so a
      // link drop cannot lose it — dedupe those replays by id.
      if (msg.delivery_id && msg.delivery_id === lastDeliveryId) return;
      if (msg.delivery_id) { lastDeliveryId = msg.delivery_id; saveSettingsNow(); }
      if (phoneFallbackTimer) { clearTimeout(phoneFallbackTimer); phoneFallbackTimer = null; }
      remoteHasDelivery = true;
      var final = (msg.text || "").trim();
      if (final) deliverRemoteText(final, false);
      remoteCommitted   = "";
      remoteHasDelivery = false;
      return;
    }

    if (msg.message_type === "phone_session_end") {
      // The phone's dictation socket closed, but the authoritative
      // phone_delivery may still be seconds away (hybrid refine). Keep the
      // session alive for the next dictation and give the delivery a grace
      // window before falling back to the accumulated live text.
      if (remoteCommitted.trim() && !phoneFallbackTimer) {
        setStatus("Phone dictation ended — waiting for the final transcript…", "warn");
        phoneFallbackTimer = setTimeout(function() {
          phoneFallbackTimer = null;
          if (!remoteCommitted.trim()) return; // the delivery arrived meanwhile
          var fallback = cleanTranscript(remoteCommitted);
          remoteCommitted = "";
          deliverRemoteText(fallback, true);
        }, PHONE_FALLBACK_GRACE_MS);
      }
      return;
    }

    if (msg.error) {
      setStatus("Phone session error: " + msg.error, "err");
      warnBeep();
    }
  }

  // Phone side: push the final text to the session room and check the ack.
  // The room buffers the last delivery for reconnecting listeners, so a
  // zero-listener ack means "held for replay", not "gone" — but the desktop
  // does not have the text yet and the user must hear that.
  // announceOutcome: the local phone copy was denied (iOS, no gesture) on an
  // otherwise-clean outcome, so this ack carries the dictation's outcome cue.
  async function relayDeliveryToDesktop(text, announceOutcome) {
    var payload = JSON.stringify({
      message_type: "phone_delivery",
      text: text,
      delivery_id: Date.now().toString(36) + "-" + Math.floor(Math.random() * 0xffffffff).toString(36),
    });
    var listeners = -1;
    // A black-holed POST must still produce an outcome: without a deadline a
    // hung relay reports nothing at all (and would stall a queued session).
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var killer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, RELAY_TIMEOUT_MS) : null;
    try {
      var res = await fetch("/api/session/" + joinedSessionCode + "/deliver", {
        method: "POST",
        body: payload,
        headers: { "Content-Type": "application/json" },
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      try { listeners = JSON.parse(await res.text()).listeners; } catch (e) { listeners = -1; }
    } catch (e) {
      setStatus("⚠ Desktop relay FAILED — the transcript did NOT reach the desktop clipboard!", "err");
      failBeep();
      return;
    } finally {
      if (killer) clearTimeout(killer);
    }
    if (listeners === 0) {
      setStatus("⚠ Desktop link is DOWN — transcript held for replay when it reconnects. VERIFY it lands before pasting!", "err");
      warnBeep();
    } else if (announceOutcome) {
      // The deferred outcome cue: the desktop received it — this is the
      // dictation's success moment.
      setStatus("Delivered to the desktop clipboard. Done!", "ok");
      doneBeep();
    }
  }

  /* ───── Big-button dictation layout ─────
     Active while this device is JOINED to a desktop session (or forced by the
     per-device override) — activation is the joined state, never the screen
     size. The button drives the exact same startRecording()/stopRecording()
     session paths as the record button, with the hotkey's tap/hold semantics;
     the whole-screen indicator is derived from the existing status/pill
     transitions. Everything here is additive: the normal layout (and the
     desktop tiny-window compactness contract) is untouched. */
  function bigButtonActive() {
    const mode = bigButtonModeEl ? bigButtonModeEl.value : "joined";
    if (mode === "never") return false;
    if (mode === "always") return true;
    return Boolean(joinedSessionCode);
  }

  function applyBigButtonUI() {
    const active = bigButtonActive();
    document.body.classList.toggle("bigbtn", active);
    if (!active) {
      document.body.classList.remove("bigbtn-settings");
      bigPeekExpanded = false;
    }
    if (bigJoinedBadgeEl) {
      bigJoinedBadgeEl.textContent = joinedSessionCode
        ? "Joined " + joinedSessionCode
        : "Not joined — dictating to this device";
    }
    if (bigLeaveBtnEl) bigLeaveBtnEl.style.display = joinedSessionCode ? "" : "none";
    updateBigScreen();
  }

  function setBigSettingsVisible(show) {
    document.body.classList.toggle("bigbtn-settings", Boolean(show) && bigButtonActive());
  }

  // Whole-screen state, derived from the SAME transitions that drive the
  // status line and the mic/link pills — no new state machinery. Because the
  // deliverable goes to the DESKTOP in joined mode, relay outcomes are part of
  // the picture automatically: a zero-listener ack or relay failure lands as
  // an "err" status after the local delivery, turning the screen red even
  // though the local done beep already played.
  function updateBigScreen() {
    if (!bigUiEl) return;
    let state;
    if (lastMicPillState === "fail") state = "alarm";
    else if (recording && !stopping) state = lastLinkPillState === "connecting" ? "connecting" : "rec";
    else if (stopping || finishing || lastLinkPillState === "uploading" || lastLinkPillState === "refining") state = "busy";
    else if (lastStatusCls === "err") state = "fail";
    else if (lastStatusCls === "warn") state = "warn";
    else if (lastStatusCls === "ok") state = "ok";
    else state = "idle";
    bigUiEl.setAttribute("data-screen", state);
    if (bigStateEl) {
      // The warn headline must never claim DONE: warn covers both degraded
      // deliveries AND idle advisories (mic re-warm failed, …) — "CHECK"
      // points at the status line below without asserting a delivery.
      bigStateEl.textContent =
        state === "alarm" ? "⚠ MIC FAIL" :
        state === "rec" ? "● REC" :
        state === "connecting" ? "CONNECTING…" :
        state === "busy" ? "WORKING…" :
        state === "ok" ? "DONE" :
        state === "warn" ? "⚠ CHECK" :
        state === "fail" ? "FAILED" : "READY";
    }
    if (bigBtnEl) {
      bigBtnEl.textContent =
        (recording && !stopping) ? "STOP" :
        (stopping || finishing) ? "…" : "HOLD TO TALK";
    }
    if (bigStatusEl) bigStatusEl.textContent = statusEl.textContent;
    updateBigPeek();
  }

  // The latest transcript collapses to a one-line peek strip; tap to expand.
  function updateBigPeek() {
    if (!bigPeekEl) return;
    bigPeekTextEl.textContent = latestText || "";
    // While a dictation is live, show the realtime words wrapped and pinned to the
    // newest line — a collapsed one-liner truncates from the end, so the latest
    // recognized words scroll off-screen and the strip looks frozen (the realtime
    // feedback the mobile/joined user actually needs). Batch has no live text, so
    // gate on latestText: nothing to show until delivery.
    var live = (recording || stopping) && !!latestText;
    bigPeekEl.classList.toggle("live", live);
    bigPeekEl.classList.toggle("expanded", bigPeekExpanded);
    bigPeekEl.classList.toggle("armed", appendArmed && !recording);
    bigPeekBarEl.textContent = live
      ? "Live transcript"
      : bigPeekExpanded
        ? "Latest transcript — tap here to collapse · tap the text to append the next dictation"
        : "Latest transcript — tap to expand";
    if (live) bigPeekTextEl.scrollTop = bigPeekTextEl.scrollHeight;
  }

  // Press/release handling. Pointer capture plus the cancel/lost/document
  // backstops guarantee that EVERY way a press can end routes through
  // bigBtnRelease — long-press-and-slide-away or multi-touch must never wedge
  // the recording state (never-lose-a-dictation, applied to input handling).
  function bigBtnPress(e) {
    if (e.preventDefault) e.preventDefault();
    if (bigBtnPointerId !== null) return; // a second finger never steals the press
    bigBtnPointerId = e.pointerId !== undefined ? e.pointerId : -1;
    try { bigBtnEl.setPointerCapture(e.pointerId); } catch (err) {}
    if (!recording && !stopping && !finishing) {
      bigBtnEngaged = true;
      bigBtnDownAt = Date.now();
      startRecording();
    } else if (stopping || finishing) {
      bigBtnEngaged = true;
      bigBtnDownAt = Date.now();
      pendingStart = true; // press while finalizing queues the next dictation
    } else {
      bigBtnEngaged = false; // second tap: toggle off
      bigBtnDownAt = 0;
      stopRecording();
    }
  }

  function bigBtnRelease(e) {
    if (bigBtnPointerId === null) return;
    if (e && e.pointerId !== undefined && e.pointerId !== bigBtnPointerId) return; // not the owning finger
    bigBtnPointerId = null;
    if (!bigBtnEngaged) return;
    bigBtnEngaged = false;
    // pointercancel / lostpointercapture mean the real release will NEVER
    // arrive (gesture takeover, capture loss). Unlike a quick tap, that is a
    // stop regardless of hold duration — an open mic nobody can release is
    // never the right interpretation. (If this press toggled an existing
    // recording off, bigBtnPress already cleared bigBtnEngaged — no re-stop.)
    const cancelled = Boolean(e && (e.type === "pointercancel" || e.type === "lostpointercapture"));
    const held = bigBtnDownAt && Date.now() - bigBtnDownAt > HOTKEY_TAP_MS;
    bigBtnDownAt = 0;
    if (!held && !cancelled) return; // quick tap: keep recording, next tap stops
    if (stopping || finishing || pendingStartTimer) { cancelQueuedStart(); return; } // press ended during a finalize/queued window: don't auto-start an unheld mic
    stopRecording();
  }

  if (bigBtnEl) {
    bigBtnEl.addEventListener("pointerdown", bigBtnPress);
    bigBtnEl.addEventListener("pointerup", bigBtnRelease);
    bigBtnEl.addEventListener("pointercancel", bigBtnRelease);
    bigBtnEl.addEventListener("lostpointercapture", bigBtnRelease);
    // Long-press context menus would swallow the release.
    bigBtnEl.addEventListener("contextmenu", (e) => e.preventDefault());
    // Backstop for environments where pointer capture is unavailable: the
    // release is caught at the document even if the finger slid off the button.
    document.addEventListener("pointerup", bigBtnRelease);
    document.addEventListener("pointercancel", bigBtnRelease);
  }

  if (bigPeekBarEl) bigPeekBarEl.addEventListener("click", () => {
    bigPeekExpanded = !bigPeekExpanded;
    updateBigPeek();
  });
  if (bigPeekTextEl) bigPeekTextEl.addEventListener("click", () => {
    if (!bigPeekExpanded) { bigPeekExpanded = true; updateBigPeek(); return; }
    // Expanded: tapping the text is click-to-append. Forward to the shared
    // transcript-box handler so the one-shot arm rules live in exactly one place.
    latestEl.click();
  });

  if (bigLeaveBtnEl) bigLeaveBtnEl.onclick = () => { if (phoneLeaveBtnEl) phoneLeaveBtnEl.click(); };
  if (bigSettingsBtnEl) bigSettingsBtnEl.onclick = () => setBigSettingsVisible(true);
  if (bigReturnBtnEl) bigReturnBtnEl.onclick = () => setBigSettingsVisible(false);
  if (bigButtonModeEl) bigButtonModeEl.addEventListener("change", () => {
    saveSettings();
    applyBigButtonUI();
  });

  /* ───── Controls & Event Listeners ───── */
  recordBtn.onclick = () => {
    if (recording) stopRecording();
    else startRecording();
  };

  forgetKeyBtn.onclick = () => {
    apiKeyEl.value = "";
    if (sonioxKeyEl) sonioxKeyEl.value = "";
    if (passphraseEl) passphraseEl.value = "";
    saveApiKeyEl.checked = false;
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    localStorage.removeItem(SONIOX_KEY_STORAGE_KEY);
    localStorage.removeItem(PASSPHRASE_STORAGE_KEY);
    localStorage.removeItem(LEGACY_ACCESS_CODE_KEY);
    saveSettingsNow();
    updateAuthUI();
    if (authSectionEl) authSectionEl.open = true;
    setStatus(SHARED_MODE ? "Shared passphrase / key removed." : "API key removed.", "ok");
  };

  clearBtn.onclick = () => {
    localStorage.removeItem(STORE_KEY);
    latestText = "";
    latestEl.textContent = "";
    finalizedSegments = []; // Fixed: Make sure screen buffer is cleared alongside history
    currentPartial = "";
    renderHistory();
    updateAppendChip();
    setStatus("History cleared.");
  };

  freshBtn.onclick = () => {
    finalizedSegments = [];
    currentPartial = "";
    latestText = "";
    latestEl.textContent = "";
    updateAppendChip();
    setStatus("Dictation box cleared — the next dictation starts a new note (history kept).", "ok");
  };

  copyBtn.onclick = () => { if (latestText) copyText(latestText); };

  if (phoneStartBtnEl) phoneStartBtnEl.onclick = () => startPhoneSession();
  if (phoneStopBtnEl)  phoneStopBtnEl.onclick  = () => stopPhoneSession();
  if (phoneJoinBtnEl) phoneJoinBtnEl.onclick = () => {
    var code = (phoneJoinInputEl ? phoneJoinInputEl.value : "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code || code.length < 4) { setStatus("Enter the 6-character code shown on the desktop.", "err"); return; }
    joinedSessionCode = code;
    if (phoneJoinBadgeEl) phoneJoinBadgeEl.style.display = "";
    if (phoneLeaveBtnEl)  phoneLeaveBtnEl.style.display = "";
    saveSettingsNow(); // join survives reloads/PWA kills — see restorePhoneLink
    applyBigButtonUI(); // joining flips this device into the big-button layout
    setStatus("Joined session " + code + ". Start recording to send audio to the desktop.", "ok");
  };
  if (phoneLeaveBtnEl) phoneLeaveBtnEl.onclick = () => {
    joinedSessionCode = "";
    if (phoneJoinBadgeEl) phoneJoinBadgeEl.style.display = "none";
    phoneLeaveBtnEl.style.display = "none";
    saveSettingsNow();
    applyBigButtonUI(); // leaving reverts to the normal layout (unless the override is "always")
    setStatus("Left the desktop session — dictations stay on this device now.", "ok");
  };

  // Click the transcript box to append the next dictation onto it — one-shot,
  // works regardless of the append-mode checkbox; click again to cancel.
  // Ignored while a session is active and when text is being selected.
  latestEl.addEventListener("click", () => {
    if (recording || stopping || finishing) return;
    if (!latestText || !latestText.trim()) return;
    try {
      const sel = window.getSelection && window.getSelection();
      if (sel && String(sel)) return; // selecting text to copy, not arming
    } catch (e) {}
    appendArmed = !appendArmed;
    updateAppendChip();
    setStatus(appendArmed
      ? "Next dictation will append to this text (click the box again to cancel)."
      : "Next dictation starts fresh.", "");
  });

  hotkeyBtn.onclick = () => {
    capturingHotkey = !capturingHotkey;
    updateHotkeyUI();
  };

  hotkeyResetBtn.onclick = () => {
    hotkey = Object.assign({}, DEFAULT_HOTKEY);
    capturingHotkey = false;
    updateHotkeyUI();
    saveSettingsNow();
    setStatus("Hotkey reset to " + hotkeyLabel(hotkey) + ".", "ok");
  };

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

  // Dynamic Scribe event listeners

  keytermsEl.addEventListener("input", updateKeytermHint);

  noiseSuppressEl.addEventListener("change", () => {
    releaseAudio();
    tryWarmOnLoad();
  });

  if (engineSegEl) {
    engineSegEl.addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.getAttribute && t.getAttribute("data-engine")) {
        setEngine(t.getAttribute("data-engine"));
      }
    });
  }

  appendModeEl.addEventListener("change", updateAppendChip);
  appendWindowEl.addEventListener("input", () => { saveSettings(); updateAppendChip(); });
  if (advancedEl) advancedEl.addEventListener("toggle", saveSettings);
  if (optionsSectionEl) optionsSectionEl.addEventListener("toggle", saveSettings);
  if (keytermsSectionEl) keytermsSectionEl.addEventListener("toggle", saveSettings);

  // Credentials box: live summary while typing; collapse once credentials are
  // entered (change fires on blur). Reopen any time via the summary.
  for (const el of [apiKeyEl, sonioxKeyEl, passphraseEl]) {
    el.addEventListener("input", updateAuthUI);
    el.addEventListener("change", () => {
      updateAuthUI();
      if (hasAuth() && authSectionEl) authSectionEl.open = false;
    });
  }

  // Keep the "appending vs fresh" countdown honest
  setInterval(updateAppendChip, 1000);

  for (const el of [
    apiKeyEl, sonioxKeyEl, passphraseEl, saveApiKeyEl, keytermsEl, timestampsEl, tagEventsEl,
    noVerbatimEl, autoCopyEl, appendModeEl, startBeepEl,
    stripNewlinesEl, stripEllipsesEl, trailingSpaceEl,
  ]) {
    el.addEventListener("change", saveSettings);
    el.addEventListener("input", saveSettings);
  }

  document.addEventListener("keydown", (e) => {
    // Hotkey capture mode: the next non-modifier keypress becomes the hotkey
    if (capturingHotkey) {
      e.preventDefault();
      if (e.code === "Escape") {
        capturingHotkey = false;
        updateHotkeyUI();
        return;
      }
      if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(e.code)) return; // wait for the main key
      hotkey = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code };
      capturingHotkey = false;
      updateHotkeyUI();
      hotkeyBtn.blur();
      saveSettingsNow();
      setStatus("Push-to-talk hotkey set to " + hotkeyLabel(hotkey) + ".", "ok");
      return;
    }

    if (e.repeat) return;

    // F13/F14 are the AutoHotkey contract (CapsLock relay) — always active.
    if (e.code === "F13") {
      e.preventDefault();
      if (!recording && !stopping && !finishing) startRecording();
      else if (stopping || finishing) pendingStart = true; // PTT again while finalizing: queue it
      return;
    }
    if (e.code === "F14") {
      e.preventDefault();
      if (recording || stopRequested) stopRecording();
      // CapsLock released while a queued start was armed (or still pending a
      // finalize): a session starting AFTER the last F14 would violate the
      // contract — and open a mic nobody is holding.
      else cancelQueuedStart();
      return;
    }

    // In-app hotkey (default Ctrl+Space): tap toggles, hold is push-to-talk.
    if (hotkeyMatches(e)) {
      const t = e.target;
      const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      // An unmodified key (e.g. plain Space) must stay typable in form fields
      if (inField && !(hotkey.ctrl || hotkey.alt || hotkey.meta)) return;
      e.preventDefault();
      if (!recording && !stopping && !finishing) {
        hotkeyEngaged = true;
        hotkeyDownAt = Date.now();
        startRecording();
      } else if (stopping || finishing) {
        hotkeyEngaged = true;
        hotkeyDownAt = Date.now();
        pendingStart = true; // tap while finalizing queues the next dictation
      } else {
        hotkeyEngaged = false; // second tap: toggle off
        hotkeyDownAt = 0;
        stopRecording();
      }
      return;
    }
  });

  document.addEventListener("keyup", (e) => {
    if (capturingHotkey || !hotkey || !hotkey.code || e.code !== hotkey.code) return;
    if (!hotkeyEngaged) return;
    hotkeyEngaged = false;
    const held = hotkeyDownAt && Date.now() - hotkeyDownAt > HOTKEY_TAP_MS;
    hotkeyDownAt = 0;
    if (!held) return; // quick tap: keep recording, next tap stops
    if (stopping || finishing || pendingStartTimer) { cancelQueuedStart(); return; } // held through a finalize/queued window: don't auto-start an unheld mic
    stopRecording();
  });

  window.addEventListener("beforeunload", () => {
    try { releaseAudio(); } catch (e) {}
  });

  // Re-engage the mic when the app comes back: bfcache restores and slept
  // tabs can leave a dead MediaStream behind that looks alive.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) releaseAudio();
    if (!recording && !stopping) tryWarmOnLoad();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (recording || stopping || finishing) {
      acquireWakeLock(); // the OS auto-releases wake locks whenever the page hides
    } else {
      tryWarmOnLoad();
    }
  });

  // Standalone PWAs (iOS home-screen installs) sometimes fire only focus —
  // not visibilitychange — when switching back from another app.
  window.addEventListener("focus", () => {
    if (!recording && !stopping && !audioGraphHealthy()) tryWarmOnLoad();
  });

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      if (!recording && !stopping && !audioGraphHealthy()) {
        releaseAudio();
        tryWarmOnLoad();
      }
    });
  }

  if (SHARED_MODE) {
    passphraseRow.style.display = "";
    if (apiKeyLabelEl) apiKeyLabelEl.textContent = "ElevenLabs API key (optional — shared passphrase access in use)";
    apiKeyEl.placeholder = "optional — leave blank to use the shared passphrase";
    if (sonioxKeyLabelEl) sonioxKeyLabelEl.textContent = "Soniox API key (optional — shared passphrase access in use)";
    sonioxKeyEl.placeholder = "optional — leave blank to use the shared passphrase";
  }

  renderPresetRow(); // must precede loadSettings, which re-checks persisted presets
  loadSettings();
  applyEngineUI();
  updateGateLabels();
  updateKeytermHint();
  updateHotkeyUI();
  restoreLatestFromHistory();
  restorePhoneLink(); // resume/rejoin a persisted phone-link pairing
  applyBigButtonUI(); // after restorePhoneLink: a persisted/QR join boots straight into the big button
  updateAuthUI();
  if (authSectionEl) authSectionEl.open = !hasAuth(); // collapsed once credentials exist
  renderHistory();
  updateAppendChip();
  tryWarmOnLoad();
})();
</script>
</body>
</html>`;
