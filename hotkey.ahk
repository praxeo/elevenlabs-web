#Requires AutoHotkey v2.0
#SingleInstance Force
SetCapsLockState("AlwaysOff")
SendMode("Event")              ; reliable while the PTT key is physically held
SetKeyDelay(0, 10)

; ===== CONFIG =====
SPINUP         := 80           ; ms before speaking (mic is kept warm by the browser)
MIN_HOLD       := 200          ; a tap shorter than this records nothing and ends quietly (grey
                               ; bar, no sound). Measured AFTER window activation + SPINUP, so the
                               ; real threshold is ~280 ms+. A press under ~1 s that the page heard
                               ; no words in also ends quietly ("TOO SHORT"): the page says so in
                               ; its window title. A real failure is still loud.
CLIP_TIMEOUT   := 165          ; backstop; must cover the browser's batch deadline (hard-capped
                               ; at 150 s by UPLOAD_DEADLINE_MAX_MS) plus capture tail
ACT_TIMEOUT    := 0.15         ; per-attempt window-activation wait
ACT_TRIES      := 2
HOLD_CAP_MS    := 900000       ; 15 min: a hold this long is a stuck key, not a dictation. It was
                               ; 60 s, which cut every long dictation off at 1:00 and switched the
                               ; bar to TRANSCRIBING while you were still talking (2026-11-22).
                               ; Hitting it now beeps, says so, and never starts another take.
STRIP_NEWLINES := true
TRAILING_SPACE := true
ERR_SOUND      := true         ; the ONLY sound this script makes — on failure
SENTINEL       := "##DICTATION_FAILED##"   ; must match the browser's marker

; --- Focus return ---
RETURN_FOCUS   := true         ; re-activate whatever window you were in when you pressed

; AUTO_PASTE: OFF BY DEFAULT ON PURPOSE (wrong-field paste = wrong-chart risk).
AUTO_PASTE     := false

; --- On-screen state bar ---
SHOW_STATE_BAR   := true
STATE_BAR_W      := 250        ; at 100 % scaling; scaled automatically for higher DPI
STATE_BAR_H      := 38
STATE_BAR_MARGIN := 18         ; distance from the bottom-right corner of the work area

; --- Mouse side buttons ---
; Forward (XButton2) held = dictate. Back (XButton1): once = Enter, twice =
; click + paste, with right-click = select all + copy. See the bottom of the file.
DBLCLICK_MS    := 300          ; back-button double-press window
COPY_DELAY_MS  := 30           ; delay between Ctrl+A and Ctrl+C
PASTE_DELAY_MS := 100          ; delay after the click before Ctrl+V

; --- Phone-link clipboard poller (optional) ---
PHONE_POLL_URL := ""           ; e.g. "https://eleven.example.workers.dev" (no trailing slash)
PHONE_CODE     := ""           ; 6-char session code from the desktop page
PHONE_AUTH     := ""           ; access code; REQUIRED in shared mode (routes answer 401 without it)
PHONE_POLL_MS  := 2000
; ==================

DICT_HWND   := 0
BUSY        := false
PREV_HWND   := 0               ; the window you were in when the press started
SPACE_GUARD := false           ; swallows a still-held Space after a Ctrl+Space take
X1_WAITING  := false           ; a back-button press is waiting to see if a second one follows

; ===== On-screen state bar =====
StateGui := ""
StateTxt := ""
BAR_W    := 0
BAR_H    := 0

InitStateBar() {
    global StateGui, StateTxt, SHOW_STATE_BAR, STATE_BAR_W, STATE_BAR_H, BAR_W, BAR_H
    if !SHOW_STATE_BAR
        return
    ; -DPIScale keeps sizes in raw pixels, but the point-size font still grows
    ; with display scaling — scale the box by hand so text never clips.
    BAR_W := Round(STATE_BAR_W * A_ScreenDPI / 96)
    BAR_H := Round(STATE_BAR_H * A_ScreenDPI / 96)
    ; WS_EX_NOACTIVATE (never steals focus) + WS_EX_TRANSPARENT (click-through)
    StateGui := Gui("+AlwaysOnTop -Caption +ToolWindow +E0x08000000 +E0x00000020 -DPIScale", "Dictation state")
    StateGui.MarginX := 0
    StateGui.MarginY := 0
    StateGui.SetFont("s13 bold cWhite", "Segoe UI")
    StateTxt := StateGui.Add("Text", "w" BAR_W " h" BAR_H " Center +0x200", "")
}

ShowState(msg, bg) {
    global StateGui, StateTxt, SHOW_STATE_BAR, STATE_BAR_MARGIN, BAR_W, BAR_H
    if (!SHOW_STATE_BAR || !IsObject(StateGui))
        return
    SetTimer(HideState, 0)             ; a new state cancels an earlier flash's pending hide
    try {
        StateGui.BackColor := bg
        StateTxt.Value := msg
        ; Work area (not full screen) keeps the bar above the taskbar.
        MonitorGetWorkArea(MonitorGetPrimary(), &wl, &wt, &wr, &wb)
        x := wr - BAR_W - STATE_BAR_MARGIN
        y := wb - BAR_H - STATE_BAR_MARGIN
        StateGui.Show("NoActivate x" x " y" y " w" BAR_W " h" BAR_H)
    }
}

HideState() {
    global StateGui, SHOW_STATE_BAR
    if (!SHOW_STATE_BAR || !IsObject(StateGui))
        return
    try StateGui.Hide()
}

FlashState(msg, bg, ms) {
    ShowState(msg, bg)
    SetTimer(HideState, -ms)
}

; A failed take's state stays up until the next press.
FailState(msg) {
    ShowState(msg, "B91C1C")
}

InitStateBar()

; ===== The dictation window's title is the page's state =====
; It can be read without focus. The page (worker.js, applyWindowState) puts
; these words in it, and this script looks for them — change them in both:
;   "OFFLINE"    a take is running and the page cannot reach its server
;   "REC" / "Working"  a take is recording / being transcribed
;   "Too short"     a click the page heard no words in: ended quietly
;   "will retry"    a failed take whose recording is transcribed by itself later
;   "Recovered"     ...and it was: the text is the newest note in the page
;   "not recovered" ...and it could not be: retry it in the page, or redictate
; The words are matched with case, so "Recovered" never matches "not recovered".
DictTitle() {
    global DICT_HWND
    t := ""
    try t := WinGetTitle("ahk_id " DICT_HWND)
    return t
}
TitleHas(word) => InStr(DictTitle(), word, true) > 0

; The page writes its outcome into its title just before it writes the
; clipboard; give the browser a moment to pass a fresh title to the window.
SettledTitle(ms := 500) {
    deadline := A_TickCount + ms
    loop {
        t := DictTitle()
        if (InStr(t, "Too short", true) || InStr(t, "FAILED", true) || InStr(t, "Done", true) || InStr(t, "Check", true) || InStr(t, "Recovered", true))
            return t
        if (A_TickCount >= deadline)
            return t
        Sleep(50)
    }
}

; A failed LONG take is transcribed by the page itself once its server answers
; again, into its notes list (never the clipboard: you may be in another chart
; by then). Its title then says "Recovered"; this puts that on the bar, which
; is what you see from Cerner.
SetTimer(WatchForRecovered, 1000)
WatchForRecovered() {
    global BUSY, DICT_HWND
    static shown := "", lost := false
    if (BUSY || !DICT_HWND || !WinExist("ahk_id " DICT_HWND))
        return
    t := DictTitle()
    if (InStr(t, "not recovered", true)) {
        if (!lost) {
            FailState("⚠ NOT RECOVERED — RETRY IN APP")
            Fail("A saved dictation could NOT be transcribed by itself. Open the dictation window: retry it there, or redictate it.")
        }
        lost := true
        return
    }
    lost := false
    rec := InStr(t, "Recovered", true) > 0
    if (rec && shown != t) {
        ShowState("↺ RECOVERED — IN NOTES", "B45309")
        Notify("A failed dictation was recovered: it is the newest note in the dictation window. Nothing was pasted — copy it from there.")
    }
    shown := rec ? t : ""
}

; ===== Phone-link poller (non-blocking) =====
LAST_DELIVERY_ID := ""
POLL_SEEDED      := false      ; first good poll only baselines — never copy a stale delivery

if (PHONE_POLL_URL != "" && PHONE_CODE != "")
    SetTimer(PollPhoneDelivery, 250)   ; fast tick; actual request rate is PHONE_POLL_MS

; The old version blocked in WaitForResponse(5), which froze hotkey handling for up
; to 5 s — a CapsLock press during a slow poll arrived late and read as a "tap".
; Now the request runs in the background and each tick only checks it.
PollPhoneDelivery() {
    global PHONE_POLL_URL, PHONE_CODE, PHONE_AUTH, PHONE_POLL_MS, BUSY
    static req := "", sentAt := 0, nextAt := 0
    if BUSY                            ; never fight the PTT clipboard handshake
        return

    if IsObject(req) {                 ; a request is in flight — check without blocking
        done := false
        try done := req.WaitForResponse(0)
        catch {
            req := ""
            return
        }
        if !done {
            if (A_TickCount - sentAt > 5000) {
                try req.Abort()
                req := ""
            }
            return
        }
        status := 0, body := ""
        try {
            status := req.Status
            body   := req.ResponseText
        }
        req := ""
        if (status = 200)              ; only a real answer may set the baseline
            HandlePhoneBody(body)
        return
    }

    if (A_TickCount < nextAt)
        return
    nextAt := A_TickCount + PHONE_POLL_MS
    try {
        r := ComObject("WinHttp.WinHttpRequest.5.1")
        r.Open("GET", PHONE_POLL_URL "/api/session/" PHONE_CODE "/latest", true)
        if (PHONE_AUTH != "")
            r.SetRequestHeader("x-phone-auth", PHONE_AUTH)
        r.Send()
        req := r
        sentAt := A_TickCount
    }
    ; network blip — next tick retries; stay silent
}

HandlePhoneBody(body) {
    global LAST_DELIVERY_ID, POLL_SEEDED, STRIP_NEWLINES, TRAILING_SPACE
    if (RegExMatch(body, '"delivery_id"\s*:\s*"((?:[^"\\]|\\.)*)"', &mId)
        && RegExMatch(body, '"text"\s*:\s*"((?:[^"\\]|\\.)*)"', &mTxt)
        && mId[1] != "") {
        if !POLL_SEEDED {
            LAST_DELIVERY_ID := mId[1]         ; baseline only
        } else if (mId[1] != LAST_DELIVERY_ID) {
            LAST_DELIVERY_ID := mId[1]
            txt := JsonUnescape(mTxt[1])
            if STRIP_NEWLINES
                txt := RegExReplace(txt, "\R+", " ")
            txt := Trim(RegExReplace(txt, " +", " "))
            if (txt != "") {
                if TRAILING_SPACE
                    txt .= " "
                A_Clipboard := txt
                Notify("Phone transcript on clipboard.")
            }
        }
    }
    POLL_SEEDED := true
}

JsonUnescape(s) {
    s := StrReplace(s, "\\", Chr(1))   ; protect escaped backslashes first
    s := StrReplace(s, '\"', '"')
    s := StrReplace(s, "\n", "`n")
    s := StrReplace(s, "\r", "`r")
    s := StrReplace(s, "\t", A_Tab)
    s := StrReplace(s, "\/", "/")
    while RegExMatch(s, "\\u([0-9A-Fa-f]{4})", &m)
        s := StrReplace(s, m[0], Chr(Integer("0x" m[1])))
    return StrReplace(s, Chr(1), "\")
}

; ===== Feedback: toasts are silent; the only audio is ErrBeep on failure =====
Notify(msg) {
    TrayTip(msg, "Dictation", 16)          ; 16 = no notification sound
}
ErrBeep() {
    global ERR_SOUND
    if ERR_SOUND
        SoundPlay("*16")
}
Fail(msg) {
    ErrBeep()
    Notify(msg)
}

ActivateWindow(hwnd) {
    global ACT_TIMEOUT, ACT_TRIES
    if (!hwnd || !WinExist("ahk_id " hwnd))
        return false
    if WinActive("ahk_id " hwnd)
        return true
    Loop ACT_TRIES {
        try WinActivate("ahk_id " hwnd)
        if WinWaitActive("ahk_id " hwnd, , ACT_TIMEOUT)
            return true
    }
    return WinActive("ahk_id " hwnd) ? true : false
}

; Re-activate the window that was focused when the press began. Returns true
; only if that exact window is now foreground — the guard auto-paste needs.
ReturnFocus() {
    global PREV_HWND, DICT_HWND, RETURN_FOCUS
    if (!RETURN_FOCUS || !PREV_HWND || PREV_HWND = DICT_HWND)
        return false
    if !WinExist("ahk_id " PREV_HWND)
        return false
    ActivateWindow(PREV_HWND)
    return WinActive("ahk_id " PREV_HWND) ? true : false
}

; Wait for transcript or sentinel. Unlike a single long ClipWait, this notices
; when the dictation window loses focus (the browser cannot write the clipboard
; without it) and says so, instead of silently running out the 165 s clock.
; It also says when the page cannot reach its server (the page keeps trying,
; and sends the recording again once it can).
WaitForTranscript(label := "TRANSCRIBING…") {
    global CLIP_TIMEOUT, DICT_HWND
    deadline := A_TickCount + CLIP_TIMEOUT * 1000
    shown := label
    nextLook := 0
    while (A_TickCount < deadline) {
        if ClipWait(0.25, 1)
            return true
        if (A_TickCount < nextLook)
            continue
        nextLook := A_TickCount + 500
        if !WinActive("ahk_id " DICT_HWND)
            want := "⚠ REFOCUS DICTATION", color := "7C2D12"
        else if TitleHas("OFFLINE")
            want := "TRANSCRIBING — NO CONNECTION", color := "9A3412"
        else
            want := label, color := "B45309"
        if (want != shown) {
            shown := want
            ShowState(want, color)
        }
    }
    return false
}

; ===== Shared push-to-talk engine (CapsLock, Ctrl+Space AND the mouse's Forward button) =====
; isHeld()      → true while the PTT key/chord/button is physically held
; waitRelease() → blocks until the PTT key is physically released
PushToTalk(isHeld, waitRelease) {
    global DICT_HWND, BUSY
    ; A back-button Enter still waiting to fire was meant for Cerner; once the
    ; take focuses the dictation window it would land there instead.
    CancelPendingEnter()
    if BUSY {                          ; another take (e.g. via the other hotkey) is running
        waitRelease()
        return
    }
    if (!DICT_HWND || !WinExist("ahk_id " DICT_HWND)) {
        FailState("⚠ NOT REGISTERED")
        Fail("Register dictation window first (Win+F12).")
        waitRelease()
        return
    }
    BUSY := true
    try {
        RunTake(isHeld, waitRelease)
    } catch as err {
        FailState("⚠ SCRIPT ERROR")
        Fail("Dictation script error: " err.Message " — nothing was pasted.")
    } finally {
        BUSY := false                  ; can never stick, whatever happened above
    }
}

RunTake(isHeld, waitRelease) {
    global DICT_HWND, SPINUP, MIN_HOLD, HOLD_CAP_MS, CLIP_TIMEOUT
    global STRIP_NEWLINES, TRAILING_SPACE, SENTINEL, PREV_HWND, AUTO_PASTE

    A_Clipboard := ""
    PREV_HWND := WinActive("A")        ; remember where you were BEFORE stealing focus

    if !ActivateWindow(DICT_HWND) {
        FailState("⚠ NO FOCUS")
        Fail("Could not focus the dictation window.")
        waitRelease()
        return
    }

    Send("{F13}")
    ShowState("● RECORDING", "B91C1C")
    Sleep(SPINUP)

    ; Wait for release via PHYSICAL key state; the cap only catches a stuck key.
    ; While you talk, the page's title says when it cannot reach its server, so
    ; a long dictation into a dead connection is known while it is spoken —
    ; not three minutes later.
    ; sawTake: the page's title showed THIS take recording or working. Only
    ; such a press can end as a quiet "Too short" — a press the page refused
    ; before recording leaves the previous take's title up for a moment.
    startTick := A_TickCount
    capped := false
    offline := false
    sawTake := false
    nextLook := A_TickCount
    while isHeld() {
        if (A_TickCount - startTick > HOLD_CAP_MS) {
            capped := true
            break
        }
        if (A_TickCount >= nextLook) {
            nextLook := A_TickCount + 100
            t := DictTitle()
            if (InStr(t, "REC", true) || InStr(t, "Working", true))
                sawTake := true
            nowOff := InStr(t, "OFFLINE", true) > 0
            if (nowOff != offline) {
                offline := nowOff
                if offline {
                    ShowState("● REC — NO CONNECTION", "9A3412")
                    ErrBeep()
                    Notify("The dictation window can't reach its server. Keep going: the recording is kept, and it is sent when the connection is back.")
                } else
                    ShowState("● RECORDING", "B91C1C")
            }
        }
        Sleep(15)
    }
    heldMs := A_TickCount - startTick

    ; Stop recording. Refocus FIRST and verify — never fire F14 into Cerner.
    if (!ActivateWindow(DICT_HWND) && !ActivateWindow(DICT_HWND)) {
        FailState("⚠ COULD NOT STOP")
        Fail("Could not refocus the dictation window to stop recording. Stop it there manually. Nothing was pasted.")
        return
    }
    Send("{F14}")
    Sleep(20)
    Send("{F14}")                      ; cheap insurance; browser ignores the 2nd

    capMin := Round(HOLD_CAP_MS / 60000)
    if capped {
        ErrBeep()
        Notify("Recording STOPPED at the " capMin "-minute limit: anything said after that was NOT recorded. Let go of the key or button.")
    }

    if (heldMs < MIN_HOLD) {
        ; A tap, not a dictation: nothing to wait for and nothing to alarm about.
        FlashState("TAP — NOTHING RECORDED", "4B5563", 1200)
        ReturnFocus()
        return
    }

    ; Keep the dictation window focused until the clipboard write lands.
    label := capped ? "⚠ STOPPED AT " capMin " MIN — TRANSCRIBING…" : "TRANSCRIBING…"
    ShowState(label, "B45309")
    t := DictTitle()
    if (InStr(t, "REC", true) || InStr(t, "Working", true))
        sawTake := true
    if !WaitForTranscript(label) {
        FailState("⚠ TIMED OUT")
        Fail("Dictation FAILED: no transcript after " CLIP_TIMEOUT " s. Nothing was pasted. Check the dictation window.")
        ReturnFocus()
        if capped
            waitRelease()              ; never let a still-held key start another take
        return
    }

    txt := A_Clipboard

    ; Tolerant check: a sentinel with stray whitespace must still count as failure,
    ; never as text to paste into a chart.
    if InStr(txt, SENTINEL) {
        A_Clipboard := ""
        title := SettledTitle()
        ; A short press the page recorded and heard no words in: it ended
        ; quietly and says "Too short" in its title. A grey line, no sound.
        if (!capped && sawTake && heldMs < 2000 && InStr(title, "Too short", true)) {
            FlashState("TOO SHORT — NO WORDS", "4B5563", 1800)
            ReturnFocus()
            return
        }
        if InStr(title, "will retry", true) {
            FailState("⚠ FAILED — WILL RETRY")
            Fail("Dictation FAILED: nothing was pasted. The recording is SAVED in the dictation window and is transcribed into its notes by itself once the connection is back — do not redictate.")
        } else {
            FailState("⚠ FAILED")
            Fail("Dictation FAILED: nothing was pasted. The dictation window says why (and offers Retry when the recording was kept).")
        }
        ReturnFocus()
        if capped
            waitRelease()
        return
    }

    cleaned := txt
    if STRIP_NEWLINES
        cleaned := RegExReplace(cleaned, "\R+", " ")
    cleaned := Trim(RegExReplace(cleaned, " +", " "))
    if (cleaned = "") {
        A_Clipboard := ""
        FailState("⚠ EMPTY")
        Fail("Dictation FAILED: the transcript was empty. Nothing was pasted.")
        ReturnFocus()
        if capped
            waitRelease()
        return
    }
    if TRAILING_SPACE
        cleaned .= " "

    if (cleaned != txt) {              ; usually a no-op (browser already cleaned it)
        A_Clipboard := cleaned
        ClipWait(2, 1)
    }

    ; SUCCESS: silent. Hand focus back; paste only onto the exact original window.
    pasted := ReturnFocus()
    if (AUTO_PASTE && pasted)
        Send("^v")
    if capped {
        ; The text is real but stops at the limit: say so until the next press,
        ; and never let the still-held key start another take.
        ShowState("⚠ STOPPED AT " capMin " MIN — CHECK THE END", "B45309")
        waitRelease()
        return
    }
    FlashState(AUTO_PASTE && pasted ? "✓ PASTED" : "✓ READY", "15803D", 900)
}

; ===== Key-state helpers =====
CapsHeld()     => GetKeyState("CapsLock", "P")
CapsRelease()  => KeyWait("CapsLock", "P")
; Chord counts as held only while BOTH keys are down — releasing either stops.
ChordHeld()    => GetKeyState("Space", "P") && GetKeyState("Ctrl", "P")
SpaceRelease() => KeyWait("Space", "P")
X2Held()       => GetKeyState("XButton2", "P")
X2Release()    => KeyWait("XButton2", "P")

; Clears the Space guard once Space is physically up.
ClearSpaceGuard() {
    global SPACE_GUARD
    if !GetKeyState("Space", "P") {
        SPACE_GUARD := false
        SetTimer(ClearSpaceGuard, 0)
    }
}

; ===== Register the dictation window: focus it, press Win+F12 =====
#F12::
{
    global DICT_HWND
    DICT_HWND := WinActive("A")
    title := ""
    try title := WinGetTitle("ahk_id " DICT_HWND)
    ; Show WHICH window got registered — catches registering Cerner by mistake.
    Notify("Dictation window registered:`n" (title != "" ? title : "(untitled window)"))
}

; ===== Push-to-talk #1: hold CapsLock =====
*CapsLock::PushToTalk(CapsHeld, CapsRelease)

; ===== Push-to-talk #2: hold Ctrl+Space (no-mouse-button fallback) =====
; Identical pipeline. Releasing EITHER key stops recording. If Ctrl is let go
; first, Space auto-repeat is swallowed (SPACE_GUARD) so it can't type spaces
; or "click" a focused button in the dictation window.
$^Space::
{
    global SPACE_GUARD
    SPACE_GUARD := true
    SetTimer(ClearSpaceGuard, 50)
    PushToTalk(ChordHeld, SpaceRelease)
}

#HotIf SPACE_GUARD
*Space::return
#HotIf

; ===== Push-to-talk #3: hold the mouse's Forward button (XButton2) =====
; Identical pipeline. The button never does browser-Forward while this runs.
*XButton2::PushToTalk(X2Held, X2Release)

; ===== Mouse Back button (XButton1) =====
; Once: Enter. Twice within DBLCLICK_MS: click where the pointer is, then paste.
; Held with a right-click: select all, then copy.
; Because Back+right-click is a combination, the plain Back action runs when the
; button is RELEASED (and only if no right-click happened while it was held).
; None of these act while a take is running.

FireEnter() {
    global X1_WAITING, BUSY
    X1_WAITING := false
    if BUSY                            ; a take began meanwhile: focus is on the dictation window
        return
    SendEvent("{Enter}")
}

CancelPendingEnter() {
    global X1_WAITING
    X1_WAITING := false
    SetTimer(FireEnter, 0)
}

; Click + paste, but never the failure marker into a chart.
ClickPaste() {
    global SENTINEL, PASTE_DELAY_MS
    if InStr(A_Clipboard, SENTINEL) {
        A_Clipboard := ""
        FailState("⚠ NOT PASTED")
        Fail("The clipboard held the dictation-failed marker, so nothing was pasted.")
        return
    }
    Click
    Sleep(PASTE_DELAY_MS)
    SendEvent("^v")
}

XButton1 & RButton::
{
    global BUSY, COPY_DELAY_MS
    if BUSY
        return
    CancelPendingEnter()
    SendEvent("^a")
    Sleep(COPY_DELAY_MS)
    SendEvent("^c")
    KeyWait("RButton")
    KeyWait("XButton1")
}

*XButton1::
{
    global BUSY, X1_WAITING, DBLCLICK_MS
    if BUSY
        return
    if X1_WAITING {                    ; second press: click + paste instead of Enter
        CancelPendingEnter()
        ClickPaste()
        return
    }
    X1_WAITING := true
    SetTimer(FireEnter, -DBLCLICK_MS)
}

; Shift+CapsLock toggles real caps lock — and restores AlwaysOff when turning
; it off (plain SetCapsLockState(0) would silently drop the AlwaysOff lock).
+CapsLock::
{
    if GetKeyState("CapsLock", "T")
        SetCapsLockState("AlwaysOff")
    else
        SetCapsLockState("On")
}

; Emergency reload (also clears a stuck BUSY state)
^!q::Reload()
