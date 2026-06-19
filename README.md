# ElevenLabs Scribe v2 Dictation

A self-contained medical dictation web app built on a single Cloudflare Worker, with **three transcription engines behind one UI**:

| Engine | What you get | What lands on the clipboard |
|---|---|---|
| **Realtime** | Text streams onto the screen as you speak | The live text |
| **Batch** *(default)* | No live text; audio uploads on release (the original batch app's behavior — the noise gate decides what gets transcribed) | The batch transcription |
| **Hybrid** | Live text as feedback **plus** a batch re-transcription of the same audio | The **refined batch text** — meaningfully more accurate |

The hybrid design in one line: **realtime text is *feedback* ("it's hearing me"), batch text is the *deliverable*.** The exact audio the realtime engine heard — including the pre-roll from before you pressed the key — is wrapped in a WAV and re-transcribed by the stronger batch model, and that is what you paste.

Designed for clinicians dictating into **Cerner running inside Citrix**: push-to-talk via AutoHotkey (CapsLock → F13/F14), clipboard handoff, audio cues so you never have to look at the browser, and *loud* failure notification — the worst outcome this tool can produce is silently wrong or missing text in a chart, and everything in the design bends toward preventing that.

**Status: alpha, in real production use** (first external alpha passed). The priority order for all work, when trade-offs collide: **(1) reliability — never lose a dictation, (2) settings portability between devices, (3) a mobile-first dictation UI.** See the [Roadmap](#roadmap).

**Key features:**

- **Engine selector** — Realtime / Batch / Hybrid, switchable per dictation, persisted per browser. Mode-specific controls show and hide with it.
- **Push-to-talk dictation** with a configurable in-app hotkey — default **Ctrl + Space** (tap to start/stop, hold to talk) — plus the F13/F14 contract for existing AutoHotkey CapsLock setups, which keeps working unchanged.
- **Live transcript** streamed from **Soniox `stt-rt-v5`** (the default realtime engine — fastest, word-by-word live feedback) over a WebSocket proxy on Cloudflare's edge. The realtime engine is switchable via a `?rt=` URL param: `el` = **ElevenLabs Scribe v2 Realtime**, `binding` = Deepgram Nova-3 on Workers AI. Batch and the hybrid refine always use **ElevenLabs Scribe v2** — the accurate deliverable. **Hybrid is the production mode**: Soniox feedback while you speak, ElevenLabs batch text on the clipboard. (The live feed is inherently below batch accuracy — streaming has no look-ahead — which is exactly why hybrid exists.)
- **Anti-clipping pipeline** (realtime/hybrid): a ~400 ms pre-roll, buffering while the socket connects, a post-release audio tail, and a commit-then-wait shutdown — so the first and last words survive. In hybrid, all of it is also captured for the batch refine.
- **Loud failure notification**: dead-mic alarm *while you're dictating*, connect-timeout alarm, failure and warn beeps that play even from a background tab, clipboard sentinel (`##DICTATION_FAILED##`), and mic/link status pills.
- **Recovery, not just alarm**: in hybrid mode, if the live link dies mid-dictation, the locally captured audio is still re-transcribed through batch — the dictation is recovered, flagged for verification instead of lost.
- **Click-to-append**: every dictation is its own note by default; click the transcript box to append the next dictation onto it (one-shot), or enable append mode to chain notes automatically within a time window — in **every** engine. The most recent transcript is restored into the box on load.
- **Keyword biasing in three tiers**: a deployer-curated standard list that rides every dictation, optional per-clinic preset lists as one-click checkboxes (*Wound care clinic*, *ER shift* — hover to see the terms), and your own custom terms — merged and deduped per dictation (the default Soniox realtime path and batch take the full list; only the ElevenLabs realtime path is capped at 50 terms; your terms win, then presets, then the standard list). Presets are edited in `keyterms.js` and reach every user on deploy.
- **Phone link** — dictate on your phone, the text lands on the desktop's clipboard: QR-scan pairing (one scan = paired until you leave), live text mirrored to the desktop while you speak, acknowledged delivery with server-side buffering and replay, automatic heartbeat/reconnect with a visible warning when the link is down, and an optional AutoHotkey poller for focus-free clipboard writes on thin clients. See [Phone link](#phone-link--dictate-on-your-phone-paste-on-your-desktop).
- **Big-button layout on joined devices** — a joined phone stops being a shrunken settings page and becomes a dictation *device*: one thumb-sized push-to-talk button (hold to talk, tap to toggle — the hotkey semantics), the whole screen as the status indicator readable at arm's length (including whether the desktop actually received the text), haptic feedback mirroring the beeps, and the transcript collapsed to a peek strip. Per-device override in Options (when joined / always / never).
- **iOS hardening** — screen wake lock per dictation, automatic mic re-engagement after app switches and PWA kills (with retries for iOS's late audio-session handback), and pairing + permissions that persist across relaunches.
- **Compact, tiny-window-first UI**: engine selector, record button, status, and the latest transcript stay on top; credentials (auto-collapse once entered), options, keyterms, and advanced tuning live in collapsible sections.
- **Installable web app** (PWA manifest) for a standalone window in constrained environments — fully functional even shrunk to a sliver.

---

## Table of contents

1. [Architecture](#architecture)
2. [Deployment](#deployment)
3. [Choosing an engine](#choosing-an-engine)
4. [Daily workflow](#daily-workflow)
5. [Hotkeys & AutoHotkey](#hotkeys--autohotkey)
6. [Phone link — dictate on your phone, paste on your desktop](#phone-link--dictate-on-your-phone-paste-on-your-desktop)
7. [Tuning guide — things to adjust](#tuning-guide--things-to-adjust)
8. [Where settings live (and don't)](#where-settings-live-and-dont)
9. [Best practices](#best-practices)
10. [Failure handling](#failure-handling)
11. [Append semantics](#append-semantics)
12. [Notes for pre-merge batch app users](#notes-for-pre-merge-batch-app-users)
13. [Roadmap](#roadmap)
14. [Thoughts & open questions](#thoughts--open-questions)
15. [Troubleshooting](#troubleshooting)

---

## Architecture

```
Browser (this page, installable PWA)
  mic → high-pass → ┬→ analyser (meter, gate UI, health watchdog)
                    ├→ AudioWorklet pump → 16 kHz PCM ─┬→ base64 frames (realtime/hybrid)  ─┐
                    │                                  └→ session buffer → WAV (hybrid)     │
                    └→ noise gate → MediaRecorder (preview; THE recording in batch mode)    │
                                                                                            ▼
Cloudflare Worker   /api/transcribe — one path, two protocols
  ├─ WebSocket upgrade → WS proxy (Soniox key in config frame, token translation)
  │       └→ Soniox wss stt-rt.soniox.com/transcribe-websocket  (stt-rt-v5)
  └─ POST multipart    → batch proxy (ElevenLabs key injection, keyterm scrub)
          └→ ElevenLabs https …/v1/speech-to-text             (scribe_v2)

Cloudflare Worker   /api/session/<code> — phone link (one Durable Object room per session)
  ├─ WebSocket → desktop listener (live transcript mirror, deliveries, heartbeat pong)
  ├─ POST /deliver → authoritative final text from the phone (ack = listener count;
  │                  last delivery buffered 2 min and replayed to reconnecting listeners)
  └─ GET /latest → held delivery for native pollers (hotkey.ahk's focus-free clipboard)
```

Everything lives in **one file, `worker.js`** — the Worker fetch handler, both proxies, and the entire client app embedded as a template literal. No build step, no dependencies, no framework. That is a deliberate constraint: the whole system can be read top to bottom, deployed by pasting into the Cloudflare dashboard, and audited in one sitting.

Design notes:

- **The gate's role depends on the engine.** In realtime/hybrid the noise gate only shapes the locally saved audio preview — the feed to Scribe is *not* gated; extraneous-speech rejection is done server-side via the Scribe VAD parameters. In **batch** mode the gate is load-bearing: the post-gate recording is exactly what gets transcribed, like the original batch app.
- **The hybrid refine hears what realtime heard.** Every 16 kHz PCM frame produced for the stream (pre-roll, while-connecting, live, tail) is also kept in a session buffer, captured at the point of production — so the refine works even if the socket never opened. On release it becomes a WAV and goes through the batch proxy.
- **One session per dictation.** Pressing PTT again while the previous dictation is finalizing, uploading, or refining queues a new session automatically.
- **The phone link is acked end-to-end.** The phone's realtime audio rides its normal `/api/transcribe` socket with a `session=<code>` tag; the Worker mirrors transcript frames into the session's Durable Object room for the desktop to display. The *authoritative* text travels separately (`POST /deliver`) and is acknowledged with the room's listener count — so a delivery into an empty room is a loud failure on the phone, never an assumption. The room buffers the last delivery for reconnecting listeners; clients dedupe by delivery id.
- In **shared mode** the Worker injects the master API key server-side; the browser only ever holds the passphrase.

## Deployment

```sh
npx wrangler deploy
```

Deploys as worker **`eleven`** — the pre-merge batch app's URL, so existing users keep their saved settings, keys, and history (`localStorage` is per-origin). Worker secrets persist across deploys. The old `elevenrealtime` worker can be retired once its users have moved over (their per-browser settings do not transfer across origins).

Two modes, controlled by Worker environment variables:

Providers: **Soniox** (`stt-rt-v5`) powers the default realtime live feed; **ElevenLabs** (`scribe_v2`) powers batch and the hybrid refine deliverable. Optional realtime alternatives: ElevenLabs Scribe v2 Realtime (`?rt=el`) and Deepgram Nova-3 on Workers AI (`?rt=binding`).

| Variable | Effect |
|---|---|
| `SONIOX_API_KEY` | The default realtime live feed (Soniox). |
| `ELEVENLABS_API_KEY` | Batch + hybrid refine (the clipboard deliverable) and `?rt=el`. |
| `APP_PASSPHRASE` | **Shared mode**: users enter only the passphrase; the Worker injects the keys and gates all realtime/batch behind the passphrase. |
| *(optional)* | `CF_ACCOUNT_ID` + `CF_AIG_GATEWAY` + `CF_AIG_TOKEN` (the `?rt=gw\|dgw` AI Gateway paths), `DEEPGRAM_API_KEY` (`?rt=dgw` → nova-3-medical). The `?rt=binding` Deepgram path needs the `[ai]` binding (`binding = "AI"` in `wrangler.toml`). |

**Deploy = push to `main`** (Cloudflare Workers Builds auto-deploys). The local wrangler OAuth token is scope-limited (can't write secrets) — **set secrets in the Cloudflare dashboard** (Workers & Pages → eleven → Settings → Variables and Secrets).

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
- **phone session code badge** (Options → Phone mic, desktop side) — clean code = link verified alive by heartbeat; **red ⚠ = dropped, reconnecting** (deliveries are buffered and replayed meanwhile). The same beep vocabulary applies to phone deliveries: success = copied, long low = copy failed/held for refocus, two-tone warn = degraded fallback or link drop.

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

Keep the dictation tab/window focused until the success beep if you rely on auto-copy — browsers refuse clipboard writes from unfocused pages. (This is a browser security boundary, not a bug to fix; the beep-then-switch habit is the workaround — and the [phone link](#phone-link--dictate-on-your-phone-paste-on-your-desktop) has its own escape hatches: a focus-retry that lands the copy the moment you click back, and an optional AHK poller with no focus requirement at all.)

## Phone link — dictate on your phone, paste on your desktop

For thin clients and locked-down desktops where the browser can't own a decent microphone: the phone does the dictating, the desktop gets the text on its clipboard.

**Pairing (once):**

1. On the desktop, open **Options → Phone mic** → **Start phone session**. A 6-character code and a QR code appear.
2. On the phone, **scan the QR** with the camera (or open the app, type the code, **Join**). That's it — the pairing persists on *both* sides across page reloads, app switches, and iOS killing the PWA, until you press **End session** (desktop) or **Leave** (phone).

**Dictating:** use the phone exactly as usual — any engine (hybrid recommended). Live text mirrors onto the desktop as you speak; when you release, the final text is delivered to the desktop, copied to its clipboard, and announced with the same success/failure beeps as a local dictation.

### The joined phone becomes a big button

The moment a device **joins** a session (typed code or QR scan), it switches to a dedicated dictation layout — and because the pairing persists, a killed-and-relaunched PWA boots straight back into it:

- **One big push-to-talk button** in the center (~⅔ of the screen wide): **hold to talk** (release stops), **quick tap to toggle** start/stop — the same semantics as the desktop hotkey, driving the exact same session machinery underneath.
- **The whole screen is the status indicator**, readable at arm's length: dark = ready, amber = connecting/working (or a degraded outcome — the headline says ⚠ CHECK, read the status line), deep red + pulsing button = recording, green flash = delivered, **solid red = failed (stays red until your next action)**. A dictation that produced no speech reads FAILED, not done — the failure sentinel is on the clipboard. Because the deliverable goes to the *desktop* in this mode, the relay outcome is part of the indicator — if the desktop link was down when the text was delivered, the screen turns red even though the local success beep already played; a dictation queued behind a failed relay waits ~1.5 s so you see the red before the next recording paints over it.
- **Haptics mirror the beeps** where the device supports it (start, done, warn, fail, mic-alarm). Vibrations accompany the sounds, never replace them.
- **The transcript collapses to a peek strip** at the bottom — tap to expand, tap the expanded text to arm click-to-append, exactly like clicking the transcript box on the desktop. **While you dictate, the strip turns live**: it wraps and keeps the newest recognized words on-screen so the realtime feedback tracks your speech (instead of a one-line strip that scrolls the latest words off the edge and looks frozen).
- The **joined badge and Leave** stay visible at the top; **Settings** opens the normal page (engine selector, credentials, keyterms, tuning — all the existing sections), and "Back to the button" returns.

**Per-device override** (Options → *Big-button layout*): **when joined** (default), **always** (a phone used for solo dictation, no desktop involved), or **never** (e.g. a desktop that joins a session but should keep its normal layout). Stored per device; in the default *when joined* mode, leaving the session restores the normal layout (with *always*, the big button stays — change the override via Settings).

**The reliability machinery underneath** (all of it exists because every layer of this link fails silently by default):

- The desktop **heartbeats** the session room and **reconnects automatically** with backoff; a drop flips the code badge to a red ⚠ with a warn beep. A clean badge means the link is genuinely alive — it's verified every 25 s, not assumed.
- Final texts are **buffered server-side for 2 minutes** and replayed if the desktop was mid-reconnect (or mid-reload) when they arrived. Deliveries carry unique ids, so a replay can never double-copy.
- The phone is **told whether the desktop actually received** each delivery. A relay miss is a loud red status on the phone — never a false success beep.
- If the desktop tab isn't focused when text arrives (you're in Cerner/Citrix), the copy is **held and retried automatically on refocus** — red status and fail beep until it lands, so a stale clipboard can't masquerade as a fresh one.
- If the phone dies before its final delivery, the desktop falls back to the **live text it already mirrored** (after a 10 s grace window), clearly framed as degraded — verify before pasting.

### Focus-free clipboard on the desktop (optional)

If the desktop runs `hotkey.ahk` anyway, set `PHONE_POLL_URL` (your worker URL) and `PHONE_CODE` (the session code) at the top of the script. It polls the session's `GET /latest` endpoint every 2 s and writes new deliveries **straight to the Windows clipboard — no browser focus needed**. It baselines on startup (never pastes a delivery that predates it), dedupes by id, and pauses itself during the CapsLock push-to-talk handshake.

### iPhone notes

- **Turn on Voice Isolation.** While the mic is active, open Control Center → **Mic Mode** → **Voice Isolation**. iOS suppresses background voices at the OS level, before the audio ever reaches the page — by far the most effective fix for ambient speech ending up in notes, and it persists per app.
- **The phone's own clipboard usually can't be written by the app** — iOS only allows clipboard writes inside a tap, and the delivery happens seconds after your last touch. While joined this doesn't matter: the **desktop** clipboard is the deliverable, and the phone reports **"Delivered to the desktop clipboard. Done!"** once the desktop acknowledges (red if it didn't), instead of a false copy failure. If you ever need the text on the phone itself, tap **Copy latest** — a tap is a gesture, so it works.
- Mic permission, the pairing, and your settings **survive iOS killing the PWA**; the mic re-warms automatically at relaunch and on app-switch returns (with retries — iOS hands the audio session back late after foregrounding).
- **Hard OS limit:** switching apps *mid-dictation* kills that dictation — iOS revokes the mic the instant a web page is backgrounded. It fails loudly (mic alarm), but finish the press before switching.
- **Security model:** the 6-character session code is the link's only credential — treat it like a meeting code. Codes are random per session, and the QR is generated locally on the page (no external QR service ever sees it).

## Tuning guide — things to adjust

### In the UI

| Setting | Default | Applies to | When to change |
|---|---|---|---|
| **Engine** | batch | — | See [Choosing an engine](#choosing-an-engine). |
| **Push-to-talk hotkey** | Ctrl + Space | all | Rebind to anything (click the field in Options, press a combo). Tap toggles; holds longer than ~400 ms behave as press-and-hold. F13/F14 stay active regardless. |
| **Keyterms** | — | all | Curate per specialty: drug names, anatomy, eponyms, colleague names. Your custom list merges with the checked **preset lists** (deployer-curated in `worker.js` — hover a checkbox to see its terms) and the always-on standard list, deduped: realtime takes 50 terms (≤ 20 chars each; your terms win, then presets, then standard), batch up to 1000 (< 50 chars each — longer preset terms simply become batch-only). Adds ~20 % to cost — and the always-on list means **every** dictation now carries that surcharge. The single biggest accuracy lever available; in realtime the status line shows the server-confirmed "(N keyterms active)". |
| **Append mode** | off | all | Off: each dictation is its own note, and clicking the transcript box arms a one-shot append. On: dictations chain automatically within the append window. |
| **Append window** | 45 s | all | Only applies with append mode on. Shorten if stale text keeps riding along into new notes; lengthen (or 0 = always) if you dictate long notes with long thinking pauses. |
| **Remove ellipses** | on | all | Scribe writes dictation pauses as "…"/"..." — this strips them. Turn off only if you genuinely dictate ellipses. |
| **Keyterms (realtime)** | — | realtime/hybrid | Soniox accepts keyterms as `context.terms` on every realtime dictation (curated in the Keyterms section). This restores live keyterm biasing that the brief Voxtral detour lacked. |
| **Gate open/close, high-pass** | 0.030 / 0.008 / 85 Hz | all (load-bearing in batch) | In realtime/hybrid these shape only the saved preview. **In batch mode they decide what gets transcribed** — see the gate tutorial below. |
| **Tag audio events** | off | batch/hybrid | Batch Scribe can annotate (laughter), (cough), etc. in the text. |
| **Timestamps** | none | batch/hybrid (word also plumbed for realtime) | Word/character granularity rides the batch API call; currently unused by the UI. |
| **Browser noise suppression** | off | all | Browser DSP can distort specialized terms. Try on only if the room is hopeless and gate/Voice-Isolation tuning wasn't enough. |

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

## Where settings live (and don't)

Everything — engine choice, keyterms, gate tuning, hotkey, credentials, history, phone-link pairing — persists in **`localStorage`**, which is scoped to *one browser profile on one device on one origin*. The practical consequences, today:

- **Desktop and phone never share settings.** Keyterms you curate on the desktop do not exist on the phone, and vice versa. Set up each device you dictate from.
- **An installed PWA may not share with the browser.** On desktop Chrome/Edge the installed app shares the browser profile's storage, so settings carry over. **On iOS they do not** — a home-screen PWA has storage completely separate from Safari. If you set up in Safari and then install to the home screen, the PWA starts blank (enter the passphrase/key once there; the QR-join and persistence features work identically in both).
- **Different browsers / profiles / private windows** are all separate worlds.
- What *does* travel: keyterm **preset lists** ship inside `worker.js` itself, so editing them and deploying reaches every user and device at next load. (This is the current workaround for shared vocabulary.)

This is the #2 roadmap priority — see [Settings portability](#roadmap). Until then: settings are per-device by design of the web platform, not by choice of this app.

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

When a dictation continues a note, the client still emits the tail of the existing text as `previous_text` on the first audio chunk, but the Worker drops it for realtime (the Soniox realtime path consumes raw audio + a config frame, not a continuation hint). Cross-press capitalization/punctuation continuity can therefore drift slightly in both the live rendering and refined/batch text — the batch API also lacks a `previous_text` equivalent.

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

- [x] **Realtime root-cause fixes + engine settle (2026-06)** — the saga is documented in `REALTIME_HANDOFF.md`. Two engine-agnostic bugs were the real cause of "garbled at natural pace" across every engine tried: (1) the **AudioWorklet pump never loaded** (it was built from a Blob URL that silently failed to register on real browsers, forcing the starving main-thread ScriptProcessor that dropped audio frames) — fixed by serving it from a real route `/pcm-pump.js`; (2) **browser noise suppression defaulted OFF** — streaming STT is far more noise-sensitive than batch, so noisy mic audio wrecked the live feed — now defaults ON. With those fixed, realtime settled on **Soniox `stt-rt-v5` as the default** (fastest: ~0.75 s first word, word-by-word), with **ElevenLabs Scribe v2 Realtime** (`?rt=el`) and **Deepgram Nova-3** (`?rt=binding`) selectable. The Nova-3 Workers-AI binding was relegated (its managed layer floored interim cadence at ~1/sec; `sample_rate` IS honored — that hypothesis was tested and ruled out). The client keeps one frame vocabulary; the Worker translates per engine (`sonioxClientToBackend`/`makeSonioxToClient`; EL near-identity passthrough; `novaClientToBackend`/`makeNova3ToClient`). Soniox tuned for dictation: endpoint detection off (PTT supplies the end), strict English, rich medical context, full keyterm list (`context.terms`).
- [x] **Hybrid = the production deliverable, with faster finalize**: confirmed the accurate path is hybrid (Soniox feedback + ElevenLabs Scribe v2 **batch** clipboard, already at the best single-speaker medical config). Hybrid now starts the batch refine the instant the audio tail ends — it no longer waits for the realtime engine's finalize (dead time removed). Remaining post-speech latency is the batch refine (~2–4 s) — open work in `LATENCY_PLAN.md`.
- [x] Realtime hardening: anti-clipping (buffer-while-connecting, post-release tail, commit-then-wait), dead-mic watchdog, connect timeout, failure-aware clipboard semantics, always-audible failure beeps, mic re-engagement, append window + chip, Advanced section, pre-roll, ellipsis filter, transcript-first layout, realtime-spec alignment (error-frame taxonomy, `previous_text`, server-confirmed keyterms), PWA, queued PTT, configurable hotkey, jsdom flow harness
- [x] **Three-engine merge**: dual-protocol Worker (WS + POST on `/api/transcribe`), engine selector with per-mode UI, batch engine (post-gate recording, upload-on-release), **hybrid accuracy mode** — realtime feedback + batch re-transcription of the exact streamed audio (incl. pre-roll) as the clipboard deliverable, with WS-death recovery via the refine, degraded-success warn semantics, and per-engine history (`liveText` kept for comparison)
- [x] **Compact-UI pass**: batch default engine, append-off default with **click-to-append** (one-shot arm by clicking the transcript box), latest transcript restored on load, collapsible Access/Options/Keyterms sections (Access auto-collapses once credentials are set), tiny-window layout for minimized/PWA use
- [x] **Keyterm presets**: deployer-curated lists in `keyterms.js` — an always-on standard list plus per-clinic checkbox presets (Wound care clinic, ER shift), injected into the page at serve time, merged client-side with custom terms (custom > presets > standard), checked state persisted per browser
- [x] **Phone link**: Durable Object session rooms, live transcript mirroring to the desktop, authoritative final delivery with listener-count acks, heartbeat + auto-reconnect (zombie-socket detection sized for background-tab throttling), 2-minute buffered replay deduped by delivery id, focus-retry clipboard copy, live-text grace fallback, QR-scan pairing (local encoder, decode-verified in tests), pairing persistence across reloads/PWA kills, `GET /latest` + AHK native poller for focus-free clipboard writes
- [x] **iOS mic resilience**: screen wake lock per dictation, muted-track detection and rebuild (interruptions leave tracks "live" but dead), persisted mic grant (PWA relaunches re-warm at boot), retrying re-warm for iOS's late audio-session handback, focus-event re-warm for standalone PWAs, idle muted-track self-heal
- [x] **Mobile-first big-button layout**: joined devices (and a per-device "always" override) get a dedicated dictation surface — one thumb-sized hold-or-tap push-to-talk button driving the normal session paths, whole-screen status derived from the existing status/pill transitions (relay outcomes included: a zero-listener ack reddens the screen after the local success), haptics mirroring the beep vocabulary, transcript peek strip with click-to-append, settings reachable behind the existing sections; activation is the *joined state*, never the screen size, so the desktop tiny-window contract is untouched

### Next — in priority order

**1. Durability: never lose a dictation.** The alpha verdict: the app works, but reliability is the product. Close every remaining window where speech can vanish:

- [ ] **Dictation journal** — persist the captured audio (and session state) to IndexedDB *during* the dictation, marked delivered only after the clipboard/relay succeeds. A tab crash, PWA kill, or browser restart mid-upload/mid-refine then boots into "1 unsent dictation — recover?" with one-tap re-transcription through batch, instead of silence. This subsumes the audio side of every failure mode below it.
- [ ] **Ride-through WS death in hybrid** — keep capturing after the live link dies and only finalize on release, so the recovered refine covers the *entire* dictation (today capture stops when the session finalizes on close).
- [ ] **Phone-side delivery queue** — if the room ack says no listener received the text (desktop down longer than the replay window), keep the delivery queued on the phone and re-POST when the link heals, instead of relying on the 2-minute server buffer alone.
- [ ] **Local failure log** — ring buffer of session outcomes (timings, bytes sent, transcripts received, failure reason, delivery acks) surfaced in the UI, for diagnosing "it failed earlier" reports from the field.

**2. Settings portability.** Settings are per-browser-per-device today (see [Where settings live](#where-settings-live-and-dont)); desktop, phone, and installed PWAs don't share. Candidate design, to be settled before building: split settings into **portable** (engine, keyterms, custom lists, append prefs, beeps) and **per-device** (gate thresholds, hotkey, mic tuning — these *should* stay local); then sync the portable half. Options, cheapest first:

- [ ] **Export/import via QR or code phrase** — the QR plumbing already exists; zero backend.
- [ ] **KV-backed profiles in shared mode** — passphrase-keyed server-side settings blob; every device with the passphrase pulls the same profile (per-device settings stay local). Plays well with the existing shared-mode trust model.
- [ ] **Piggyback the phone link** — a paired phone/desktop already share a room; syncing portable settings across an active pair is nearly free once the split exists.

**3. Mobile-first dictation UI.** ✅ Landed — see [The joined phone becomes a big button](#the-joined-phone-becomes-a-big-button). Remaining polish ideas:

- [ ] Large-type live readout on the big screen while dictating: the peek strip now goes *live* during recording (wraps + tail-pins the realtime words so they stay on-screen), but a bigger center readout that replaces the state word mid-dictation could read better at arm's length.
- [ ] Swipe gestures (swipe up = expand transcript, swipe down = settings) as an alternative to the tap targets.

**Also queued (smaller):**

- [ ] **Mic self-test button** — 2-second record-and-meter check producing an explicit pass/fail, for non-developer users who won't read a meter.
- [ ] **Settings presets** — e.g. *Quiet office* / *Shared ward* bundles for the Scribe VAD trio, one click instead of three sliders.

### Later / ideas

- [ ] **Direct client-side streaming** — the realtime API accepts single-use tokens (`token` query param, minted via the tokens endpoint); the Worker could become a passphrase-gated token minter and the browser would connect straight to ElevenLabs, dropping the proxy hop from the audio path entirely.
- [ ] **Zero-retention mode** — `enable_logging=false` puts a session in zero-retention mode (enterprise plans only); worth wiring as an option if PHI policy ever requires it.
- [ ] **Warm socket** — keep one WebSocket open across dictations for instant start; needs answers on idle billing/session timeout before committing.
- [x] **AudioWorklet migration** — the realtime/hybrid frame pump now runs on the audio render thread (`pcm-pump` worklet), so it can't be starved by main-thread work the way the deprecated `ScriptProcessorNode` was. This fixed slow/sparse realtime on phones (the pump was dropping buffers under UI load, starving the STT). `ScriptProcessorNode` stays as a fallback for browsers without worklet support.
- [ ] **Passphrase hardening** — shared-mode passphrase travels as a query parameter on the WS path; move to a WebSocket subprotocol header or first-message auth to shrink the exposure surface (logs, proxies).
- [ ] **Editable transcript box** — let the user correct text in place before copy; cursor-aware appending.
- [ ] **True streaming into Cerner** — AHK polls clipboard deltas (or a local helper receives text over localhost) and types text as it commits. Big workflow win, big failure-mode surface; prototype now that the hybrid mode has proven out.
- [ ] **Per-user keyterm lists in shared mode** (KV-backed) instead of per-browser localStorage.
- [ ] **Word timestamps** — already plumbed; could drive partial-text highlighting or audio-sync review of suspect words.

## Thoughts & open questions

- **Realtime vs batch accuracy.** The realtime model (Soniox `stt-rt-v5`) trades some accuracy for latency versus batch ElevenLabs `scribe_v2`, but it **does** take keyterms (as `context.terms`), so drug names and eponyms get biasing on the live leg too. Hybrid still exists because the UX separates the two moments — live text during, clipboard at the end — so the slower, stronger model can own the deliverable. **Validate realtime on real dictation before trusting it standalone**: any streaming STT can emit fluent-but-wrong text on silence/noise, which in a chart is the exact "silent wrong text" failure the app's loud-failure design guards against.
- **Hybrid audio fidelity.** The refine gets the 16 kHz averaged-downsample feed (exactly what realtime heard), not the mic's native 48 kHz — the ungated 48 kHz signal is never recorded. Parity-with-realtime is the design goal; if refine accuracy ever disappoints, a parallel ungated 48 kHz capture is the experiment to run.
- **Why per-dictation sockets.** Sessions are short and the connect cost is masked by buffering, so per-dictation sockets keep the cost model legible and avoid idle-session billing questions.
- **The gate earns its keep again.** In the realtime-only sibling the gate was vestigial; in the merged app it is load-bearing for batch mode, and the meter/analyser doubles as the health watchdog everywhere.
- **`commit: true` under `commit_strategy=vad`.** The shutdown path sends a final empty chunk with `commit: true` and then *waits*; even if a future API change ignored the manual commit, the wait-for-quiet + deadline still close the session gracefully. Re-verify against ElevenLabs docs as the realtime API evolves.
- **Clipboard focus is a hard boundary.** Browsers will not let an unfocused page write the clipboard. Every design here (beeps, sentinel, AHK pacing) routes around that instead of fighting it; a local helper app would be the only true escape hatch.
- **Cost notes.** Keyterms add ~20 %. Realtime is billed on audio time (the tail and connect buffering add a fraction of a second per dictation). Hybrid adds one batch call per dictation on top — the price of the accuracy win; pick Realtime or Batch when that trade isn't worth it.
- **Settings live in `localStorage` v9 keys.** Bumping the version string wipes every user's tuned thresholds and saved keys — treat key names (including the legacy `scribe_v2_access_code_v9` fallback) as part of the public contract. The per-device scoping this implies is the app's biggest UX rough edge today — see [Where settings live](#where-settings-live-and-dont) and roadmap priority #2.
- **The phone is becoming the primary microphone.** The phone link started as a thin-client workaround and alpha use is pulling it toward being the default capture path — which is what motivates roadmap priority #3 (a phone-width layout that is a dictation *device*, not a shrunken settings page). The desktop increasingly acts as a receiver: display, clipboard, AHK relay.

## Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Mic won't engage after reopening | Should self-heal (track revalidation on `pageshow`/visibility). If the *mic off* pill persists, click the page once (autoplay policy) or re-grant mic permission. |
| Three-beep alarm right after starting | OS muted the mic, wrong input device, or Citrix audio redirection dropped. Check the meter moves when you speak. |
| Text stops mid-dictation, red status | Network/service drop. In hybrid the refine usually recovers the full text (verify the ending); in realtime the partial was copied — verify before pasting. |
| Two-tone warn beep, amber status | Hybrid's batch refine failed — the *live* text was copied and is usable; the status names the upstream error. If it recurs, check quota/key and consider Realtime mode until resolved. |
| "uploading…"/"refining…" hangs then fails | Batch API unreachable or slow; deadlines are 30 s (batch) / 8 s (refine). The audio preview still holds the recording. |
| Last words missing | Should be fixed by the tail + commit-wait flow. If it recurs, raise `TAIL_MS`. |
| First words missing (realtime/hybrid) | The pre-roll captures ~400 ms before the keypress while the mic is warm. On the very first dictation after a cold open there is no pre-roll yet — speak on the start beep. |
| First words missing (batch) | The gate opens late — lower the **open threshold** (red), and speak on the beep; there is no pre-roll in batch mode. |
| Nothing transcribes in batch mode | The gate never opened (recording too short/empty → sentinel). Watch the gate pill while speaking; retune the thresholds. |
| Success beep but paste shows `##DICTATION_FAILED##` | The previous dictation failed and left the sentinel; the beep belongs to a newer one. Use the history panel. |
| Nothing transcribes, *LINK FAIL* | Worker can't reach the STT backend (Soniox for realtime, ElevenLabs for batch) or the key/passphrase is wrong — the status line shows the upstream error. |
| No beeps in the background | Beeps reuse the live audio context precisely for this; if the mic was never warmed, there is no running context — warm the mic first (open the app once). On a phone-link desktop (which never records), the beep context is warmed by the Start-session click — after a reload, click the page once. |
| Phone dictation never reaches the desktop | Check the desktop code badge: **⚠ = reconnecting** (self-heals; deliveries are buffered 2 min and replayed). If the phone showed "desktop link is DOWN", the desktop was offline past the buffer — the text is still in the phone's box and history. |
| Desktop shows the text but the paste is stale | The tab wasn't focused when the copy ran. Click the browser window once — the held copy lands automatically and the status goes green. For a permanent fix on thin clients, use the AHK poller (`PHONE_POLL_URL`/`PHONE_CODE` in `hotkey.ahk`). |
| Background voices in the notes (phone) | iOS Control Center → Mic Mode → **Voice Isolation** (the OS-level fix). Remember: in hybrid, the clipboard text comes from the batch refine, which hears the ungated mic — Voice Isolation is the lever that cleans it. |
| iPhone mic cold after reopening the app | It re-warms automatically (boot, visibility, focus — with retries). If the warn status says it couldn't re-engage, tap Start once: acquisition inside a tap always works. Switching apps *mid-dictation* kills that dictation — OS limit, not recoverable. |
