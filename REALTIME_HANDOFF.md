# Realtime STT Investigation — Handoff

> **Purpose:** restart context for getting **good live/interim realtime speech-to-text**
> working in this medical dictation app **via Cloudflare** (Workers AI / AI Gateway).
> Batch works great; realtime/hybrid is the goal that keeps slipping. This doc is the
> ground truth from a very long live-debugging session so the next session doesn't repeat it.

---

## ✅ CURRENT STATE (2026-06-19) — read this first

**Realtime default = Soniox `stt-rt-v5`.** This is an append-log: the Session 3 entry just below is current; everything from **"TL;DR"** downward (Nova-3 binding, the `sample_rate` hypothesis, the AI-Gateway transports) is the **historical investigation record**, kept for the root-cause trail — *not* the live engine. `?rt=el` = ElevenLabs Scribe v2 Realtime; `?rt=binding`/`flux`/`gw`/`dgw` = the relegated Deepgram fallbacks. Batch + the hybrid clipboard = ElevenLabs Scribe v2.

**Latency ground truth — MEASURED on a real WS (do NOT re-derive; re-measure only if you swap the realtime engine, and don't confuse it with the ~0.75 s *first-word* latency):** after PTT release Soniox returns the committed transcript **~73 ms** later and closes the socket **~84 ms** later, and the full text is already on screen *before* release. So the engine is not the post-speech delay — the client constants were. We cut `TAIL_MS` 600→250 and `COMMIT_QUIET_MS` 350→150, and shortened the batch-upload path (`start(1000)` timeslice recorder, precomputed batch keyterms, TLS pre-warm, `BATCH_UPLOAD_TIMEOUT_MS` 30→15 s); the hybrid refine also no longer waits for the realtime finalize. Full breakdown + the remaining (product-level) hybrid-delivery decision live in **`LATENCY_PLAN.md`**.

---

## ☀️ SESSION 3 (2026-06-17 late) — engines swapped + accuracy push; MORNING TEST READY

**The big realtime bugs are fixed (AudioWorklet, noise suppression — see Session 2). This session swapped engines and pushed accuracy.** Current state:

**Engines (realtime transport via `?rt=`):** DEFAULT = **Soniox stt-rt-v5** (fastest live feedback: ~0.75s first word, word-by-word). `?rt=el` = ElevenLabs Scribe v2 Realtime. `?rt=binding`/`nova`/`flux`/`gw`/`dgw` = Deepgram. Batch (clipboard in batch/hybrid mode) = ElevenLabs Scribe v2 (unchanged, top accuracy).

**THE PRODUCTION ANSWER (verified by the accuracy workflow against the code): use HYBRID.** In hybrid the clipboard text is the **ElevenLabs Scribe v2 BATCH** re-transcription of the captured audio (full 1000-term keyterms, temperature=0, language=en, single-speaker — already optimal), i.e. ~batch-tier accuracy (~5–6% WER class), a tier above ANY streaming engine. The live feed (Soniox) is **inherently** below batch accuracy because streaming has no right-context — that gap is structural, not a config bug, so don't expect the live text itself to be production-grade. **Hybrid = fast Soniox feedback for your eyes + batch-grade text on the clipboard.** The hybrid end-latency was fixed (the refine no longer waits for the realtime finalize). NOTE: `DEFAULT_ENGINE` is still `"batch"` (worker.js) — you must SELECT Hybrid (or we flip the default; see below).

**Accuracy changes deployed tonight (live-feed, all reversible):**
- Soniox config tuned for PTT dictation: `enable_endpoint_detection:false` (PTT gives the end; endpointing was finalizing mid-sentence and losing context), `language_hints_strict:true`, richer `general` context (specialty/setting/style), + an 8000-char context budget guard. Probe-verified accepted (no errors, first word ~740ms).
- Lifted the **50-term/20-char keyterm throttle** on the Soniox path (was a real bug — only 50 terms reached the engine). Soniox now gets the full preset list (≤300 terms, char-budget-guarded); `?rt=el` keeps the 50/20 cap.
- Added high-mangle ER drug names (ondansetron/Zofran, ketorolac/Toradol, Zosyn, etc.) to the ER keyterm preset (additive; helps the hybrid clipboard + Soniox live).

### ☀️ MORNING — do these (in order)

1. **Try HYBRID at natural pace.** Hard-reload, select **Hybrid**, dictate a real note. Judge the **clipboard** text (that's the batch deliverable, your production candidate), not the live feed. Soniox live text is just feedback.
2. **Measure accuracy on YOUR voice** (the decisive step — TTS can't reproduce your real-speech gap). Record 5–10 real dictations, then:
   ```sh
   # convert each recording to 16k mono PCM (from the app's audio download or any recorder):
   ffmpeg -i note1.webm -ac 1 -ar 16000 -f s16le .real/note1.16k.pcm
   # write the ground truth + the must-get terms next to it:
   #   .real/note1.txt    = what you actually said
   #   .real/note1.terms  = comma list of drugs/doses/wound terms that MUST survive
   $env:PROBE_KEY="sepsis"; node .test/accuracy-matrix.mjs --real
   ```
   It scores **Soniox vs ElevenLabs vs the batch deliverable** on your audio with **WER + medical-term-recall** (a mangled drug name barely moves WER but is clinically critical — term-recall is the decision metric). This proves whether hybrid-batch clears your production bar.
3. **A/B the mic settings** (per-device, big potential win): noise suppression ON vs OFF and autoGainControl false vs true on YOUR mic/room. Modern STT sometimes does BETTER with browser noise-suppression OFF on a close mic — but this session already saw a WIN with it ON, so test, don't assume. (These are local per-device settings.)
4. **Decide:** if hybrid-batch clears your bar (it should), say so and I'll set **Hybrid as the default engine** (it's `DEFAULT_ENGINE` in worker.js; flipping affects only fresh profiles) and frame the live text as "feedback" in the UI. If you want the live feed itself tuned further, the harness from step 2 makes it data-driven.

**Open items I did NOT auto-change (your call):** DEFAULT_ENGINE batch→hybrid; noiseSuppression/AGC defaults (per-device A/B). **Cleanup later:** remove `/api/nova-probe` + the `.test/`/`.tts/`/`.real/`/`.wf-*.mjs`/`.dsp-test.mjs` scratch (gitignored).

---

## ✅ SESSION 2 RESULT (2026-06-17) — ACTUAL ROOT CAUSE FOUND & FIXED

**The realtime garble was the AudioWorklet never loading.** It was loaded from a **Blob URL**; on the real browser `addModule(blobUrl)` resolved but did NOT register the processor (`new AudioWorkletNode(ctx,"pcm-pump")` → `InvalidStateError: node name 'pcm-pump' is not defined`), so every session silently fell back to the deprecated main-thread **ScriptProcessor**, which starves under UI load and drops audio frames → "slow, laggy, useless" live transcription. Batch was always immune (MediaRecorder is off-thread). Confirmed by the user's live console + the hybrid test (clipboard clean, live text useless). The s27 flow test never caught it because it **mocks** `addModule`/`AudioWorkletNode`.

**FIX (deployed, commit `2fc2852`):** serve the worklet as a **real same-origin module at `GET /pcm-pump.js`** and `addModule()` that URL first (Blob second, ScriptProcessor last), each logging which path is active. Retest: hard-reload the app and confirm the console shows **`[audio] AudioWorklet pump active (/pcm-pump.js)`** — then dictate at natural pace.

**Hypotheses RULED OUT (don't re-chase):** sample_rate IS honored (probe: perfect at 16000, garble at 8000/48000); the box-filter downsample is fine (matches ffmpeg on TTS); the client downsample is honest (Node proof). The opt-in `?rt=flux/gw/dgw` transports + `/api/nova-probe` below remain available but were built under the (wrong) sample-rate hypothesis — keep them as fallbacks only if the worklet fix proves insufficient. Side note: the nova-3 binding throws frequent `AiError 5030` under rapid connects (reliability watch-item).

---

## ⭐ SESSION 2 UPDATE (2026-06-17) — (earlier in the session) sample-rate hypothesis, probe + opt-in transports

**What changed this session (all on `main`, auto-deployed, production verified healthy):**

1. **The client audio pipeline is NOT the bug — proven.** Ported `downsampleBuffer` to Node and fed it known sine tones at 48 kHz and 44.1 kHz, per-frame (4096-sample frames) exactly as `handleAudioFrame` does. Result: **drift −0.024 % (no time-compression), frequency preserved (440→439.6 Hz), no frame-boundary clicks.** The pump produces honest, correctly-timed 16 kHz PCM. (`.dsp-test.mjs` — run `node .dsp-test.mjs`.) ⇒ The hybrid clipboard (`buildWavBlob(pcm,16000)`→ElevenLabs) *should* be clean; the garble is **downstream of capture**.

2. **Root cause (medium-high confidence): the `@cf/deepgram/nova-3` Workers-AI binding silently DROPS `sample_rate`.** A multi-agent research workflow (21 agents, adversarially verified against primary docs) found: nova-3's `schema-input.json` has **no `sample_rate` property**, while the **sibling Flux schema REQUIRES it** — proving Cloudflare forwards `sample_rate` *only when the model declares it*. Deepgram needs `sample_rate` for raw/headerless `linear16` and applies its own default if absent (commonly 24000). Decoding genuine-16 kHz audio as 24 k/48 k = "plays too fast" = **the exact "slow=clean / fast=garbled" signature**, and it's the one mechanism consistent across all 4 engines (shared declared-but-unhonored-rate contract). No Deepgram formatting flag (smart_format/punctuate/numerals/endpointing) causes word-level garble.

3. **Deployed fixes — all opt-in, default realtime path BYTE-IDENTICAL (zero regression):**
   - **`?rt=` realtime transport selector** in `handleTranscribeRealtime` (and the client forwards `?rt=` from the page URL):
     - `auto`/absent → **nova-3 binding (current behavior, unchanged)**.
     - `rt=flux` → `@cf/deepgram/flux` on the **same `env.AI` binding, NO new credential**; Flux's schema *requires* `sample_rate` so CF forwards it — directly tests+cures the rate hypothesis.
     - `rt=gw` → AI Gateway **`workers-ai`** URL for nova-3 with `sample_rate` in the query string (needs `CF_ACCOUNT_ID`+`CF_AIG_GATEWAY`+`CF_AIG_TOKEN`).
     - `rt=dgw` → AI Gateway **`deepgram`** passthrough to **`nova-3-medical`** (the clinical streaming model that 500s on the binding; needs the above + `DEEPGRAM_API_KEY`).
     - Gateway paths **loud-fail until their secrets exist**, so nothing changes in prod until you opt in. Keyterms use the correct **repeated `&keyterm=`** form on query-string transports (the binding's single space-joined `keyterm` was wrong per Deepgram docs).
   - **`/api/nova-probe`** (re-added, capability-gated): streams caller-supplied 16 kHz PCM to a chosen model at a controllable `sample_rate`/cadence/encoding, returns the transcript. **Gated by your existing `APP_PASSPHRASE`** (or a `PROBE_KEY` secret) — no new secret needed. **REMOVE after the investigation.**
   - One-time client diagnostic: logs `audioCtx.sampleRate` (warns if ≠ 48000).

4. **Why I could not run the billed test autonomously:** the local wrangler OAuth token **cannot write secrets** (`Authentication error 10000`) and **cannot run `wrangler dev`'s remote AI proxy** (edge-preview blocked), and I won't leave an unauthenticated billed AI endpoint exposed on a production medical app overnight. So the probe is gated by `APP_PASSPHRASE` and is **ready for you to run in one command.**

### ☀️ MORNING QUICK START (do these in order)

> Test harness lives in `.test/` and `.tts/` (10 medical sentences synthesized via Windows SAPI → 16 kHz PCM, incl. the known failure "sepsis and a heart rate of 112"). WER scorer normalizes number-words. PowerShell: use `$env:PROBE_KEY="..."` instead of the inline `PROBE_KEY=...`.

1. **THE DECISIVE TEST — is `sample_rate` honored?** (uses your app passphrase as the key)
   ```sh
   cd C:\elevenlabs-web-
   PROBE_KEY="<your APP_PASSPHRASE>" node .test/run-probe.mjs ratecheck
   ```
   Sends the **same** 16 kHz audio declared as 8000/16000/24000/48000 to nova-3.
   - **A wrong declaration (24000/48000) scoring much better than 16000, or all garbled alike ⇒ the binding DROPS `sample_rate` ⇒ root cause CONFIRMED ⇒ use `rt=flux` / `rt=gw` / `rt=dgw`.**
   - **16000 clearly best, others degrade monotonically ⇒ binding HONORS rate ⇒ rate is NOT the bug ⇒ pivot** (Flux model quality, downsample continuity, keyterms).
2. **nova-3 vs Flux:** `PROBE_KEY="<pass>" node .test/run-probe.mjs model`  ·  **pace sweep:** `... pace`  ·  **everything:** `... full`
   (`raw_first_frames` in the JSON reveals Flux's real frame shape if the translator needs tuning.)
3. **Live-test Flux (no secret):** open **`https://eleven.obert-john.workers.dev/?rt=flux`** and dictate at natural pace. Clean ⇒ Flux is the fix; promote it to default in `handleTranscribeRealtime` (drop the `?rt=` gate) + extend `flow.test.mjs`.
4. **AI Gateway nova-3 (honored rate, no Deepgram key):** create an AI Gateway in the CF dashboard; set vars/secrets **via the dashboard** (Workers&Pages → eleven → Settings → Variables) — the local wrangler token can't: `CF_ACCOUNT_ID=ea078f12e66a1bab34c49f57e179c95c`, `CF_AIG_GATEWAY=<name>`, `CF_AIG_TOKEN=<AI Gateway auth token>`. Then open `?rt=gw`.
5. **nova-3-medical (biggest clinical win):** also add `DEEPGRAM_API_KEY` (paid Deepgram acct), then `?rt=dgw`.

**Ranked recommendation:** (1) run the probe to confirm; (2) if confirmed, try **`?rt=flux`** first (zero setup); (3) for production, prefer **`rt=dgw` nova-3-medical** if you'll provision a Deepgram key (clinical model + guaranteed-honored rate), else **`rt=gw`**. Keep **hybrid** as the clipboard deliverable throughout — it's the chart-text safety net and is unaffected.

**Cleanup when done:** remove `/api/nova-probe` (+`handleNovaProbe`/`wavHeaderBytes`/route) and the `.dsp-test.mjs`/`.test/`/`.tts/`/`.wf-realtime-research.mjs`/`.dev.vars` scratch (all git-ignored or untracked).

---

## TL;DR

- **Realtime currently runs on Deepgram Nova-3 via Cloudflare Workers AI** (`env.AI.run("@cf/deepgram/nova-3", cfg, {websocket:true})`). It **connects and streams** with live partials + punctuation + numbers, edge-hosted.
- **THE CORE PROBLEM:** accuracy is **only good when you dictate slowly**. At natural speaking pace it garbles — even plain English (e.g. *"sepsis and a heart rate of 112"* → *"a set of to set an a 112"*; numbers + punctuation survive).
- **This pace-sensitivity has appeared on EVERY streaming engine tried** (ElevenLabs Scribe Realtime → Mistral Voxtral → Soniox → Deepgram Nova-3), while **batch (ElevenLabs Scribe v2) reads clean every time.** Batch uses a *completely different audio path* (MediaRecorder webm) than realtime (a live PCM pump). → **Prime suspect: the streaming audio pipeline, not the engine.**
- **Chosen next direction:** try Nova-3 through the **Cloudflare AI Gateway realtime WebSocket URL** (not the binding) — full native Deepgram query-param surface (proper `sample_rate`, possibly `nova-3-medical`). **AND** investigate the audio pipeline, since that's the cross-engine common factor.

---

## What the next session should do (the ask)

Spin up a **multi-agent workflow** that investigates and proposes **several concrete solutions** to get **fast + relatively accurate interim/realtime STT through Cloudflare**. Constraints:

- **Must stay on Cloudflare** (Workers AI and/or AI Gateway). Batch stays on ElevenLabs and is untouched.
- **Fast + relatively accurate at natural dictation pace** is the bar.
- Preserve the app's client **frame vocabulary** (`session_started` / `partial_transcript` / `committed_transcript` / `error`), the **one-delivery-per-session** and **loud-failure** invariants, and the phone-link mirroring.

Candidate avenues for the agents (verify against live Cloudflare + Deepgram docs AND the code):

1. **External-URL WebSocket** instead of the `env.AI` binding (passes the FULL native Deepgram query-param surface → likely honors `sample_rate` correctly and may allow `model=nova-3-medical`). **Auth = a Cloudflare API token (NOT a service token, NOT a Deepgram key).** Two flavors (verified against live docs 2026-06-16):
   - **AI Gateway:** `wss://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY_NAME}/workers-ai?model=@cf/deepgram/nova-3&encoding=linear16&sample_rate=16000&interim_results=true&...` with header `cf-aig-authorization: <CF_API_TOKEN>`. Requires creating a named AI Gateway in the dashboard. Docs: <https://developers.cloudflare.com/ai-gateway/usage/websockets-api/realtime-api/>.
   - **Direct Workers AI:** `wss://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/@cf/deepgram/nova-3?encoding=linear16&sample_rate=16000&interim_results=true&...` with header `Authorization: Bearer <CF_API_TOKEN>` (the Aura TTS example uses this form). No gateway needed.
   - Token: create at dash → My Profile → API Tokens, permission **Workers AI** (+ **AI Gateway** for the gateway flavor). Store as a Worker secret (e.g. `CF_AI_TOKEN`); the Worker makes the outbound WS server-side. Account ID = `ea078f12e66a1bab34c49f57e179c95c`. No Deepgram key (the model is Workers-AI-hosted, billed by CF). NOTE: the WS params on these URLs are the native Deepgram query string, so booleans are `interim_results=true` (string in the URL anyway), and `sample_rate=16000` is the real Deepgram param.
2. **AUDIO PIPELINE (highest-value suspect).** Why does the live PCM pump garble at pace while batch's MediaRecorder audio is clean? Investigate sample-rate correctness, gain/levels, the averaged-downsample anti-aliasing, and frame cadence. **Decisive diagnostic that already exists in-app:** *hybrid mode* re-transcribes the **exact captured streaming PCM** through ElevenLabs batch (`buildWavBlob(sessionPcm)`). If that hybrid-refine output is **clean**, the streaming PCM is fine and the realtime *engines* are the limit. If it's **garbled**, the streaming audio capture is the bug → fix the pump and ALL engines improve. **Run this test first.**
3. **Sample-rate / speed artifact.** "Slow = clean, fast = garbled" is the classic signature of a rate/speed mismatch. Confirm whether the binding actually honors `sample_rate:"16000"` (nova-3's input schema has NO `sample_rate` field — only Flux's does). Test alternate rates / declaring rate via the AI Gateway query string / sending a containerized format (WAV) that self-describes the rate.
4. **Other Cloudflare realtime STT options:** `@cf/deepgram/flux` (built for streaming, but turn-based; earlier dictation test was rough), Cloudflare **RealtimeKit** transcription (which itself runs Nova-3 on Workers AI — see how it feeds audio), Whisper (batch only, not streaming), any newer partner STT.
5. **Best-practice Deepgram streaming config for dictation** (endpointing off vs tuned, interim_results, encoding, utterance handling) for natural-pace continuous speech.

The workflow should return a **ranked set of concrete, implementable proposals** (with the exact config/URL/code shape and the expected effect), then we implement + live-test the top one.

---

## App architecture (essentials)

- **One file:** `worker.js` (~4100 lines) = the Cloudflare Worker fetch handler **+** the entire client app embedded in the `INDEX_HTML` template literal (vanilla JS, no build step). **Inside `INDEX_HTML`: never use backticks or `${`** (it's a template literal — they terminate/interpolate it, *including in comments*). Client regex/string backslashes are double-escaped.
- **Repo:** `praxeo/elevenlabs-web-`, worker name **`eleven`**, live URL **<https://eleven.obert-john.workers.dev>**.
- **Deploy:** **Cloudflare Workers Builds auto-deploys on push to `main`** (no manual `wrangler deploy`). There is no preview URL configured — pushing to `main` = production. Flow used: edit → `node --check` + render-served-script check + `node tests/flow.test.mjs` → commit → push `main` → poll the `Workers Builds: eleven` check on the commit via `gh api repos/praxeo/elevenlabs-web-/commits/<sha>/check-runs`.
- **Account ID:** `ea078f12e66a1bab34c49f57e179c95c` (from the build dashboard URLs).
- **Three engines:** **Realtime** (Deepgram Nova-3 / Workers AI), **Batch** (ElevenLabs Scribe v2 — WORKS WELL), **Hybrid** (realtime live text as feedback; ElevenLabs batch re-transcription of the same audio is the clipboard deliverable).
- **Shared mode is ON** for this deployment (`APP_PASSPHRASE` set) — users enter only the passphrase; batch uses the server `ELEVENLABS_API_KEY`. Realtime (Nova-3) needs **no STT key** — it uses the `[ai]` binding (`binding = "AI"` in `wrangler.toml`), gated by the passphrase.
- **Client → Worker frames:** `{message_type:"input_audio_chunk", audio_base_64, commit, sample_rate:16000}`; final flush sets `commit:true`. **Worker → client frames the client understands:** `session_started {config}`, `partial_transcript {text}`, `committed_transcript {text}`, `error {error}` (ANY frame with a string `error` triggers the loud-fail path). Keep this vocabulary so the client barely changes.
- **Audio pump:** 48 kHz float (AudioWorklet `pcm-pump`, 4096-sample/~85 ms frames; ScriptProcessor fallback) → `downsampleBuffer` (averaging) to 16 kHz → `floatTo16BitPCM` (s16le) → base64 → Worker `b64ToBytes` → **binary WS frames** to the engine. Batch instead records post-gate via **MediaRecorder (webm)** — the clean path.

---

## VERIFIED GROUND TRUTH (the gold — don't re-derive these)

### Workers AI Nova-3 binding behavior
1. **`env.AI.run("@cf/deepgram/nova-3", cfg, {websocket:true})` works** — on success it returns a `Response` whose `.webSocket` is the backend socket the Worker can `accept()` and translate in the middle. (Cloudflare's docs only ever show `return resp` passthrough; the middle-layer translation is undocumented but **confirmed working**.)
2. **🔑 THE BINDING 500s (`AiError` internalCode 5030) ON BOOLEAN/NUMBER PARAM VALUES — every value must be a STRING.** `interim_results:true` → 500; `interim_results:"true"` → OK. (Cloudflare's Flux example passes `sample_rate:"16000"` as a string — the tell.) This single gotcha caused a dozen failed deploys.
3. **Params that WORK (as strings):** `encoding:"linear16"`, `sample_rate:"16000"`, `language:"en-US"`, `interim_results:"true"`, `smart_format:"true"`, `punctuate:"true"`, `numerals:"true"`, `endpointing:"false"`, `channels:"1"`, `keyterm:"<string>"`.
4. **`mode:"medical"` 500s even as a string** — the **medical model variant is NOT available on the streaming binding**. (Confirmed via a probe of `mode_medical` and `full_str_medical` both 500ing while `full_str_general` is OK.) nova-3's Cloudflare `schema-input.json` lists `mode` enum `[general,medical,finance]` but it doesn't work over `{websocket:true}`.
5. **nova-3's `schema-input.json` has NO `sample_rate` property** (only Flux's schema does). Passing it doesn't 500, but it's unclear whether it's **honored** — see the speed/rate hypothesis.

### Deepgram-on-Workers-AI streaming protocol (observed live)
- First frame: **`{type:"Connected", request_id, sequence_id}`** — handshake; ignore it.
- Transcript frames: **`{type:"Results", channel:{alternatives:[{transcript, ...}]}, is_final, speech_final}`** (Deepgram-native shape). Parse `channel.alternatives[0].transcript`; **don't hard-gate on `type==="Results"`** (Cloudflare's example keys off `channel.alternatives`).
- End: **`{type:"Metadata", request_id, ...}`** after `CloseStream`.
- **Control frames TO Deepgram:** only **`{type:"CloseStream"}`** is accepted. **`{type:"KeepAlive"}` and `{type:"Finalize"}` are REJECTED** ("Could not deserialize ... unknown variant, expected `CloseStream`") — sending them kills the stream. On PTT release (`commit`), send **only `CloseStream`**.

### Translator design that's correct (already implemented)
- `makeNova3ToClient(tier)`: emit `session_started {config:{tier}}` on first frame; accumulate `is_final` text into `finalText`, emit a running `partial_transcript` each frame; emit **`committed_transcript` ONCE on `Metadata`** (NOT per `speech_final` — the client *appends* every committed frame, which duplicated cumulative text into "hello hello world"). Ignore `Connected`/`SpeechStarted`/`UtteranceEnd`; any string `error` → loud error; unknown frames → ignore (don't fabricate text, don't fail loudly).
- `novaClientToBackend`: base64 audio → binary PCM; on `commit` → `[{type:"CloseStream"}]` only.

### The accuracy problem (the unsolved crux)
- **Clean when dictated slowly; garbled at natural pace.** Numbers, punctuation, capitalization, and short common words survive; clinical terms AND some plain English ("heart rate") garble at speed.
- **Same pattern across ALL streaming engines** (Scribe Realtime, Voxtral, Soniox, Nova-3). **Batch is always clean.** → strongly implicates the **streaming audio pipeline** (common to all realtime engines) over any single engine.
- `mode:"medical"` being unavailable hurts clinical vocabulary, but it doesn't explain plain-English garble at pace — so keyterms alone likely won't fix it.

---

## Current deployed config (on `main`)

Realtime connect config (in `handleTranscribeRealtime`, all string values):
```js
{
  encoding: "linear16",
  sample_rate: "16000",
  language: "en-US",
  interim_results: "true",
  smart_format: "true",
  punctuate: "true",
  numerals: "true",
  endpointing: "false",
  keyterm: "<space-joined keyterms, if any>"
}
// model: "@cf/deepgram/nova-3", opened via env.AI.run(model, cfg, {websocket:true})
// fallback tier "bare": { encoding:"linear16", sample_rate:"16000" } (finals only)
```

The status line shows `(live)` or `(bare)` — which tier opened.

---

## Key code locations in `worker.js`

- **Realtime handler:** `handleTranscribeRealtime` (~line 314) — auth/passphrase gate, the connect `tiers` + `liveCfg`, audio forward loop, translator wiring, close handling.
- **Translator + wire mapping (exported for tests):** `novaClientToBackend`, `makeNova3ToClient` (~lines 196–312).
- **Model id:** `NOVA3_MODEL = "@cf/deepgram/nova-3"`.
- **Batch (untouched, ElevenLabs):** `handleTranscribeBatch`.
- **Client (in `INDEX_HTML`):** audio pump `handleAudioFrame` / `downsampleBuffer` / `floatTo16BitPCM` / the AudioWorklet `pcm-pump` source / `buildWavBlob` (hybrid PCM→WAV); WS open + params (`/api/transcribe?...`); `session_started` handler (shows the `(tier)`); credential check (realtime needs no STT key); the Advanced "Realtime (Deepgram Nova-3 on Workers AI)" section.
- **`wrangler.toml`:** has `[ai] binding = "AI"` and the `SESSION_ROOM` durable object.
- **Tests:** `tests/flow.test.mjs` — scenario **s26** covers the Nova-3 translator (string-value note, Connected/Metadata/CloseStream, no-dup commit, loose parser). Run: `npm install --no-save jsdom jsqr && node tests/flow.test.mjs`. Validate served script: render `INDEX_HTML` via `default.fetch` and `node --check` the inline `<script>`.

## Diagnostic tooling used this session (removed, but re-addable)
- A temporary **`/api/nova-probe`** GET endpoint opened nova-3 with each candidate config server-side and returned an OK/500 matrix — *this is how the string-value gotcha and `mode:medical` failure were found in one shot*. It was removed after use. **Re-add a probe like this** to test AI-Gateway-URL configs / rates quickly without per-deploy guessing. (When shared mode is on, either gate it on `?passphrase=` or temporarily un-gate to read it via a plain GET.)

---

## Git state note
This debugging happened with **direct commits to `main`** (live-debug loop), not the usual branch→PR flow. The Nova-3 migration originally landed via PRs #21/#22 (Soniox-era, later reverted) and the Soniox→Nova-3 swap PR #23, then many direct `main` commits. The branch `claude/nova3-realtime` exists. Consider squashing/cleaning the realtime history once a working approach is locked.
