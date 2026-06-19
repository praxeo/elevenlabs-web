# Plan: kill the post-speech finalize latency (the delay AFTER the live text is done)

> For a fresh session. Repo: `C:\elevenlabs-web-\worker.js` (single-file CF Worker).
> Live: https://eleven.obert-john.workers.dev . Deploy = push to `main` (Workers Builds auto-deploys; poll `gh api repos/praxeo/elevenlabs-web-/commits/<sha>/check-runs`). Validate before every push: `node --check worker.js` + render the served `<script>` and `node --check` it + `node tests/flow.test.mjs`. Probe is gated by the app passphrase (`PROBE_KEY=sepsis`).

## STATUS (updated 2026-06-19) — what's landed vs what's open

**Landed (on `main`):**
- **Hybrid fast-finalize** (commit `4822e9a`): the batch refine starts the instant the tail ends; it no longer waits for the realtime engine's finalize.
- **Batch/upload-path cuts** (`[LATENCY]`-tagged in `worker.js`): `MediaRecorder.start(1000)` timeslice (flush the last <1 s, not the whole take), `precomputedBatchKeyterms` (the keyterm merge moved off the stop→upload critical path), a TLS pre-warm before the upload, and `BATCH_UPLOAD_TIMEOUT_MS` 30000 → 15000.
- **Step 1 (this change):** `TAIL_MS` 600 → **250**, `COMMIT_QUIET_MS` 350 → **150**. Pure-realtime post-release latency ~700 ms → ~350 ms. Flow tests retimed (scenario 12) + a trailing-partial anti-clip assertion added.

**Open:**
- **Step 2 (hybrid):** the batch refine (~2–4 s) is the remaining hybrid latency. Choosing 2a (tuned Soniox *is* the deliverable) vs 2b (optimistic two-phase delivery) is a **product decision** gated on the real-voice accuracy test — NOT yet made. 2b breaks "exactly one clipboard delivery"; don't build it silently.
- **Real-voice clipping check:** confirm the shorter `TAIL_MS` doesn't clip crisp word-endings on real dictation; bump to ~350 if it does.

> See also: `REALTIME_HANDOFF.md` (engine evolution + the AudioWorklet root-cause) and `CLAUDE.md` (session state machine, tuning constants, the finalize/upload latency optimizations).

## Problem
After the user stops speaking, the live (Soniox) words are already on screen, but there is a noticeable delay before the session finalizes and the text lands on the clipboard. "Too much latency and delay after the live transcription is finished."

## Diagnosis — MEASURED (do not re-derive; verify if you change the engine)
- **The engine is NOT the bottleneck.** On a real production WS, Soniox returns the committed transcript **~73 ms** after the commit and closes the socket **~84 ms** after commit. The full text is already present in the last partial *before* release (Soniox streams word-by-word).
- Therefore the post-speech delay is **entirely client-side**:
  - **Pure realtime (Soniox default):** `release → TAIL_MS(600ms) stream → send commit → ~85ms engine finalize/close → finalizeSession → deliver`. ≈ **~700 ms, dominated by TAIL_MS**. (`COMMIT_QUIET_MS` is mostly pre-empted because Soniox closes the backend socket right after `finished`, which the Worker forwards.)
  - **Hybrid:** `release → TAIL_MS(600ms) → batch refine (ElevenLabs Scribe v2 POST, ~2–4 s, `REFINE_TIMEOUT_MS`=8000 cap) → deliver`. ≈ **2–4 s, dominated by the batch refine**. (Session 3 already removed the old "wait for realtime finalize before batch" stall.)

Constants (worker.js ~1914-1937, **post-Step-1**): `TAIL_MS=250`, `FINAL_WAIT_MS=2500`, `COMMIT_QUIET_MS=150`, `REFINE_TIMEOUT_MS=8000`, `BATCH_UPLOAD_TIMEOUT_MS=15000`, `PREROLL_MS=400`.

## Step 0 — confirm the mode + instrument the finalize timeline (do this FIRST)
1. Ask/confirm which engine+mode the user runs when they feel the delay: **pure Realtime (Soniox)** vs **Hybrid**. The fix is different.
2. ✅ **DONE (2026-06-19).** `?debug=1` now prints, to the on-screen `rtDebugLog` overlay (DevTools-free), both:
   - a **live audio-cadence heartbeat** (`[audio …] pump=worklet|scriptprocessor framesSent=… partials=… wsBuffered=…`, ~1/s while recording) — distinguishes a stalled **pump** (framesSent flatlines) from a stalled **engine** (framesSent climbs, partials don't), and a growing `wsBuffered` flags main-thread/network send backpressure (the ScriptProcessor-starvation tell); and
   - a **finalize timeline** via `dbgPhase()` — `[phase …] … (+Nms since release)` at `stopRecording` (release), tail-timer fire, commit send, final committed arrival, `finalizeSession`, batch-refine POST start/return (hybrid), and `deliverFinalText`. One real dictation shows exactly where the post-release ms go. The pump kind is also tee'd to the overlay at session start (`[audio] AudioWorklet pump active` vs `!! … FALLBACK to ScriptProcessor pump`), so the live-stall root cause from Session 2 is visible without DevTools.

## Step 1 — pure realtime (Soniox): cut the client finalize constants  ✅ DONE (2026-06-19)
Soniox finalizes in ~85 ms and the text is complete at release, so the conservative constants tuned for old engines are now pure overhead. **Landed:** `TAIL_MS` 600→250, `COMMIT_QUIET_MS` 350→150 in `worker.js`; flow-test timing updated (scenario 12 retimed for the shorter tail) + a trailing-partial anti-clip assertion added. The rationale and the anti-clipping caveat below stand as the record.
- **worker.js:1915** `TAIL_MS` 600 → **250** (Soniox streams continuously and the user releases *after* finishing, so trailing audio is minimal; 250 ms still covers the in-flight ~85 ms frame + a hair).
- **worker.js:1917** `COMMIT_QUIET_MS` 350 → **150** (Soniox usually closes the backend socket itself ~85 ms post-commit, pre-empting this; lower it so the path that *does* rely on it is snappy).
- Leave `FINAL_WAIT_MS=2500` (it's only the safety deadline; committed arrives in ~73 ms so it never bites).
- Net expected: post-release ~700 ms → **~350 ms**.
- **Verify no clipping** (the reason TAIL exists): with the harness, transcribe a clip that ends mid-word at TAIL 600 vs 250 and confirm the last word survives; and have the user dictate a few notes ending crisply. If a clipped tail ever appears, bump TAIL to ~350. Keep `capturePcm`/hybrid byte math intact (TAIL only changes how long capture continues).
- These are per-engine-agnostic but tuned for Soniox; if the user switches back to `?rt=el` (EL finalize is slower/heavier), consider a slightly larger TAIL. Optional: make TAIL/COMMIT_QUIET engine-aware (smaller for Soniox).

Optional deeper win (only if Step 1 isn't enough): Soniox supports a manual `{"type":"finalize"}` control frame that forces immediate finalization without closing. Current code sends only the empty-string end-of-audio on commit (sonioxClientToBackend, ~line 374) — which already finalizes in ~85 ms, so this is likely unnecessary. Measure before adding.

## Step 2 — hybrid: the batch refine is the delay (this is the real "too much latency" case)
The hybrid clipboard is the ElevenLabs Scribe v2 **batch** re-transcription (~2–4 s after the tail) — that latency buys batch-tier accuracy. You cannot make the batch itself instant. Options, pick based on the **morning real-voice accuracy test** (`.test/accuracy-matrix.mjs --real`, WER + term-recall, scores Soniox vs EL vs batch on his audio):

- **2a (preferred if Soniox clears his accuracy bar):** make **pure Realtime (Soniox)** the deliverable and drop hybrid for daily use. With Step 1, delivery is ~350 ms after release and the text is already correct. Run the batch only as an optional background "verify" that flags discrepancies (no clipboard rewrite). This is the fastest path and preserves one-delivery.
- **2b (if batch accuracy is required):** keep hybrid but **optimistic two-phase delivery** — deliver the Soniox final to the clipboard immediately (paste-ready in ~350 ms), run the batch refine in the background, and when it returns: update the on-screen box to the refined text + a distinct cue (warnBeep/▲) and, only if it differs, re-copy. ⚠ This BREAKS "exactly one clipboard delivery" and risks a double-paste into Cerner — it is a **product decision**, not a silent change. If adopted, gate it behind a setting and make the second copy loud + bounded (e.g., only within N seconds, only if the box wasn't already pasted). Discuss with the user before building.
- **2c:** shave the fixed parts only — TAIL 600→250 (Step 1) also helps hybrid; the batch POST itself has little headroom.

Recommendation: do Step 1 now (unconditional win), then let the morning accuracy test decide 2a vs 2b. Most likely outcome: **2a** (Soniox tuned is good enough → instant delivery), with hybrid kept available for high-stakes notes.

## Verification
- `node --check worker.js`; render+check the served `<script>`; `node tests/flow.test.mjs` (the scenario-12 hybrid timing and any tail/commit-timing assertions may need updating in the SAME change — search flow.test.mjs for `TAIL`, `COMMIT_QUIET`, sleep values around the realtime/hybrid finalize and adjust to the new constants).
- Re-measure post-release latency on a real WS (reuse the harness pattern in this session: stream a `.tts/*.16k.pcm`, timestamp commit→committed→close) and confirm the client-side total dropped.
- Real-voice: have the user dictate; confirm the clipboard lands fast AND the last word isn't clipped.

## Invariants — do not break (CLAUDE.md)
- Loud failure (sentinel + failBeep) on any failure; never a silent/blank chart.
- Exactly ONE clipboard delivery + one outcome beep per session (this is the crux of Step 2b — don't violate it without the user's explicit OK).
- Anti-clipping: TAIL exists so the last word isn't cut — verify after lowering it.
- Inside `INDEX_HTML`: no backticks / `${...}` (even in comments); double-escape client regex backslashes.
- Batch/hybrid clipboard accuracy path stays ElevenLabs Scribe v2 — don't degrade it for speed.

## Exact code locations
- Constants: worker.js ~1914-1926 (`TAIL_MS`, `FINAL_WAIT_MS`, `COMMIT_QUIET_MS`, `REFINE_TIMEOUT_MS`).
- `stopRecording` (tail timer) ~3228; `beginCommitPhase` ~3265; the realtime `committed_transcript` handler + quiet timer ~2967; `finalizeSession` ~3287; `refineAndDeliverHybrid` ~3340; `deliverFinalText` (search).
- Soniox config + commit (empty-frame end-of-audio): sonioxClientToBackend ~line 374, sonioxConfig in handleTranscribeRealtime (~651).
- `rtDebugLog` overlay (Step 0 timestamps): search `rtDebugLog` / `RT_DEBUG`.
- Harness: `.test/accuracy-matrix.mjs` (--real), `.test/wer.mjs`, `.test/term-recall.mjs`, `.tts/` corpus, `/api/nova-probe` (transport el/soniox).
