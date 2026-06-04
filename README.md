# elevenlabs-web-

```markdown
# ElevenLabs Scribe v2 Dictation – Project README

A self-contained, low-latency medical dictation system built on Cloudflare Workers and AutoHotkey, targeting **Cerner running inside Citrix**.

**Key features:**
- **Push-to-talk dictation** via a single key (CapsLock) – no mouse, no window switching.
- **Hysteresis noise gate + high‑pass filter** to suppress background voices and room rumble.
- **Scribe v2 English batch transcription** with custom keyword biasing.
- **Instant paste** into the Cerner field (or keystroke fallback).
- **Audio feedback** (start/done/fail beeps) so you never look away from the chart.

---

## Table of Contents
1. [Architecture overview](#architecture-overview)
2. [Deployment](#deployment)
3. [AutoHotkey setup](#autohotkey-setup)
4. [Daily workflow](#daily-workflow)
5. [Audio pipeline & noise gate tuning](#audio-pipeline--noise-gate-tuning)
6. [Configuration reference](#configuration-reference)
7. [Troubleshooting](#troubleshooting)
8. [Known limitations](#known-limitations)
9. [Future improvements](#future-improvements)
10. [Appendix: AutoHotkey script](#appendix-autohotkey-script)

---

## Architecture overview

```
[Microphone] ──► Browser (Web Audio gate) ──► Worker (proxy) ──► ElevenLabs Scribe v2
                     │                              │
                     └── F13/F14 triggers           └── POST /api/transcribe
                          (AHK sends)                    xi-api-key auth

[AutoHotkey] ──► controls focus & paste into Citrix
```

- **Cloudflare Worker** (`worker.js`) – a single file that serves the entire web app (`GET /`) and proxies transcription requests (`POST /api/transcribe`).
- **Browser app** – vanilla HTML/CSS/JS embedded in the Worker. It captures audio via `getUserMedia`, applies a real‑time gate/filter, and sends chunks to the Worker.
- **AutoHotkey v2 script** – handles the push‑to‑talk logic: registers the browser window, sends start/stop signals, waits for the transcript, and pastes it into Cerner.

All state (settings, API key/access code, history) is stored in the browser’s `localStorage`.

**Key resolution** (per transcription request, decided in the Worker):
1. If the browser sends an API key (bring-your-own), that key is used.
2. Otherwise, if the Worker has a **shared key + access code** configured (see [Shared access](#shared-access-no-api-key-for-your-users)) and the browser sends a matching access code, the shared key is used.
3. Otherwise the request is rejected (no key available).

So power users can still paste their own ElevenLabs key (overriding everything), while invited users just enter a short access code — no API key needed.

---

## Deployment

1. Install [Wrangler](https://developers.cloudflare.com/workers/wrangler/) and authenticate with your Cloudflare account.
2. Put `worker.js` in a new folder and run:
   ```bash
   npx wrangler deploy
   ```
3. Open the deployed URL (or a custom route if you set one).  
   If you ever see `“No event handlers registered”`, the Worker failed to *parse* – usually an unescaped backtick inside the `INDEX_HTML` template literal. Check the Wrangler output for the line number.

The app is served directly from the Worker; no additional hosting is needed.

---

## Shared access (no API key for your users)

By default every user pastes their own ElevenLabs API key. If you want to let
specific people (e.g. a colleague) dictate **without an API key** — billing the
usage to one shared key you control — configure two Worker **secrets**:

| Secret | Purpose |
| --- | --- |
| `ELEVENLABS_API_KEY` | The shared ElevenLabs key requests fall back to. |
| `APP_PASSPHRASE` | A short **access code** that authorizes use of that shared key. |

```bash
npx wrangler secret put ELEVENLABS_API_KEY   # paste the shared ElevenLabs key
npx wrangler secret put APP_PASSPHRASE        # choose a short access code
npx wrangler deploy
```

(You can also set these in the Cloudflare dashboard: **Workers → your Worker →
Settings → Variables and Secrets**, type **Secret**. The binding names must be
exactly `ELEVENLABS_API_KEY` and `APP_PASSPHRASE`.)

Then share the Worker URL **and** the access code with your user (out-of-band —
a text/Signal message, not committed anywhere). They open the page, type the
access code once (tick *Remember on this browser* so it persists), and dictate.

**How it works / why it’s safe to share a `*.workers.dev` URL:** the access-code
check runs **inside the Worker**, which serves every request — so there is no
custom domain or Cloudflare Access to set up, and no `workers.dev` "bypass" to
worry about. "Shared mode" turns on only when **both** secrets are set; setting
the key without an access code leaves it off (fail-safe — the shared key is never
exposed un-gated). The access code field appears in the UI only in shared mode.

- **Power users still bring their own key.** If a key is typed into the
  (optional) API-key field, it overrides the shared key — your existing AHK
  workflow is unchanged.
- **Anyone with the URL + the code can spend against your key.** That is the
  intended trade-off; keep your ElevenLabs account usage limits in place as the
  cost backstop. To rotate the code, re-run `npx wrangler secret put APP_PASSPHRASE`.
- **To turn shared access off:** delete the secrets
  (`npx wrangler secret delete APP_PASSPHRASE`) and redeploy; the app reverts to
  bring-your-own-key only.

> Local testing: put `ELEVENLABS_API_KEY=...` and `APP_PASSPHRASE=...` in a
> `.dev.vars` file (git-ignored) and run `npx wrangler dev`.

---

## AutoHotkey setup

1. Save the script from the [appendix](#appendix-autohotkey-script) as a `.ahk` file.  
   **Important:** Save as **UTF-8 with BOM** or use the ASCII‑only version below – on network drives the default encoding can break the file.
2. Double‑click to run (green `H` icon in the system tray).
3. **Register the dictation window** (do this every time you open the app):
   - Focus the installed web app window.
   - Press **Win+F12**. You should hear a confirmation beep and see a tray tip.
4. The script is now active.  
   **Hotkeys:**
   - `CapsLock` (hold) – record and transcribe
   - `Win+F11` – cycle delivery mode (paste / type / manual)
   - `Shift+CapsLock` – toggle real Caps Lock (if you ever need it)
   - `Ctrl+Alt+Q` – reload the script

**Delivery modes:**
| Mode | Behaviour |
|------|-----------|
| **Paste** | Copies cleaned text to clipboard and sends `Ctrl+V`. Fastest. |
| **Type** | Types the transcript character‑by‑character. Use when Citrix clipboard redirection is disabled. |
| **Manual** | Focuses Cerner, beeps, and waits for **you** to press `Ctrl+V`. Works even if AHK can’t send keystrokes. |

Switch modes on‑the‑fly with `Win+F11`.

---

## Daily workflow

1. Open the dictation app (installed PWA from Chrome).
2. Run the AHK script (it sits in the tray).
3. Press **Win+F12** while the app is focused → registered.
4. Click into the Cerner note field.
5. **Hold CapsLock** → the app beeps (880 Hz, one short tone) → **speak**.
6. **Release CapsLock** → transcription fires. When it finishes you’ll hear a **rising two‑note chirp** (1046→1568 Hz) from the browser, and a system “info” sound from AHK when the text appears in Cerner.

The CapsLock key itself will never toggle caps – the script locks it off. If you need real caps, press `Shift+CapsLock`.

---

## Audio pipeline & noise gate tuning

The browser’s audio processing chain is:

```
mic → high‑pass filter → analyser → hysteresis gate → MediaRecorder → Worker
```

The **hysteresis gate** is the key weapon against background voices. It uses two thresholds:

- **Open threshold (red marker)** – the level above which the gate *opens*. Set this just above the room’s background chatter.
- **Close threshold (yellow marker)** – once open, the gate stays open until the level drops below this (plus a 900 ms hold). Set this low – your quiet word‑endings and soft syllables must keep it open.

The **high‑pass filter** (default 85 Hz) removes low‑frequency rumble (HVAC, desk thumps) before the gate sees it, preventing false triggering.

### How to tune (2‑minute routine)

1. **Record silence** – see where the background peaks on the meter.
2. **Set the red (Open) marker** just above that peak.
3. **Speak normally** – confirm the meter shoots well past red and the pill shows **OPEN**.
4. **Set the yellow (Close) marker** low, in the gap between your voice and the noise.
5. **Talk a long, pause‑heavy sentence** – the pill should stay **OPEN** the whole time.
6. If you hear your own cut‑offs, lower both thresholds. If background leaks in, raise the red one.

A detailed, interactive tutorial is built right into the app – click **“How do these filter settings work?”** below the sliders.

### Symptom cheat‑sheet

| Symptom | Cause | Fix |
|----------|-------|-----|
| Word beginnings missing | Open threshold too high | Lower the red marker |
| Words drop mid‑sentence | Close threshold too high, or hold too short | Lower yellow; the hold is already 900 ms |
| Background voices transcribed | Open threshold too low | Raise red |
| Gate flickers open/closed | Gap between red/yellow too narrow | Widen it (raise red, lower yellow) |
| Nothing records at all | Both thresholds above your voice | Drag both toward 0, re‑tune |

**Microphone advice:** A close‑talk cardioid mic with low gain, aimed so its null points at the noise source, will widen the “your‑voice‑vs‑room” gap dramatically – the gate then just cleans up the remainder.

---

## Configuration reference

### Scribe v2 API settings (hardcoded in the Worker)

| Parameter | Value | Reason |
|-----------|-------|--------|
| `model_id` | `scribe_v2` | Batch English model |
| `language_code` | `en` | Pinned; no language auto‑detection |
| `diarize` | `false` | Single speaker only |
| `num_speakers` | `1` | |
| `temperature` | `0` | Deterministic output |
| `no_verbatim` | `true` (default) | Strips um/uh/false starts |
| `tag_audio_events` | `false` (default) | Clean clinical text, no `(laughter)` tags |
| `keyterms` | JSON array `["..."]` | Max 1000 terms, <50 chars, ≤5 words each; ~20 % cost surcharge |

The `no_verbatim` and `tag_audio_events` defaults are set server‑side but can be toggled in the UI.

### Gate & filter defaults (web app)

| Control | Default | Range | Description |
|---------|---------|-------|-------------|
| Open threshold | 0.030 | 0 – 0.12 | Must exceed to open gate |
| Close threshold | 0.008 | 0 – 0.12 | Must drop below (for 900 ms) to close |
| High‑pass | 85 Hz | 0 – 200 Hz | 85–100 Hz ideal; 0 = off |
| Hold time | 900 ms | hardcoded | Gate stays open after dropping below Close |
| Attack | 20 ms | hardcoded | Time to open once above Open |
| Release | 120 ms | hardcoded | Fade‑out when closing |

### AHK timing

| Variable | Value | Purpose |
|----------|-------|---------|
| `SPINUP` | 250 ms | Delay after `F13` before you should speak |
| `MIN_HOLD` | 400 ms | Taps shorter than this are discarded as accidents |
| `SETTLE` | 120 ms | Pause before paste into Citrix |
| `CLIP_TIMEOUT` | 20 s | Max wait for transcript on clipboard |

---

## Troubleshooting

### Transcript is cut off at the start
- **Gate issue?** Confirm the **Open** threshold is low enough and that the pill shows OPEN the instant you talk. If the pill remains closed, lower the red marker.
- **Timing issue?** The `SPINUP` delay in AHK is 250 ms; if the browser’s start beep comes very late, increase `SPINUP`. Also make sure you **hear the beep before speaking** – the beep means the recorder is truly live.
- **Fast tap?** If you tap CapsLock very briefly, AHK discards it (beep + “Tap ignored”). Hold at least half a second.

### Background voices still appear
- Raise the **Open threshold** until they sit completely left of the red marker on the meter.
- Use a close‑talk cardioid mic with **low gain**, pointed **back** at the noise source.
- Turn **off** browser noise suppression – on a good mic it can pump background during pauses.

### CapsLock gets “stuck” or feels laggy
The script uses a single‑thread `KeyWait` pattern with a `BUSY` guard. If it ever feels stuck, press `Ctrl+Alt+Q` to reload. If the problem recurs, check that no other application is intercepting CapsLock.

### Transcription fails (error beep / no text)
- Open the browser app and look at the status line – it will show the error message.
- Common causes: invalid API key, audio blob empty (mic permission), or ElevenLabs API error.
- Verify the Worker deployment; check the browser’s DevTools console (F12) for network errors.

### No end beep from AHK (but text appears)
`SoundBeep` relies on the legacy PC speaker, which may be absent. The script now uses `SoundPlay("*64")` (Windows system sound). If you still don’t hear it, ensure your system sound scheme isn’t muted. The browser’s done beep (rising chirp) should always work and serves as the primary “ready” signal.

---

## Known limitations

1. **Latency is inherent** – after release, the audio must upload, transcribe, and return before the paste. Typical waiting time is 1–3 seconds for short clips. Focus switching (Cerner ↔ browser) adds a small additional delay.
2. **Background speech** at similar volume cannot be completely removed by software alone; the gate only filters by loudness, not by speaker identity. Hardware (close‑talking cardioid mic) is the primary defence.
3. **The app is English‑only** (`language_code: "en"` hardcoded). Other languages would need changes to both the Worker and UI.
4. **Push‑to‑talk, not continuous** – the system requires holding CapsLock; it does not use voice activity detection. This is intentional for medical notes where you control the recording window.
5. **Citrix focus reliance** – if Citrix does not restore the caret properly after switching back, the paste may land in the wrong field. In our tested environment the caret is retained; if your site behaves differently, consider the “manual” delivery mode.
6. **No enrolment or voice isolation** – Scribe does not distinguish your voice from another’s; it transcribes all audible speech.

---

## Future improvements

These items were discussed but not implemented; they are roughly ordered by impact.

- **Calibrate button** – auto‑suggest gate thresholds from 2 s of ambient silence.
- **Text post‑processing** – user‑configurable find‑and‑replace table (e.g., `"a fib" → "AFib"`).
- **Per‑context profiles** – switchable sets of keyterms and replacements (e.g., “ED note”, “discharge summary”).
- **Expander mode** – replace the hard gate with a softer expander (attenuates background by ~18 dB instead of muting), which is more forgiving on word edges.
- **Fully local recording** – use AHK + ffmpeg to record locally, then POST directly to the Worker, eliminating all focus switching and the browser dependency. This would be the ultimate robustness upgrade.
- **On‑screen AHK overlay** – a tiny always‑on‑top box showing REC / SENDING / DONE, useful when the browser window is minimised.

---

## Appendix: AutoHotkey script

```ahk
#Requires AutoHotkey v2.0
#SingleInstance Force
SetCapsLockState("AlwaysOff")
SendMode("Event")
SetKeyDelay(0, 10)

; ===== CONFIG =====
DELIVERY       := "paste"   ; "paste" | "type" | "manual"
CHAR_DELAY     := 8
CLIP_TIMEOUT   := 20
SPINUP         := 250
MIN_HOLD       := 400
SETTLE         := 120
STRIP_NEWLINES := true
TRAILING_SPACE := true
BEEPS          := true
; ==================

DICT_HWND   := 0
CERNER_HWND := 0
BUSY        := false

OkBeep() {
    global BEEPS
    if BEEPS
        SoundPlay("*64")
}
ErrBeep() {
    global BEEPS
    if BEEPS
        SoundPlay("*16")
}
DoneBeep() {
    global BEEPS
    if BEEPS
        SoundPlay("*48")
}

ActivateWindow(hwnd) {
    if (!hwnd || !WinExist("ahk_id " hwnd))
        return false
    Loop 3 {
        try WinActivate("ahk_id " hwnd)
        if WinWaitActive("ahk_id " hwnd, , 0.20)
            return true
    }
    return WinActive("ahk_id " hwnd) ? true : false
}

#F12::
{
    global DICT_HWND
    DICT_HWND := WinActive("A")
    OkBeep()
    TrayTip("Dictation", "Dictation window registered.", 1)
}

#F11::
{
    global DELIVERY
    if (DELIVERY = "paste")
        DELIVERY := "type"
    else if (DELIVERY = "type")
        DELIVERY := "manual"
    else
        DELIVERY := "paste"
    TrayTip("Dictation", "Delivery mode: " DELIVERY, 1)
    OkBeep()
}

*CapsLock::
{
    global DICT_HWND, CERNER_HWND, BUSY, DELIVERY
    global CHAR_DELAY, CLIP_TIMEOUT, SPINUP, MIN_HOLD, SETTLE
    global STRIP_NEWLINES, TRAILING_SPACE

    if BUSY {
        KeyWait("CapsLock")
        return
    }
    if (!DICT_HWND || !WinExist("ahk_id " DICT_HWND)) {
        ErrBeep()
        TrayTip("Dictation", "Register dictation window first (Win+F12).", 1)
        KeyWait("CapsLock")
        return
    }

    BUSY := true

    cur := WinActive("A")
    if (cur && cur != DICT_HWND)
        CERNER_HWND := cur

    A_Clipboard := ""

    if !ActivateWindow(DICT_HWND) {
        ErrBeep()
        BUSY := false
        KeyWait("CapsLock")
        return
    }
    Send("{F13}")
    Sleep(SPINUP)

    startTick := A_TickCount
    KeyWait("CapsLock")
    heldMs := A_TickCount - startTick

    if WinActive("ahk_id " DICT_HWND)
        Send("{F14}")

    if (heldMs < MIN_HOLD) {
        ErrBeep()
        TrayTip("Dictation", "Tap ignored (hold to dictate).", 1)
        ActivateWindow(CERNER_HWND)
        BUSY := false
        return
    }

    if !ClipWait(CLIP_TIMEOUT, 1) {
        ErrBeep()
        TrayTip("Dictation", "No transcript (timeout).", 1)
        ActivateWindow(CERNER_HWND)
        BUSY := false
        return
    }

    txt := A_Clipboard
    if STRIP_NEWLINES
        txt := RegExReplace(txt, "\R+", " ")
    txt := Trim(RegExReplace(txt, " +", " "))
    if (txt = "") {
        ErrBeep()
        ActivateWindow(CERNER_HWND)
        BUSY := false
        return
    }
    if TRAILING_SPACE
        txt .= " "

    A_Clipboard := txt
    ClipWait(2, 1)

    if !ActivateWindow(CERNER_HWND) {
        ErrBeep()
        TrayTip("Dictation", "Could not refocus Cerner. Click field, then Ctrl+V.", 2)
        BUSY := false
        return
    }
    Sleep(SETTLE)

    if (DELIVERY = "paste") {
        Send("^v")
        OkBeep()
    }
    else if (DELIVERY = "type") {
        Loop Parse, txt
        {
            SendText(A_LoopField)
            Sleep(CHAR_DELAY)
        }
        OkBeep()
    }
    else {
        DoneBeep()
        TrayTip("Dictation", "Ready. Press Ctrl+V to paste.", 1)
    }

    BUSY := false
}

+CapsLock::SetCapsLockState(!GetKeyState("CapsLock", "T"))
^!q::Reload()
```
```
