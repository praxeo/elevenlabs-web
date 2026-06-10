# CLAUDE.md

Guidance for AI/dev sessions working in this repo. Read this before touching `worker.js`.

## What this is

A one-file Cloudflare Worker serving a realtime medical dictation app (ElevenLabs Scribe v2 Realtime over WebSocket). Users are clinicians doing push-to-talk dictation into Cerner/Citrix via AutoHotkey, with clipboard handoff. See `README.md` for product behavior, tuning, and roadmap.

**Prime directive: failures must be loud.** A silent failure means wrong or missing text in a patient chart. Never trade failure visibility for a feature. An error path must never play the success beep or leave a stale clipboard unflagged.

## Repo layout

- `worker.js` — everything: Worker fetch handler, WebSocket proxy (`handleTranscribe`), PWA manifest/icons, and the entire client app embedded in the `INDEX_HTML` template literal.
- `tests/flow.test.mjs` — jsdom harness simulating full dictation sessions (see Validation). If `tests/` is missing, you are on pre-hardening `main`; the harness and the behavior it tests land with branch `claude/dreamy-shannon-ojwbj0`.
- `wrangler.toml`, `README.md`, this file.

## Constraints & style

- **No build step, no runtime dependencies, no frameworks.** The client is vanilla JS inside a template literal. Keep it that way unless explicitly asked otherwise.
- Inside `INDEX_HTML`:
  - **Never use backticks or `${`** — it's a template literal; they terminate/interpolate it.
  - Client-side regex/string backslashes must be **double-escaped** (`\\r\\n` in source → `\r\n` in the served page).
  - Client JS uses string concatenation, not template literals — match that.
  - A few legacy lines carry trailing whitespace; exact-match edits must include it.
- Settings persist under `localStorage` keys suffixed `_v9` (`scribe_v2_settings_v9`, `scribe_v2_transcripts_v9`, `elevenlabs_api_key_browser_v9`, `scribe_v2_passphrase_v9`). **Bumping the suffix wipes all user settings/history** — add fields to the existing schema instead; only bump on explicit request.

## Hard invariants — do not break

- **F13 keydown starts, F14 keydown stops — always, unconditionally.** This is the AutoHotkey contract (CapsLock hold). Users have working AHK scripts; in-page key handling must stay compatible. The configurable in-app hotkey (default Ctrl+Space; tap = toggle, hold > `HOTKEY_TAP_MS` = push-to-talk; stored in settings as `hotkey: {ctrl,alt,shift,meta,code}`) is **additive** — it must never replace or shadow F13/F14.
- **Clipboard sentinel** is exactly `##DICTATION_FAILED##` (AHK/user workflows recognize it).
- **Beep semantics**: start/done beeps are gated by the checkbox; **failure/alarm beeps always play**. Beeps reuse the persistent `audioCtx` when running (a fresh `AudioContext` in a background tab starts suspended and is silent — exactly when the cue matters most).
- **STT feed is pre-gate**: Scribe receives raw high-passed audio; the noise gate shapes only the local `MediaRecorder` preview. Don't route the gate into the STT path.
- **Shared mode**: the master API key must never reach the browser; the Worker injects it server-side after the constant-time passphrase check (`safeEqual`).
- **Failure-aware finalize**: unexpected disconnects copy whatever partial text exists, but with red status + fail beep. No-text failures copy the sentinel. A failed clipboard write must fail-beep.
- `cleanTranscript` semantics (optional ellipsis strip — Scribe renders pauses as "…"/"..." — strip newlines, collapse spaces, tighten space-before-punctuation, optional trailing space) — downstream paste workflows depend on them.

## Client session state machine

One WebSocket per dictation. Per-session state is guarded by `sessionSeq` (stale socket callbacks bail out) and `sessionFinalized` (finalize runs exactly once).

```
idle
 └─ startRecording(): ensureAudio() revalidates/rebuilds the graph, resets per-session
    state, applies append-window decision, seeds pendingChunks with the pre-roll
    (buildPrerollChunks: last PREROLL_MS of idle frames), opens WS
     └─ connecting: onaudioprocess buffers frames (cap PENDING_CHUNK_CAP);
        CONNECT_TIMEOUT_MS → loud fail (sentinel + failBeep)
         └─ open: flush buffer, stream live
             └─ stopRecording() [PTT release]: stopPhase="tail" — audio KEEPS
                streaming for TAIL_MS (anti-clipping)
                 └─ beginCommitPhase(): send {audio_base_64:"", commit:true},
                    stopPhase="awaitFinal"; close COMMIT_QUIET_MS after the last
                    committed transcript, or at FINAL_WAIT_MS deadline
                     └─ onclose → finalizeSession(unexpected = !userStopped)
```

- Any close we didn't request ⇒ `finalizeSession(true)` ⇒ red status + fail beep.
- A 30 ms watchdog (inside the gate meter loop) fires the mic alarm on dead/muted track or RMS flatline (< `FLATLINE_RMS` after 2.5 s), and a warn if speech flows but zero transcripts arrive in 8 s.
- F13 during finalization sets `pendingStart`; `maybePendingStart()` starts the next session after finalize.
- Trailing partials are part of `latestText` — never discard a partial at shutdown; that is the anti-clipping backstop if the commit reply never comes.
- Mic re-engagement: `audioGraphHealthy()` checks the actual `MediaStreamTrack.readyState`, not just variable presence; rebuilt on start and on `pageshow` / `visibilitychange` / `devicechange`. bfcache restores leave dead streams that *look* alive — that was the original "mic won't engage on reopen" bug.
- Pre-roll: while not live-streaming, `onaudioprocess` keeps raw frames in `prerollFrames` (memory only, capped); session start prepends the last `PREROLL_MS` of them. The ring only ever holds never-sent frames (live frames go to the socket, not the ring), so prepending cannot double-transcribe — keep that property when touching the audio pump.

## ElevenLabs realtime API (as used)

- Backend: `wss api.elevenlabs.io/v1/speech-to-text/realtime` via Worker `fetch` with `Upgrade: websocket` + `xi-api-key`.
- Query params: `model_id=scribe_v2_realtime`, `audio_format=pcm_16000`, `language_code=en`, `commit_strategy=vad`, `no_verbatim`, `include_timestamps`, optional `vad_silence_threshold_secs` / `vad_threshold` / `min_speech_duration_ms`, repeated `keyterms` (≤ 50, ≤ 20 chars, ≤ 5 words, sanitized in the Worker).
- Client → server frames: every chunk goes through the `sendAudioChunk` chokepoint, which guarantees the spec-required fields: `{"message_type":"input_audio_chunk","audio_base_64":"…","commit":false,"sample_rate":16000}`; the final flush sets `commit:true`. `previous_text` (append-continuation context, tail of the current note) may ride **only the first** chunk of a socket — the server errors if it appears later; keep that property when touching the send paths.
- Server → client frames: `session_started` (echoes the applied config incl. `keyterms` — surfaced in the status line as "(N keyterms active)"), `partial_transcript`, `committed_transcript`, `committed_transcript_with_timestamps`, plus a family of error frames (`error`, `auth_error`, `quota_exceeded`, `rate_limited`, `commit_throttled`, `session_time_limit_exceeded`, `input_error`, `chunk_size_exceeded`, `insufficient_audio_activity`, `transcriber_error`, …). Client rule: **any frame carrying a string `error` takes the loud error path** — never match error types by name only. The Worker synthesizes an `error` frame then closes `1008` on handshake failures, so upstream errors surface through the same path.
- Audio pipeline: 48 kHz float (ScriptProcessor, 4096 samples ≈ 85 ms/frame) → averaged downsample to 16 kHz → s16le → base64.

## Validation (no browser needed)

```sh
node --check worker.js

# Render through the real fetch handler and syntax-check the served inline script:
node --input-type=module -e "
const m = await import('./worker.js');
const r = await m.default.fetch(new Request('https://x/'), {});
const h = await r.text();
const js = h.slice(h.indexOf('<script>')+8, h.indexOf('</'+'script>'));
require('fs').writeFileSync('/tmp/served.js', js);" 2>/dev/null || true
node --check /tmp/served.js

# Full session-flow simulation (7 scenarios: happy path incl. pre-roll/buffering/
# tail/commit-wait, unexpected disconnect, dead-mic alarm, append-window expiry,
# connect timeout, queued PTT, hotkey tap/hold):
npm install --no-save jsdom
node tests/flow.test.mjs
```

When changing the session flow, beeps, clipboard behavior, or watchdog: **update/extend `tests/flow.test.mjs` scenarios in the same change** and run them. The harness mocks `WebSocket`, `AudioContext`, `getUserMedia`, `MediaRecorder`, and the clipboard.

jsdom gotchas baked into the harness: define `window.isSecureContext = true` and stub `navigator.clipboard`, or every clipboard path "fails"; fire `onaudioprocess` manually to simulate audio frames.

## Tuning constants (top of the client script)

| Constant | Default | Meaning |
|---|---|---|
| `CONNECT_TIMEOUT_MS` | 5000 | WS must open within this or loud-fail |
| `TAIL_MS` | 600 | Post-release audio tail (anti-clipping) |
| `FINAL_WAIT_MS` | 2500 | Max wait for final commit after flush |
| `COMMIT_QUIET_MS` | 350 | Close this soon after last committed transcript |
| `FLATLINE_RMS` | 0.0008 | Dead-mic threshold for the watchdog |
| `PENDING_CHUNK_CAP` | 400 | ≈ 35 s buffered while connecting |
| `HOTKEY_TAP_MS` | 400 | Hotkey press shorter = tap (toggle), longer = hold (PTT) |
| `PREROLL_MS` | 400 | Idle audio prepended at session start (first-word rescue) |

## Deployment

`npx wrangler deploy`. Shared mode: `npx wrangler secret put ELEVENLABS_API_KEY` and `…put APP_PASSPHRASE`. HTML is served `cache-control: no-store` (users always get the latest build); manifest/icons are cacheable. `wrangler dev` works for UI checks; the WS proxy needs a real key to go end-to-end.

## Known sharp edges

- `ScriptProcessorNode` is deprecated (AudioWorklet migration is on the roadmap) — don't add new load-bearing logic to it beyond the existing frame pump.
- Closing the WS immediately after sending `commit:true` loses the final transcript — that was the original last-word-clipping bug. Always go through the await-final path.
- Clipboard writes require document focus; both `navigator.clipboard` and the `execCommand` fallback fail unfocused. The UX (beeps, sentinel) is built around that constraint — don't "fix" it by silently retrying later, which would put stale text on the clipboard at an unexpected time.
- The shared-mode passphrase travels as a query param (hardening idea in the README roadmap); don't add logging of request URLs in the Worker.
