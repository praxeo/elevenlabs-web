#Requires AutoHotkey v2.0
#SingleInstance Force
SetCapsLockState("AlwaysOff")
SendMode("Event")              ; reliable while CapsLock is physically held
SetKeyDelay(0, 10)

; ===== CONFIG =====
SPINUP         := 80           ; ms before speaking (mic is kept warm by the browser)
MIN_HOLD       := 350          ; taps shorter than this are discarded
CLIP_TIMEOUT   := 20           ; backstop; covers hybrid's worst case (tail + final-wait + 8s batch refine ≈ 11s); sentinel makes failures return in ~2s
ACT_TIMEOUT    := 0.15         ; per-attempt window-activation wait
ACT_TRIES      := 2
HOLD_CAP_MS    := 60000        ; absolute max hold before we force-stop (anti-wedge)
STRIP_NEWLINES := true
TRAILING_SPACE := true
ERR_SOUND      := true         ; the ONLY sound this script makes — on failure
SENTINEL       := "##DICTATION_FAILED##"   ; must match the browser's marker
; ==================

DICT_HWND := 0
BUSY      := false

; --- Feedback: toasts are ALWAYS silent (option 16). The only audio is ErrBeep
;     on a genuine failure. Success is completely silent. ---
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
    if WinActive("ahk_id " hwnd)           ; already focused — skip the wait
        return true
    Loop ACT_TRIES {
        try WinActivate("ahk_id " hwnd)
        if WinWaitActive("ahk_id " hwnd, , ACT_TIMEOUT)
            return true
    }
    return WinActive("ahk_id " hwnd) ? true : false
}

; ===== Register the dictation window: focus it, press Win+F12 =====
; Silent confirmation toast, no sound.
#F12::
{
    global DICT_HWND
    DICT_HWND := WinActive("A")
    Notify("Dictation window registered.")
}

; ===== Push-to-talk: CAPSLOCK HOLD → RECORD → CLEANED TEXT ON CLIPBOARD =====
*CapsLock::
{
    global DICT_HWND, BUSY, SPINUP, MIN_HOLD, CLIP_TIMEOUT, HOLD_CAP_MS
    global STRIP_NEWLINES, TRAILING_SPACE, SENTINEL

    if BUSY {
        KeyWait("CapsLock")
        return
    }
    if (!DICT_HWND || !WinExist("ahk_id " DICT_HWND)) {
        Fail("Register dictation window first (Win+F12).")
        KeyWait("CapsLock")
        return
    }

    BUSY := true
    A_Clipboard := ""

    if !ActivateWindow(DICT_HWND) {
        Fail("Could not focus the dictation window.")
        BUSY := false
        KeyWait("CapsLock")
        return
    }

    Send("{F13}")
    Sleep(SPINUP)

    ; --- Wait for release using PHYSICAL key state (robust against competing
    ;     keyboard hooks that can swallow a logical key-up). Hard cap prevents
    ;     ever wedging here forever. ---
    startTick := A_TickCount
    Loop {
        if !GetKeyState("CapsLock", "P")
            break
        Sleep(15)
        if (A_TickCount - startTick > HOLD_CAP_MS)
            break
    }
    heldMs := A_TickCount - startTick

    ; --- Stop recording. Re-activate first so a focus drift can't skip F14,
    ;     and send twice as cheap insurance (browser ignores the 2nd if stopped). ---
    ActivateWindow(DICT_HWND)
    Send("{F14}")
    Sleep(20)
    Send("{F14}")

    ; --- Discard accidental taps ---
    if (heldMs < MIN_HOLD) {
        Fail("Tap ignored (hold to dictate).")
        BUSY := false
        return
    }

    ; --- Wait for transcript OR failure sentinel on the clipboard ---
    if !ClipWait(CLIP_TIMEOUT, 1) {
        Fail("No transcript (timeout).")
        BUSY := false
        return
    }

    txt := A_Clipboard

    ; Browser signalled a failed / empty transcription — bail fast, don't paste.
    if (txt = SENTINEL) {
        A_Clipboard := ""
        Fail("No speech detected / transcription failed.")
        BUSY := false
        return
    }

    if STRIP_NEWLINES
        txt := RegExReplace(txt, "\R+", " ")
    txt := Trim(RegExReplace(txt, " +", " "))
    if (txt = "") {
        A_Clipboard := ""
        Fail("Empty transcript.")
        BUSY := false
        return
    }
    if TRAILING_SPACE
        txt .= " "

    A_Clipboard := txt
    ClipWait(2, 1)

    ; SUCCESS: completely silent. The browser's done-beep already told you it's
    ; ready; cleaned text is on the clipboard waiting for Ctrl+V.
    BUSY := false
}

; Shift+CapsLock toggles real caps lock if ever needed
+CapsLock::SetCapsLockState(!GetKeyState("CapsLock", "T"))

; Emergency reload (also clears a stuck BUSY state)
^!q::Reload()
