# ElevenLabs Scribe v2 Dictation

A single-file Cloudflare Worker for push-to-talk medical dictation. You hold a key, speak, and release; the audio uploads to ElevenLabs Scribe v2 and the transcript lands on your clipboard. The whole app — the Worker and the client — lives in `worker.js` as one template literal, with no build step and no dependencies.

It is batch-only. An earlier realtime/hybrid streaming effort was removed; that investigation is archived in [`REALTIME_HANDOFF.md`](REALTIME_HANDOFF.md). The developer guide and invariants are in [`CLAUDE.md`](CLAUDE.md).

Status: alpha, in production use. Priorities, in order: (1) never lose a dictation, (2) settings that move between devices, (3) the phone experience.

## How it works

- **Push-to-talk.** The default hotkey is Ctrl+Space: tap to start and stop, or hold to talk and release to stop (holds longer than ~400 ms). F13/F14 also start and stop, for the AutoHotkey relay (`hotkey.ahk` maps CapsLock to F13/F14). On release, the recording uploads and the transcript is copied.
- **Live capture feedback.** While recording you see a moving waveform, a "Hearing you" indicator, and a timer. This runs on-device from the audio analyser — there is no streaming transcription and nothing leaves the machine. It only confirms the microphone is capturing.
- **The noise gate decides what is transcribed.** Audio runs microphone → high-pass → noise gate → recorder, and the post-gate recording is exactly what gets uploaded. Gate tuning therefore affects the transcript, not just a preview (see [Tuning](#tuning)).
- **One note per dictation by default.** Click the transcript box to append the next dictation onto the current note, or turn on append mode to chain dictations within a time window (default 45 s). The most recent transcript is restored on reload, and the clipboard always holds the current note.

### Audio cues

The workflow is meant to be used without watching the screen.

| Sound | Meaning |
|---|---|
| Single beep | Recording started |
| Rising double beep | Transcript copied to the clipboard |
| Long low beep | Failure — the sentinel `##DICTATION_FAILED##` was copied, or the clipboard write failed. Do not paste. |
| Three descending beeps | Dead-microphone alarm — recording but no signal (fires about 2.5 s in) |
| Two beeps | Warn — a degraded but usable outcome; verify before pasting |

Start and done beeps can be turned off in Options. Failure and warn alarms always play, and reuse the running audio context so they sound even when the tab is in the background. Status pills show microphone health (mic ready / REC / MIC FAIL), pipeline state (link idle / uploading… / LINK FAIL), and the gate state.

## Failure handling

The main risk is dictating into a dead pipeline and not realizing it. Every failure is made loud:

- A watchdog alarms within about 2.5 s if the microphone track dies or the signal flatlines.
- An upload failure copies the sentinel and shows a red status with the upstream error.
- A failed clipboard write (for example, the tab lost focus) fails loudly rather than leaving a stale clipboard. If nothing was transcribed, the sentinel is copied so a blind paste is obviously wrong.
- The last 100 transcripts are kept in history, so a botched copy is never a lost dictation.
- The audio graph is revalidated on start, on tab restore, on visibility change, and on device change, so a silently dead microphone stream is rebuilt rather than trusted.

## Keyterms

Keyterms bias the transcription toward your vocabulary — drug names, anatomy, eponyms, names. There are three tiers, merged and deduplicated per dictation (your terms win, then checked presets, then the standard list), up to 1000 terms of under 50 characters each:

- A standard list that rides every dictation.
- Optional preset lists you toggle as checkboxes (for example, wound care or ER).
- Your own custom terms.

The presets and standard list are edited in `keyterms.js` and reach every device on the next deploy. Keyterms add roughly 20% to the per-dictation cost, so keep the always-on list small.

## Phone link

Dictate on your phone and the text lands on the desktop's clipboard. This is for setups where the desktop browser cannot get a good microphone.

**Pairing.** On the desktop, click **Pair a phone** to show a QR code and a 6-character code. Scan it with the phone, or type the code. The overlay closes once the phone joins. The pairing persists on both sides across reloads and app restarts until you end the session (desktop) or leave it (phone).

**On the phone**, a joined device switches to a big-button layout: one large push-to-talk button with the same hold/tap behavior as the hotkey, the whole screen as a status indicator readable at arm's length, haptics that mirror the beeps, and the transcript collapsed to a strip. A per-device override (Options → Big-button layout) sets when this layout is used: when joined (the default), always, or never. While the phone is on this layout the screen is kept awake, because iOS reclaims the microphone when the screen locks — so the mic stays ready between dictations instead of going cold. If the phone does sleep or you switch apps, the mic re-engages on its own when you reopen or refocus the page.

**Reliability.** Every layer of the link fails loudly by default:

- The desktop heartbeats the session room and reconnects automatically; a drop shows a red badge.
- Final text is delivered with an acknowledgement (the room's listener count). A delivery that no one received is a loud failure on the phone, not an assumption.
- The room buffers the last delivery for two minutes and replays it to a reconnecting desktop; clients deduplicate by id, so a replay cannot double-paste.
- If the desktop is down longer than that, the phone keeps the delivery queued and retries it on reconnect and at the next launch.
- If the desktop tab is not focused when text arrives, the copy is held and retried on refocus.
- `hotkey.ahk` can poll `GET /latest` and write the clipboard with no browser focus required (set `PHONE_POLL_URL` and `PHONE_CODE` at the top of the script).

**Keeping other voices out.** Three layers, because no single one is enough. (1) Hold the mic **close** — the biggest lever; a close voice drowns out the room. (2) **iOS Voice Isolation** (Control Center → Mic Mode) strips background *noise* at the OS level — but another person's voice is speech, so it can survive both that and browser noise suppression. (3) So the app also **filters out other speakers automatically** (on by default, in Advanced): when a second voice is loud enough to be transcribed, it keeps only the main speaker and shows a status note about what it removed. The one-time **Mic tips** card (reopen it from the big-button bar or Options) walks through the first two. The session code is the link's only credential, and the QR is generated on the page rather than by an external service.

## Settings

Everything is stored in `localStorage`, scoped to one browser profile, on one device, on one origin. The desktop and phone do not share settings, and an installed iOS home-screen app does not share with Safari — set up each device you dictate from. The exception is keyterm presets, which ship in the code and so reach every device on deploy. Syncing settings across devices is a planned improvement.

## Deployment

Push to `main` and Cloudflare Workers Builds deploys the worker named `eleven`. (`npx wrangler deploy` also works.) The served HTML is `no-store`.

There are two ways to supply the ElevenLabs key:

- **Shared mode:** set `ELEVENLABS_API_KEY` and `APP_PASSPHRASE`. Users enter only the passphrase; the Worker checks it in constant time and injects the key server-side, so the key never reaches the browser.
- **Bring your own key:** leave the passphrase unset and each user enters their own ElevenLabs key, stored per browser.

Set secrets in the Cloudflare dashboard (Workers & Pages → eleven → Settings). To install as an app, open the URL in Chrome or Edge and choose Install; you get a standalone window that keeps microphone permission, and the layout stays usable shrunk to a sliver.

## Tuning

**The gate.** It creates a gap between your voice and the room and only lets your voice through. The meter shows the live level with two marks: red is the open threshold (speech must exceed it to start recording), and yellow is the close threshold (the gate holds open until the level drops below it, plus about a 0.9 s hold). A quick routine: record silence and note where the room sits, set red just above it, confirm the gate pill flips OPEN when you speak, set yellow low in the gap, then check the pill stays OPEN through a sentence with pauses.

| Symptom | Fix |
|---|---|
| Word beginnings cut off | Open threshold too high — lower red |
| Words drop mid-sentence | Close threshold too high — lower yellow |
| Background still transcribed | Open threshold too low — raise red |
| Gate flickers open and closed | Gap too narrow — raise red, lower yellow |
| Nothing records | Both above your voice — lower both |

A close, low-gain microphone does more than the sliders can. Browser noise suppression is on by default; there is an Options toggle to try it off on a close microphone.

A few constants sit at the top of the client script in `worker.js`: `BATCH_UPLOAD_TIMEOUT_MS` (15000), `FLATLINE_RMS` (0.0008, the dead-microphone threshold), and `HOTKEY_TAP_MS` (400, the tap-versus-hold cutoff). The phone-link timing constants are listed in `CLAUDE.md`.

## Roadmap

In priority order:

1. **Durability.** A dictation journal — persist the captured audio to IndexedDB during the dictation and recover after a crash — plus a local failure log. The phone-side delivery queue has landed.
2. **Settings portability.** Sync the portable settings (keyterms, append and beep preferences) across devices while keeping per-device tuning local, via export/import or passphrase-keyed server-side profiles.
3. **Phone UI.** The big-button layout has landed; remaining ideas are a larger live readout and swipe gestures.

Validation runs without a browser: `node tests/flow.test.mjs` (a jsdom harness) plus a `node --check` of the served script. See `CLAUDE.md` for the full developer guide.
