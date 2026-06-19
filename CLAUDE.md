# CLAUDE.md

Guidance for AI/dev sessions working in this repo. Read this before touching `worker.js`.

## What this is

> **⚑ BATCH-ONLY product (Realtime + Hybrid REMOVED 2026-06-19).** Batch is the deliverable — "fast and amazingly accurate". The three-engine era (Realtime/Hybrid/direct-stream/Soniox/Deepgram) was **deleted** (worker.js 5520→3359). The full realtime investigation + a git resurrection pointer live in **`REALTIME_HANDOFF.md`** — the door is open, but this codebase is batch. There is **no engine selector** and no `sessionEngine` branching that matters (it's always `"batch"`); `loadSettings` migrates any saved engine to `"batch"`.

A one-file Cloudflare Worker. The whole product:

- **Push-to-talk → Batch.** On release, the **post-gate `MediaRecorder` webm** uploads to **ElevenLabs Scribe v2 batch** (`handleTranscribeBatch`) and the accurate transcription lands on the clipboard. In batch the **noise gate is load-bearing**: the post-gate recording *is* what gets transcribed. Locked to the best single-speaker medical config (`temperature=0`, `language_code=en`, `num_speakers=1`, `diarize=false`).
- **Live capture feedback** (`#recFeedback`) — while recording: a scrolling voice **waveform** (canvas, driven by the analyser the gate already runs), a **"Hearing you"** indicator (gate open = speech vs silence), and an **elapsed timer**. No STT cost/latency, nothing leaves the device — it just proves the dictation is capturing. Driven from the 30 ms gate-meter loop (`showRecFeedback`/`updateRecFeedback`/`drawWave`); hidden on finalize.
- **Phone link** — dictate on the phone, the text lands on the desktop clipboard. The phone dictates **in batch** and POSTs the final text to `/api/session/<code>/deliver`; the desktop holds a listener WS to the `SessionRoom` and writes its clipboard on `phone_delivery`. (The retired realtime "live mirror" is gone; the delivery + resilience contract stays — see the Phone link section.)

Users are clinicians doing push-to-talk dictation into Cerner/Citrix via AutoHotkey, with clipboard handoff. See `README.md` for product behavior and `REALTIME_HANDOFF.md` for the (archived) realtime investigation + how to bring it back.

**Prime directive: failures must be loud.** A silent failure means wrong or missing text in a patient chart. Never trade failure visibility for a feature. An error path must never play the success beep or leave a stale clipboard unflagged.

## Status & direction

**Alpha, in real production use** (first external alpha passed June 2026). **Product = BATCH-ONLY** (see the banner at the top): batch is the deliverable, the live capture waveform is the feedback, Realtime/Hybrid were **removed** (2026-06-19) — the investigation + a resurrection path are archived in `REALTIME_HANDOFF.md`. **Go-forward focus: perfect (a) batch accuracy/latency, (b) the UI experience, and (c) the phone link.** The README's [Roadmap](README.md#roadmap) is the canonical backlog — keep it updated in the same change as the code. When priorities collide, this is the binding order:

1. **Reliability — never lose a dictation.** Loud failure is the floor, not the ceiling: the next step is durability (IndexedDB dictation journal, crash-safe recovery, phone-side delivery queue). Work that narrows a loss window outranks features; work that widens one — even temporarily, even behind a flag — is rejected.
2. **Settings portability.** Settings are `localStorage`-scoped: per browser profile, per device, per origin — desktop, phone, and installed PWAs don't share (iOS home-screen PWAs don't even share with Safari). The planned split: **portable** settings (keyterms, append prefs) sync across devices; **per-device** settings (gate thresholds, hotkey, mic tuning) deliberately stay local. Don't entrench new settings in ways that make that split harder — when adding one, note which side it belongs to.
3. **Mobile-first dictation UI.** ✅ Landed as the **big-button layout** (see the Phone link section): activation is the *joined state* (`joinedSessionCode`) or the per-device `bigButtonMode` override — never the screen size. The desktop compactness contract below stays unchanged; the layout is an additive fixed overlay, not a redesign.

## Repo layout

- `worker.js` — almost everything (~3360 lines): Worker fetch handler (`POST /api/transcribe` → `handleTranscribeBatch`; the `SessionRoom` durable object + `/api/session/<code>` routes for the phone link; PWA manifest/icons), and the entire client app embedded in the `INDEX_HTML` template literal.
- `keyterms.js` — `export const KEYTERM_PRESETS` (the three-tier medical keyterm lists), imported by `worker.js` and injected into the page. Edit here to add/curate terms.
- `tests/flow.test.mjs` — jsdom harness simulating full batch dictation sessions + the phone link (see Validation).
- `hotkey.ahk` — AutoHotkey v2 push-to-talk relay (CapsLock → F13/F14, clipboard handoff) + optional phone-link clipboard poller (`GET /latest`, focus-free native clipboard writes).
- `wrangler.toml` (deploys as worker `eleven`), `README.md`, this file.
- `REALTIME_HANDOFF.md` — **archive** of the realtime-engine investigation (root causes, what was ruled out, the engine evolution) + how to resurrect it (the owner hasn't given up on realtime). **Do not delete.** `LATENCY_PLAN.md` — **archived**: the realtime/hybrid finalize-latency plan, obsolete for the batch-only product but kept for the resurrection path.

## Constraints & style

- **No build step, no runtime dependencies, no frameworks.** The client is vanilla JS inside a template literal. Keep it that way unless explicitly asked otherwise.
- Inside `INDEX_HTML`:
  - **Never use backticks or `${`** — it's a template literal; they terminate/interpolate it. This includes comments.
  - Client-side regex/string backslashes must be **double-escaped** (`\\r\\n` in source → `\r\n` in the served page).
  - Client JS uses string concatenation, not template literals — match that.
- Settings persist under `localStorage` keys suffixed `_v9` (`scribe_v2_settings_v9`, `scribe_v2_transcripts_v9`, `elevenlabs_api_key_browser_v9`, `soniox_api_key_browser_v9` (the old realtime BYO key — now **dormant**: still read/written + the hidden `#sonioxKey` input survives, but nothing uses it since realtime was removed), `scribe_v2_passphrase_v9`). **Bumping the suffix wipes all user settings/history** — add fields to the existing schema instead; only bump on explicit request.
- `scribe_v2_access_code_v9` is the pre-merge batch app's passphrase key. `loadSettings` **must keep reading it as a fallback** (users at the legacy batch URL still have their code there); writes go to `scribe_v2_passphrase_v9`, and forget/unremember must clear both.
- **Compactness contract**: the app must stay fully usable in a tiny minimized PWA window. The primary card (record button, meter/pills, status, latest transcript — there is no engine selector anymore) stays always-visible and first in the DOM; credentials live in the Access `<details>` (auto-collapses once `hasAuth()`, reopened by `updateAuthUI` paths on missing/forgotten credentials), checkboxes + hotkey in Options, keyterms and Advanced in their own `<details>`. Put new settings inside those sections, not in always-visible rows. **The joined-mode big-button layout is additive to this**: `#bigUi` is a fixed overlay (`display:none` without `body.bigbtn`), the primary card keeps its DOM position, and nothing about the tiny-window rules changes when the layout is off — keep it that way.

## Hard invariants — do not break

- **F13 keydown starts, F14 keydown stops — always, unconditionally.** This is the AutoHotkey contract (CapsLock hold). F14 while idle also cancels a queued-but-not-yet-started session (`cancelQueuedStart`) — a session starting *after* the last F14 would violate the contract and open a mic nobody is holding. The configurable in-app hotkey (default Ctrl+Space; tap = toggle, hold > `HOTKEY_TAP_MS` = push-to-talk) is **additive** — it must never replace or shadow F13/F14.
- **Clipboard sentinel** is exactly `##DICTATION_FAILED##` (AHK/user workflows recognize it).
- **Beep semantics**: start/done beeps are gated by the checkbox; **failure (`failBeep`), mic-alarm (`micAlarmBeep`) and warn (`warnBeep`) sounds always play**. Beeps reuse the persistent `audioCtx` when running (a fresh `AudioContext` in a background tab starts suspended and is silent — exactly when the cue matters most). A degraded success (e.g. a joined phone whose relay-to-desktop leg is in doubt) gets `warnBeep`, never `doneBeep`.
- **Exactly one delivery per session.** The finalize path ends in exactly one `deliverFinalText()` call — one clipboard outcome, one beep. `sessionFinalized` guards finalize; the `finishing` flag spans the async upload phase and serializes sessions: F13/hotkey during it queues via `pendingStart`, never overlaps.
- **The noise gate is load-bearing**: the post-gate `MediaRecorder` recording *is* what gets uploaded and transcribed, so `MediaRecorder` construction failure is fatal (sentinel + failBeep), and an over-aggressive gate clips real speech. The gate also drives the capture-waveform feedback + the dead-mic watchdog (both read the analyser).
- **Shared mode**: the master API key must never reach the browser; the Worker injects it server-side into the ElevenLabs batch request after the constant-time passphrase check (`safeEqual`) on the `POST /api/transcribe` path. (The phone-link `SessionRoom` WS still carries the passphrase as a query param — the master key never rides it — see Known sharp edges.)
- **Failure-aware finalize**: an upload failure / no-text outcome delivers loud — red status + fail beep, sentinel on the clipboard when there's no text. A failed clipboard write must fail-beep — with one scoped exception: on a **joined** device with an otherwise-clean outcome, the local copy is best-effort (iOS denies clipboard writes outside a user gesture, and the **desktop** clipboard is the deliverable there) — the outcome cue defers to the relay ack via `announceRelayOutcome`/`relayDeliveryToDesktop(text, announceOutcome)`: done beep on a listener ack, red warn/fail on zero-listeners or relay failure. Still exactly one outcome beep per session; unexpected/mic-alarm outcomes keep the loud local copy-failure path even when joined.
- `cleanTranscript` semantics (optional ellipsis strip — Scribe renders pauses as "…"/"..." — strip newlines, collapse spaces, tighten space-before-punctuation, optional trailing space) — downstream paste workflows depend on them.

## Client session state machine

One session per dictation, guarded by `sessionSeq` (stale callbacks bail out), `sessionFinalized` (finalize runs exactly once), and `finishing` (delivery still in flight; new sessions queue).

```
idle
 └─ startRecording(): credential check (ElevenLabs key / passphrase), ensureAudio(),
    acquireWakeLock(), per-session resets, precompute batch keyterms + TLS pre-warm,
    append decision (appendArmed one-shot beats checkbox+window), sessionBaseText
    snapshot
     └─ startBatchRecording(): post-gate MediaRecorder.start(1000) IS the capture
        path (the #recFeedback waveform/timer runs off the analyser meanwhile)
         └─ stopRecording() [PTT release]: mediaRecorder.stop()
             └─ recorder.onstop → finalizeSession(false) → finishBatchSession():
                upload webm → ElevenLabs Scribe v2 batch (BATCH_UPLOAD_TIMEOUT_MS)
                → splice onto sessionBaseText → deliverFinalText
```

- **`deliverFinalText` is the single delivery exit** — exactly one clipboard outcome + one beep per session. No text ⇒ sentinel + failBeep; clean ⇒ copy + doneBeep; unexpected/mic-alarm ⇒ copy + warn/fail. Joined (phone) ⇒ also `relayDeliveryToDesktop`, and a denied local copy on an otherwise-clean outcome defers to the relay ack (see Phone link).
- Any unexpected failure ⇒ `finalizeSession(true)` / `deliverFinalText({unexpected:true})` ⇒ red status + fail beep + sentinel-if-no-text.
- A 30 ms watchdog (inside the gate meter loop) fires the mic alarm on dead/muted track or RMS flatline (< `FLATLINE_RMS` after 2.5 s) — works in batch (no WS dependency).
- F13 during finalization or delivery sets `pendingStart`; `maybePendingStart()` starts the next session after `deliverFinalText` — via a cancellable `pendingStartTimer` (60 ms; **1.5 s after a failure outcome** so the red screen/status is seen before the next REC paints over it). On the phone-link path the queued start additionally waits for the relay ack (`relayDeliveryToDesktop(...).finally(maybePendingStart)`, deadline `RELAY_TIMEOUT_MS`). **A queued start dies when the press that queued it ends without a tap**: a hold released during the finalize/queued window, a cancelled pointer, or F14 calls `cancelQueuedStart()` — the deferred `startRecording` must never open a mic nobody is holding. `finishing` stays true through the delivery's status/beep branches (cleared just before the relay/queue tail), so the big-screen derivation shows WORKING… across the awaits instead of a stale state.
- **Click-to-append**: clicking the populated transcript box while idle toggles `appendArmed` — a one-shot "append the next dictation" that beats the append-mode checkbox (off by default) and the window; consumed at session start, cleared whenever the box empties, ignored mid-session and while text is selected. The chip + box border surface the armed state.
- **Boot restore**: `restoreLatestFromHistory()` puts the newest history entry into the box and adopts its `createdAt` as `lastFinalizeAt`, so the note stays visible across reloads and the append window keeps counting from the real finish time.
- Mic re-engagement: `audioGraphHealthy()` checks the actual `MediaStreamTrack.readyState` **and `muted`** (iOS interruptions — lock screen, Siri, calls — leave the track "live" but permanently muted), not just variable presence; rebuilt on start and on `pageshow` / `visibilitychange` / `focus` (standalone PWAs can fire only focus on app switch) / `devicechange`, and an idle track that stays muted > 1.2 s self-heals. bfcache restores leave dead streams that *look* alive. iOS Safari has no Permissions API entry for the mic, so `tryWarmOnLoad` falls back to `micEverGranted` — **persisted as the additive `micGranted` settings field**, so a killed-and-relaunched PWA re-warms at boot instead of staying cold. Re-warms go through `warmWithRetry` (700 ms / 2 s backoff): iOS hands the audio session back late after foregrounding, so the first `getUserMedia` can fail and succeed moments later; after the retries it gives up with a visible warn status. A screen wake lock is held from session start to `deliverFinalText` (re-acquired on `visibilitychange` mid-session) so iOS auto-lock cannot reclaim the mic mid-dictation or suspend the page mid-upload.

## Phone link (dictate on the phone, clipboard on the desktop)

One Durable Object room per 6-char session code (`SessionRoom`, top of `worker.js`; route `/api/session/<code>`). The desktop holds a listener WebSocket to the room; the phone joins by code, dictates **in batch** locally, and its `deliverFinalText` POSTs the authoritative final text to `/api/session/<code>/deliver`. The desktop's `phone_delivery` handler is what writes the desktop clipboard. (The realtime "live mirror" — the phone streaming transcript frames into the room for on-the-desktop preview — was removed with the realtime engine; the desktop now sees text only on the final `phone_delivery`, never word-by-word.)

Resilience contract — every layer of this link fails silently by default; do not weaken these:

- **Heartbeat + reconnect**: the desktop pings the room every `PHONE_PING_INTERVAL_MS`; no room traffic for `PHONE_PONG_TIMEOUT_MS` (sized for background-tab timer throttling) = zombie socket — force-close and reconnect with backoff (cap `PHONE_RECONNECT_MAX_MS`) for as long as `phoneSessionCode` is set. A drop flips the code badge to `⚠`/danger with a red status. The badge being visible is **not** proof of a live link — only the heartbeat is.
- **Buffered delivery + dedupe**: the room retains the last `phone_delivery` and replays it to (re)connecting listeners within `DELIVERY_REPLAY_WINDOW_MS`; the phone stamps each delivery with a `delivery_id` and the desktop dedupes by it, so replays can never double-copy.
- **Delivery ack**: `/deliver` answers with the room's listener count. Zero listeners ⇒ red "desktop link is DOWN" status + warn beep on the phone (when the local done beep already played — local delivery succeeded, relay leg failed). Never restore fire-and-forget here.
- **The phone's local copy is best-effort while joined**: iOS denies clipboard writes outside a user gesture, and by delivery time (post-upload) there is none — so on a joined device a denied local copy on an otherwise-clean outcome must NOT read as a failure (the desktop clipboard is the deliverable). The outcome cue defers to the relay ack ("Delivered to the desktop clipboard. Done!" + done beep on a listener ack; the existing red paths on zero-listeners/relay failure). Unjoined, a denied copy stays the loud failure it always was.
- **Focus-retry copy**: a delivery whose clipboard write fails (tab unfocused behind Citrix/Cerner) is held in `pendingCopyText` with red status + fail beep, and retried on the window `focus` event. This is the sanctioned exception to "don't silently retry clipboard writes later" — it is not silent; the status stays red until the retry lands.
- **`phone_session_end` / live-mirror fallback is now vestigial**: it existed because the phone's realtime socket closed *before* the batch refine finished, so the desktop kept a `PHONE_FALLBACK_GRACE_MS` grace timer and the accumulated live `remoteCommitted` text as a degraded fallback. With the realtime mirror removed, nothing emits `phone_session_end` and `remoteCommitted` never fills — the desktop relies entirely on the authoritative `phone_delivery` POST (acked + replayed + deduped). The handlers are dormant/harmless; the real durability gap is now a **phone-side delivery queue** (roadmap) for a phone that dies before delivering.
- **Audible desktop cues**: the desktop listener never records, so `audioCtx` may not exist; `beepCtx` is warmed from the session-start click (a user gesture) and `beep()` falls back to it. Without this, every fail beep on the listener is silent. (A boot-time session resume has no gesture — `restorePhoneLink` arms a one-shot warm-up on the first pointerdown/keydown.)
- **QR join**: the desktop renders a QR of `/?join=<code>` next to the code badge, generated by the embedded encoder (`qrMatrix` — byte mode, EC M, versions 1-6) — **never** an external QR image service, which would leak the code (the link's only credential). The phone's boot path (`restorePhoneLink`) consumes `?join=`, persists the join like a typed code, and scrubs the param from the address bar. Scenario 24 round-trips the rendered SVG through a real decoder (`jsqr`) — keep that test: a QR that renders but doesn't scan is a silent failure.
- **Pairing survives reloads**: `phoneSessionCode`, `joinedSessionCode`, and `lastDeliveryId` persist as additive `_v9` settings fields; `restorePhoneLink()` (boot, after `loadSettings`) resumes the desktop room / restores the phone's join, so an iOS PWA kill or tab reload cannot break the link. Persisting `lastDeliveryId` is what keeps the room's replay from double-copying across a reload. "End session" / "Leave" must clear the stored codes.
- **`GET /api/session/<code>/latest`** returns the room's held delivery (within the replay window) for native pollers — `hotkey.ahk`'s optional phone-link poller uses it to write the clipboard with **no browser-focus requirement** (set `PHONE_POLL_URL` + `PHONE_CODE` at the top of the script). The poller baselines the first id it sees (never pastes a pre-existing delivery), dedupes by `delivery_id`, and skips polls while the PTT clipboard handshake is in flight (`BUSY`). Same trust model as the listener WS: the code is the only credential.
- **Big-button layout (joined devices)**: while `joinedSessionCode` is set (or `bigButtonMode` = "always" — a per-device additive `_v9` field; "never" wins over a join), `body.bigbtn` swaps the page for a fixed overlay: one center push-to-talk button + whole-screen status + transcript peek strip. The button has the hotkey's tap/hold semantics (`HOTKEY_TAP_MS`) and drives the normal `startRecording()`/`stopRecording()`/`pendingStart` paths — never parallel session logic. Input is pointer-events with capture; pointercancel/lostpointercapture/document-level release backstops mean a slide-away or multi-touch can never wedge the recording, and **a `pointercancel`/`lostpointercapture` stops the dictation regardless of hold duration** (the real release can never arrive — an open mic is never the right interpretation; a sub-tap-threshold cancel must NOT convert to toggle mode). The screen state (`updateBigScreen`) is **derived** from the existing `setStatus` class + mic/link pill transitions — the zero-listener "desktop link is DOWN" ack and relay failures land as `err` statuses *after* the local delivery, which is what reddens the screen (the queued next session waits on the relay ack and gives a failure ~1.5 s of screen time — see the session-state section); do not invent separate state for it. The warn headline is "⚠ CHECK", never a DONE claim (warn covers idle advisories too), and the no-speech sentinel outcome is classified `err` so it reads FAILED. **During a batch dictation the big screen shows "● REC" + a STOP button** as the capture cue; the peek strip's **`live` mode** (`updateBigPeek`, gated on `(recording || stopping) && latestText` — wrap + pin-to-newest-line so streaming words don't scroll off the edge) is **dormant in batch** because there is no mid-recording `latestText`, so the strip stays the collapsed "Latest transcript" until delivery. (The mechanism is left intact for the realtime resurrection path.) **Go-forward UI gap:** the `#recFeedback` capture waveform/timer lives in the primary card, which the `#bigUi` overlay covers — surfacing that capture feedback on the big screen is open UI work. Haptics (`haptic()`) live inside the beep functions and mirror them — they must never replace a sound. `applyBigButtonUI()` runs at boot after `restorePhoneLink()` (a persisted or `?join=` boot lands directly in the layout) and on join/leave/override changes.

## STT APIs (as used)

**One endpoint** — `POST /api/transcribe` → `handleTranscribeBatch`:

- Proxies to **ElevenLabs** `https://api.elevenlabs.io/v1/speech-to-text` batch `scribe_v2` with `xi-api-key` / `env.ELEVENLABS_API_KEY`. Locked to the best single-speaker medical config (`temperature=0`, `language_code=en`, `num_speakers=1`, `diarize=false`). Multipart fields: `api_key` or `passphrase` (shared mode injects the master key server-side after the constant-time `safeEqual`), `file` (webm/ogg from the `MediaRecorder`), `file_format=other`, `timestamps_granularity`, `no_verbatim`, `tag_audio_events`, `keyterms_json` (≤ 1000 terms, < 50 chars). Size gates 1 KB–25 MB; failures return a string `error` that surfaces in the loud failure status.
- **Keyterms** live in **`keyterms.js`** (`export const KEYTERM_PRESETS`, imported by `worker.js`), three-tier: `always:true` lists ride every dictation (pay the ~20 % surcharge — keep minimal), the rest are checkboxes (`presetIds` in `_v9` settings). Injected into the page via the `__KEYTERM_PRESETS__` token (**function replacer only**). Client merges via `effectiveKeyterms` (trim priority **custom > checked presets > always-on**), capped at **≤1000 terms / <50 chars** for batch. `sanitizeKeyterms` (server) + the client cap both apply.
- **Audio pipeline (batch):** `getUserMedia` → high-pass → **noise gate** → `destNode` → **`MediaRecorder.start(1000)`** webm/opus. The gate's analyser also drives the capture waveform + dead-mic watchdog. `noiseSuppression` **DEFAULTS ON** (`autoGainControl:false`) — there's an Options A/B toggle (modern batch STT sometimes does better with it OFF on a close mic; per-device, untested). On release, `recorder.onstop` flushes the last <1 s into `chunks[]` and `finishBatchSession` uploads.
- **Finalize/upload latency optimizations (`[LATENCY]`-tagged).** (1) `MediaRecorder.start(1000)` timeslice — chunks accrue *during* recording so `onstop` flushes <1 s, not the whole take (don't drop the arg). (2) **`precomputedBatchKeyterms`** snapshots the `effectiveKeyterms()` merge/dedup at session *start*, off the stop→upload path. (3) A **TLS pre-warm** (`new Image().src="/favicon.ico?warm=…"` at session start) opens TCP/TLS before the upload — deliberately an `Image`, not `fetch()`, so it never consumes a batch queue slot or trips the harness's queue-driven `fetch` mock.

(Realtime/Hybrid streaming, the Soniox/Deepgram/EL-realtime handlers + translators, the temp-key endpoint, the `/pcm-pump.js` worklet, and `/api/nova-probe` were removed — see `REALTIME_HANDOFF.md`.)

## Validation (no browser needed)

```sh
node --check worker.js

# Render through the real fetch handler and syntax-check the served inline script:
node --input-type=module -e "
import { writeFileSync } from 'fs';
const m = await import('./worker.js');
const r = await m.default.fetch(new Request('https://x/'), {});
const h = await r.text();
const js = h.slice(h.indexOf('<script>')+8, h.indexOf('</'+'script>'));
writeFileSync('/tmp/served.js', js);"
node --check /tmp/served.js

# Full session-flow simulation — batch-only product, 17 scenario groups
# (numbered 0,3,4,7,9,10,11,17,18,19,20,21,22,23,24,25,29; the gaps are the
# deleted realtime/hybrid/translator/pump/direct scenarios — numbering kept so
# git history lines up):
#  0  boot shim: legacy access-code->passphrase migration, defaults, history
#     restore, auth-section auto-collapse once a key is entered
#  3  batch dead-mic flatline alarm -> sentinel
#  4  batch append-window expiry starts fresh
#  7  batch configurable hotkey tap(toggle)/hold(PTT) + F13/F14 contract
#  9  batch happy path: NO WebSocket opens, exactly one POST /api/transcribe
#     upload, history tagged engine "batch", link pill returns to idle
# 10  batch upload failure -> sentinel + LINK FAIL
# 11  PTT queued during a slow batch upload (finalize-gap busy)
# 17  click-to-append one-shot
# 18  keyterm presets: injected lists, custom>checked>always merge, dedupe,
#     persistence
# 19  phone mic session: phone dictates batch, /api/session/<code>/deliver POST
#     carries the code
# 20  phone link resilience: reconnect, replay-dedupe, focus-retry, grace
#     fallback, zero-listener ack is loud
# 21  SessionRoom DO contract incl. GET /api/session/<code>/latest
# 22  phone link persistence: resume/rejoin across reloads
# 23  iOS mic resilience: wake lock, muted-track rebuild, Permissions-API-free
#     re-warm
# 24  QR join: locally-encoded QR decoded back with jsqr + /?join= auto-join
# 25  big-button layout: join/leave/persisted/QR activation, hold-vs-tap pointer
#     semantics incl. slide-away backstop, sub-threshold pointercancel,
#     multi-touch, queued-start cancellation (release/cancel/F14), screen-state
#     mirror incl. zero-listener + relay-fail redden, finalize-gap busy,
#     sentinel-outcome FAILED, haptic patterns, peek strip, per-device override,
#     joined local-copy denial deferring to the relay ack
# 29  batch-only product: saved Hybrid->Batch migration, no engine selector in
#     the DOM, live capture feedback (#recFeedback) shows while recording / hides
#     on finalize, NO realtime WS opens, batch text reaches the clipboard
npm install --no-save jsdom jsqr
node tests/flow.test.mjs
```

When changing the session flow, beeps, clipboard behavior, engines, or watchdog: **update/extend `tests/flow.test.mjs` scenarios in the same change** and run them. The harness mocks `WebSocket`, `fetch` (queue-driven; an empty queue answers 500 so unexpected uploads fail loudly), `AudioContext`, `getUserMedia`, `MediaRecorder` (delivers a real Blob on stop), and the clipboard.

jsdom gotchas baked into the harness: define `window.isSecureContext = true` and stub `navigator.clipboard`, or every clipboard path "fails"; stub `URL.createObjectURL` (the preview path runs whenever the recorder delivers chunks); the mock `MediaRecorder` must deliver a real `Blob` via `ondataavailable` on `stop()` so the batch upload has a body; let the gate-meter loop tick (a short `sleep`) for the dead-mic watchdog + the capture-feedback show/hide to fire.

## Tuning constants (top of the client script)

| Constant | Default | Meaning |
|---|---|---|
| `BATCH_UPLOAD_TIMEOUT_MS` | 15000 | Batch upload + transcription deadline (a hung request fails loudly past this) |
| `FLATLINE_RMS` | 0.0008 | Dead-mic threshold for the gate-loop watchdog |
| `HOTKEY_TAP_MS` | 400 | Hotkey press shorter = tap (toggle), longer = hold (PTT) |
| `PHONE_PING_INTERVAL_MS` | 25000 | Desktop→room heartbeat cadence |
| `PHONE_PONG_TIMEOUT_MS` | 90000 | No room traffic for this long = zombie socket, force reconnect |
| `PHONE_RECONNECT_MAX_MS` | 15000 | Room-listener reconnect backoff cap |
| `PHONE_FALLBACK_GRACE_MS` | 10000 | (Phone link) wait for `phone_delivery` before the desktop falls back. Vestigial now — nothing emits `phone_session_end` since the realtime mirror was removed; harmless. |
| `RELAY_TIMEOUT_MS` | 10000 | Phone→room delivery ack deadline (a hung relay fails loudly; the queued next session waits on the ack) |
| `DELIVERY_REPLAY_WINDOW_MS` | 120000 | (Worker, top of file) room replays the held delivery to reconnecting listeners |

The AHK script's `CLIP_TIMEOUT := 20` comfortably covers the batch upload deadline (15 s). If you raise `BATCH_UPLOAD_TIMEOUT_MS`, raise it too.

## Deployment

**Deploy = push to `main`** — Cloudflare **Workers Builds auto-deploys** on push (worker name `eleven` — the pre-merge batch app's URL, so users' localStorage survives; secrets persist across deploys). Confirm via `gh api repos/praxeo/elevenlabs-web/commits/<sha>/check-runs` (the `Workers Builds: eleven` check). `npx wrangler deploy` also works but the local OAuth token is **scope-limited**: it CANNOT write secrets (`auth error 10000`) — **set secrets via the Cloudflare dashboard** (Workers & Pages → eleven → Settings). Secrets in use: **`ELEVENLABS_API_KEY`** (the batch transcription) and **`APP_PASSPHRASE`** (gates shared mode). `SONIOX_API_KEY` and the Deepgram/AI-Gateway/`PROBE_KEY` secrets are no longer used (realtime removed) and can be deleted from the dashboard. HTML served `no-store`. Note (workflow on the feature branch in this repo): pushes to the working branch ALSO build/deploy to the live worker, so a broken push goes live — validate before pushing.

## Known sharp edges

- Clipboard writes require document focus; both `navigator.clipboard` and the `execCommand` fallback fail unfocused. The UX (beeps, sentinel) is built around that constraint — don't "fix" it by silently retrying later. (The phone-link focus-retry is the one sanctioned exception: it is loud while pending and retries only on refocus — see the Phone link section.)
- The shared-mode passphrase travels as a query param on the phone-link WS path; don't add logging of request URLs in the Worker. The batch POST carries it in the form body.
- "Clear dictation box" / "Clear history" during an in-flight upload mutate `finalizedSegments`, which the delivery then overwrites from `sessionBaseText` — a cleared box can reappear with the delivered note. Cosmetic, known, alpha-acceptable.
- The audio preview/download is the **post-gate** recording — i.e. exactly what was uploaded/transcribed (the gate is load-bearing in batch), so an over-aggressive gate that clips the preview also clipped the transcript. Tune the gate, not just the preview.
- **Phone link in batch:** the phone has no live text, so the desktop's `remoteCommitted`/`phone_session_end` grace-fallback never fires — the desktop relies entirely on the authoritative `phone_delivery` POST. That's fine (the delivery is acked + replayed + deduped), but it means a phone that dies *before* delivering leaves the desktop with nothing; durability (a phone-side delivery queue) is the roadmap answer.
