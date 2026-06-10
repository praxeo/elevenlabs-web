# ElevenLabs Scribe v2 Realtime Dictation

A self-contained, low-latency **realtime** medical dictation web app built on a single Cloudflare Worker. This is the realtime (WebSocket) sibling of the Scribe v2 batch dictation tool: text appears live in the transcript box as you speak, and the finished text lands on the clipboard the moment you release push-to-talk.

Designed for clinicians dictating into **Cerner running inside Citrix**: push-to-talk via AutoHotkey (CapsLock → F13/F14), clipboard handoff, audio cues so you never have to look at the browser, and *loud* failure notification — the worst outcome this tool can produce is silently wrong or missing text in a chart, and everything in the design bends toward preventing that.

**Key features:**

- **Push-to-talk dictation** with a configurable in-app hotkey — default **Ctrl + Space** (tap to start/stop, hold to talk) — plus the F13/F14 contract for existing AutoHotkey CapsLock setups, which keeps working unchanged.
- **Live transcript** streamed from ElevenLabs Scribe v2 Realtime over a secure WebSocket proxy (the API key never reaches the browser in shared mode).
- **Anti-clipping pipeline**: a ~400 ms pre-roll (the moment *before* you pressed is captured too), buffering while the socket connects, a post-release audio tail, and a commit-then-wait shutdown — so the first and last words survive.
- **Loud failure notification**: dead-mic alarm *while you're dictating*, connect-timeout alarm, failure beeps that play even from a background tab, clipboard sentinel (`##DICTATION_FAILED##`), and mic/link status pills.
- **Smart append window**: consecutive dictations continue the same note; stale text drops off automatically.
- **Custom keyword biasing** (up to 50 keyterms) for specialized medical vocabulary.
- **Installable web app** (PWA manifest) for a standalone window in constrained environments.

---

## Table of contents

1. [Architecture](#architecture)
2. [Deployment](#deployment)
3. [Daily workflow](#daily-workflow)
4. [AutoHotkey](#autohotkey)
5. [Tuning guide — things to adjust](#tuning-guide--things-to-adjust)
6. [Best practices](#best-practices)
7. [Failure handling](#failure-handling)
8. [Append semantics](#append-semantics)
9. [Roadmap](#roadmap)
10. [Thoughts & open questions](#thoughts--open-questions)
11. [Troubleshooting](#troubleshooting)

---

## Architecture

```
Browser (this page, installable PWA)
  mic → high-pass → ┬→ analyser (meter, gate UI, health watchdog)
                    ├→ ScriptProcessor → 16 kHz PCM → base64 frames ─┐
                    └→ noise gate → MediaRecorder (local playback)   │
                                                                     ▼
Cloudflare Worker  /api/transcribe  (WebSocket proxy, key injection, keyterm scrub)
                                                                     ▼
ElevenLabs  wss …/v1/speech-to-text/realtime  (scribe_v2_realtime, VAD commits)
```

Everything lives in **one file, `worker.js`** — the Worker fetch handler, the WebSocket proxy, and the entire client app embedded as a template literal. No build step, no dependencies, no framework. That is a deliberate constraint: the whole system can be read top to bottom, deployed by pasting into the Cloudflare dashboard, and audited in one sitting.

Design notes:

- The **noise gate only shapes the locally saved audio preview**. The realtime feed to Scribe is *not* gated — extraneous-speech rejection is done server-side via the Scribe VAD parameters (noise filter / click filter / pause limit). This differs from the batch sibling, where the gate shapes what gets transcribed.
- **One WebSocket session per dictation.** Pressing PTT again while the previous dictation is finalizing queues a new session automatically.
- In **shared mode** the Worker injects the master API key server-side; the browser only ever holds the passphrase.

## Deployment

```sh
npx wrangler deploy
```

Two modes, controlled by Worker environment variables:

| Variable | Effect |
|---|---|
| *(none)* | Each user pastes their own ElevenLabs API key into the UI. |
| `ELEVENLABS_API_KEY` **and** `APP_PASSPHRASE` | **Shared mode**: users enter only the passphrase; the Worker injects the master key server-side. |

Set secrets with `npx wrangler secret put ELEVENLABS_API_KEY` (and `APP_PASSPHRASE`).

### Install as an app (optional)

Open the deployed URL in Chrome/Edge → browser menu → **Install app** (or the install icon in the address bar). The app opens in its own standalone window, keeps mic permission, and is easier to keep running between dictations than a tab.

## Daily workflow

1. Open the app (or standalone window). The mic warms automatically if permission was previously granted — the **mic ready** pill confirms it.
2. Start dictating: **tap Ctrl + Space** (tap again to stop) or **hold it** like a radio mic — or hold CapsLock via AHK, or click the record button. Start beep = go. You can speak immediately; audio is buffered while the pipeline connects.
3. Speak. Text appears live; the **REC** and **LIVE** pills confirm both mic and pipeline are healthy.
4. Release. The app streams a short audio tail, commits, waits for the final words, then copies the full text. **Rising double beep = text is on the clipboard.** Switch windows and paste.
5. Dictate again within the append window to continue the same note (the combined text is recopied each time), or wait for the window to lapse / press **Clear dictation box** to begin a new note.

### Audio cues

| Sound | Meaning |
|---|---|
| Single mid beep | Recording started |
| Rising double beep | Success — transcript copied to clipboard |
| Long low beep | Failure — sentinel copied, or clipboard copy failed (do **not** paste) |
| Three descending low beeps | **Mic dead alarm** — recording but no audio signal (fires mid-dictation) |
| Two mid beeps | Audio is flowing but no text is coming back from the service |

Start/done beeps can be disabled with the checkbox; **failure alarms always play**, and they reuse the live audio context so they sound even when the tab is in the background.

### Status pills

- **mic ready / REC / MIC FAIL / mic off** — actual `MediaStreamTrack` health, not just permission state.
- **link idle / connecting… / LIVE / LINK FAIL** — WebSocket pipeline state.
- **gate open/closed** — local noise gate (affects only the saved audio preview).
- **append chip** (above the transcript) — whether the next dictation appends or starts fresh, with a countdown.

## Hotkeys & AutoHotkey

Two ways to drive push-to-talk, both always active:

- **In-app hotkey** (no AHK needed): default **Ctrl + Space**. A quick **tap** starts a dictation and another tap stops it; **holding** the combo works like a radio mic — release to stop (presses longer than ~400 ms count as holds). Rebind it by clicking the hotkey button and pressing any combo; unmodified keys (e.g. plain `Space`) are allowed but won't trigger while you're typing in a text field. Saved per-browser.
- **F13 (start) / F14 (stop)** — the AutoHotkey contract. Any AHK setup that sends F13 on press / F14 on release to the browser window keeps working unchanged; the in-page handling is identical to the batch app. Example (AHK v1):

```ahk
*CapsLock::
    if WinExist("ElevenLabs Scribe v2 Dictation") {
        ControlSend,, {F13}, ElevenLabs Scribe v2 Dictation
    }
    KeyWait, CapsLock
    if WinExist("ElevenLabs Scribe v2 Dictation") {
        ControlSend,, {F14}, ElevenLabs Scribe v2 Dictation
    }
return
```

Keep the dictation tab/window focused until the success beep if you rely on auto-copy — browsers refuse clipboard writes from unfocused pages. (This is a browser security boundary, not a bug to fix; the beep-then-switch habit is the workaround.)

## Tuning guide — things to adjust

### In the UI

| Setting | Default | When to change |
|---|---|---|
| **Push-to-talk hotkey** | Ctrl + Space | Rebind to anything (click the field, press a combo). Tap toggles; holds longer than ~400 ms behave as press-and-hold. F13/F14 stay active regardless. |
| **Keyterms** | — | Curate per specialty: drug names, anatomy, eponyms, colleague names. ≤ 50 terms, ≤ 20 chars, ≤ 5 words each. Adds ~20 % to cost. The single biggest accuracy lever available. The status line shows "(N keyterms active)" per session — that count is echoed back by the server, so it's proof they applied. |
| **Append window** | 45 s | Shorten if stale text keeps riding along into new notes; lengthen (or 0 = always) if you dictate long notes with long thinking pauses. |
| **Remove ellipses** | on | Scribe writes dictation pauses as "…"/"..." — this strips them (and tightens any orphaned space before punctuation). Turn off only if you genuinely dictate ellipses. |
| **Scribe pause limit** (`vad_silence_threshold_secs`) | 2.0 s | Raise if segments finalize mid-sentence and grammar suffers; lower for snappier commits on short utterances. |
| **Scribe noise filter** (`vad_threshold`) | 0.55 | Raise in shared/noisy rooms to reject background speech; lower if soft speech is being missed. |
| **Scribe click filter** (`min_speech_duration_ms`) | 150 ms | Raise if keyboard clicks / rustles produce stray words; lower if clipped single-word utterances ("yes", "stat") get dropped. |
| **Gate open/close, high-pass** | 0.030 / 0.008 / 85 Hz | Preview-only in this variant. The meter doubles as the mic-health indicator, so keep the meter; the thresholds matter only for the saved audio file. |
| **Browser noise suppression** | off | Browser DSP can distort specialized terms. Try on only if the room is hopeless and raising the Scribe noise filter wasn't enough. |
| **Timestamps** | none | `word` is plumbed through but currently unused by the UI. |

### In the code (`worker.js`, top of the client script)

| Constant | Default | Meaning / safe range |
|---|---|---|
| `CONNECT_TIMEOUT_MS` | 5000 | WebSocket must open within this or the dictation fails loudly. 3000–8000. |
| `TAIL_MS` | 600 | Audio keeps streaming this long after PTT release. Raise to ~900 if last words still clip; cost is added latency per dictation. |
| `FINAL_WAIT_MS` | 2500 | Max wait for the final committed transcript after commit. |
| `COMMIT_QUIET_MS` | 350 | Close this soon after the last committed transcript arrives. |
| `FLATLINE_RMS` | 0.0008 | Below this for the whole session ⇒ dead-mic alarm. If you get false alarms on a *very* quiet/gated headset, lower it; if a dead Citrix audio redirect ever passes silently, raise it. Verify against your real noise floor. |
| `PENDING_CHUNK_CAP` | 400 | ~35 s of audio buffered while the socket connects. |
| `HOTKEY_TAP_MS` | 400 | Hotkey presses shorter than this are taps (toggle); longer are holds (push-to-talk). |
| `PREROLL_MS` | 400 | Idle audio kept in memory and prepended at session start (first-word rescue). Raise to ~600 if onsets still clip; it only ever contains never-sent audio, so duplicates are impossible. |

`echoCancellation` is currently `true` in `getUserMedia`. For a close-talking headset with no speaker playback, turning it off is a legitimate accuracy experiment (less DSP mangling of plosives) — change it in `ensureAudio()`.

## Best practices

- **Trust the beeps, not the screen.** The workflow is designed to be eyes-free: start beep → speak → release → success beep → paste. Any failure produces a *different* sound. If you heard the success beep, the text is on the clipboard; if you didn't, do not paste.
- **Glance at the meter before a long dictation.** If the bar doesn't move when you speak, the watchdog will alarm at ~2.5 s anyway — but the glance costs nothing.
- **Treat red status as "verify before pasting."** Partial text is still copied after a mid-dictation failure (losing it would be worse), but it is flagged red + fail-beeped for a reason.
- **Curate keyterms like a formulary.** Prune terms when you rotate services; 50 well-chosen terms beat 50 stale ones, and they're 20 % of your bill.
- **Use the append window for multi-breath notes**, and **Clear dictation box** when switching patients/fields — the chip above the transcript always tells you which will happen next.
- **Keep the last-audio preview in mind when alpha testing.** Every dictation's gated audio is captured locally; when a transcription is wrong, download the audio — it answers "did it mishear, or did it not hear?"
- **Install as a PWA** on shared workstations: standalone window, persistent mic grant, no tab roulette.
- **History is the safety net.** Last 100 transcripts persist in `localStorage`; a botched clipboard is never a lost dictation.

## Failure handling

The biggest risk in dictation is speaking a long passage into a dead pipeline and finding out afterwards. This app attacks that from several angles:

- **While recording**: a watchdog checks the mic track (`ended`/`muted`) and the RMS level. A flatlined mic triggers the three-beep alarm and red status *within ~2.5 s of pressing PTT* — before the long paragraph, not after.
- **Connecting**: if the WebSocket can't open within 5 s, the dictation fails loudly (sentinel + low beep) instead of silently discarding audio. Audio spoken during connection setup is buffered and flushed once the socket opens, and the last ~400 ms *before* the keypress (the pre-roll) is prepended — people start the first word as the key lands, and that audio would otherwise be gone. The pre-roll lives only in memory while the mic is warm and is discarded unless a dictation starts immediately.
- **Mid-dictation disconnect**: an unexpected close is treated as a failure — whatever partial text arrived is still copied, but the status turns red and the failure beep plays so you verify before pasting.
- **Clipboard**: if the copy fails (tab lost focus too early), the failure beep plays instead of the success beep. If nothing was transcribed at all, the sentinel `##DICTATION_FAILED##` is copied so a blind paste is self-evident rather than silently stale.
- **Reopening the app**: the audio graph is revalidated on every start, on tab restore (`pageshow`/bfcache), on visibility change, and on device changes — a stale, silently-dead mic stream is torn down and re-acquired instead of being trusted.

## Append semantics

- **Append mode on (default)**: a dictation started within the **append window** (default 45 s, configurable, 0 = always) continues the current note; the combined text is what gets copied. After the window lapses, the next dictation starts a fresh note automatically.
- **Clear dictation box** button: clears the current note immediately (history untouched).
- **Append mode off**: every dictation is its own note.

The mental model: **the clipboard always equals the current note.** Appending recopies the whole note, so a paste at any point yields everything dictated so far; pasting replaces, so nothing is double-entered.

When a dictation continues a note, the tail of the existing text is also sent to Scribe as context (`previous_text` on the first audio chunk), so capitalization, punctuation, and terminology stay consistent across push-to-talk presses. Fresh notes send no context.

## Roadmap

### Landed — realtime hardening

> Implemented on branch `claude/dreamy-shannon-ojwbj0`; if your deployment lacks the status pills and the Advanced section, you are running pre-hardening `main`.

- [x] Anti-clipping: buffer-while-connecting, 600 ms post-release tail, commit-then-wait shutdown
- [x] Dead-mic watchdog with mid-dictation alarm (track health + RMS flatline)
- [x] Connect timeout, unexpected-disconnect handling, failure-aware clipboard semantics
- [x] Failure beeps always audible (background-tab safe, not gated by the beep checkbox)
- [x] Mic re-engagement on reopen (track revalidation on start / pageshow / visibility / devicechange)
- [x] Append window + countdown chip + Clear dictation box
- [x] Advanced section for developer-ish sliders; mic/link status pills
- [x] ~400 ms pre-roll (first-word rescue) prepended at session start
- [x] Ellipsis (pause-artifact) filter; transcript-first layout with the audio preview tucked away
- [x] Realtime-spec alignment: server-confirmed keyterm count in the status line (`session_started` echo), the full error-frame taxonomy handled loudly (`auth_error`, `quota_exceeded`, `rate_limited`, …), spec-required `commit`/`sample_rate` on every chunk, and `previous_text` continuation context when appending
- [x] PWA manifest + icons; `wrangler.toml`; jsdom flow-test harness (`tests/flow.test.mjs`)
- [x] Queued PTT restart while the previous dictation finalizes
- [x] Configurable in-app hotkey (default Ctrl + Space, tap-or-hold) for use without AHK

### Next

- [ ] **Hybrid accuracy mode** — keep realtime for live feedback, but re-transcribe the locally captured audio through **batch Scribe v2** on release and copy *that* (model is meaningfully stronger; the audio is already recorded; costs one extra API call and ~1–2 s). Likely the single biggest accuracy win available.
- [ ] **Mic self-test button** — 2-second record-and-meter check producing an explicit pass/fail, for non-developer users who won't read a meter.
- [ ] **Local failure log** — small ring buffer of session outcomes (start/stop times, bytes sent, transcripts received, failure reason) surfaced in the UI, for diagnosing "it failed earlier" reports.
- [ ] **Settings presets** — e.g. *Quiet office* / *Shared ward* bundles for the Scribe VAD trio, one click instead of three sliders.

### Later / ideas

- [ ] **Direct client-side streaming** — the realtime API accepts single-use tokens (`token` query param, minted via the tokens endpoint); the Worker could become a passphrase-gated token minter and the browser would connect straight to ElevenLabs, dropping the proxy hop from the audio path entirely.
- [ ] **Zero-retention mode** — `enable_logging=false` puts a session in zero-retention mode (enterprise plans only); worth wiring as an option if PHI policy ever requires it.
- [ ] **Warm socket** — keep one WebSocket open across dictations for instant start; needs answers on idle billing/session timeout before committing.
- [ ] **AudioWorklet migration** — `ScriptProcessorNode` is deprecated; works today, but the replacement should land before browsers force the issue.
- [ ] **Passphrase hardening** — shared-mode passphrase travels as a query parameter; move to a WebSocket subprotocol header or first-message auth to shrink the exposure surface (logs, proxies).
- [ ] **Editable transcript box** — let the user correct text in place before copy; cursor-aware appending.
- [ ] **True streaming into Cerner** — AHK polls clipboard deltas (or a local helper receives text over localhost) and types text as it commits. Big workflow win, big failure-mode surface; prototype only after the hybrid mode proves out.
- [ ] **Per-user keyterm lists in shared mode** (KV-backed) instead of per-browser localStorage.
- [ ] **Word timestamps** — already plumbed (`timestamps=word`); could drive partial-text highlighting or audio-sync review of suspect words.

## Thoughts & open questions

- **Realtime vs batch accuracy.** `scribe_v2_realtime` trades accuracy for latency versus batch `scribe_v2`; keyterms narrow but don't close the gap. That is why the hybrid mode is the top roadmap item: realtime text is *feedback* ("it's hearing me"), batch text is the *deliverable*. The UX already separates those moments — live text during, clipboard at the end.
- **Why per-dictation sockets.** Sessions are short and the connect cost is now masked by buffering, so per-dictation sockets keep the cost model legible and avoid idle-session billing questions. Revisit only if connect latency becomes the dominant complaint.
- **The local gate is vestigial here.** In the batch sibling it decides what gets transcribed; in this variant it only shapes the saved preview, since Scribe's server-side VAD does the rejection. It is kept for preview parity and because the meter/analyser infrastructure doubles as the health watchdog. Retiring the gate sliders entirely (keeping the meter) is on the table if users find them confusing even inside Advanced.
- **`commit: true` under `commit_strategy=vad`.** The shutdown path sends a final empty chunk with `commit: true` and then *waits*; even if a future API change ignored the manual commit, the wait-for-quiet + deadline still close the session gracefully and trailing partials are promoted into the final text. Re-verify against ElevenLabs docs as the realtime API evolves.
- **Clipboard focus is a hard boundary.** Browsers will not let an unfocused page write the clipboard. Every design here (beeps, sentinel, AHK pacing) routes around that instead of fighting it; a local helper app would be the only true escape hatch.
- **Cost notes.** Keyterms add ~20 %; realtime is billed on audio time — the 600 ms tail and connect buffering add a fraction of a second per dictation, which is the right trade against word loss.
- **Settings live in `localStorage` v9 keys.** Bumping the version string wipes every user's tuned thresholds and saved keys — treat key names as part of the public contract.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Mic won't engage after reopening | Should self-heal (track revalidation on `pageshow`/visibility). If the *mic off* pill persists, click the page once (autoplay policy) or re-grant mic permission. |
| Three-beep alarm right after starting | OS muted the mic, wrong input device, or Citrix audio redirection dropped. Check the meter moves when you speak. |
| Text stops mid-dictation, red status | Network/service drop. The partial transcript was still copied — verify before pasting. |
| Last words missing | Should be fixed by the tail + commit-wait flow. If it recurs, raise `TAIL_MS` and/or the Scribe pause limit. |
| First words missing | The pre-roll captures ~400 ms before the keypress, so anticipation is covered while the mic is warm. If it persists: lower the Scribe **noise filter** (e.g. 0.55 → 0.40) and **click filter** (150 → 100 ms) — server-side VAD can eat a soft onset. Note the *audio preview* always soft-clips onsets (the local gate opens late); that's cosmetic — Scribe hears the ungated feed. On the very first dictation after a cold open there is no pre-roll yet — speak on the start beep. |
| Success beep but paste shows `##DICTATION_FAILED##` | The previous dictation failed and left the sentinel; the beep belongs to a newer one. Use the history panel. |
| Nothing transcribes, *LINK FAIL* | Worker can't reach ElevenLabs or the key/passphrase is wrong — the status line shows the upstream error. |
| No beeps in the background | Beeps reuse the live audio context precisely for this; if the mic was never warmed, there is no running context — warm the mic first (open the app once). |
