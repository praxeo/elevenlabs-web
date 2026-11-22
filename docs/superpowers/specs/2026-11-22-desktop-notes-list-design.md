# Desktop notes list: every dictation editable and extendable

2026-11-22. Short design (approved: "B, build it").

## Why

John: "the 'append to this' is always un-clickable/inactive. I should be able to add in to any prior dictation and edit them. eventually i want to have AI processing. so each one should be easily editable."

The desktop kept a note in one of three places:
- the box
- the "Last dictation" slot
- a hidden saved list

"Append to this" was disabled whenever the box held text, which is nearly always. Saved transcripts could not be added to.

The phone already has the model John wants: a list of notes, each one editable in place, each with "➕ Add to this".

## Approaches

- **A.** Patch the box and slot: make "Append to this" swap notes, and add "Add to this" to saved rows. Rejected: a note still lives in three places, and per-note AI actions would have to be built three times.
- **B (picked).** The desktop gets the phone's notes list. One visible list, one note model on both devices, one place for future AI actions.

## Design

**The list.** The desktop's primary card is now, top to bottom:
1. the record bar
2. the trace
3. the status line
4. the recovery banner
5. the **notes list**: the newest 10, then "Show N older notes"
6. the pairing row

The notes are the history entries; there is no new storage. Each card is the phone's card:
- a header with the time, "via <service>" and "edited"
- the text, editable in place: click to edit, saved on blur, Escape reverts, an empty note is refused
- the actions ➕ Add to this, Copy, Report and 🗑 (two taps)
- "Other voices were removed" when the speaker filter cut something

While a take runs, every card is locked. The phone-only parts (selecting several notes, send tags) appear only on the phone layout.

**Takes.**
- A take becomes a **new note** at the top, copied to the clipboard as now.
- **"➕ Add to this"** on any note (one-shot) makes the next take add onto that note in place. The whole note is copied and the card shows it. The status names the note: "Your next take adds to the 4:43 PM note."
- **Options → "Add each dictation to the newest note"** (the append-mode checkbox, renamed) makes every take add to the newest note in place.
- A note emptied or deleted mid-take falls back to a new note, so text is never dropped. This is the existing phone rule.

**Phone deliveries arriving on the desktop.**
- A delivery becomes a new note.
- With append mode on, it is added to the newest note in place.
- A whole-note re-send (`replace`) arrives as a new note. It never overwrites a desktop note: the desktop cannot tell which of its notes the phone meant.
- The delivery-id dedupe still runs first.

**Removed from the desktop:**

| Removed | Replaced by |
|---|---|
| the note box, its append chip, "Copy & clear", "➕ Append next", "Clear", the box's "Send to desktop" | the cards |
| the "Last dictation" slot | the cards |
| "Show saved transcripts" and the hidden list | the cards |
| "Report a mistake" above the box | each card's Report |
| "Clear history" | Diagnostics → "Delete all notes", which asks first |

**Unchanged:**
- F13/F14 and the hotkey, the clipboard, the beeps and the sentinel
- the recovery banner, the phone layout, the delivery queue
- the history storage and its trimming rules

## Not in scope

The AI actions themselves. The card's action row is where they will go.

## Tests

Scenarios 4, 17, 20, 31, 32 and 31m (the Copy label) are rewritten to the notes model:
- a new take is a new note
- Add to this adds in place
- append mode adds to the newest note
- editing a card persists
- a phone delivery lands as a note

The many "reset the box" clicks between takes go away, because every take is a new note anyway.
