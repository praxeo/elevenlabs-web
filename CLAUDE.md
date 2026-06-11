# CLAUDE.md

Guidance for AI/dev sessions working in this repo. Read this before touching `worker.js`.

## What this is

A one-file Cloudflare Worker serving a medical dictation app with **three engines** behind one UI:

- **Realtime** — ElevenLabs Scribe v2 Realtime over WebSocket; live text is the deliverable.
- **Batch** (default) — the post-gate recording uploads to batch Scribe v2 on release (the pre-merge batch app's behavior).
- **Hybrid** — realtime text is *feedback*; the same audio is re-transcribed through batch Scribe v2 and *that* lands on the clipboard.

Users are clinicians doing push-to-talk dictation into Cerner/Citrix via AutoHotkey, with clipboard handoff. See `README.md` for product behavior, tuning, and roadmap.

**Prime directive: failures must be loud.** A silent failure means wrong or missing text in a patient chart. Never trade failure visibility for a feature. An error path must never play the success beep or leave a stale clipboard unflagged.

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
- Settings persist under `localStorage` keys suffixed `_v9` (`scribe_v2_settings_v9`, `scribe_v2_transcripts_v9`, `elevenlabs_api_key_browser_v9`, `scribe_v2_passphrase_v9`). **Bumping the suffix wipes all user settings/history** — add fields to the existing schema instead; only bump on explicit request.
- `scribe_v2_access_code_v9` is the pre-merge batch app's passphrase key. `loadSettings` **must keep reading it as a fallback** (users at the legacy batch URL still have their code there); writes go to `scribe_v2_passphrase_v9`, and forget/unremember must clear both.
- **Compactness contract**: the app must stay fully usable in a tiny minimized PWA window. The primary card (engine selector, record button, meter/pills, status, latest transcript) stays always-visible and first in the DOM; credentials live in the Access `<details>` (auto-collapses once `hasAuth()`, reopened by `updateAuthUI` paths on missing/forgotten credentials), checkboxes + hotkey in Options, keyterms and Advanced in their own `<details>`. Put new settings inside those sections, not in always-visible rows.

## Hard invariants — do not break

- **F13 keydown starts, F14 keydown stops — always, unconditionally.** This is the AutoHotkey contract (CapsLock hold). The configurable in-app hotkey (default Ctrl+Space; tap = toggle, hold > `HOTKEY_TAP_MS` = push-to-talk) is **additive** — it must never replace or shadow F13/F14.
- **Clipboard sentinel** is exactly `##DICTATION_FAILED##` (AHK/user workflows recognize it).
- **Beep semantics**: start/done beeps are gated by the checkbox; **failure (`failBeep`), mic-alarm (`micAlarmBeep`) and warn (`warnBeep`) sounds always play**. Beeps reuse the persistent `audioCtx` when running (a fresh `AudioContext` in a background tab starts suspended and is silent — exactly when the cue matters most). A degraded success (hybrid refine failed, live text delivered) gets `warnBeep`, never `doneBeep`.
- **Exactly one delivery per session.** Every engine's finalize path ends in exactly one `deliverFinalText()` call — one clipboard outcome, one beep. `sessionFinalized` guards finalize; the `finishing` flag spans the async upload/refine phases and serializes sessions: F13/hotkey during it queues via `pendingStart`, never overlaps.
- **STT feed is pre-gate** in realtime/hybrid: Scribe receives raw high-passed audio; the noise gate shapes only the local `MediaRecorder` preview. **In batch mode the gate is load-bearing**: the post-gate recording *is* what gets transcribed, and `MediaRecorder` construction failure is fatal (sentinel + failBeep), not a preview degradation.
- **`capturePcm` captures each frame exactly once, at production time** (audio pump + pre-roll build) — never in `sendAudioChunk`/`flushPendingChunks`. That is what makes the hybrid refine a recovery path when the socket never opens or dies: the buffer is a superset of what the stream delivered. Keep the pre-roll property too: the ring only ever holds never-sent frames, so prepending cannot double-transcribe.
- **Shared mode**: the master API key must never reach the browser; the Worker injects it server-side after the constant-time passphrase check (`safeEqual`) — on both the WS and POST paths.
- **Failure-aware finalize**: unexpected disconnects deliver whatever text exists, but with red status + fail beep. No-text failures copy the sentinel. A failed clipboard write must fail-beep. In hybrid, a dead link does **not** skip the refine (that's the recovery), but the outcome is still framed as a failure to verify.
- `cleanTranscript` semantics (optional ellipsis strip — Scribe renders pauses as "…"/"..." — strip newlines, collapse spaces, tighten space-before-punctuation, optional trailing space) — downstream paste workflows depend on them.

## Client session state machine

One session per dictation, guarded by `sessionSeq` (stale socket callbacks bail out), `sessionFinalized` (finalize runs exactly once), and `finishing` (delivery still in flight; new sessions queue).

```
idle
 └─ startRecording(): ensureAudio(), per-session resets, sessionEngine = engine
    snapshot, append decision (appendArmed one-shot beats checkbox+window),
    sessionBaseText snapshot
     ├─ ENGINE batch: no WebSocket, no pre-roll. Post-gate MediaRecorder is the
     │  capture path; stopRecording() → recorder.onstop → finalizeSession(false)
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
- F13 during finalization or delivery sets `pendingStart`; `maybePendingStart()` starts the next session after `deliverFinalText`.
- **Click-to-append**: clicking the populated transcript box while idle toggles `appendArmed` — a one-shot "append the next dictation" that beats the append-mode checkbox (off by default) and the window; consumed at session start, cleared whenever the box empties, ignored mid-session and while text is selected. The chip + box border surface the armed state.
- **Boot restore**: `restoreLatestFromHistory()` puts the newest history entry into the box and adopts its `createdAt` as `lastFinalizeAt`, so the note stays visible across reloads and the append window keeps counting from the real finish time.
- Trailing partials are part of `latestText` — never discard a partial at shutdown; that is the anti-clipping backstop if the commit reply never comes.
- Mic re-engagement: `audioGraphHealthy()` checks the actual `MediaStreamTrack.readyState` **and `muted`** (iOS interruptions — lock screen, Siri, calls — leave the track "live" but permanently muted), not just variable presence; rebuilt on start and on `pageshow` / `visibilitychange` / `devicechange`. bfcache restores leave dead streams that *look* alive. iOS Safari has no Permissions API entry for the mic, so `tryWarmOnLoad` falls back to `micEverGranted` (set on the first successful `getUserMedia`) — without that fallback every re-warm path is a silent no-op on iOS. A screen wake lock is held from session start to `deliverFinalText` (re-acquired on `visibilitychange` mid-session) so iOS auto-lock cannot reclaim the mic mid-dictation or suspend the page mid-upload/refine.
- `sessionPcm` (hybrid) is reset at session start and emptied in `refineAndDeliverHybrid` — a ~20 MB buffer must never outlive its session. On cap (`SESSION_PCM_CAP_BYTES`) the complete live text beats a truncated refine.

## Phone link (dictate on the phone, clipboard on the desktop)

One Durable Object room per 6-char session code (`SessionRoom`, top of `worker.js`; route `/api/session/<code>`). The desktop holds a listener WebSocket to the room; the phone joins by code — its realtime WS carries `session=<code>` so the Worker mirrors transcript frames into the room (live feedback on the desktop), and the phone's `deliverFinalText` POSTs the authoritative final text to `/api/session/<code>/deliver`. The desktop's `phone_delivery` handler is what writes the desktop clipboard.

Resilience contract — every layer of this link fails silently by default; do not weaken these:

- **Heartbeat + reconnect**: the desktop pings the room every `PHONE_PING_INTERVAL_MS`; no room traffic for `PHONE_PONG_TIMEOUT_MS` (sized for background-tab timer throttling) = zombie socket — force-close and reconnect with backoff (cap `PHONE_RECONNECT_MAX_MS`) for as long as `phoneSessionCode` is set. A drop flips the code badge to `⚠`/danger with a red status. The badge being visible is **not** proof of a live link — only the heartbeat is.
- **Buffered delivery + dedupe**: the room retains the last `phone_delivery` and replays it to (re)connecting listeners within `DELIVERY_REPLAY_WINDOW_MS`; the phone stamps each delivery with a `delivery_id` and the desktop dedupes by it, so replays can never double-copy.
- **Delivery ack**: `/deliver` answers with the room's listener count. Zero listeners ⇒ red "desktop link is DOWN" status + warn beep on the phone (the local done beep has already played — correct: the local delivery succeeded, the relay leg failed). Never restore fire-and-forget here.
- **Focus-retry copy**: a delivery whose clipboard write fails (tab unfocused behind Citrix/Cerner) is held in `pendingCopyText` with red status + fail beep, and retried on the window `focus` event. This is the sanctioned exception to "don't silently retry clipboard writes later" — it is not silent; the status stays red until the retry lands.
- **`phone_session_end` is per-dictation, not per-session**: the Worker broadcasts it when the phone's realtime socket closes, which is *before* the hybrid refine finishes. The desktop must NOT tear down the session on it; it starts a `PHONE_FALLBACK_GRACE_MS` timer and, only if no `phone_delivery` arrives, delivers the accumulated live `remoteCommitted` text framed as degraded (warn). A real delivery cancels the timer.
- **Audible desktop cues**: the desktop listener never records, so `audioCtx` may not exist; `beepCtx` is warmed from the session-start click (a user gesture) and `beep()` falls back to it. Without this, every fail beep on the listener is silent. (A boot-time session resume has no gesture — `restorePhoneLink` arms a one-shot warm-up on the first pointerdown/keydown.)
- **QR join**: the desktop renders a QR of `/?join=<code>` next to the code badge, generated by the embedded encoder (`qrMatrix` — byte mode, EC M, versions 1-6) — **never** an external QR image service, which would leak the code (the link's only credential). The phone's boot path (`restorePhoneLink`) consumes `?join=`, persists the join like a typed code, and scrubs the param from the address bar. Scenario 24 round-trips the rendered SVG through a real decoder (`jsqr`) — keep that test: a QR that renders but doesn't scan is a silent failure.
- **Pairing survives reloads**: `phoneSessionCode`, `joinedSessionCode`, and `lastDeliveryId` persist as additive `_v9` settings fields; `restorePhoneLink()` (boot, after `loadSettings`) resumes the desktop room / restores the phone's join, so an iOS PWA kill or tab reload cannot break the link. Persisting `lastDeliveryId` is what keeps the room's replay from double-copying across a reload. "End session" / "Leave" must clear the stored codes.
- **`GET /api/session/<code>/latest`** returns the room's held delivery (within the replay window) for native pollers — `hotkey.ahk`'s optional phone-link poller uses it to write the clipboard with **no browser-focus requirement** (set `PHONE_POLL_URL` + `PHONE_CODE` at the top of the script). The poller baselines the first id it sees (never pastes a pre-existing delivery), dedupes by `delivery_id`, and skips polls while the PTT clipboard handshake is in flight (`BUSY`). Same trust model as the listener WS: the code is the only credential.

## ElevenLabs APIs (as used)

**One path, two protocols** — `/api/transcribe`:
- **WebSocket upgrade** → `handleTranscribeRealtime`: proxies to `wss api.elevenlabs.io/v1/speech-to-text/realtime` with `xi-api-key`. Query params: `model_id=scribe_v2_realtime`, `audio_format=pcm_16000`, `language_code=en`, `commit_strategy=vad`, `no_verbatim`, `include_timestamps`, optional `vad_silence_threshold_secs` / `vad_threshold` / `min_speech_duration_ms`, repeated `keyterms` (≤ 50, ≤ 20 chars, ≤ 5 words).
- **POST** (multipart form) → `handleTranscribeBatch`: proxies to `https://api.elevenlabs.io/v1/speech-to-text` batch `scribe_v2`. Fields: `api_key` or `passphrase`, `file` (webm/ogg from batch mode, wav from the hybrid refine), `file_format=other`, `timestamps_granularity` (none/word/character), `no_verbatim`, `tag_audio_events`, `keyterms_json` (≤ 1000 terms, < 50 chars). Size gates 1 KB–25 MB.
- Both handlers share `safeEqual`, `json`, and `sanitizeKeyterms` (per-API limits as parameters). Keyterm scrubbing happens client-side (`parseKeyterms` with per-API caps) **and** server-side — keep both.
- **Keyterm presets** live in the `KEYTERM_PRESETS` const (top of `worker.js`, before `MANIFEST`): `always: true` lists apply to every dictation invisibly (every dictation then pays the ~20 % keyterm surcharge); the rest render as checkboxes in the Keyterms section, persisted as `presetIds` in the `_v9` settings (additive field). The Worker injects the sanitized lists via the `__KEYTERM_PRESETS__` token — **function replacer only**; a string replacement would interpret `$`-patterns in term text. The client merges in `effectiveKeyterms` with trim priority **custom > checked presets > always-on** when the realtime 50-term cap overflows; batch (1000) gets everything, so in hybrid the clipboard text benefits from the full list even when the live feed trimmed. Editing/adding a list = edit the const + deploy. `renderPresetRow()` must run before `loadSettings()` at boot.
- Client → server WS frames: every chunk goes through the `sendAudioChunk` chokepoint, which guarantees the spec-required fields: `{"message_type":"input_audio_chunk","audio_base_64":"…","commit":false,"sample_rate":16000}`; the final flush sets `commit:true`. `previous_text` (append-continuation context) may ride **only the first** chunk of a socket — the server errors if it appears later.
- Server → client frames: `session_started` (echoes applied config incl. `keyterms` — surfaced in the status line), `partial_transcript`, `committed_transcript`, `committed_transcript_with_timestamps`, plus a family of error frames. Client rule: **any frame carrying a string `error` takes the loud error path** — never match error types by name only. The Worker synthesizes an `error` frame then closes `1008` on handshake failures.
- Audio pipeline: 48 kHz float (ScriptProcessor, 4096 samples ≈ 85 ms/frame) → averaged downsample to 16 kHz → s16le → base64 (stream) and, in hybrid, the same buffers → `buildWavBlob` (44-byte RIFF header via DataView) → POST.

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

# Full session-flow simulation (24 scenario groups: realtime happy path incl.
# pre-roll/buffering/tail/commit-wait, unexpected disconnect, dead-mic alarm,
# append-window expiry, connect timeout, queued PTT, hotkey tap/hold, engine
# selector, batch happy/fail/queued-PTT, hybrid happy/refine-fail/recovery/
# append/no-live-text, click-to-append, keyterm presets, boot shim:
# migration/defaults/restore/auth collapse, phone mic session, phone link
# resilience: reconnect/replay-dedupe/focus-retry/grace-fallback/zero-listener
# ack, SessionRoom DO contract incl. GET /latest, phone link persistence:
# resume/rejoin across reloads, iOS mic resilience: wake lock/muted-track
# rebuild/Permissions-API-free re-warm, QR join: locally-encoded QR decoded
# back with jsqr + /?join= auto-join):
npm install --no-save jsdom jsqr
node tests/flow.test.mjs
```

When changing the session flow, beeps, clipboard behavior, engines, or watchdog: **update/extend `tests/flow.test.mjs` scenarios in the same change** and run them. The harness mocks `WebSocket`, `fetch` (queue-driven; an empty queue answers 500 so unexpected uploads fail loudly), `AudioContext`, `getUserMedia`, `MediaRecorder` (delivers a real Blob on stop), and the clipboard.

jsdom gotchas baked into the harness: define `window.isSecureContext = true` and stub `navigator.clipboard`, or every clipboard path "fails"; stub `URL.createObjectURL` (the preview path runs whenever the recorder delivers chunks); fire `onaudioprocess` manually to simulate audio frames (each ≈ 2730 bytes at 16 kHz — the hybrid refine needs ≥ 6 frames to clear `MIN_REFINE_BYTES`).

## Tuning constants (top of the client script)

| Constant | Default | Meaning |
|---|---|---|
| `CONNECT_TIMEOUT_MS` | 5000 | WS must open within this or loud-fail |
| `TAIL_MS` | 600 | Post-release audio tail (anti-clipping) |
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
| `DELIVERY_REPLAY_WINDOW_MS` | 120000 | (Worker, top of file) room replays the held delivery to reconnecting listeners |

The AHK script's `CLIP_TIMEOUT := 20` is sized for hybrid's worst case (tail 0.6 s + final-wait 2.5 s + refine 8 s ≈ 11 s). If you raise the client deadlines, raise it too.

## Deployment

`npx wrangler deploy` (worker name `eleven` — the pre-merge batch app's URL, so its users' localStorage survives; secrets persist across deploys). Shared mode: `npx wrangler secret put ELEVENLABS_API_KEY` and `…put APP_PASSPHRASE`. HTML is served `cache-control: no-store` (users always get the latest build); manifest/icons are cacheable. `wrangler dev` works for UI checks; the proxies need a real key to go end-to-end.

## Known sharp edges

- `ScriptProcessorNode` is deprecated (AudioWorklet migration is on the roadmap) — don't add new load-bearing logic to it beyond the existing frame pump + `capturePcm`.
- Closing the WS immediately after sending `commit:true` loses the final transcript — always go through the await-final path.
- Clipboard writes require document focus; both `navigator.clipboard` and the `execCommand` fallback fail unfocused. The UX (beeps, sentinel) is built around that constraint — don't "fix" it by silently retrying later. (The phone-link focus-retry is the one sanctioned exception: it is loud while pending and retries only on refocus — see the Phone link section.)
- The shared-mode passphrase travels as a query param on the WS path (hardening idea in the README roadmap); don't add logging of request URLs in the Worker. The POST path carries it in the form body.
- "Clear dictation box" / "Clear history" during an in-flight upload/refine mutate `finalizedSegments`, which the delivery then overwrites from `sessionBaseText` — a cleared box can reappear with the delivered note. Cosmetic, known, alpha-acceptable.
- The hybrid refine has no `previous_text` equivalent (batch API limitation) — cross-press capitalization/punctuation continuity in refined text can drift slightly from the live rendering.
- The audio preview/download is the post-gate recording in every engine; in hybrid the refine hears the *ungated* WAV, so the preview is not byte-identical to what batch transcribed.
