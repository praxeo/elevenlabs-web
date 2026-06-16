# CLAUDE.md

Guidance for AI/dev sessions working in this repo. Read this before touching `worker.js`.

## What this is

A one-file Cloudflare Worker serving a medical dictation app with **three engines** behind one UI:

- **Realtime** — Soniox realtime STT over WebSocket (`stt-rt-v5`); live text is the deliverable. (Was ElevenLabs Scribe v2 Realtime, then briefly Mistral Voxtral — both swapped out. The client still speaks the ElevenLabs frame vocabulary; the Worker translates to/from Soniox's token protocol.)
- **Batch** (default) — the post-gate recording uploads to batch Scribe v2 on release (the pre-merge batch app's behavior). **Still ElevenLabs.**
- **Hybrid** — realtime text is *feedback* (Soniox); the same audio is re-transcribed through batch Scribe v2 (**ElevenLabs**) and *that* lands on the clipboard.

Users are clinicians doing push-to-talk dictation into Cerner/Citrix via AutoHotkey, with clipboard handoff. See `README.md` for product behavior, tuning, and roadmap.

**Prime directive: failures must be loud.** A silent failure means wrong or missing text in a patient chart. Never trade failure visibility for a feature. An error path must never play the success beep or leave a stale clipboard unflagged.

## Status & direction

**Alpha, in real production use** (first external alpha passed June 2026). The README's [Roadmap](README.md#roadmap) is the canonical backlog — keep it updated in the same change as the code. When priorities collide, this is the binding order:

1. **Reliability — never lose a dictation.** Loud failure is the floor, not the ceiling: the next step is durability (IndexedDB dictation journal, crash-safe recovery, phone-side delivery queue). Work that narrows a loss window outranks features; work that widens one — even temporarily, even behind a flag — is rejected.
2. **Settings portability.** Settings are `localStorage`-scoped: per browser profile, per device, per origin — desktop, phone, and installed PWAs don't share (iOS home-screen PWAs don't even share with Safari). The planned split: **portable** settings (engine, keyterms, append prefs) sync across devices; **per-device** settings (gate thresholds, hotkey, mic tuning) deliberately stay local. Don't entrench new settings in ways that make that split harder — when adding one, note which side it belongs to.
3. **Mobile-first dictation UI.** ✅ Landed as the **big-button layout** (see the Phone link section): activation is the *joined state* (`joinedSessionCode`) or the per-device `bigButtonMode` override — never the screen size. The desktop compactness contract below stays unchanged; the layout is an additive fixed overlay, not a redesign.

## Repo layout

- `worker.js` — everything: Worker fetch handler (dual-protocol `/api/transcribe`), batch proxy, WebSocket proxy, PWA manifest/icons, and the entire client app embedded in the `INDEX_HTML` template literal.
- `tests/flow.test.mjs` — jsdom harness simulating full dictation sessions across all three engines (see Validation).
- `hotkey.ahk` — AutoHotkey v2 push-to-talk relay (CapsLock → F13/F14, clipboard handoff) + optional phone-link clipboard poller (`GET /latest`, focus-free native clipboard writes).
- `wrangler.toml` (deploys as worker `eleven`), `README.md`, this file.

## Constraints & style

- **No build step, no runtime dependencies, no frameworks.** The client is vanilla JS inside a template literal. Keep it that way unless explicitly asked otherwise.
- Inside `INDEX_HTML`:
  - **Never use backticks or `${`** — it's a template literal; they terminate/interpolate it. This includes comments.
  - Client-side regex/string backslashes must be **double-escaped** (`\\r\\n` in source → `\r\n` in the served page).
  - Client JS uses string concatenation, not template literals — match that.
- Settings persist under `localStorage` keys suffixed `_v9` (`scribe_v2_settings_v9`, `scribe_v2_transcripts_v9`, `elevenlabs_api_key_browser_v9`, `soniox_api_key_browser_v9` (realtime BYO key), `scribe_v2_passphrase_v9`). **Bumping the suffix wipes all user settings/history** — add fields to the existing schema instead; only bump on explicit request.
- `scribe_v2_access_code_v9` is the pre-merge batch app's passphrase key. `loadSettings` **must keep reading it as a fallback** (users at the legacy batch URL still have their code there); writes go to `scribe_v2_passphrase_v9`, and forget/unremember must clear both.
- **Compactness contract**: the app must stay fully usable in a tiny minimized PWA window. The primary card (engine selector, record button, meter/pills, status, latest transcript) stays always-visible and first in the DOM; credentials live in the Access `<details>` (auto-collapses once `hasAuth()`, reopened by `updateAuthUI` paths on missing/forgotten credentials), checkboxes + hotkey in Options, keyterms and Advanced in their own `<details>`. Put new settings inside those sections, not in always-visible rows. **The joined-mode big-button layout is additive to this**: `#bigUi` is a fixed overlay (`display:none` without `body.bigbtn`), the primary card keeps its DOM position, and nothing about the tiny-window rules changes when the layout is off — keep it that way.

## Hard invariants — do not break

- **F13 keydown starts, F14 keydown stops — always, unconditionally.** This is the AutoHotkey contract (CapsLock hold). F14 while idle **or already ending** (the post-release tail / finalize / delivery — where `recording` can still read true through the batch/realtime tail) cancels a queued-but-not-yet-started session (`cancelQueuedStart`) instead of re-stopping — a session starting *after* the last F14 would violate the contract and open a mic nobody is holding. The configurable in-app hotkey (default Ctrl+Space; tap = toggle, hold > `HOTKEY_TAP_MS` = push-to-talk) is **additive** — it must never replace or shadow F13/F14.
- **Clipboard sentinel** is exactly `##DICTATION_FAILED##` (AHK/user workflows recognize it).
- **Beep semantics**: start/done beeps are gated by the checkbox; **failure (`failBeep`), mic-alarm (`micAlarmBeep`) and warn (`warnBeep`) sounds always play**. Beeps reuse the persistent `audioCtx` when running (a fresh `AudioContext` in a background tab starts suspended and is silent — exactly when the cue matters most). A degraded success (hybrid refine failed, live text delivered) gets `warnBeep`, never `doneBeep`.
- **Exactly one delivery per session.** Every engine's finalize path ends in exactly one `deliverFinalText()` call — one clipboard outcome, one beep. `sessionFinalized` guards finalize; the `finishing` flag spans the async upload/refine phases and serializes sessions: F13/hotkey during it queues via `pendingStart`, never overlaps.
- **STT feed is pre-gate** in realtime/hybrid: the realtime STT backend (Soniox) receives raw high-passed audio; the noise gate shapes only the local `MediaRecorder` preview. **In batch mode the gate is load-bearing**: the post-gate recording *is* what gets transcribed, and `MediaRecorder` construction failure is fatal (sentinel + failBeep), not a preview degradation. **PTT opens the gate on press** (`primeGateOpen`, called at record start in both paths): pressing to talk means speech is imminent, so the gate opens immediately instead of waiting for the RMS open threshold — otherwise batch clips the onset of the first word (the post-gate recording is the transcript). The meter loop's close-on-silence logic still gates long pauses from there; pre-gate engines are already onset-safe but get an unclipped preview.
- **`capturePcm` captures each frame exactly once, at production time** (audio pump + pre-roll build) — never in `sendAudioChunk`/`flushPendingChunks`. That is what makes the hybrid refine a recovery path when the socket never opens or dies: the buffer is a superset of what the stream delivered. Keep the pre-roll property too: the ring only ever holds never-sent frames, so prepending cannot double-transcribe.
- **Shared mode**: the master API key must never reach the browser; the Worker injects it server-side after the constant-time passphrase check (`safeEqual`) — on both the WS and POST paths.
- **Failure-aware finalize**: unexpected disconnects deliver whatever text exists, but with red status + fail beep. No-text failures copy the sentinel. A failed clipboard write must fail-beep — with one scoped exception: on a **joined** device with an otherwise-clean outcome, the local copy is best-effort (iOS denies clipboard writes outside a user gesture, and the **desktop** clipboard is the deliverable there) — the outcome cue defers to the relay ack via `announceRelayOutcome`/`relayDeliveryToDesktop(text, announceOutcome)`: done beep on a listener ack, red warn/fail on zero-listeners or relay failure. Still exactly one outcome beep per session; unexpected/mic-alarm/refine-failed outcomes keep the loud local copy-failure path even when joined. In hybrid, a dead link does **not** skip the refine (that's the recovery), but the outcome is still framed as a failure to verify.
- `cleanTranscript` semantics (optional ellipsis strip — Scribe renders pauses as "…"/"..." — strip newlines, collapse spaces, tighten space-before-punctuation, optional trailing space) — downstream paste workflows depend on them.

## Client session state machine

One session per dictation, guarded by `sessionSeq` (stale socket callbacks bail out), `sessionFinalized` (finalize runs exactly once), and `finishing` (delivery still in flight; new sessions queue).

```
idle
 └─ startRecording(): ensureAudio(), per-session resets, sessionEngine = engine
    snapshot, append decision (appendArmed one-shot beats checkbox+window),
    sessionBaseText snapshot
     ├─ ENGINE batch: no WebSocket, no pre-roll. Post-gate MediaRecorder is the
     │  capture path; stopRecording() keeps the recorder running BATCH_TAIL_MS
     │  after release (the last word isn't clipped — batch transcribes the
     │  recording itself) → recorder.onstop → finalizeSession(false)
     │  → finishBatchSession(): upload webm → splice onto sessionBaseText
     │  → deliverFinalText
     └─ ENGINE realtime/hybrid: seed pendingChunks with pre-roll
        (buildPrerollChunks; hybrid also capturePcm's every frame), open WS
         └─ connecting: onaudioprocess buffers frames (cap PENDING_CHUNK_CAP);
            CONNECT_TIMEOUT_MS → loud fail (sentinel + failBeep)
             └─ open: flush buffer, stream live
                 └─ stopRecording() [PTT release]: stopPhase="tail" — audio KEEPS
                    streaming for TAIL_MS (anti-clipping)
                     └─ beginCommitPhase(): send {audio_base_64:"", commit:true},
                        stopPhase="awaitFinal"; close COMMIT_QUIET_MS after the last
                        committed transcript, or at FINAL_WAIT_MS deadline
                         └─ onclose → finalizeSession(unexpected = !userStopped)
                             ├─ ENGINE realtime: deliverFinalText(live text)
                             └─ ENGINE hybrid: refineAndDeliverHybrid():
                                buildWavBlob(sessionPcm) → batchTranscribe
                                (REFINE_TIMEOUT_MS) → refined text replaces live
                                → deliverFinalText; refine-fail → live text +
                                warnBeep; both-fail → sentinel
```

- Any close we didn't request ⇒ `finalizeSession(true)` ⇒ red status + fail beep (hybrid still refines — recovery — but stays framed as a failure).
- A 30 ms watchdog (inside the gate meter loop) fires the mic alarm on dead/muted track or RMS flatline (< `FLATLINE_RMS` after 2.5 s), and a warn if speech flows but zero transcripts arrive in 8 s (realtime/hybrid). The mic alarm works in batch mode too (no WS dependency).
- F13 during finalization or delivery sets `pendingStart`; `maybePendingStart()` starts the next session after `deliverFinalText` — via a cancellable `pendingStartTimer` (60 ms; **1.5 s after a failure outcome** so the red screen/status is seen before the next REC paints over it). On the phone-link path the queued start additionally waits for the relay ack (`relayDeliveryToDesktop(...).finally(maybePendingStart)`, deadline `RELAY_TIMEOUT_MS`). **A queued start dies when the press that queued it ends without a tap**: a hold released during the finalize/queued window, a cancelled pointer, or F14 calls `cancelQueuedStart()` — the deferred `startRecording` must never open a mic nobody is holding. `finishing` stays true through the delivery's status/beep branches (cleared just before the relay/queue tail), so the big-screen derivation shows WORKING… across the awaits instead of a stale state.
- **Click-to-append**: clicking the populated transcript box while idle toggles `appendArmed` — a one-shot "append the next dictation" that beats the append-mode checkbox (off by default) and the window; consumed at session start, cleared whenever the box empties, ignored mid-session and while text is selected. The chip + box border surface the armed state.
- **Boot restore**: `restoreLatestFromHistory()` puts the newest history entry into the box and adopts its `createdAt` as `lastFinalizeAt`, so the note stays visible across reloads and the append window keeps counting from the real finish time.
- Trailing partials are part of `latestText` — never discard a partial at shutdown; that is the anti-clipping backstop if the commit reply never comes.
- Mic re-engagement: `audioGraphHealthy()` checks the actual `MediaStreamTrack.readyState` **and `muted`** (iOS interruptions — lock screen, Siri, calls — leave the track "live" but permanently muted), not just variable presence; rebuilt on start and on `pageshow` / `visibilitychange` / `focus` (standalone PWAs can fire only focus on app switch) / `devicechange`, and an idle track that stays muted > 1.2 s self-heals. bfcache restores leave dead streams that *look* alive. iOS Safari has no Permissions API entry for the mic, so `tryWarmOnLoad` falls back to `micEverGranted` — **persisted as the additive `micGranted` settings field**, so a killed-and-relaunched PWA re-warms at boot instead of staying cold. Re-warms go through `warmWithRetry` (700 ms / 2 s backoff): iOS hands the audio session back late after foregrounding, so the first `getUserMedia` can fail and succeed moments later; after the retries it gives up with a visible warn status. A screen wake lock is held from session start to `deliverFinalText` (re-acquired on `visibilitychange` mid-session) so iOS auto-lock cannot reclaim the mic mid-dictation or suspend the page mid-upload/refine.
- `sessionPcm` (hybrid) is reset at session start and emptied in `refineAndDeliverHybrid` — a ~20 MB buffer must never outlive its session. On cap (`SESSION_PCM_CAP_BYTES`) the complete live text beats a truncated refine.

## Phone link (dictate on the phone, clipboard on the desktop)

One Durable Object room per 6-char session code (`SessionRoom`, top of `worker.js`; route `/api/session/<code>`). The desktop holds a listener WebSocket to the room; the phone joins by code — its realtime WS carries `session=<code>` so the Worker mirrors transcript frames into the room (live feedback on the desktop), and the phone's `deliverFinalText` POSTs the authoritative final text to `/api/session/<code>/deliver`. The desktop's `phone_delivery` handler is what writes the desktop clipboard.

Resilience contract — every layer of this link fails silently by default; do not weaken these:

- **Heartbeat + reconnect**: the desktop pings the room every `PHONE_PING_INTERVAL_MS`; no room traffic for `PHONE_PONG_TIMEOUT_MS` (sized for background-tab timer throttling) = zombie socket — force-close and reconnect with backoff (cap `PHONE_RECONNECT_MAX_MS`) for as long as `phoneSessionCode` is set. A drop flips the code badge to `⚠`/danger with a red status. The badge being visible is **not** proof of a live link — only the heartbeat is.
- **Buffered delivery + dedupe**: the room retains the last `phone_delivery` and replays it to (re)connecting listeners within `DELIVERY_REPLAY_WINDOW_MS`; the phone stamps each delivery with a `delivery_id` and the desktop dedupes by it, so replays can never double-copy.
- **Delivery ack**: `/deliver` answers with the room's listener count. Zero listeners ⇒ red "desktop link is DOWN" status + warn beep on the phone (when the local done beep already played — local delivery succeeded, relay leg failed). Never restore fire-and-forget here.
- **The phone's local copy is best-effort while joined**: iOS denies clipboard writes outside a user gesture, and by delivery time (post upload/refine) there is none — so on a joined device a denied local copy on an otherwise-clean outcome must NOT read as a failure (the desktop clipboard is the deliverable). The outcome cue defers to the relay ack ("Delivered to the desktop clipboard. Done!" + done beep on a listener ack; the existing red paths on zero-listeners/relay failure). Unjoined, a denied copy stays the loud failure it always was.
- **Focus-retry copy**: a delivery whose clipboard write fails (tab unfocused behind Citrix/Cerner) is held in `pendingCopyText` with red status + fail beep, and retried on the window `focus` event. This is the sanctioned exception to "don't silently retry clipboard writes later" — it is not silent; the status stays red until the retry lands.
- **`phone_session_end` is per-dictation, not per-session**: the Worker broadcasts it when the phone's realtime socket closes, which is *before* the hybrid refine finishes. The desktop must NOT tear down the session on it; it starts a `PHONE_FALLBACK_GRACE_MS` timer and, only if no `phone_delivery` arrives, delivers the accumulated live `remoteCommitted` text framed as degraded (warn). A real delivery cancels the timer.
- **Audible desktop cues**: the desktop listener never records, so `audioCtx` may not exist; `beepCtx` is warmed from the session-start click (a user gesture) and `beep()` falls back to it. Without this, every fail beep on the listener is silent. (A boot-time session resume has no gesture — `restorePhoneLink` arms a one-shot warm-up on the first pointerdown/keydown.)
- **QR join**: the desktop renders a QR of `/?join=<code>` next to the code badge, generated by the embedded encoder (`qrMatrix` — byte mode, EC M, versions 1-6) — **never** an external QR image service, which would leak the code (the link's only credential). The phone's boot path (`restorePhoneLink`) consumes `?join=`, persists the join like a typed code, and scrubs the param from the address bar. Scenario 24 round-trips the rendered SVG through a real decoder (`jsqr`) — keep that test: a QR that renders but doesn't scan is a silent failure.
- **Pairing survives reloads**: `phoneSessionCode`, `joinedSessionCode`, and `lastDeliveryId` persist as additive `_v9` settings fields; `restorePhoneLink()` (boot, after `loadSettings`) resumes the desktop room / restores the phone's join, so an iOS PWA kill or tab reload cannot break the link. Persisting `lastDeliveryId` is what keeps the room's replay from double-copying across a reload. "End session" / "Leave" must clear the stored codes.
- **`GET /api/session/<code>/latest`** returns the room's held delivery (within the replay window) for native pollers — `hotkey.ahk`'s optional phone-link poller uses it to write the clipboard with **no browser-focus requirement** (set `PHONE_POLL_URL` + `PHONE_CODE` at the top of the script). The poller baselines the first id it sees (never pastes a pre-existing delivery), dedupes by `delivery_id`, and skips polls while the PTT clipboard handshake is in flight (`BUSY`). Same trust model as the listener WS: the code is the only credential.
- **Big-button layout (joined devices)**: while `joinedSessionCode` is set (or `bigButtonMode` = "always" — a per-device additive `_v9` field; "never" wins over a join), `body.bigbtn` swaps the page for a fixed overlay: one center push-to-talk button + whole-screen status + transcript peek strip. The button has the hotkey's tap/hold semantics (`HOTKEY_TAP_MS`) and drives the normal `startRecording()`/`stopRecording()`/`pendingStart` paths — never parallel session logic. Input is pointer-events with capture; pointercancel/lostpointercapture/document-level release backstops mean a slide-away or multi-touch can never wedge the recording, and **a `pointercancel`/`lostpointercapture` stops the dictation regardless of hold duration** (the real release can never arrive — an open mic is never the right interpretation; a sub-tap-threshold cancel must NOT convert to toggle mode). The screen state (`updateBigScreen`) is **derived** from the existing `setStatus` class + mic/link pill transitions — the zero-listener "desktop link is DOWN" ack and relay failures land as `err` statuses *after* the local delivery, which is what reddens the screen (the queued next session waits on the relay ack and gives a failure ~1.5 s of screen time — see the session-state section); do not invent separate state for it. The warn headline is "⚠ CHECK", never a DONE claim (warn covers idle advisories too), and the no-speech sentinel outcome is classified `err` so it reads FAILED. **During recording the peek strip goes `live`** (`updateBigPeek`, gated on `(recording || stopping) && latestText`): it wraps and pins the scroll to the newest line so the realtime words stay on-screen — a collapsed head-truncated one-liner scrolls the latest words off the right edge and looks frozen as the note grows (the realtime feedback the mobile/joined user needs). It reverts to the collapsed "Latest transcript" peek once recording ends; batch has no live text so it never enters the live view. Haptics (`haptic()`) live inside the beep functions and mirror them — they must never replace a sound. `applyBigButtonUI()` runs at boot after `restorePhoneLink()` (a persisted or `?join=` boot lands directly in the layout) and on join/leave/override changes.

## STT APIs (as used)

**One path, two protocols** — `/api/transcribe`:
- **WebSocket upgrade** → `handleTranscribeRealtime`: proxies to **Soniox** `wss stt-rt.soniox.com/transcribe-websocket`. Auth is **not** a header — the Soniox key rides the first (config) frame, so the upgrade carries no credential. The realtime path uses the **Soniox** key — BYO via the `api_key` query param, or shared-mode injects `env.SONIOX_API_KEY` after the passphrase check. The Worker sends the JSON config as the first frame: `{api_key, model:"stt-rt-v5", audio_format:"pcm_s16le", sample_rate:16000, num_channels:1, language_hints:["en"], enable_endpoint_detection:true, context:{terms:[…keyterms…]}}`. **Realtime keyterms are back** (Voxtral lacked them) — sent as `context.terms` (sanitized: ≤ 100 terms). The other ElevenLabs-era query params the client still sends (`no_verbatim`, `timestamps`) are **inert/not forwarded**. The Worker bridges the two protocols (see the translation note below).
- **POST** (multipart form) → `handleTranscribeBatch`: proxies to **ElevenLabs** `https://api.elevenlabs.io/v1/speech-to-text` batch `scribe_v2` with `xi-api-key`/`env.ELEVENLABS_API_KEY`. **Unchanged by the realtime swap** — batch and the hybrid refine still hit ElevenLabs. Fields: `api_key` or `passphrase`, `file` (webm/ogg from batch mode, wav from the hybrid refine), `file_format=other`, `timestamps_granularity` (none/word/character), `no_verbatim`, `tag_audio_events`, `keyterms_json` (≤ 1000 terms, < 50 chars). Size gates 1 KB–25 MB.
- **Realtime frame translation** (`sonioxClientToBackend` + `makeSonioxToClient`, exported for tests, top of `worker.js` above `handleTranscribeRealtime`): the client speaks the ElevenLabs frame vocabulary; the Worker maps it to Soniox's wire protocol. Client `input_audio_chunk` → the **raw PCM bytes** (base64-decoded into a `Uint8Array`, sent as a binary WS frame — Soniox takes binary, not base64); the final flush (commit) → an **empty string** (`""` = end-of-audio). An `inputEnded` latch drops any stray post-commit frame. Soniox → client: each response carries `tokens[]` with an `is_final` flag — **non-final** tokens are provisional (resent each response), **final** tokens are confirmed (sent once). The Worker accumulates the confirmed text and emits, every response, a `partial_transcript` holding `confirmed + provisional-tail` (the complete current view); on `finished` it emits a `committed_transcript` with the confirmed text (locks in + triggers the client's prompt close). An `error_code` response → a `{message_type:"error"}` frame so the loud path fires; an abnormal backend close surfaces Soniox's close code/reason as an error frame too. The same normalized frames also feed the phone-link room (the desktop listener parses the ElevenLabs vocabulary too). Credentials: realtime needs the Soniox key, batch the ElevenLabs key; hybrid needs both (shared-mode passphrase covers both). BYO key fields: `soniox_api_key_browser_v9` and `elevenlabs_api_key_browser_v9`.
- Both handlers share `safeEqual`, `json`, and `sanitizeKeyterms` (per-API limits as parameters). Keyterm scrubbing happens client-side (`parseKeyterms` with per-API caps) **and** server-side — keep both.
- **Keyterm presets** live in the `KEYTERM_PRESETS` const (top of `worker.js`, before `MANIFEST`): `always: true` lists apply to every dictation invisibly (every dictation then pays the ~20 % keyterm surcharge); the rest render as checkboxes in the Keyterms section, persisted as `presetIds` in the `_v9` settings (additive field). The Worker injects the sanitized lists via the `__KEYTERM_PRESETS__` token — **function replacer only**; a string replacement would interpret `$`-patterns in term text. The client merges in `effectiveKeyterms` with trim priority **custom > checked presets > always-on** when the realtime 50-term cap overflows; batch (1000) gets everything, so in hybrid the clipboard text benefits from the full list even when the live feed trimmed. Editing/adding a list = edit the const + deploy. `renderPresetRow()` must run before `loadSettings()` at boot.
- Client → server WS frames: every chunk goes through the `sendAudioChunk` chokepoint: `{"message_type":"input_audio_chunk","audio_base_64":"…","commit":false,"sample_rate":16000}`; the final flush sets `commit:true`. `previous_text` (append-continuation context) may ride **only the first** chunk — but **the Worker drops it** for realtime (cross-press continuity drift, like the batch refine already has). This is the *client* contract; the Worker translates it to Soniox's binary-PCM + empty-string-end protocol.
- Server → client frames (the vocabulary the **client and phone listener** consume; the Worker emits these by translating Soniox responses): `session_started` (config empty), `partial_transcript`, `committed_transcript`. Client rule: **any frame carrying a string `error` takes the loud error path** — never match error types by name only. The Worker synthesizes an `error` frame then closes `1008` on handshake failures, and maps any Soniox `error_code` (or abnormal close) to one too.
- Audio pipeline: 48 kHz float → the **frame pump** (`buildPumpNode`) → `handleAudioFrame` → averaged downsample to 16 kHz → s16le → base64 (stream) and, in hybrid, the same buffers → `buildWavBlob` (44-byte RIFF header via DataView) → POST. The pump is an **AudioWorklet** (`pcm-pump`, loaded from a Blob URL so the no-build-step constraint holds): it buffers the 128-sample render quanta into `PUMP_FRAME_SAMPLES` (4096 ≈ 85 ms) frames **on the audio render thread** and posts owned (transferred) copies to the main thread. Running off the main thread is load-bearing on mobile — the old main-thread `ScriptProcessorNode` got starved by UI/gate-meter/DOM work and dropped buffers, starving Soniox into slow, sparse transcripts (batch was immune: `MediaRecorder` is off-thread). `ScriptProcessorNode` stays as a **fallback** (same `handleAudioFrame`) so capture is never lost if the worklet can't load; the 4096 frame size is matched so every downstream byte count (`capturePcm`, `MIN_REFINE_BYTES`) is unchanged.

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

# Full session-flow simulation (26 scenario groups: realtime happy path incl.
# pre-roll/buffering/tail/commit-wait, unexpected disconnect, dead-mic alarm,
# append-window expiry, connect timeout, queued PTT, hotkey tap/hold, engine
# selector, batch happy (incl. PTT gate-open priming)/fail/queued-PTT, hybrid happy/refine-fail/recovery/
# append/no-live-text, click-to-append, keyterm presets, boot shim:
# migration/defaults/restore/auth collapse, phone mic session, phone link
# resilience: reconnect/replay-dedupe/focus-retry/grace-fallback/zero-listener
# ack, SessionRoom DO contract incl. GET /latest, phone link persistence:
# resume/rejoin across reloads, iOS mic resilience: wake lock/muted-track
# rebuild/Permissions-API-free re-warm, QR join: locally-encoded QR decoded
# back with jsqr + /?join= auto-join, big-button layout: join/leave/persisted/
# QR activation, hold-vs-tap pointer semantics incl. slide-away backstop,
# sub-threshold pointercancel, multi-touch, queued-start cancellation
# (release/cancel/F14), screen-state mirror incl. zero-listener + relay-fail
# redden, finalize-gap busy, sentinel-outcome FAILED, haptic patterns, peek
# strip incl. live realtime words on-screen while recording, per-device
# override, joined local-copy denial deferring to the
# relay ack, Soniox realtime frame translation: client chunk→binary PCM/
# empty-string-end, final/non-final tokens→running partial + committed on
# finished, error_code→loud error frame, AudioWorklet pump: module load +
# AudioWorkletNode (not ScriptProcessor) + a posted frame streaming a
# spec-shaped audio chunk — the rest of the suite covers the ScriptProcessor
# fallback path via the same handleAudioFrame):
npm install --no-save jsdom jsqr
node tests/flow.test.mjs
```

When changing the session flow, beeps, clipboard behavior, engines, or watchdog: **update/extend `tests/flow.test.mjs` scenarios in the same change** and run them. The harness mocks `WebSocket`, `fetch` (queue-driven; an empty queue answers 500 so unexpected uploads fail loudly), `AudioContext`, `getUserMedia`, `MediaRecorder` (delivers a real Blob on stop), and the clipboard.

jsdom gotchas baked into the harness: define `window.isSecureContext = true` and stub `navigator.clipboard`, or every clipboard path "fails"; stub `URL.createObjectURL` (the preview path runs whenever the recorder delivers chunks); fire `onaudioprocess` manually to simulate audio frames (each ≈ 2730 bytes at 16 kHz — the hybrid refine needs ≥ 6 frames to clear `MIN_REFINE_BYTES`).

## Tuning constants (top of the client script)

| Constant | Default | Meaning |
|---|---|---|
| `CONNECT_TIMEOUT_MS` | 5000 | WS must open within this or loud-fail |
| `TAIL_MS` | 600 | Post-release audio tail, realtime/hybrid (anti-clipping) |
| `BATCH_TAIL_MS` | 300 | Batch: keep the recorder running this long after release so the last word isn't clipped (smaller than realtime — no streaming pipeline, and less added latency on the slower engine) |
| `FINAL_WAIT_MS` | 2500 | Max wait for final commit after flush |
| `COMMIT_QUIET_MS` | 350 | Close this soon after the last committed transcript |
| `FLATLINE_RMS` | 0.0008 | Dead-mic threshold for the watchdog |
| `PENDING_CHUNK_CAP` | 400 | ≈ 35 s buffered while connecting |
| `HOTKEY_TAP_MS` | 400 | Hotkey press shorter = tap (toggle), longer = hold (PTT) |
| `PREROLL_MS` | 400 | Idle audio prepended at session start (first-word rescue) |
| `BATCH_UPLOAD_TIMEOUT_MS` | 30000 | Pure batch upload + transcription deadline |
| `REFINE_TIMEOUT_MS` | 8000 | Hybrid refine deadline (live text is the fallback) |
| `SESSION_PCM_CAP_BYTES` | 24 MiB | Hybrid capture cap (~12.5 min); past it, live text wins |
| `MIN_REFINE_BYTES` | 16000 | ~0.5 s; below this the hybrid refine is skipped |
| `PHONE_PING_INTERVAL_MS` | 25000 | Desktop→room heartbeat cadence |
| `PHONE_PONG_TIMEOUT_MS` | 90000 | No room traffic for this long = zombie socket, force reconnect |
| `PHONE_RECONNECT_MAX_MS` | 15000 | Room-listener reconnect backoff cap |
| `PHONE_FALLBACK_GRACE_MS` | 10000 | Wait for `phone_delivery` after `phone_session_end` before live-text fallback |
| `RELAY_TIMEOUT_MS` | 10000 | Phone→room delivery ack deadline (a hung relay fails loudly; the queued next session waits on the ack) |
| `DELIVERY_REPLAY_WINDOW_MS` | 120000 | (Worker, top of file) room replays the held delivery to reconnecting listeners |

The AHK script's `CLIP_TIMEOUT := 20` is sized for hybrid's worst case (tail 0.6 s + final-wait 2.5 s + refine 8 s ≈ 11 s). If you raise the client deadlines, raise it too.

## Deployment

`npx wrangler deploy` (worker name `eleven` — the pre-merge batch app's URL, so its users' localStorage survives; secrets persist across deploys). Shared mode now needs **three** secrets: `npx wrangler secret put ELEVENLABS_API_KEY` (batch/refine), `…put SONIOX_API_KEY` (realtime), and `…put APP_PASSPHRASE`. HTML is served `cache-control: no-store` (users always get the latest build); manifest/icons are cacheable. `wrangler dev` works for UI checks; the proxies need real keys to go end-to-end.

## Known sharp edges

- The frame pump is an **AudioWorklet** now (`buildPumpNode`); `ScriptProcessorNode` is the deprecated fallback only. Keep all per-frame logic in `handleAudioFrame` (shared by both paths) — don't split behavior across the two, and don't add load-bearing logic to the ScriptProcessor branch.
- Closing the WS immediately after sending `commit:true` loses the final transcript — always go through the await-final path.
- Clipboard writes require document focus; both `navigator.clipboard` and the `execCommand` fallback fail unfocused. The UX (beeps, sentinel) is built around that constraint — don't "fix" it by silently retrying later. (The phone-link focus-retry is the one sanctioned exception: it is loud while pending and retries only on refocus — see the Phone link section.)
- The shared-mode passphrase travels as a query param on the WS path (hardening idea in the README roadmap); don't add logging of request URLs in the Worker. The POST path carries it in the form body.
- "Clear dictation box" / "Clear history" during an in-flight upload/refine mutate `finalizedSegments`, which the delivery then overwrites from `sessionBaseText` — a cleared box can reappear with the delivered note. Cosmetic, known, alpha-acceptable.
- The hybrid refine has no `previous_text` equivalent (batch API limitation) — cross-press capitalization/punctuation continuity in refined text can drift slightly from the live rendering.
- The audio preview/download is the post-gate recording in every engine; in hybrid the refine hears the *ungated* WAV, so the preview is not byte-identical to what batch transcribed.
