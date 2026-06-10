# ElevenLabs Scribe v2 Dictation

A self-contained medical dictation web app built on a single Cloudflare Worker, with **three transcription engines behind one UI**:

| Engine | What you get | What lands on the clipboard |
|---|---|---|
| **Realtime** | Text streams onto the screen as you speak | The live text |
| **Batch** *(default)* | No live text; audio uploads on release (the original batch app's behavior — the noise gate decides what gets transcribed) | The batch transcription |
| **Hybrid** | Live text as feedback **plus** a batch re-transcription of the same audio | The **refined batch text** — meaningfully more accurate |

The hybrid design in one line: **realtime text is *feedback* ("it's hearing me"), batch text is the *deliverable*.** The exact audio the realtime engine heard — including the pre-roll from before you pressed the key — is wrapped in a WAV and re-transcribed by the stronger batch model, and that is what you paste.

Designed for clinicians dictating into **Cerner running inside Citrix**: push-to-talk via AutoHotkey (CapsLock → F13/F14), clipboard handoff, audio cues so you never have to look at the browser, and *loud* failure notification — the worst outcome this tool can produce is silently wrong or missing text in a chart, and everything in the design bends toward preventing that.

**Key features:**

- **Engine selector** — Realtime / Batch / Hybrid, switchable per dictation, persisted per browser. Mode-specific controls show and hide with it.
- **Push-to-talk dictation** with a configurable in-app hotkey — default **Ctrl + Space** (tap to start/stop, hold to talk) — plus the F13/F14 contract for existing AutoHotkey CapsLock setups, which keeps working unchanged.
- **Live transcript** streamed from ElevenLabs Scribe v2 Realtime over a secure WebSocket proxy (the API key never reaches the browser in shared mode).
- **Anti-clipping pipeline** (realtime/hybrid): a ~400 ms pre-roll, buffering while the socket connects, a post-release audio tail, and a commit-then-wait shutdown — so the first and last words survive. In hybrid, all of it is also captured for the batch refine.
- **Loud failure notification**: dead-mic alarm *while you're dictating*, connect-timeout alarm, failure and warn beeps that play even from a background tab, clipboard sentinel (`##DICTATION_FAILED##`), and mic/link status pills.
- **Recovery, not just alarm**: in hybrid mode, if the live link dies mid-dictation, the locally captured audio is still re-transcribed through batch — the dictation is recovered, flagged for verification instead of lost.
- **Click-to-append**: every dictation is its own note by default; click the transcript box to append the next dictation onto it (one-shot), or enable append mode to chain notes automatically within a time window — in **every** engine. The most recent transcript is restored into the box on load.
- **Custom keyword biasing** from one keyterm list (realtime uses up to 50 terms, batch up to 1000).
- **Compact, tiny-window-first UI**: engine selector, record button, status, and the latest transcript stay on top; credentials (auto-collapse once entered), options, keyterms, and advanced tuning live in collapsible sections.
- **Installable web app** (PWA manifest) for a standalone window in constrained environments — fully functional even shrunk to a sliver.

---

## Table of contents

1. [Architecture](#architecture)
2. [Deployment](#deployment)
3. [Choosing an engine](#choosing-an-engine)
4. [Daily workflow](#daily-workflow)
5. [Hotkeys & AutoHotkey](#hotkeys--autohotkey)
6. [Tuning guide — things to adjust](#tuning-guide--things-to-adjust)
7. [Best practices](#best-practices)
8. [Failure handling](#failure-handling)
9. [Append semantics](#append-semantics)
10. [Notes for pre-merge batch app users](#notes-for-pre-merge-batch-app-users)
11. [Roadmap](#roadmap)
12. [Thoughts & open questions](#thoughts--open-questions)
13. [Troubleshooting](#troubleshooting)

---

## Architecture

```
Browser (this page, installable PWA)
  mic → high-pass → ┬→ analyser (meter, gate UI, health watchdog)
                    ├→ ScriptProcessor → 16 kHz PCM ─┬→ base64 frames (realtime/hybrid) ─┐
                    │                                └→ session buffer → WAV (hybrid)     │
                    └→ noise gate → MediaRecorder (preview; THE recording in batch mode)  │
                                                                                          ▼
Cloudflare Worker   /api/transcribe — one path, two protocols
  ├─ WebSocket upgrade → WS proxy (key injection, keyterm scrub)
  │       └→ ElevenLabs wss …/v1/speech-to-text/realtime  (scribe_v2_realtime, VAD commits)
  └─ POST multipart    → batch proxy (key injection, keyterm scrub)
          └→ ElevenLabs https …/v1/speech-to-text          (scribe_v2)
```

Everything lives in **one file, `worker.js`** — the Worker fetch handler, both proxies, and the entire client app embedded as a template literal. No build step, no dependencies, no framework. That is a deliberate constraint: the whole system can be read top to bottom, deployed by pasting into the Cloudflare dashboard, and audited in one sitting.

Design notes:

- **The gate's role depends on the engine.** In realtime/hybrid the noise gate only shapes the locally saved audio preview — the feed to Scribe is *not* gated; extraneous-speech rejection is done server-side via the Scribe VAD parameters. In **batch** mode the gate is load-bearing: the post-gate recording is exactly what gets transcribed, like the original batch app.
- **The hybrid refine hears what realtime heard.** Every 16 kHz PCM frame produced for the stream (pre-roll, while-connecting, live, tail) is also kept in a session buffer, captured at the point of production — so the refine works even if the socket never opened. On release it becomes a WAV and goes through the batch proxy.
- **One session per dictation.** Pressing PTT again while the previous dictation is finalizing, uploading, or refining queues a new session automatically.
- In **shared mode** the Worker injects the master API key server-side; the browser only ever holds the passphrase.

## Deployment

```sh
npx wrangler deploy
```

Deploys as worker **`eleven`** — the pre-merge batch app's URL, so existing users keep their saved settings, keys, and history (`localStorage` is per-origin). Worker secrets persist across deploys. The old `elevenrealtime` worker can be retired once its users have moved over (their per-browser settings do not transfer across origins).

Two modes, controlled by Worker environment variables:

| Variable | Effect |
|---|---|
| *(none)* | Each user pastes their own ElevenLabs API key into the UI. |
| `ELEVENLABS_API_KEY` **and** `APP_PASSPHRASE` | **Shared mode**: users enter only the passphrase; the Worker injects the master key server-side. |

Set secrets with `npx wrangler secret put ELEVENLABS_API_KEY` (and `APP_PASSPHRASE`).

### Install as an app (optional)

Open the deployed URL in Chrome/Edge → browser menu → **Install app** (or the install icon in the address bar). The app opens in its own standalone window, keeps mic permission, and is easier to keep running between dictations than a tab.

The layout is built for tiny windows: shrink the app to a sliver and the record button, status line, and latest transcript stay visible while everything else collapses into expandable sections.

## Choosing an engine

- **Batch (default)** — the original app's behavior: cheapest, no live feedback, and the local noise gate (not server VAD) decides what gets transcribed. The strongest model owns the clipboard; also the right pick on very constrained networks (no WebSocket), or when your gate tuning is doing useful work that server VAD can't replicate.
- **Hybrid** — best text quality with live feedback. You watch live text for confidence, and the clipboard gets the stronger batch model's rendering of the same audio. Costs both API calls per dictation and adds ~1–2 s after release before the done-beep. The history keeps both renderings, so you can audit how much the refine actually fixes.
- **Realtime** — fastest done-beep, single API call. Pick it when turnaround matters more than the last few percent of accuracy, or while evaluating whether hybrid's gain is worth its cost for your voice/mic/room.

Switching engines mid-dictation affects the *next* dictation, never the one in flight.

## Daily workflow

1. Open the app (or standalone window). The mic warms automatically if permission was previously granted — the **mic ready** pill confirms it.
2. Start dictating: **tap Ctrl + Space** (tap again to stop) or **hold it** like a radio mic — or hold CapsLock via AHK, or click the record button. Start beep = go. In realtime/hybrid you can speak immediately; audio is buffered while the pipeline connects.
3. Speak. In realtime/hybrid, text appears live; the **REC** and **LIVE** pills confirm both mic and pipeline are healthy. In batch mode there is no live text — the gate pill flipping **OPEN** while you speak is your confirmation.
4. Release. Realtime: tail → commit → copy. Hybrid: tail → commit → **"Refining via batch…"** → the refined text replaces the live text and is copied. Batch: **"uploading…"** → transcribed text appears and is copied. **Rising double beep = text is on the clipboard.** Switch windows and paste.
5. To continue the same note, **click the transcript box** before the next dictation (the chip confirms "next dictation appends"; the combined text is recopied each time) — or turn on **append mode** in Options to chain dictations automatically within the append window. **Clear dictation box** starts a new note.

### Audio cues

| Sound | Meaning |
|---|---|
| Single mid beep | Recording started |
| Rising double beep | Success — transcript copied to clipboard |
| Long low beep | Failure — sentinel copied, or clipboard copy failed (do **not** paste) |
| Three descending low beeps | **Mic dead alarm** — recording but no audio signal (fires mid-dictation) |
| Two mid beeps | **Warn** — degraded success: hybrid refine failed and the *live* text was copied instead (usable, verify); also: audio flowing but no text coming back |

Start/done beeps can be disabled with the checkbox in **Options**; **failure and warn alarms always play**, and they reuse the live audio context so they sound even when the tab is in the background.

### Status pills

- **mic ready / REC / MIC FAIL / mic off** — actual `MediaStreamTrack` health, not just permission state.
- **link idle / connecting… / LIVE / uploading… / refining… / LINK FAIL** — transcription pipeline state across all engines.
- **gate open/closed** — local noise gate. Preview-only in realtime/hybrid; **decides what gets transcribed in batch mode** (the hint under the sliders updates per engine).
- **append chip** (above the transcript) — whether the next dictation appends or starts fresh; appears when you click the box (one-shot append, with a highlighted border) or when append mode is on (with a countdown).

## Hotkeys & AutoHotkey

Two ways to drive push-to-talk, both always active:

- **In-app hotkey** (no AHK needed): default **Ctrl + Space**. A quick **tap** starts a dictation and another tap stops it; **holding** the combo works like a radio mic — release to stop (presses longer than ~400 ms count as holds). Rebind it under **Options** by clicking the hotkey button and pressing any combo; unmodified keys (e.g. plain `Space`) are allowed but won't trigger while you're typing in a text field. Saved per-browser.
- **F13 (start) / F14 (stop)** — the AutoHotkey contract, identical in every engine. The full Windows relay script ships in this repo as **`hotkey.ahk`** (AHK v2): register the browser window with **Win + F12**, then hold CapsLock to dictate; it waits for the transcript or the failure sentinel on the clipboard and pastes-ready text is announced by the browser's beep. Its `CLIP_TIMEOUT` is sized for hybrid's worst case (~11 s) — keep it ≥ 20 if you adjust the client deadlines.

A minimal AHK v1 alternative:

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

| Setting | Default | Applies to | When to change |
|---|---|---|---|
| **Engine** | batch | — | See [Choosing an engine](#choosing-an-engine). |
| **Push-to-talk hotkey** | Ctrl + Space | all | Rebind to anything (click the field in Options, press a combo). Tap toggles; holds longer than ~400 ms behave as press-and-hold. F13/F14 stay active regardless. |
| **Keyterms** | — | all | Curate per specialty: drug names, anatomy, eponyms, colleague names. One list feeds both APIs: realtime takes the first 50 (≤ 20 chars each), batch up to 1000 (< 50 chars each). Adds ~20 % to cost. The single biggest accuracy lever available; in realtime the status line shows the server-confirmed "(N keyterms active)". |
| **Append mode** | off | all | Off: each dictation is its own note, and clicking the transcript box arms a one-shot append. On: dictations chain automatically within the append window. |
| **Append window** | 45 s | all | Only applies with append mode on. Shorten if stale text keeps riding along into new notes; lengthen (or 0 = always) if you dictate long notes with long thinking pauses. |
| **Remove ellipses** | on | all | Scribe writes dictation pauses as "…"/"..." — this strips them. Turn off only if you genuinely dictate ellipses. |
| **Scribe pause limit** (`vad_silence_threshold_secs`) | 2.0 s | realtime/hybrid | Raise if segments finalize mid-sentence and grammar suffers; lower for snappier commits on short utterances. |
| **Scribe noise filter** (`vad_threshold`) | 0.55 | realtime/hybrid | Raise in shared/noisy rooms to reject background speech; lower if soft speech is being missed. |
| **Scribe click filter** (`min_speech_duration_ms`) | 150 ms | realtime/hybrid | Raise if keyboard clicks / rustles produce stray words; lower if clipped single-word utterances get dropped. |
| **Gate open/close, high-pass** | 0.030 / 0.008 / 85 Hz | all (load-bearing in batch) | In realtime/hybrid these shape only the saved preview. **In batch mode they decide what gets transcribed** — see the gate tutorial below. |
| **Tag audio events** | off | batch/hybrid | Batch Scribe can annotate (laughter), (cough), etc. in the text. |
| **Timestamps** | none | batch/hybrid (word also plumbed for realtime) | Word/character granularity rides the batch API call; currently unused by the UI. |
| **Browser noise suppression** | off | all | Browser DSP can distort specialized terms. Try on only if the room is hopeless and raising the Scribe noise filter wasn't enough. |

### Tuning the gate (matters most in batch mode)

Think of the gate as a **bouncer for your mic**: create a gap between how loud YOUR voice is and how loud the room is, then only let your voice through. The meter shows live loudness with two marks — **red = open threshold** (speech must exceed it to start the recording) and **yellow = close threshold** (the gate holds open until the level falls below it, plus a ~0.9 s hold).

Two-minute routine: record while silent and watch how far the room pushes the meter → set red just above that → speak normally and confirm the gate pill flips OPEN → set yellow low, in the gap → dictate a long, pausey sentence and confirm the pill stays OPEN throughout.

| Symptom (batch mode) | Fix |
|---|---|
| Word beginnings cut off | Open too high → lower red |
| Words drop mid-sentence | Close too high → lower yellow |
| Background still transcribed | Open too low → raise red |
| Gate flickers open/closed | Gap too narrow → raise red, lower yellow |
| Nothing records at all | Both above your voice → drag both toward 0 |

The #1 way to widen the voice-vs-room gap is the mic itself (close, low gain, point the back of a cardioid at the noise); the sliders clean up what's left. In realtime/hybrid, use the **Scribe filters** for room rejection instead — the gate only affects the saved preview there.

### In the code (`worker.js`, top of the client script)

| Constant | Default | Meaning / safe range |
|---|---|---|
| `CONNECT_TIMEOUT_MS` | 5000 | WebSocket must open within this or the dictation fails loudly. 3000–8000. |
| `TAIL_MS` | 600 | Audio keeps streaming this long after PTT release. Raise to ~900 if last words still clip. |
| `FINAL_WAIT_MS` | 2500 | Max wait for the final committed transcript after commit. |
| `COMMIT_QUIET_MS` | 350 | Close this soon after the last committed transcript arrives. |
| `FLATLINE_RMS` | 0.0008 | Below this for the whole session ⇒ dead-mic alarm. Verify against your real noise floor. |
| `PENDING_CHUNK_CAP` | 400 | ~35 s of audio buffered while the socket connects. |
| `HOTKEY_TAP_MS` | 400 | Hotkey presses shorter than this are taps (toggle); longer are holds (push-to-talk). |
| `PREROLL_MS` | 400 | Idle audio kept in memory and prepended at session start (first-word rescue). Raise to ~600 if onsets still clip. |
| `BATCH_UPLOAD_TIMEOUT_MS` | 30000 | Pure batch mode's upload + transcription deadline. |
| `REFINE_TIMEOUT_MS` | 8000 | Hybrid refine deadline; past it the live text is delivered with the warn beep. |
| `SESSION_PCM_CAP_BYTES` | 24 MiB | Hybrid capture cap (~12.5 min of audio); past it the complete live text beats a truncated refine. |
| `MIN_REFINE_BYTES` | 16000 | ~0.5 s of audio; shorter sessions skip the refine. |

`echoCancellation` is currently `true` in `getUserMedia`. For a close-talking headset with no speaker playback, turning it off is a legitimate accuracy experiment — change it in `ensureAudio()`.

## Best practices

- **Trust the beeps, not the screen.** The workflow is designed to be eyes-free: start beep → speak → release → success beep → paste. Any failure produces a *different* sound. The two-tone warn means "the text is usable but came from the live engine — verify."
- **Glance at the meter before a long dictation.** If the bar doesn't move when you speak, the watchdog will alarm at ~2.5 s anyway — but the glance costs nothing.
- **Treat red status as "verify before pasting."** Text is still delivered after a mid-dictation failure when it exists (losing it would be worse), but it is flagged red + fail-beeped for a reason.
- **Use hybrid's history to audit the refine.** Hybrid entries store both renderings (`liveText` alongside the refined text) — compare them to see what the batch model is actually buying you.
- **Curate keyterms like a formulary.** Prune terms when you rotate services; they're 20 % of your bill.
- **Click the box to continue a note** (or turn on append mode + window for hands-free chaining), and **Clear dictation box** when switching patients/fields — the chip above the transcript always tells you which will happen next.
- **Download the audio when a transcription is wrong** — it answers "did it mishear, or did it not hear?" (Note: the preview is the post-gate recording; in hybrid the refine heard the ungated feed.)
- **Install as a PWA** on shared workstations: standalone window, persistent mic grant, no tab roulette.
- **History is the safety net.** Last 100 transcripts persist in `localStorage`; a botched clipboard is never a lost dictation.

## Failure handling

The biggest risk in dictation is speaking a long passage into a dead pipeline and finding out afterwards. This app attacks that from several angles:

- **While recording**: a watchdog checks the mic track (`ended`/`muted`) and the RMS level. A flatlined mic triggers the three-beep alarm and red status *within ~2.5 s of pressing PTT* — in every engine.
- **Connecting** (realtime/hybrid): if the WebSocket can't open within 5 s, the dictation fails loudly (sentinel + low beep) instead of silently discarding audio — except in hybrid, where the captured audio still goes through the batch refine and the dictation is *recovered*. Audio spoken during connection setup is buffered and flushed once the socket opens, and the last ~400 ms *before* the keypress (the pre-roll) is prepended.
- **Mid-dictation disconnect**: an unexpected close is treated as a failure. Realtime: the partial text is copied, red status, fail beep. **Hybrid: the captured audio is re-transcribed through batch and the complete refined text is delivered** — still red + fail beep, because audio after the link died was not captured and the ending needs verification.
- **Hybrid refine failure**: the live text is complete and valid, so it is copied — with the two-tone warn beep and an amber status naming the error, never the success beep. If both engines fail, the sentinel goes out.
- **Batch upload failure**: sentinel + red status with the upstream error. The recording stays in the audio preview for manual recovery.
- **Clipboard**: if the copy fails (tab lost focus too early), the failure beep plays instead of the success beep. If nothing was transcribed at all, the sentinel `##DICTATION_FAILED##` is copied so a blind paste is self-evident rather than silently stale.
- **Reopening the app**: the audio graph is revalidated on every start, on tab restore (`pageshow`/bfcache), on visibility change, and on device changes — a stale, silently-dead mic stream is torn down and re-acquired instead of being trusted.

### Hybrid outcome matrix

| Live link | Batch refine | Clipboard gets | Sound |
|---|---|---|---|
| ok | ok | refined text | success |
| ok | fails / times out | live text | two-tone warn |
| died mid-dictation | ok | refined text (recovered) | fail beep — verify the ending |
| died mid-dictation | fails | live partial (if any) else sentinel | fail beep |
| ok | ok but empty | sentinel ("no speech") | fail beep |

## Append semantics

- **Click the transcript box** (any engine): the next dictation appends onto the text shown — a one-shot arm that works regardless of the checkbox and the window. The chip and the highlighted box border confirm it; a second click cancels. Clicking while selecting text does nothing (so manual copying still works), and clicks are ignored mid-session.
- **Append mode on**: a dictation started within the **append window** (default 45 s, configurable, 0 = always) continues the current note; the combined text is what gets copied. After the window lapses, the next dictation starts a fresh note automatically. Works identically in all three engines — batch and hybrid splice their transcription onto the note base.
- **Append mode off (the default)**: every dictation is its own note unless you click the box first.
- **Clear dictation box** button: clears the current note immediately (history untouched).
- **On load** the most recent saved transcript is restored into the box — a reload never hides the note you just dictated, and the append window keeps counting from the note's original finish time.

The mental model: **the clipboard always equals the current note.** Appending recopies the whole note, so a paste at any point yields everything dictated so far; pasting replaces, so nothing is double-entered.

When a dictation continues a note, the tail of the existing text is also sent to Scribe Realtime as context (`previous_text` on the first audio chunk), so capitalization and punctuation stay consistent across presses in the live rendering. The batch API has no equivalent parameter, so refined/batch text can drift slightly in cross-press continuity.

## Notes for pre-merge batch app users

This app deploys over the original batch app's URL, and your saved settings, API key/access code, gate tuning, and history carry over (the old `scribe_v2_access_code_v9` key is read automatically). Behavior deltas to know about:

- **The default engine is batch — the old behavior.** Pick **Realtime** or **Hybrid** in the engine selector to try the new modes; the choice is persisted per browser.
- **Gate hold time is now 0.9 s** (was 0.4 s in code, though the old README documented 900 ms). Word endings survive longer pauses; lower `HOLD_SECONDS` in the code if you preferred the snappier close.
- **Failure beeps now always play** — they were accidentally tied to the start/done-beep checkbox before. Silence on failure was never intended.
- **The record button no longer locks during upload** — pressing PTT during an upload queues the next dictation instead.
- **You gain**: the append window, the configurable in-app hotkey, mic/link status pills, the dead-mic alarm, pre-roll + anti-clipping (in realtime/hybrid), PWA install, and the test harness.
- **Pre-roll does not apply to batch mode** (the gate-in-path recording can't splice in pre-gate audio) — keep the AHK `SPINUP` habit of speaking on the beep.

## Roadmap

### Landed

- [x] Realtime hardening: anti-clipping (buffer-while-connecting, post-release tail, commit-then-wait), dead-mic watchdog, connect timeout, failure-aware clipboard semantics, always-audible failure beeps, mic re-engagement, append window + chip, Advanced section, pre-roll, ellipsis filter, transcript-first layout, realtime-spec alignment (error-frame taxonomy, `previous_text`, server-confirmed keyterms), PWA, queued PTT, configurable hotkey, jsdom flow harness
- [x] **Three-engine merge**: dual-protocol Worker (WS + POST on `/api/transcribe`), engine selector with per-mode UI, batch engine (post-gate recording, upload-on-release), **hybrid accuracy mode** — realtime feedback + batch re-transcription of the exact streamed audio (incl. pre-roll) as the clipboard deliverable, with WS-death recovery via the refine, degraded-success warn semantics, and per-engine history (`liveText` kept for comparison)
- [x] **Compact-UI pass**: batch default engine, append-off default with **click-to-append** (one-shot arm by clicking the transcript box), latest transcript restored on load, collapsible Access/Options/Keyterms sections (Access auto-collapses once credentials are set), tiny-window layout for minimized/PWA use

### Next

- [ ] **Ride-through WS death in hybrid** — keep capturing after the live link dies and only finalize on release, so the recovered refine covers the *entire* dictation (today capture stops when the session finalizes on close).
- [ ] **Mic self-test button** — 2-second record-and-meter check producing an explicit pass/fail, for non-developer users who won't read a meter.
- [ ] **Local failure log** — small ring buffer of session outcomes (start/stop times, bytes sent, transcripts received, failure reason) surfaced in the UI, for diagnosing "it failed earlier" reports.
- [ ] **Settings presets** — e.g. *Quiet office* / *Shared ward* bundles for the Scribe VAD trio, one click instead of three sliders.

### Later / ideas

- [ ] **Direct client-side streaming** — the realtime API accepts single-use tokens (`token` query param, minted via the tokens endpoint); the Worker could become a passphrase-gated token minter and the browser would connect straight to ElevenLabs, dropping the proxy hop from the audio path entirely.
- [ ] **Zero-retention mode** — `enable_logging=false` puts a session in zero-retention mode (enterprise plans only); worth wiring as an option if PHI policy ever requires it.
- [ ] **Warm socket** — keep one WebSocket open across dictations for instant start; needs answers on idle billing/session timeout before committing.
- [ ] **AudioWorklet migration** — `ScriptProcessorNode` is deprecated; works today, but the replacement should land before browsers force the issue.
- [ ] **Passphrase hardening** — shared-mode passphrase travels as a query parameter on the WS path; move to a WebSocket subprotocol header or first-message auth to shrink the exposure surface (logs, proxies).
- [ ] **Editable transcript box** — let the user correct text in place before copy; cursor-aware appending.
- [ ] **True streaming into Cerner** — AHK polls clipboard deltas (or a local helper receives text over localhost) and types text as it commits. Big workflow win, big failure-mode surface; prototype now that the hybrid mode has proven out.
- [ ] **Per-user keyterm lists in shared mode** (KV-backed) instead of per-browser localStorage.
- [ ] **Word timestamps** — already plumbed; could drive partial-text highlighting or audio-sync review of suspect words.

## Thoughts & open questions

- **Realtime vs batch accuracy.** `scribe_v2_realtime` trades accuracy for latency versus batch `scribe_v2`; keyterms narrow but don't close the gap. Hybrid exists precisely because the UX already separates the two moments — live text during, clipboard at the end — so the slower, stronger model can own the deliverable.
- **Hybrid audio fidelity.** The refine gets the 16 kHz averaged-downsample feed (exactly what realtime heard), not the mic's native 48 kHz — the ungated 48 kHz signal is never recorded. Parity-with-realtime is the design goal; if refine accuracy ever disappoints, a parallel ungated 48 kHz capture is the experiment to run.
- **Why per-dictation sockets.** Sessions are short and the connect cost is masked by buffering, so per-dictation sockets keep the cost model legible and avoid idle-session billing questions.
- **The gate earns its keep again.** In the realtime-only sibling the gate was vestigial; in the merged app it is load-bearing for batch mode, and the meter/analyser doubles as the health watchdog everywhere.
- **`commit: true` under `commit_strategy=vad`.** The shutdown path sends a final empty chunk with `commit: true` and then *waits*; even if a future API change ignored the manual commit, the wait-for-quiet + deadline still close the session gracefully. Re-verify against ElevenLabs docs as the realtime API evolves.
- **Clipboard focus is a hard boundary.** Browsers will not let an unfocused page write the clipboard. Every design here (beeps, sentinel, AHK pacing) routes around that instead of fighting it; a local helper app would be the only true escape hatch.
- **Cost notes.** Keyterms add ~20 %. Realtime is billed on audio time (the tail and connect buffering add a fraction of a second per dictation). Hybrid adds one batch call per dictation on top — the price of the accuracy win; pick Realtime or Batch when that trade isn't worth it.
- **Settings live in `localStorage` v9 keys.** Bumping the version string wipes every user's tuned thresholds and saved keys — treat key names (including the legacy `scribe_v2_access_code_v9` fallback) as part of the public contract.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Mic won't engage after reopening | Should self-heal (track revalidation on `pageshow`/visibility). If the *mic off* pill persists, click the page once (autoplay policy) or re-grant mic permission. |
| Three-beep alarm right after starting | OS muted the mic, wrong input device, or Citrix audio redirection dropped. Check the meter moves when you speak. |
| Text stops mid-dictation, red status | Network/service drop. In hybrid the refine usually recovers the full text (verify the ending); in realtime the partial was copied — verify before pasting. |
| Two-tone warn beep, amber status | Hybrid's batch refine failed — the *live* text was copied and is usable; the status names the upstream error. If it recurs, check quota/key and consider Realtime mode until resolved. |
| "uploading…"/"refining…" hangs then fails | Batch API unreachable or slow; deadlines are 30 s (batch) / 8 s (refine). The audio preview still holds the recording. |
| Last words missing | Should be fixed by the tail + commit-wait flow. If it recurs, raise `TAIL_MS` and/or the Scribe pause limit. |
| First words missing (realtime/hybrid) | The pre-roll captures ~400 ms before the keypress while the mic is warm. If it persists: lower the Scribe **noise filter** (0.55 → 0.40) and **click filter** (150 → 100 ms). On the very first dictation after a cold open there is no pre-roll yet — speak on the start beep. |
| First words missing (batch) | The gate opens late — lower the **open threshold** (red), and speak on the beep; there is no pre-roll in batch mode. |
| Nothing transcribes in batch mode | The gate never opened (recording too short/empty → sentinel). Watch the gate pill while speaking; retune the thresholds. |
| Success beep but paste shows `##DICTATION_FAILED##` | The previous dictation failed and left the sentinel; the beep belongs to a newer one. Use the history panel. |
| Nothing transcribes, *LINK FAIL* | Worker can't reach ElevenLabs or the key/passphrase is wrong — the status line shows the upstream error. |
| No beeps in the background | Beeps reuse the live audio context precisely for this; if the mic was never warmed, there is no running context — warm the mic first (open the app once). |
