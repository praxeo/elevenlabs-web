# Pare down the page: no noise gate, fewer options

2026-11-21. Short design (one PR).

## Why

John: "the gating, the bar, the endless options … its a little too much. too busy." With every section open, Options and Advanced together are about 2,500 px tall: 11 controls in Options and 14 in Advanced, most with a paragraph of explanation. John: "i dont think the gate makes much difference in real use tbh open or close", "speaker filter seems to work", "yes always dictating around other people".

## Goals

- A page with a handful of choices that matter. Anything nobody should need to change is fixed in code.
- Remove the noise gate from the recording. This also removes the 120 ms look-ahead on every release and the way quiet speech used to record as nothing.
- Other voices are handled by the speaker filter, on every device by default.

## Non-goals

- The phone notes layout, the AutoHotkey script and the pairing flow are not redesigned. They only lose duplicates.
- No settings reset: `_v9` stays. Removed settings are no longer read, and their saved values are ignored (the same precedent as the `cleanTranscript` toggles).

## Anti-goals (a failure even if it works)

- Any loud-failure guarantee weakened: the dead-mic watchdog, the corpse probe, the "MIC PRODUCED NO SIGNAL" / "VERY LOW MIC LEVEL" naming, the incomplete-transcript warning, the sentinel, the beeps.
- F13/F14, one delivery per take, or the failed-upload recording kept for Retry: any of these changed.
- A take that gets slower.

## Approaches (gate)

1. **Take the gate out of the recording (picked).** The mic is recorded as it hears you, through the gain stage and the 85 Hz high-pass filter. The look-ahead delay goes, so every take lands about 120 ms sooner. Quiet speech can no longer be cut. Cost: quiet voices in the background now reach the service, which the speaker filter answers.
2. Keep the gate in the code, but wide open and hidden. A smaller change that is easy to undo, but it leaves dead code and still leaves the look-ahead to decide.
3. Keep the gate and only hide its sliders. Keeps the 120 ms delay and the clipped-quiet-speech failure.

John chose to take it out: "i dont think the gate makes much difference", "speaker filter seems to work".

## The design

**Audio.** The recorded branch is `mic → makeup gain → high-pass → recorder`, with no gate node and no delay node. The analyser stays exactly where it is and is still read every 30 ms. The "Hearing you" light, the incomplete-transcript baseline (`lastGateOpenAtMs`, which could be renamed to "last speech"), the level trace and the low-level naming all keep working from fixed **speech-detection** thresholds that only read and never cut. My call: 0.018 to open and 0.008 to close, the iPhone values. The capture tail becomes the release tail alone, fixed at 80 ms. The iPhone level seed keeps its 3× gain and drops its gate value.

**Speaker filter.** One switch, "Filter out other speakers", on by default on every device. This drops "…also on this desktop". A desktop now sends `diarize=true` with no forced `num_speakers`, the same request the phone already sends. Single-speaker takes are unaffected: the filter does nothing when there is one voice, and when it can't tell voices apart it keeps everything and warns. My call, with the reason: you dictate around people on every device.

**Main card.**
- The "Mic level" row shrinks to the mic pill. The meter bar and its red and yellow marks go, along with the "gate" and "link" pills.
- The waveform, "Hearing you" and the timer still show while you record. The status line and window colour still show uploading and failure.
- The startup hint becomes one short line, and the outdated footer line goes.

**Options (5):** append mode, start/done beeps, the hotkey, the transcription service, and the speaker filter. Each gets one short hint line at most.

**Advanced:** mic gain, browser noise suppression, echo cancellation, the backup service, the window recording cue, and the phone layout. Each gets one short line.

**Diagnostics** (a new closed section that replaces "Last recorded audio & downloads"): upload while you dictate, the timing readout with copy and clear, and the last audio with its downloads.

**Removed. Each value is fixed in code and any saved value is ignored:**

| Removed | Fixed at |
|---|---|
| auto-copy | always on |
| gate open and close | no gate |
| gate look-ahead | none |
| release tail | 80 ms |
| high-pass | 85 Hz |
| auto gain control | off |
| tag audio events | off |
| "…also on this desktop" | filter on everywhere |

Also removed:
- the Options phone-link block: the two Pair buttons on the main card and their overlays already start, join, end and leave
- the Options "Mic tips" button: it stays on the phone layout's top row
- the "How do these settings work?" essay

## Left to the builder

- Wiring the pairing overlays so they no longer depend on the removed Options elements.
- Retiring `gateLookaheadMs` / `captureTailMs` without moving the stop timing beyond the 80 ms tail.
- Updating `tests/flow.test.mjs` in the same change:
  - scenarios 45 (no delay node, an 80 ms tail), 33 (seed without the gate) and 3b/3c (naming still right)
  - 30 and 49 (desktop diarize on by default, the new desktop request shape)
  - 31m (no auto-gain lever), 10 (no link pill)
  - the phone-link scenarios that click Options buttons: drive the main-card buttons instead
  - a new check that the removed controls are gone and the five Options are present
- Rewriting CLAUDE.md:
  - the hard invariant "The noise gate is load-bearing"
  - the audio pipeline paragraph
  - the speaker-filter text about the desktop single-speaker default
  - the tuning table rows
- README (settings and Roadmap) in the same change.

## Visual design (added 2026-11-21: "lets make it functional and beautiful")

A bedside monitor, because the job is the same: state readable at a glance from the corner of an eye, beside Cerner, on a machine with no speakers.

**Tokens**

| Token | Value | Use |
|---|---|---|
| bezel | `#1a1f24` | background |
| raised surface | `#232a31` | overlay cards, phone notes |
| glass | `#12161a` | the note, inputs, the trace |
| text | `#e8edef` | body text |
| secondary | `#8e99a1` | labels and hints |
| green | `#5fe08f` | the live trace, done |
| amber | `#f2b640` | working, check |
| red | `#ff5b52` | recording, failure |
| cyan | `#5cc6e6` | anything you can act on |

**Type.** Readouts (the record band, the timer, section names) use Bahnschrift on Windows and DIN Alternate on Apple. Both ship with the system, so nothing is downloaded; a hospital machine may block font CDNs. The note and the hints use the system UI face.

**The one bold element** is the record band:
- idle: graphite with a red dot
- recording: solid red with a stop square
- uploading: amber outline
- failed: red outline

While a take runs, a green trace sweeps across a faint grid under the band, like a monitor lead, with a large timer.

**Everything else is quiet:**
- one column, with settings as plain rows behind hairlines and a turning chevron (no boxed cards)
- sentence-case labels
- one-line hints
- the window-wide state wash is unchanged

**Rejected in self-review:** keeping the two bordered cards and only recolouring them. That is the generic dashboard kit, and it would have looked like any other settings page.
