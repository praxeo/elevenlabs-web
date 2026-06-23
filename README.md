# ElevenLabs Scribe v2 Dictation — working notes

Personal notes on this app: what it is, what's worked, what hasn't, and what's next — so I can debug it and keep making it better. The full product guide and the hard invariants are in [`CLAUDE.md`](CLAUDE.md); the realtime dead-end is archived in [`REALTIME_HANDOFF.md`](REALTIME_HANDOFF.md).

One file, no build, no dependencies: `worker.js` is the Cloudflare Worker *and* the whole client (one template literal). Keyterm lists live in `keyterms.js`. I use it for push-to-talk dictation into Cerner/Citrix via AutoHotkey, with the transcript handed off on the clipboard. Status: alpha, in real use.

## What it does

Hold a key, speak, release. The audio uploads to ElevenLabs Scribe v2 (batch) and the transcript lands on the clipboard. Batch-only, single speaker, medical config.

- **Push-to-talk.** Ctrl+Space (tap = start/stop, hold = talk-and-release). F13/F14 also start/stop, for the AutoHotkey relay (CapsLock → F13/F14).
- **The noise gate decides what's transcribed.** mic → high-pass → gate → recorder, and the post-gate recording is exactly what's uploaded — so gate tuning changes the transcript, not just a preview.
- **Live capture feedback.** A waveform, a "Hearing you" light, and a timer while recording, all on-device from the analyser. Nothing streams; it just proves the mic is live. (This is the reassurance realtime used to give, for free.)
- **One note per dictation.** ➕ Append next adds the next dictation onto the current note (a one-shot); append mode keeps chaining until I turn it off or clear the box. Always explicit — no hidden timer.
- **Editable boxes.** The active box is hand-editable between dictations; History rows have Edit/Save/Cancel. Edits flow through to Copy, Append, and delivery.

### Audio cues — meant to be used without watching the screen

| Sound | Meaning |
|---|---|
| Single beep | Recording started |
| Rising double beep | Copied to the clipboard |
| Long low beep | Failure — sentinel `##DICTATION_FAILED##` copied, or the clipboard write failed. Don't paste. |
| Three descending beeps | Dead-mic alarm — recording but no signal (~2.5 s in) |
| Two beeps | Warn — a degraded but usable outcome; verify before pasting |

Start/done beeps are optional (Options). Failure and warn alarms always play, and reuse the running audio context so they sound even in a background tab.

## What's worked

- **Batch is the product.** Fast and accurate, dead simple, no streaming jitter. The three-engine era was a distraction (see below).
- **Loud failure, everywhere.** The prime directive — a silent failure is wrong text in a chart. Sentinel on the clipboard, alarms that always play, a dead-mic watchdog, and the last 100 transcripts kept in History so a botched copy is never a lost dictation.
- **The gate earns its keep.** It's the capture path *and* it drives the waveform feedback and the dead-mic watchdog — one analyser, three jobs.
- **Phone link durability.** The phone dictates and the text lands on the desktop clipboard. The delivery is queued on the phone (persisted, retried on reconnect and at boot), acked by listener count, replayed by the room, and deduped by id — so a dropped link, or a phone that dies after transcribing, recovers instead of losing the note.
- **Keeping the phone screen awake.** The real fix for "iOS keeps killing the mic between takes" was to *prevent* the interruption (hold the wake lock while the phone is on the big-button surface), not just recover after it.
- **Diarization keep-primary-speaker.** Drops a bystander voice the mic caught and reports how many words it removed. It can only ever remove a second voice, never empty a clean note. On by default.

## What hasn't worked (and the lessons)

- **Realtime/hybrid streaming — removed.** A lot of work, and our live feed stayed jittery while the same engine was smooth on the vendor's own demo. Root cause: we captured raw PCM and downsampled/sent it on the *main thread*, so under render load it shipped jittery audio; batch (and the demo) use off-thread `MediaRecorder`. Batch was always flawless, so I cut realtime entirely. Full post-mortem and a resurrection path are in [`REALTIME_HANDOFF.md`](REALTIME_HANDOFF.md) — I haven't given up on it.
- **The hidden append time window.** Append used to depend on how many seconds had passed since the last dictation — the same action gave different results, and a pause past the cliff silently wiped a note. Deleted; append is now purely explicit.
- **Noise suppression / Voice Isolation don't stop other *voices*.** They strip *noise*; another person's speech is speech and survives them. The levers that actually work: hold the mic close (the biggest one), iOS Voice Isolation for noise, and the diarization filter for a second speaker. The one-time Mic tips card walks through them.
- **iOS hands back dead microphones.** After backgrounding, iOS leaves a dead mic track reporting `readyState:"live"`, unmuted, with no `ended` event — so the app trusted a corpse and recorded silence (the worst real bug: looked like it was recording, captured nothing). Fix: any backgrounding marks the graph suspect and forces a fresh `getUserMedia`. A mid-dictation AudioContext interruption also freezes the analyser, so the watchdog alarms on a non-running context — and it's never auto-recovered: fail loud, redictate.
- **Clipboard writes need focus.** Both the modern API and the fallback fail when the tab is unfocused (behind Citrix/Cerner). I don't silently retry, with one sanctioned exception: a pending copy held with a red status and retried on refocus.

## Phone link

For setups where the desktop can't get a good mic. On the desktop, **Pair a phone** shows a QR + 6-char code (QR generated on-page, never an external service — the code is the only credential). The phone joins, switches to a **big-button layout** (one push-to-talk button, whole-screen status, haptics mirroring the beeps), and dictates in batch; the final text POSTs to the desktop, which writes the clipboard. Pairing survives reloads and app restarts on both sides until End session (desktop) / Leave (phone). The resilience machinery (heartbeat, reconnect, delivery queue, dedupe, focus-retry, and the AHK `/latest` poller for focus-free pasting) is detailed in `CLAUDE.md`.

## Keyterms

Bias the transcription toward my vocabulary — drugs, anatomy, eponyms, names. Three tiers, merged and deduped per dictation (my terms > checked presets > the always-on standard list), capped at 1000 terms under 50 chars. Edit the lists in `keyterms.js`; they reach every device on the next deploy. Keyterms add ~20% to cost, so the always-on list stays small.

## Settings & storage

Everything is in `localStorage`, scoped to one browser profile / device / origin — desktop, phone, and an installed iOS PWA don't share. Set up each device I dictate from. The split I'm building toward: portable settings (keyterms, append/beep prefs) sync across devices; per-device tuning (gate, hotkey, mic) stays local. Keyterm presets already reach every device because they ship in the code.

## Deploy

Push to `main` → Cloudflare Workers Builds deploys the worker `eleven` (`npx wrangler deploy` also works; the served HTML is `no-store`). Two ways to supply the key:

- **Shared mode:** set `ELEVENLABS_API_KEY` + `APP_PASSPHRASE`. Users enter only the passphrase; the Worker checks it in constant time and injects the key server-side — it never reaches the browser.
- **Bring your own key:** leave the passphrase unset; each user enters their own ElevenLabs key, stored per browser.

Set secrets in the Cloudflare dashboard (the local wrangler token can't write secrets). Install as an app from Chrome/Edge for a standalone window that keeps mic permission and stays usable shrunk to a sliver.

## Tuning the gate

The gate puts a gap between my voice and the room and only lets my voice through. The meter shows the live level with two marks: red = open threshold (speech must exceed it to start recording), yellow = close threshold (holds open until the level drops below it, plus ~0.9 s). Routine: record silence and note where the room sits, set red just above it, confirm the pill flips OPEN when I speak, set yellow low in the gap, then check it stays OPEN through a sentence with pauses.

| Symptom | Fix |
|---|---|
| Word beginnings cut off | Open too high — lower red |
| Words drop mid-sentence | Close too high — lower yellow |
| Background still transcribed | Open too low — raise red |
| Gate flickers open and closed | Gap too narrow — raise red, lower yellow |
| Nothing records | Both above your voice — lower both |

A close, low-gain mic does more than the sliders can. Constants at the top of the client script: `BATCH_UPLOAD_TIMEOUT_MS` (15000), `FLATLINE_RMS` (0.0008, the dead-mic threshold), `HOTKEY_TAP_MS` (400, tap-vs-hold); the phone-link timings are in `CLAUDE.md`.

## Roadmap

In priority order — #1 is the standing rule, never lose a dictation:

1. **Durability.** A dictation journal: persist the captured audio to IndexedDB during recording and recover after a crash, plus a local failure log. (The phone-side delivery queue is done; the in-flight *audio* gap is what's left.)
2. **Settings portability.** Sync the portable settings across devices while keeping per-device tuning local — export/import or passphrase-keyed server-side profiles.
3. **Phone UI.** The big-button layout is done; surfacing the capture waveform on the big screen is the open gap, then a larger live readout and swipe gestures.

## Validation

No browser needed: `node tests/flow.test.mjs` (a jsdom harness simulating full dictation sessions + the phone link) plus a `node --check` of the served script. Update the scenarios in the same change as any session-flow / beep / clipboard / watchdog change. The full developer guide is `CLAUDE.md`.
