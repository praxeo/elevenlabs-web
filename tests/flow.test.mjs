// Session-flow simulation for the embedded client app.
//
// Run from the repo root:
//   npm install --no-save jsdom jsqr
//   node tests/flow.test.mjs
//
// Renders the page through the real Worker fetch handler, boots it in jsdom
// with mocked WebSocket / fetch / audio graph / clipboard, and drives:
//   1. happy path: buffer-while-connecting, tail streaming, commit, await-final
//   2. unexpected mid-dictation disconnect (must fail loudly, keep partial text)
//   3. dead-mic flatline alarm + empty-session sentinel
//   4. append-window expiry drops stale text
//   5. connect timeout fails loudly with sentinel
//   6. PTT pressed during finalization queues a new session
//   7. configurable hotkey: tap toggles, hold is push-to-talk
//   8. engine selector: per-mode controls + persistence
//   9. batch engine happy path (no socket; upload -> clipboard)
//  10. batch upload failure -> sentinel, loud status
//  11. PTT queued during a slow batch upload
//  12. hybrid happy path: live feedback, refined text on the clipboard
//  13. hybrid refine failure: live text delivered with a warn
//  14. hybrid recovery: WS dies mid-dictation, batch refine still delivers
//  15. hybrid append parity: previous_text on the first frame, refined splice
//  16. hybrid with zero live text: refine still delivers
//  17. click-to-append: clicking the transcript box arms a one-shot append
//  18. keyterm presets: injected lists render as checkboxes, merge into both
//      APIs (custom > checked presets > always-on), dedupe, persist
//  19. phone mic session: desktop listener mirrors transcripts + delivers
//      phone_delivery to the clipboard; phone rides the session code on its
//      WS and POSTs the final text to the room
//  20. phone link resilience: session survives phone_session_end, dropped
//      listener socket reconnects loudly, replayed deliveries dedupe by id,
//      unfocused clipboard copy retries on refocus, session_end grace window
//      falls back to live text (cancelled by the real delivery), and the
//      phone treats a zero-listener deliver ack as a loud failure
//  21. SessionRoom DO contract (direct): ping/pong, listener-count ack,
//      held-delivery replay inside the window only, transcripts not buffered,
//      GET /latest for native pollers (fresh delivery vs stale null)
//  22. phone link persistence: desktop session + phone join survive reloads
//      (resume room at boot, replay deduped by the persisted delivery id,
//      Leave/End forget the stored codes)
//  23. iOS mic resilience: screen wake lock held per dictation, muted-track
//      rebuild (iOS interruptions leave tracks "live" but muted), and the
//      visibility re-warm working without the Permissions API (iOS Safari)
//  24. QR join: desktop renders a locally-encoded QR of /?join=<code> that a
//      real decoder (jsqr) reads back; opening that URL on the phone joins,
//      persists, and cleans the address bar
//  25. big-button dictation layout: joining flips it on and Leave reverts,
//      a persisted join and the /?join= boot path land straight in it, the
//      button drives the normal session paths with hotkey tap/hold semantics
//      (slide-away via the document backstop, sub-threshold pointercancel
//      stops, multi-touch ignored, a queued press cancelled/F14'd/released-
//      after-delivery never auto-starts an unheld mic), the whole-screen
//      state mirrors status/pill transitions (zero-listener relay ack and
//      relay failures redden it — even with a queued tap pending; the
//      finalize gap renders WORKING, never a stale success; the no-speech
//      sentinel outcome reads FAILED), haptics mirror the beep patterns,
//      the peek strip expands + click-to-append works, the normal settings
//      stay reachable, the per-device override persists ("never" wins over
//      a join), and a joined phone whose local clipboard is denied (iOS: no
//      write outside a gesture) defers the outcome to the relay ack instead
//      of a false copy-FAILED — while zero-listener/relay-failure/unjoined
//      outcomes stay loud failures
// (scenario 0, asserted right after boot: legacy access-code migration shim,
//  batch default engine, append-mode off by default, latest transcript
//  restored from history, and the auth section's open/collapse behavior)
//
// Exits non-zero on any failure. Extend these scenarios whenever the session
// flow, beeps, clipboard behavior, or watchdog change.

import { JSDOM } from 'jsdom';
import jsQR from 'jsqr';
import { dirname, join } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const here = dirname(fileURLToPath(import.meta.url));
const worker = await import(pathToFileURL(join(here, '..', 'worker.js')).href);
const res = await worker.default.fetch(new Request('https://dictation.test/'), {});
const html = await res.text();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
function check(name, cond, extra) {
  console.log((cond ? 'PASS' : 'FAIL') + ' - ' + name + (extra !== undefined ? '  [' + extra + ']' : ''));
  if (!cond) failures++;
}

// ---- mocks ----
const sockets = [];
class MockWS {
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.closed = false;
    sockets.push(this);
  }
  send(d) { if (this.readyState !== 1) throw new Error('not open'); this.sent.push(d); }
  close() { if (this.closed) return; this.closed = true; this.readyState = 3; if (this.onclose) this.onclose({}); }
  // test helpers
  open() { this.readyState = 1; if (this.onopen) this.onopen({}); }
  msg(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }
  serverClose() { this.readyState = 3; const wasClosed = this.closed; this.closed = true; if (!wasClosed && this.onclose) this.onclose({}); }
}
MockWS.CONNECTING = 0; MockWS.OPEN = 1; MockWS.CLOSING = 2; MockWS.CLOSED = 3;

let micRms = 0.05; // pretend speech level
let scriptNode = null;

class MockAudioCtx {
  constructor() { this.state = 'running'; this.currentTime = 0; this.sampleRate = 48000; this.destination = {}; }
  resume() { return Promise.resolve(); }
  close() { return Promise.resolve(); }
  createMediaStreamSource() { return { connect() {} }; }
  createBiquadFilter() { return { type: '', frequency: { value: 0 }, Q: { value: 0 }, connect() {} }; }
  createAnalyser() {
    return {
      fftSize: 1024,
      connect() {},
      getFloatTimeDomainData(buf) { buf.fill(micRms); },
    };
  }
  createGain() { return { gain: { value: 0, setTargetAtTime() {} }, connect() {} }; }
  createMediaStreamDestination() { return { stream: { tag: 'dest' }, connect() {} }; }
  createScriptProcessor() {
    scriptNode = { connect() {}, onaudioprocess: null };
    return scriptNode;
  }
  createOscillator() { return { frequency: { value: 0 }, connect() {}, start() {}, stop() {} }; }
}

const micTrack = { readyState: 'live', muted: false, listeners: {}, addEventListener(ev, fn) { this.listeners[ev] = fn; }, stop() { this.readyState = 'ended'; } };
const mockStream = { getAudioTracks: () => [micTrack], getTracks: () => [micTrack] };

let clipboard = '';
let gumCalls = 0;        // getUserMedia acquisitions (mic re-engagement paths)
let wakeLockCalls = 0;   // wake lock acquisitions
let activeWakeLock = null;

// Queue-driven fetch mock for the batch upload path. Each entry:
// { delayMs?, status, body }. An empty queue answers 500 so an unexpected
// upload fails the scenario loudly instead of hanging.
const fetchQueue = [];
const fetchCalls = [];

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://dictation.test/',
  beforeParse(window) {
    window.AudioContext = MockAudioCtx;
    window.WebSocket = MockWS;
    window.MediaRecorder = class {
      constructor(stream, opts) { this.state = 'inactive'; this.stream = stream; this.opts = opts; }
      static isTypeSupported() { return false; }
      start() { this.state = 'recording'; }
      stop() {
        if (this.state === 'inactive') return;
        this.state = 'inactive';
        // Deliver a plausible recording so size gates and the preview path run.
        if (this.ondataavailable) {
          this.ondataavailable({ data: new window.Blob([new Uint8Array(2048)], { type: 'audio/webm' }) });
        }
        if (this.onstop) this.onstop();
      }
    };
    window.URL.createObjectURL = () => 'blob:mock';
    window.URL.revokeObjectURL = () => {};
    window.fetch = (url, opts) => {
      fetchCalls.push({ url: String(url), opts: opts || {}, form: opts && opts.body });
      const next = fetchQueue.shift() || { status: 500, body: { error: 'unexpected fetch (queue empty)' } };
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => {
          resolve({
            ok: next.status >= 200 && next.status < 300,
            status: next.status,
            text: () => Promise.resolve(JSON.stringify(next.body)),
          });
        }, next.delayMs || 5);
        if (opts && opts.signal) {
          opts.signal.addEventListener('abort', () => {
            clearTimeout(t);
            const err = new Error('aborted');
            err.name = 'AbortError';
            reject(err);
          });
        }
      });
    };
    Object.defineProperty(window.navigator, 'mediaDevices', {
      value: { getUserMedia: () => { gumCalls++; return Promise.resolve(mockStream); }, addEventListener() {} },
      configurable: true,
    });
    Object.defineProperty(window.navigator, 'wakeLock', {
      value: { request: () => { wakeLockCalls++; activeWakeLock = { release() { activeWakeLock = null; return Promise.resolve(); } }; return Promise.resolve(activeWakeLock); } },
      configurable: true,
    });
    Object.defineProperty(window.navigator, 'permissions', {
      value: { query: () => Promise.resolve({ state: 'granted' }) }, // warm mic on load
      configurable: true,
    });
    Object.defineProperty(window.navigator, 'clipboard', {
      value: { writeText(t) { clipboard = t; return Promise.resolve(); } },
      configurable: true,
    });
    Object.defineProperty(window, 'isSecureContext', { value: true, configurable: true });
    // Scenario 0 seed: a pre-merge batch-app user with a remembered access
    // code under the legacy key. The page must surface it as the passphrase.
    window.localStorage.setItem('scribe_v2_settings_v9', JSON.stringify({ saveApiKey: true }));
    window.localStorage.setItem('scribe_v2_access_code_v9', 'legacy-code');
    // Scenario 0 seed: a saved transcript — the boot must restore it into the
    // latest-transcript box (most recent note visible after a reload).
    window.localStorage.setItem('scribe_v2_transcripts_v9', JSON.stringify([
      { text: 'Restored note. ', createdAt: new Date().toISOString(), engine: 'batch' },
    ]));
    window.addEventListener('error', (e) => { console.log('PAGE ERROR:', e.message); failures++; });
  },
});

const w = dom.window;
const doc = w.document;
const status = () => doc.getElementById('status').textContent.trim();
const statusCls = () => doc.getElementById('status').className;
const latest = () => doc.getElementById('latest').textContent;
const pump = (n = 3) => { // fire onaudioprocess n times (~85ms of audio each)
  for (let i = 0; i < n; i++) {
    scriptNode.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.05) } });
  }
};

await sleep(200);

// ===== Scenario 0: boot state — migration shim + defaults + restore =====
console.log('--- scenario 0: boot migration + defaults + restore ---');
check('legacy access code surfaced as passphrase', doc.getElementById('passphrase').value === 'legacy-code', JSON.stringify(doc.getElementById('passphrase').value));
check('default engine is batch', doc.getElementById('engBatch').className.includes('active'));
check('append mode unchecked by default', !doc.getElementById('appendMode').checked);
check('latest transcript restored from history on boot', latest().includes('Restored note.'), latest());
check('auth section open while credentials are missing', doc.getElementById('authSection').open === true);
check('auth summary prompts for the key', doc.getElementById('authSummary').textContent.includes('enter'), doc.getElementById('authSummary').textContent);

doc.getElementById('apiKey').value = 'test-key';
doc.getElementById('sonioxKey').value = 'test-skey';
doc.getElementById('apiKey').dispatchEvent(new w.Event('change', { bubbles: true }));
check('auth section collapses once a key is entered', doc.getElementById('authSection').open === false);
check('auth summary shows the key is set', doc.getElementById('authSummary').textContent.includes('✓'), doc.getElementById('authSummary').textContent);

// Scenarios 1–7 exercise the realtime engine and append-mode-on behavior
// explicitly (both defaults now differ); the engine scenarios below switch
// modes themselves, and scenario 17 covers the append-off default.
doc.getElementById('engRealtime').click();
doc.getElementById('appendMode').click();
check('append mode toggled on for the legacy scenarios', doc.getElementById('appendMode').checked);
doc.getElementById('freshBtn').click(); // clear the restored note so scenario 1 starts fresh

// ===== Scenario 1: happy path with slow connect (pre-roll + buffer + flush), tail, commit, final =====
console.log('--- scenario 1: happy path ---');
check('mic warmed on load (pre-roll possible)', scriptNode !== null);
pump(3); // speaking as/just before the key lands -> pre-roll ring, not discarded
doc.getElementById('recordBtn').click();
await sleep(150);
const s1 = sockets[0];
check('socket created, still connecting', s1 && s1.readyState === 0);
check('realtime socket carries keyterms (Soniox context terms)', typeof new URL(s1.url).searchParams.get('keyterms_json') === 'string', s1.url);
pump(4); // speak while connecting
check('no frames sent while connecting', s1.sent.length === 0);
s1.open();
await sleep(30);
check('pre-roll + buffered frames flushed on open', s1.sent.length === 7, s1.sent.length);
check('status shows live', status().includes('transcribing live'), status());
s1.msg({ message_type: 'session_started', session_id: 'sess-1', config: { tier: 'medical' } });
check('session_started surfaces the realtime config tier', status().includes('(medical)'), status());
check('link pill LIVE', doc.getElementById('linkPill').textContent === 'LIVE');
check('mic pill REC', doc.getElementById('micPill').textContent === 'REC');
s1.msg({ message_type: 'partial_transcript', text: 'patient presents' });
s1.msg({ message_type: 'committed_transcript', text: 'Patient presents with... ascites.' }); // pause artifact
check('committed text displayed, ellipsis stripped', latest().includes('Patient presents with ascites.'), latest());

// stop (PTT release) — audio must keep flowing during the tail
const sentBeforeStop = s1.sent.length;
doc.getElementById('recordBtn').click();
check('finalizing status', status().includes('Finalizing'), status());
pump(3); // trailing speech during tail window
check('tail audio still streams after stop', s1.sent.length === sentBeforeStop + 3, s1.sent.length - sentBeforeStop);
// Anti-clipping backstop: a trailing partial during the (now-shorter, 250ms) tail
// must still render — partials are never discarded at shutdown (the rescue if the
// final commit reply never arrives). The committed below clears this transient.
s1.msg({ message_type: 'partial_transcript', text: 'trailing tail words' });
check('trailing partial during tail is retained', latest().includes('trailing tail words'), latest());
await sleep(700); // > TAIL_MS
const commitFrames = s1.sent.filter((d) => JSON.parse(d).commit === true);
check('commit frame sent after tail', commitFrames.length === 1);
pump(2);
check('no audio after commit phase', s1.sent.filter((d) => !JSON.parse(d).commit).length === sentBeforeStop + 3);
// server returns the final commit for the trailing words (unicode pause artifact)
s1.msg({ message_type: 'committed_transcript', text: 'Last words… intact.' });
await sleep(500); // > COMMIT_QUIET_MS
check('socket closed after quiet period', s1.closed);
check('final text includes trailing commit', latest().includes('Last words intact.'), latest());
check('success status', status().includes('Done!'), status());
check('clipboard holds full text', clipboard.includes('Patient presents with ascites.') && clipboard.includes('Last words intact.'), JSON.stringify(clipboard));
check('no ellipses reach the clipboard', !clipboard.includes('...') && !clipboard.includes('…'), JSON.stringify(clipboard));
check('append chip visible + appending', doc.getElementById('appendChip').textContent.includes('append'), doc.getElementById('appendChip').textContent);
const frames1 = s1.sent.map((d) => JSON.parse(d));
check('every frame carries sample_rate 16000 + boolean commit', frames1.every((f) => f.sample_rate === 16000 && typeof f.commit === 'boolean'), frames1.length + ' frames');
check('fresh note sends no previous_text', frames1.every((f) => !('previous_text' in f)));

// ===== Scenario 2: append within window, then unexpected mid-dictation disconnect =====
console.log('--- scenario 2: unexpected disconnect ---');
doc.getElementById('recordBtn').click();
await sleep(80);
const s2 = sockets[1];
s2.open();
await sleep(30);
pump(2); // speak: frames should now carry the append context on the first one only
const f2 = s2.sent.map((d) => JSON.parse(d));
check('append session: first frame carries previous_text tail', f2.length >= 2 && typeof f2[0].previous_text === 'string' && f2[0].previous_text.endsWith('Last words intact.'), JSON.stringify(f2[0] && f2[0].previous_text));
check('previous_text only on the first frame', f2.slice(1).every((f) => !('previous_text' in f)));
s2.msg({ message_type: 'committed_transcript', text: 'More findings.' });
check('append mode kept earlier text', latest().includes('Last words intact.') && latest().includes('More findings.'), latest());
s2.msg({ message_type: 'auth_error', error: 'invalid key' });
check('non-generic error frame surfaces loudly', statusCls().includes('err') && status().includes('auth_error: invalid key'), status());
s2.serverClose(); // dies mid-dictation, no user stop
await sleep(100);
check('unexpected close -> error status', statusCls().includes('err') && status().includes('Connection lost'), status());
check('partial copied to clipboard anyway', clipboard.includes('More findings.'));
check('link pill FAIL', doc.getElementById('linkPill').textContent === 'LINK FAIL');

// ===== Scenario 3: dead mic flatline alarm =====
console.log('--- scenario 3: dead mic alarm ---');
doc.getElementById('freshBtn').click(); // empty buffer so the sentinel path is hit
micRms = 0.0; // flatline
doc.getElementById('recordBtn').click();
await sleep(80);
const s3 = sockets[2];
s3.open();
await sleep(2800); // > 2.5s flatline detection
check('mic alarm fired', status().includes('MIC NOT CAPTURING'), status());
check('mic pill FAIL', doc.getElementById('micPill').textContent === 'MIC FAIL');
doc.getElementById('recordBtn').click();
await sleep(700);
await sleep(2700); // FINAL_WAIT deadline, no commits coming
check('finalize after deadline with no text -> sentinel', clipboard === '##DICTATION_FAILED##', JSON.stringify(clipboard));
check('no-speech status mentions mic', status().includes('microphone never produced a signal'), status());
micRms = 0.05;

// ===== Scenario 4: append window expiry starts fresh =====
console.log('--- scenario 4: append window expiry ---');
doc.getElementById('appendWindow').value = '1'; // 1 second window
doc.getElementById('recordBtn').click();
await sleep(80);
const s4 = sockets[3];
s4.open();
s4.msg({ message_type: 'committed_transcript', text: 'First note.' });
doc.getElementById('recordBtn').click();
await sleep(700);
s4.msg({ message_type: 'committed_transcript', text: '' });
await sleep(500);
check('note saved', clipboard.includes('First note.'), JSON.stringify(clipboard));
await sleep(1300); // exceed 1s append window
doc.getElementById('recordBtn').click();
await sleep(80);
const s5 = sockets[4];
s5.open();
s5.msg({ message_type: 'partial_transcript', text: 'Second note' });
check('window expired -> old text dropped', !latest().includes('First note.') && latest().includes('Second note'), latest());
doc.getElementById('recordBtn').click();
await sleep(3300);

// ===== Scenario 5: connect timeout fails loudly =====
console.log('--- scenario 5: connect timeout ---');
doc.getElementById('freshBtn').click();
doc.getElementById('recordBtn').click();
await sleep(120);
check('recording started (connecting)', doc.getElementById('recordBtn').textContent.includes('Stop'));
await sleep(5300); // CONNECT_TIMEOUT_MS
check('timeout -> failed status', statusCls().includes('err') && status().includes('FAILED'), status());
check('sentinel on clipboard', clipboard === '##DICTATION_FAILED##');
check('record button reset', doc.getElementById('recordBtn').textContent.includes('Start'));

// ===== Scenario 6: F13 during finalization queues a new dictation =====
console.log('--- scenario 6: queued PTT restart ---');
doc.getElementById('recordBtn').click();
await sleep(80);
const s7 = sockets[sockets.length - 1];
s7.open();
s7.msg({ message_type: 'committed_transcript', text: 'Quick one.' });
doc.getElementById('recordBtn').click(); // stop -> finalizing
doc.dispatchEvent(new w.KeyboardEvent('keydown', { code: 'F13' })); // PTT again immediately
await sleep(700);
s7.msg({ message_type: 'committed_transcript', text: '' });
await sleep(600);
const sCount = sockets.length;
await sleep(300);
check('pending start spawned a new session', sockets.length === sCount + 1 || doc.getElementById('recordBtn').textContent.includes('Stop'), 'sockets=' + sockets.length);

// ===== Scenario 7: configurable hotkey (default Ctrl+Space) =====
console.log('--- scenario 7: hotkey tap + hold ---');
// clean up whatever scenario 6 left running (its socket never opens -> connect timeout)
if (doc.getElementById('recordBtn').textContent.includes('Stop')) {
  doc.getElementById('recordBtn').click();
  await sleep(6500);
}
check('idle before hotkey tests', doc.getElementById('recordBtn').textContent.includes('Start'));
const kd = (init) => doc.dispatchEvent(new w.KeyboardEvent('keydown', init));
const ku = (init) => doc.dispatchEvent(new w.KeyboardEvent('keyup', init));

// tap = toggle on
const sBeforeHk = sockets.length;
kd({ code: 'Space', ctrlKey: true });
await sleep(80);
ku({ code: 'Space', ctrlKey: true }); // released quickly -> tap
await sleep(80);
check('hotkey tap started recording', doc.getElementById('recordBtn').textContent.includes('Stop'));
check('hotkey opened a new socket', sockets.length === sBeforeHk + 1, sockets.length - sBeforeHk);
const hk1 = sockets[sockets.length - 1];
hk1.open();
hk1.msg({ message_type: 'committed_transcript', text: 'Hotkey tap note.' });
// tap again = toggle off
kd({ code: 'Space', ctrlKey: true });
ku({ code: 'Space', ctrlKey: true });
await sleep(700);
hk1.msg({ message_type: 'committed_transcript', text: '' });
await sleep(500);
check('hotkey tap-off saved + copied', clipboard.includes('Hotkey tap note.'), JSON.stringify(clipboard));

// hold = push-to-talk
kd({ code: 'Space', ctrlKey: true });
await sleep(600); // > HOTKEY_TAP_MS
const hk2 = sockets[sockets.length - 1];
hk2.open();
hk2.msg({ message_type: 'committed_transcript', text: 'Hotkey held note.' });
ku({ code: 'Space', ctrlKey: true }); // release after holding -> stop
await sleep(80);
check('hotkey release began finalizing', status().includes('Finalizing'), status());
await sleep(700);
hk2.msg({ message_type: 'committed_transcript', text: '' });
await sleep(500);
check('hotkey hold note saved + copied', clipboard.includes('Hotkey held note.'), JSON.stringify(clipboard));
check('plain Space does nothing', (() => { kd({ code: 'Space' }); return doc.getElementById('recordBtn').textContent.includes('Start'); })());

// ===== Scenario 8: engine selector — per-mode controls + persistence =====
console.log('--- scenario 8: engine selector ---');
doc.getElementById('engBatch').click();
check('batch button active', doc.getElementById('engBatch').className.includes('active'));
check('vad section hidden in batch mode', doc.getElementById('vadSection').style.display === 'none');
check('batch opts visible in batch mode', doc.getElementById('batchOptsSection').style.display !== 'none');
check('gate hint says gate is the recording', doc.getElementById('gateHint').textContent.includes('IS the recording'), doc.getElementById('gateHint').textContent);
await sleep(400); // debounced settings save
check('engine persisted to settings', JSON.parse(w.localStorage.getItem('scribe_v2_settings_v9')).engine === 'batch');
doc.getElementById('engRealtime').click();
check('vad section back in realtime mode', doc.getElementById('vadSection').style.display !== 'none');
check('batch opts hidden in realtime mode', doc.getElementById('batchOptsSection').style.display === 'none');
doc.getElementById('engBatch').click();

// ===== Scenario 9: batch engine happy path =====
console.log('--- scenario 9: batch happy path ---');
doc.getElementById('freshBtn').click();
const sCountBatch = sockets.length;
const fCountBatch = fetchCalls.length;
fetchQueue.push({ status: 200, body: { text: 'Batch note dictated.' } });
doc.getElementById('recordBtn').click();
await sleep(120);
check('batch recording started', doc.getElementById('recordBtn').textContent.includes('Stop'));
check('batch status mentions upload-on-release', status().includes('release to upload'), status());
doc.getElementById('recordBtn').click(); // stop -> recorder flush -> upload
await sleep(300);
check('no WebSocket opened in batch mode', sockets.length === sCountBatch, sockets.length - sCountBatch);
check('exactly one upload', fetchCalls.length === fCountBatch + 1, fetchCalls.length - fCountBatch);
const upload = fetchCalls[fetchCalls.length - 1];
check('upload went to /api/transcribe via POST', upload.url.includes('/api/transcribe') && upload.opts.method === 'POST');
check('upload form carries api key + keyterms + tag_audio_events + file',
  upload.form && upload.form.get('api_key') === 'test-key' &&
  typeof upload.form.get('keyterms_json') === 'string' &&
  upload.form.get('tag_audio_events') === 'false' &&
  upload.form.get('file') !== null);
check('batch text displayed', latest().includes('Batch note dictated.'), latest());
check('batch text on clipboard', clipboard.includes('Batch note dictated.'), JSON.stringify(clipboard));
check('batch success status', status().includes('Done!'), status());
const hist9 = JSON.parse(w.localStorage.getItem('scribe_v2_transcripts_v9'));
check('history entry tagged engine batch', hist9[0] && hist9[0].engine === 'batch', hist9[0] && hist9[0].engine);
check('record button reset after batch', doc.getElementById('recordBtn').textContent.includes('Start'));
check('link pill idle after batch', doc.getElementById('linkPill').textContent === 'link idle');

// ===== Scenario 10: batch upload failure -> sentinel =====
console.log('--- scenario 10: batch upload failure ---');
doc.getElementById('freshBtn').click();
fetchQueue.push({ status: 500, body: { error: 'service exploded' } });
doc.getElementById('recordBtn').click();
await sleep(120);
doc.getElementById('recordBtn').click();
await sleep(300);
check('upload failure -> sentinel on clipboard', clipboard === '##DICTATION_FAILED##', JSON.stringify(clipboard));
check('upload failure -> loud err status', statusCls().includes('err') && status().includes('FAILED'), status());
check('upload failure surfaces the server error', status().includes('service exploded'), status());
check('link pill FAIL after failed upload', doc.getElementById('linkPill').textContent === 'LINK FAIL');
check('record button reset after failure', doc.getElementById('recordBtn').textContent.includes('Start'));

// ===== Scenario 11: PTT queued during a slow batch upload =====
console.log('--- scenario 11: batch queued PTT ---');
doc.getElementById('freshBtn').click();
fetchQueue.push({ delayMs: 800, status: 200, body: { text: 'Slow upload note.' } });
doc.getElementById('recordBtn').click();
await sleep(120);
doc.getElementById('recordBtn').click(); // stop -> slow upload starts
await sleep(120);
doc.dispatchEvent(new w.KeyboardEvent('keydown', { code: 'F13' })); // PTT during upload
check('still uploading when PTT queued', doc.getElementById('linkPill').textContent === 'uploading…', doc.getElementById('linkPill').textContent);
await sleep(1100); // upload resolves, queued session starts (~60ms later)
check('slow upload delivered', clipboard.includes('Slow upload note.'), JSON.stringify(clipboard));
check('queued PTT started the next batch session', doc.getElementById('recordBtn').textContent.includes('Stop'));
fetchQueue.push({ status: 200, body: { text: 'Second.' } });
doc.getElementById('recordBtn').click(); // wrap up the queued session
await sleep(300);
check('queued session delivered too', clipboard.includes('Second.'), JSON.stringify(clipboard));

// ===== Scenario 12: hybrid happy path — live feedback, refined clipboard =====
console.log('--- scenario 12: hybrid happy path ---');
doc.getElementById('engHybrid').click();
doc.getElementById('freshBtn').click();
const fCount12 = fetchCalls.length;
fetchQueue.push({ delayMs: 400, status: 200, body: { text: 'Refined note text.' } });
pump(2); // speaking as the key lands -> pre-roll
doc.getElementById('recordBtn').click();
await sleep(120);
const s12 = sockets[sockets.length - 1];
s12.open();
await sleep(30);
pump(6); // live speech (with pre-roll: 8 frames ≈ 0.7s, above the refine minimum)
s12.msg({ message_type: 'partial_transcript', text: 'live partial words' });
check('hybrid shows live partials', latest().includes('live partial words'), latest());
s12.msg({ message_type: 'committed_transcript', text: 'Live committed words.' });
doc.getElementById('recordBtn').click(); // stop -> tail (250ms) -> HYBRID FAST FINALIZE
// Hybrid no longer blocks the batch refine on the realtime engine's finalize
// (the old await-final + commit-quiet wait): sessionPcm is complete after the
// tail, so the refine begins as soon as TAIL_MS elapses.
await sleep(400); // tail done (250ms); refine in flight (fetch delayMs 400, resolves ~650ms after stop)
check('refining status shown', status().includes('Refining via batch'), status());
check('link pill refining', doc.getElementById('linkPill').textContent === 'refining…', doc.getElementById('linkPill').textContent);
await sleep(450); // refine resolves (~650ms after stop) and delivers
check('exactly one refine upload', fetchCalls.length === fCount12 + 1, fetchCalls.length - fCount12);
const refineCall = fetchCalls[fetchCalls.length - 1];
const refineFile = refineCall.form && refineCall.form.get('file');
check('refine uploaded a wav file', refineFile && refineFile.name === 'recording.wav', refineFile && refineFile.name);
check('clipboard holds the REFINED text', clipboard.includes('Refined note text.'), JSON.stringify(clipboard));
check('clipboard does not hold the live text', !clipboard.includes('Live committed words.'), JSON.stringify(clipboard));
check('box swapped to refined text', latest().includes('Refined note text.') && !latest().includes('Live committed words.'), latest());
check('refined success status', status().includes('Refined transcript') && status().includes('Done!'), status());
const hist12 = JSON.parse(w.localStorage.getItem('scribe_v2_transcripts_v9'));
check('history entry engine hybrid, live text kept for comparison',
  hist12[0] && hist12[0].engine === 'hybrid' && typeof hist12[0].liveText === 'string' && hist12[0].liveText.includes('Live committed words.'),
  hist12[0] && (hist12[0].engine + ' / ' + JSON.stringify(hist12[0].liveText)));
check('link pill idle after refine', doc.getElementById('linkPill').textContent === 'link idle');

// ===== Scenario 13: hybrid refine failure -> live text + audible warn =====
console.log('--- scenario 13: hybrid refine failure ---');
doc.getElementById('freshBtn').click();
fetchQueue.push({ status: 500, body: { error: 'refine exploded' } });
doc.getElementById('recordBtn').click();
await sleep(120);
const s13 = sockets[sockets.length - 1];
s13.open();
await sleep(30);
pump(8);
s13.msg({ message_type: 'committed_transcript', text: 'Live survives.' });
doc.getElementById('recordBtn').click();
await sleep(700);
s13.msg({ message_type: 'committed_transcript', text: '' });
await sleep(700);
check('live text delivered when refine fails', clipboard.includes('Live survives.'), JSON.stringify(clipboard));
check('warn status names the refine failure', statusCls().includes('warn') && status().includes('refine failed') && status().includes('refine exploded'), status());
check('not reported as a clean Done', !status().includes('Done!'), status());

// ===== Scenario 14: hybrid recovery — WS dies, batch refine still delivers =====
console.log('--- scenario 14: hybrid WS-death recovery ---');
doc.getElementById('freshBtn').click();
fetchQueue.push({ status: 200, body: { text: 'Recovered full text.' } });
doc.getElementById('recordBtn').click();
await sleep(120);
const s14 = sockets[sockets.length - 1];
s14.open();
await sleep(30);
pump(8);
s14.msg({ message_type: 'partial_transcript', text: 'doomed partial' });
s14.serverClose(); // link dies mid-dictation — no user stop
await sleep(700);
check('refine ran despite the dead link', clipboard.includes('Recovered full text.'), JSON.stringify(clipboard));
check('recovery framed as a failure to verify', statusCls().includes('err') && status().includes('recovered via batch'), status());

// ===== Scenario 15: hybrid append parity =====
console.log('--- scenario 15: hybrid append parity ---');
doc.getElementById('freshBtn').click();
doc.getElementById('appendWindow').value = '0'; // 0 = always append
fetchQueue.push({ status: 200, body: { text: 'Part one.' } });
doc.getElementById('recordBtn').click();
await sleep(120);
const s15a = sockets[sockets.length - 1];
s15a.open();
await sleep(30);
pump(8);
doc.getElementById('recordBtn').click();
await sleep(700);
s15a.msg({ message_type: 'committed_transcript', text: '' });
await sleep(700);
check('first hybrid note delivered', clipboard.includes('Part one.'), JSON.stringify(clipboard));
fetchQueue.push({ status: 200, body: { text: 'Part two.' } });
doc.getElementById('recordBtn').click();
await sleep(120);
const s15b = sockets[sockets.length - 1];
s15b.open();
await sleep(30);
pump(8);
const f15 = s15b.sent.map((d) => JSON.parse(d));
check('append session: first frame carries refined previous_text', f15.length >= 1 && typeof f15[0].previous_text === 'string' && f15[0].previous_text.endsWith('Part one.'), JSON.stringify(f15[0] && f15[0].previous_text));
doc.getElementById('recordBtn').click();
await sleep(700);
s15b.msg({ message_type: 'committed_transcript', text: '' });
await sleep(700);
check('refined splice keeps the note base', clipboard.includes('Part one.') && clipboard.includes('Part two.'), JSON.stringify(clipboard));

// ===== Scenario 16: hybrid with zero live text — refine still delivers =====
console.log('--- scenario 16: hybrid no live text ---');
doc.getElementById('freshBtn').click();
doc.getElementById('appendWindow').value = '1';
await sleep(1300); // let the append window lapse so this note starts fresh
fetchQueue.push({ status: 200, body: { text: 'Only batch heard this.' } });
doc.getElementById('recordBtn').click();
await sleep(120);
const s16 = sockets[sockets.length - 1];
s16.open();
await sleep(30);
pump(8); // audio flows but the server never sends a transcript
doc.getElementById('recordBtn').click();
await sleep(700);  // tail + commit
await sleep(2700); // FINAL_WAIT deadline passes with no reply
await sleep(300);  // refine resolves
check('refine delivered text the live engine missed', clipboard.includes('Only batch heard this.'), JSON.stringify(clipboard));
check('treated as a clean refined success', status().includes('Refined transcript') && status().includes('Done!'), status());

// ===== Scenario 17: click-to-append — clicking the box arms a one-shot append =====
console.log('--- scenario 17: click-to-append ---');
doc.getElementById('engBatch').click();
doc.getElementById('appendMode').click(); // back OFF — the shipped default
check('append mode off again', !doc.getElementById('appendMode').checked);
doc.getElementById('freshBtn').click();
fetchQueue.push({ status: 200, body: { text: 'Alpha.' } });
doc.getElementById('recordBtn').click();
await sleep(120);
doc.getElementById('recordBtn').click();
await sleep(300);
check('base note delivered', clipboard.includes('Alpha.'), JSON.stringify(clipboard));
check('chip hidden with append mode off', doc.getElementById('appendChip').style.display === 'none');

doc.getElementById('latest').click(); // arm: next dictation appends
check('box click arms the append chip',
  doc.getElementById('appendChip').style.display !== 'none' &&
  doc.getElementById('appendChip').textContent.includes('append'),
  doc.getElementById('appendChip').textContent);
check('box highlighted while armed', doc.getElementById('latest').className.includes('armed'));
doc.getElementById('latest').click(); // second click cancels
check('second click disarms', doc.getElementById('appendChip').style.display === 'none');
doc.getElementById('latest').click(); // re-arm for the real run

fetchQueue.push({ status: 200, body: { text: 'Beta.' } });
doc.getElementById('recordBtn').click();
await sleep(120);
doc.getElementById('recordBtn').click();
await sleep(300);
check('armed dictation appended onto the note', clipboard.includes('Alpha.') && clipboard.includes('Beta.'), JSON.stringify(clipboard));

fetchQueue.push({ status: 200, body: { text: 'Gamma.' } });
doc.getElementById('recordBtn').click();
await sleep(120);
doc.getElementById('recordBtn').click();
await sleep(300);
check('arm is one-shot: the following dictation starts fresh', clipboard.includes('Gamma.') && !clipboard.includes('Beta.'), JSON.stringify(clipboard));

// ===== Scenario 18: keyterm presets — injected lists, merge, dedupe, persistence =====
console.log('--- scenario 18: keyterm presets ---');
// Recover the injected preset definitions from the served page so these
// assertions track whatever lists the deployer curates (no hardcoded terms).
const presetSrc = html.match(/const KEYTERM_PRESETS\s*=\s*\((.*)\);/);
check('preset definitions injected into the page', !!presetSrc);
const PRESETS = JSON.parse(presetSrc[1]);
const alwaysTerms = PRESETS.filter((p) => p.always).flatMap((p) => p.terms);
const rtEligible = (t) => t.length <= 20 && t.split(' ').length <= 5;
const rtAlways = alwaysTerms.filter(rtEligible);
const optional = PRESETS.filter((p) => !p.always);
check('ships an always-on list and at least one optional preset', rtAlways.length > 0 && optional.length > 0);
const preset1 = optional[0];
const p1Term = preset1.terms.find((t) => rtEligible(t) && !alwaysTerms.includes(t));
check('optional preset has a realtime-eligible distinct term', typeof p1Term === 'string', p1Term);
check('one checkbox per optional preset, none for always-on lists',
  doc.querySelectorAll('#presetRow input[data-preset]').length === optional.length,
  doc.querySelectorAll('#presetRow input[data-preset]').length);

// Leg A (realtime, unchecked): always-on terms ride, preset terms do not,
// custom terms lead the merged list.
doc.getElementById('engRealtime').click();
doc.getElementById('freshBtn').click();
doc.getElementById('keyterms').value = 'zebraterm';
doc.getElementById('recordBtn').click();
await sleep(120);
const s18a = sockets[sockets.length - 1];
const ktA = JSON.parse(new URL(s18a.url).searchParams.get('keyterms_json'));
check('custom term leads the merged list', ktA[0] === 'zebraterm', JSON.stringify(ktA[0]));
check('always-on terms ride with presets unchecked', rtAlways.every((t) => ktA.includes(t)), ktA.length + ' terms');
check('unchecked preset terms are not sent', !ktA.includes(p1Term));
s18a.open();
await sleep(30);
s18a.msg({ message_type: 'committed_transcript', text: 'Preset leg A.' });
doc.getElementById('recordBtn').click();
await sleep(700);
s18a.msg({ message_type: 'committed_transcript', text: '' });
await sleep(500);
check('leg A delivered normally', clipboard.includes('Preset leg A.'), JSON.stringify(clipboard));

// Check the first optional preset; the choice must persist in settings.
const p1Box = doc.querySelector('input[data-preset="' + preset1.id + '"]');
p1Box.click();
await sleep(400); // debounced settings save
const s18Settings = JSON.parse(w.localStorage.getItem('scribe_v2_settings_v9'));
check('checked preset id persisted in settings (additive v9 field)',
  Array.isArray(s18Settings.presetIds) && s18Settings.presetIds.includes(preset1.id),
  JSON.stringify(s18Settings.presetIds));

// Leg B (realtime, checked): preset terms ride; a custom dupe of a preset
// term is sent exactly once; the realtime cap holds.
doc.getElementById('freshBtn').click();
doc.getElementById('keyterms').value = 'zebraterm\n' + p1Term;
doc.getElementById('recordBtn').click();
await sleep(120);
const s18b = sockets[sockets.length - 1];
const ktB = JSON.parse(new URL(s18b.url).searchParams.get('keyterms_json'));
check('checked preset terms ride the realtime call',
  preset1.terms.filter(rtEligible).slice(0, 5).every((t) => ktB.includes(t)), ktB.length + ' terms');
check('term duplicated between custom box and preset sent once',
  ktB.filter((t) => t.toLowerCase() === p1Term.toLowerCase()).length === 1);
// Default transport is Soniox (large context budget) -> client sends the fuller
// list (<=300, char-budget-guarded server-side); only ?rt=el uses the 50/20 cap.
check('realtime keyterm cap respected (Soniox default, <=300)', ktB.length <= 300, ktB.length);
s18b.open();
await sleep(30);
s18b.msg({ message_type: 'committed_transcript', text: 'Preset leg B.' });
doc.getElementById('recordBtn').click();
await sleep(700);
s18b.msg({ message_type: 'committed_transcript', text: '' });
await sleep(500);
check('leg B delivered normally', clipboard.includes('Preset leg B.'), JSON.stringify(clipboard));

// Leg C (batch, checked): the upload form carries the full preset list —
// including terms too long for realtime — plus the always-on list.
doc.getElementById('engBatch').click();
doc.getElementById('freshBtn').click();
fetchQueue.push({ status: 200, body: { text: 'Preset leg C.' } });
doc.getElementById('recordBtn').click();
await sleep(120);
doc.getElementById('recordBtn').click();
await sleep(300);
const ktC = JSON.parse(fetchCalls[fetchCalls.length - 1].form.get('keyterms_json'));
check('batch call carries the full checked preset list', preset1.terms.every((t) => ktC.includes(t)), ktC.length + ' terms');
check('batch call carries the always-on list', alwaysTerms.every((t) => ktC.includes(t)));

// Leg D (batch, unchecked again): preset terms vanish, always-on terms remain
// even with the custom box empty.
p1Box.click();
doc.getElementById('keyterms').value = '';
doc.getElementById('freshBtn').click();
fetchQueue.push({ status: 200, body: { text: 'Preset leg D.' } });
doc.getElementById('recordBtn').click();
await sleep(120);
doc.getElementById('recordBtn').click();
await sleep(300);
const ktD = JSON.parse(fetchCalls[fetchCalls.length - 1].form.get('keyterms_json'));
check('unchecking removes preset terms from the next call', !ktD.includes(p1Term));
check('always-on terms survive with box empty and nothing checked', alwaysTerms.every((t) => ktD.includes(t)), ktD.length + ' terms');

// ===== Scenario 19: phone mic session =====
console.log('--- scenario 19: phone mic session ---');
{
  // Fresh boot so session state is clean
  const socks19 = [];
  const fetchCalls19 = [];
  let w19;
  const dom19 = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://dictation.test/',
    beforeParse(win) {
      w19 = win;
      win.isSecureContext = true;
      win.navigator.clipboard = { writeText: (t) => { win._clip = t; return Promise.resolve(); } };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.AudioContext = MockAudioCtx;
      win.navigator.mediaDevices = { getUserMedia: () => Promise.resolve({ getTracks: () => [{ readyState: 'live', stop() {}, addEventListener() {} }], getAudioTracks: () => [{ readyState: 'live', enabled: true, stop() {}, addEventListener() {} }] }), addEventListener: () => {} };
      win.fetch = (url, opts) => { fetchCalls19.push({ url: String(url), opts }); return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ text: 'Phone hello.' }) }); };
      win.MediaRecorder = class { constructor(s) { this.state = 'inactive'; } static isTypeSupported() { return false; } start() { this.state = 'recording'; } stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.onstop) this.onstop(); } };
      const SockClass = class extends MockWS { constructor(url) { super(url); socks19.push(this); } };
      SockClass.CONNECTING = 0; SockClass.OPEN = 1; SockClass.CLOSING = 2; SockClass.CLOSED = 3;
      win.WebSocket = SockClass;
    },
  });
  await sleep(80);
  const doc19 = dom19.window.document;

  // ---- Part A: desktop starts a phone session ----
  const startBtn = doc19.getElementById('phoneStartBtn');
  check('phoneStartBtn exists', !!startBtn);
  if (startBtn) startBtn.click();
  await sleep(20);
  // A WebSocket should have been opened to /api/session/...
  const sessionSock = socks19.find((s) => s.url.includes('/api/session/'));
  check('desktop opens session listener WebSocket', !!sessionSock);

  if (sessionSock) {
    // Simulate phone sending a partial then committed transcript then phone_delivery
    sessionSock.open();
    sessionSock.msg({ message_type: 'partial_transcript', transcript: 'Hello' });
    await sleep(10);
    const latestEl19 = doc19.getElementById('latest');
    check('desktop shows partial from phone', (latestEl19.textContent || '').includes('Hello'));

    sessionSock.msg({ message_type: 'committed_transcript', transcript: 'Hello world.' });
    await sleep(10);
    check('desktop shows committed from phone', (latestEl19.textContent || '').includes('Hello world'));

    sessionSock.msg({ message_type: 'phone_delivery', text: 'Hello world.' });
    await sleep(30);
    check('desktop clipboard gets phone delivery', (w19._clip || '').includes('Hello world'));
  }

  // ---- Part B: phone side — joinedSessionCode appended to WS URL ----
  const socks19b = [];
  const fetchCalls19b = [];
  const dom19b = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://dictation.test/',
    beforeParse(win) {
      win.isSecureContext = true;
      win.navigator.clipboard = { writeText: (t) => { win._clip = t; return Promise.resolve(); } };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.AudioContext = MockAudioCtx;
      win.navigator.mediaDevices = { getUserMedia: () => Promise.resolve({ getTracks: () => [{ readyState: 'live', stop() {}, addEventListener() {} }], getAudioTracks: () => [{ readyState: 'live', enabled: true, stop() {}, addEventListener() {} }] }), addEventListener: () => {} };
      win.fetch = (url, opts) => { fetchCalls19b.push({ url: String(url), opts }); return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true,"listeners":1}'), json: () => Promise.resolve({ text: 'Phone realtime.' }) }); };
      win.MediaRecorder = class { constructor(s) { this.state = 'inactive'; } static isTypeSupported() { return false; } start() { this.state = 'recording'; } stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.onstop) this.onstop(); } };
      const SockClass = class extends MockWS { constructor(url) { super(url); socks19b.push(this); } };
      SockClass.CONNECTING = 0; SockClass.OPEN = 1; SockClass.CLOSING = 2; SockClass.CLOSED = 3;
      win.WebSocket = SockClass;
    },
  });
  await sleep(80);
  const doc19b = dom19b.window.document;

  // Enter a session code and join
  const joinInput = doc19b.getElementById('phoneJoinInput');
  const joinBtn = doc19b.getElementById('phoneJoinBtn');
  check('phoneJoinInput exists', !!joinInput);
  if (joinInput && joinBtn) {
    joinInput.value = 'ABC123';
    joinBtn.click();
    await sleep(10);

    // Switch to realtime and start recording
    doc19b.getElementById('engRealtime').click();
    doc19b.getElementById('apiKey').value = 'test-key';
    doc19b.getElementById('sonioxKey').value = 'test-skey';
    doc19b.getElementById('recordBtn').click();
    await sleep(50);

    const transcribeSock = socks19b.find((s) => s.url.includes('/api/transcribe'));
    check('phone WS URL includes session code', !!(transcribeSock && transcribeSock.url.includes('session=ABC123')));

    if (transcribeSock) {
      transcribeSock.open();
      transcribeSock.msg({ message_type: 'session_started', config: {} });
      // Use `text` field (ElevenLabs format); fires while recording so it seeds finalizedSegments
      transcribeSock.msg({ message_type: 'committed_transcript', text: 'Phone realtime.' });
      // Stop recording; tail window runs for TAIL_MS (250ms)
      doc19b.getElementById('recordBtn').click();
      await sleep(700); // > TAIL_MS — beginCommitPhase now sends commit:true
      // Server responds with a final committed transcript after the commit; this triggers
      // the COMMIT_QUIET_MS (150ms) close path instead of the 2500ms deadline
      transcribeSock.msg({ message_type: 'committed_transcript', text: 'Phone realtime.' });
      await sleep(500); // > COMMIT_QUIET_MS — WS closes -> finalizeSession -> deliverFinalText
      // After delivery, should have POSTed to /api/session/ABC123/deliver
      const deliverCall = fetchCalls19b.find((c) => c.url.includes('/api/session/') && c.url.includes('/deliver'));
      check('phone POSTs final text to session deliver endpoint', !!deliverCall);
    }
  }
}

// ===== Scenario 20: phone link resilience =====
console.log('--- scenario 20: phone link resilience ---');
{
  // ---- Desktop side: reconnect, replay dedupe, focus-retry, grace fallback ----
  const socks20 = [];
  let w20;
  let clipFail = false; // simulates an unfocused tab: both clipboard paths fail
  const dom20 = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://dictation.test/',
    beforeParse(win) {
      w20 = win;
      win.isSecureContext = true;
      win.navigator.clipboard = { writeText: (t) => { if (clipFail) return Promise.reject(new Error('Document is not focused')); win._clip = t; return Promise.resolve(); } };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.AudioContext = MockAudioCtx;
      win.navigator.mediaDevices = { getUserMedia: () => Promise.resolve({ getTracks: () => [{ readyState: 'live', stop() {}, addEventListener() {} }], getAudioTracks: () => [{ readyState: 'live', enabled: true, stop() {}, addEventListener() {} }] }), addEventListener: () => {} };
      win.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true,"listeners":1}') });
      win.MediaRecorder = class { constructor(s) { this.state = 'inactive'; } static isTypeSupported() { return false; } start() { this.state = 'recording'; } stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.onstop) this.onstop(); } };
      const SockClass = class extends MockWS { constructor(url) { super(url); socks20.push(this); } };
      SockClass.CONNECTING = 0; SockClass.OPEN = 1; SockClass.CLOSING = 2; SockClass.CLOSED = 3;
      win.WebSocket = SockClass;
    },
  });
  await sleep(80);
  const doc20 = dom20.window.document;
  const status20 = () => doc20.getElementById('status').textContent;
  const badge20 = () => doc20.getElementById('phoneCodeBadge');

  doc20.getElementById('phoneStartBtn').click();
  await sleep(20);
  const sockA = socks20.find((s) => s.url.includes('/api/session/'));
  check('s20: listener socket opened', !!sockA);
  const code20 = sockA ? sockA.url.split('/api/session/')[1] : '';
  sockA.open();
  await sleep(10);

  // pong frames are heartbeat plumbing, not deliveries
  sockA.msg({ message_type: 'pong' });
  await sleep(10);

  // delivery with an id, then a replay of the same id must be ignored
  sockA.msg({ message_type: 'phone_delivery', text: 'First note.', delivery_id: 'd1' });
  await sleep(30);
  check('s20: delivery copied to the clipboard', (w20._clip || '').includes('First note.'), JSON.stringify(w20._clip));
  check('s20: delivery success status', status20().includes('Done!'), status20());
  w20._clip = 'UNTOUCHED';
  sockA.msg({ message_type: 'phone_delivery', text: 'First note.', delivery_id: 'd1' });
  await sleep(30);
  check('s20: replayed delivery_id deduped', w20._clip === 'UNTOUCHED', JSON.stringify(w20._clip));

  // phone_session_end no longer tears the session down (multi-dictation sessions)
  sockA.msg({ message_type: 'phone_session_end' });
  await sleep(30);
  check('s20: session_end keeps the listener socket open', !sockA.closed);
  check('s20: badge still shows the code after session_end', badge20().style.display !== 'none' && badge20().textContent.includes(code20), badge20().textContent);

  // dropped socket -> loud status, warn badge, auto-reconnect to the same room
  sockA.serverClose();
  await sleep(30);
  check('s20: drop is loud', status20().includes('reconnecting'), status20());
  check('s20: badge flags the dead link', badge20().textContent.includes('⚠'), badge20().textContent);
  await sleep(1300); // first reconnect backoff is 1s
  const sessSocks20 = socks20.filter((s) => s.url.includes('/api/session/'));
  const sockB = sessSocks20[1];
  check('s20: reconnected to the same room', !!sockB && sockB.url.includes(code20), sessSocks20.length + ' session sockets');
  sockB.open();
  await sleep(10);
  check('s20: badge recovers once reconnected', !badge20().textContent.includes('⚠'), badge20().textContent);

  // the room replays the held delivery on reconnect; a new id must deliver
  sockB.msg({ message_type: 'phone_delivery', text: 'Held note.', delivery_id: 'd2' });
  await sleep(30);
  check('s20: held delivery lands after reconnect', (w20._clip || '').includes('Held note.'), JSON.stringify(w20._clip));

  // focus-retry: copy fails while "unfocused", retries on the focus event
  clipFail = true;
  sockB.msg({ message_type: 'phone_delivery', text: 'Blocked note.', delivery_id: 'd3' });
  await sleep(30);
  check('s20: failed copy is loud and warns against pasting', status20().includes('FAILED'), status20());
  check('s20: clipboard untouched by the failed copy', !(w20._clip || '').includes('Blocked note.'), JSON.stringify(w20._clip));
  clipFail = false;
  w20.dispatchEvent(new w20.Event('focus'));
  await sleep(30);
  check('s20: refocus retries the copy', (w20._clip || '').includes('Blocked note.'), JSON.stringify(w20._clip));
  check('s20: refocus success status', status20().includes('Done!'), status20());

  // session_end grace window: live committed text is delivered only after the
  // authoritative delivery had its chance
  sockB.msg({ message_type: 'committed_transcript', transcript: 'Live only words.' });
  sockB.msg({ message_type: 'phone_session_end' });
  await sleep(30);
  check('s20: fallback waits for the real delivery first', !(w20._clip || '').includes('Live only words.'), JSON.stringify(w20._clip));
  check('s20: waiting status during the grace window', status20().includes('waiting'), status20());
  await sleep(10500); // > PHONE_FALLBACK_GRACE_MS
  check('s20: grace fallback delivers the live text', (w20._clip || '').includes('Live only words.'), JSON.stringify(w20._clip));
  check('s20: fallback framed as degraded', status20().includes('Verify'), status20());

  // a real delivery cancels a pending fallback (no stale overwrite later)
  sockB.msg({ message_type: 'committed_transcript', transcript: 'Stale live.' });
  sockB.msg({ message_type: 'phone_session_end' });
  await sleep(30);
  sockB.msg({ message_type: 'phone_delivery', text: 'Authoritative note.', delivery_id: 'd4' });
  await sleep(10500);
  check('s20: delivery cancels the grace fallback', (w20._clip || '').includes('Authoritative note.') && !(w20._clip || '').includes('Stale live.'), JSON.stringify(w20._clip));

  // End session: everything closes and stays closed (no reconnect loop)
  doc20.getElementById('phoneStopBtn').click();
  await sleep(1500);
  const sessSocksEnd = socks20.filter((s) => s.url.includes('/api/session/'));
  check('s20: stop closes the listener for good', sessSocksEnd.every((s) => s.closed) && sessSocksEnd.length === 2, sessSocksEnd.length + ' session sockets');

  // ---- Phone side: a deliver ack with zero listeners must be loud ----
  const socks20p = [];
  const fetch20p = [];
  const dom20p = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://dictation.test/',
    beforeParse(win) {
      win.isSecureContext = true;
      win.navigator.clipboard = { writeText: (t) => { win._clip = t; return Promise.resolve(); } };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.AudioContext = MockAudioCtx;
      win.navigator.mediaDevices = { getUserMedia: () => Promise.resolve({ getTracks: () => [{ readyState: 'live', stop() {}, addEventListener() {} }], getAudioTracks: () => [{ readyState: 'live', enabled: true, stop() {}, addEventListener() {} }] }), addEventListener: () => {} };
      win.fetch = (url, opts) => {
        fetch20p.push({ url: String(url), opts });
        if (String(url).includes('/deliver')) {
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true,"listeners":0}') });
        }
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"text":"unused"}') });
      };
      win.MediaRecorder = class { constructor(s) { this.state = 'inactive'; } static isTypeSupported() { return false; } start() { this.state = 'recording'; } stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.onstop) this.onstop(); } };
      const SockClass = class extends MockWS { constructor(url) { super(url); socks20p.push(this); } };
      SockClass.CONNECTING = 0; SockClass.OPEN = 1; SockClass.CLOSING = 2; SockClass.CLOSED = 3;
      win.WebSocket = SockClass;
    },
  });
  await sleep(80);
  const doc20p = dom20p.window.document;
  const status20p = () => doc20p.getElementById('status').textContent;

  doc20p.getElementById('phoneJoinInput').value = 'ABC123';
  doc20p.getElementById('phoneJoinBtn').click();
  doc20p.getElementById('engRealtime').click();
  doc20p.getElementById('apiKey').value = 'test-key';
  doc20p.getElementById('sonioxKey').value = 'test-skey';
  doc20p.getElementById('recordBtn').click();
  await sleep(50);
  const phoneSock = socks20p.find((s) => s.url.includes('/api/transcribe'));
  check('s20p: phone WS carries the session code', !!(phoneSock && phoneSock.url.includes('session=ABC123')));
  phoneSock.open();
  phoneSock.msg({ message_type: 'committed_transcript', text: 'Phone note.' });
  doc20p.getElementById('recordBtn').click(); // stop -> tail -> commit
  await sleep(700);
  phoneSock.msg({ message_type: 'committed_transcript', text: '' });
  await sleep(600); // quiet period -> finalize -> deliver -> relay ack
  const dCall = fetch20p.find((c) => c.url.includes('/deliver'));
  check('s20p: deliver POST sent', !!dCall);
  const dBody = dCall ? JSON.parse(dCall.opts.body) : {};
  check('s20p: deliver carries text + delivery_id', dBody.text && dBody.text.includes('Phone note.') && typeof dBody.delivery_id === 'string' && dBody.delivery_id.length > 0, JSON.stringify(dBody.delivery_id));
  check('s20p: zero-listener ack is loud on the phone', status20p().includes('Desktop link is DOWN'), status20p());
}

// ===== Scenario 21: SessionRoom Durable Object contract (direct, no jsdom) =====
console.log('--- scenario 21: session room DO contract ---');
{
  class FakeSock {
    constructor() { this.sent = []; this.handlers = {}; }
    accept() {}
    send(d) { this.sent.push(d); }
    addEventListener(ev, fn) { this.handlers[ev] = fn; }
  }
  let lastPair = null;
  globalThis.WebSocketPair = function () {
    lastPair = { client: new FakeSock(), server: new FakeSock() };
    return { 0: lastPair.client, 1: lastPair.server };
  };
  const RealResponse = globalThis.Response;
  globalThis.Response = class {
    constructor(body, init) { this.body = body; const i = init || {}; this.status = i.status || 200; this.webSocket = i.webSocket; }
    async text() { return this.body; }
  };

  const room = new worker.SessionRoom({}, {});
  const wsReq = () => ({ headers: { get: (h) => (h === 'Upgrade' ? 'websocket' : null) }, method: 'GET', url: 'https://room/api/session/ABC123' });
  const postReq = (body) => ({ headers: { get: () => null }, method: 'POST', url: 'https://room/broadcast', text: async () => body });

  await room.fetch(wsReq());
  const listenerA = lastPair.server;
  listenerA.handlers.message({ data: JSON.stringify({ message_type: 'ping' }) });
  check('s21: room answers ping with pong', listenerA.sent.some((d) => JSON.parse(d).message_type === 'pong'));

  const delivery = JSON.stringify({ message_type: 'phone_delivery', text: 'DO note.', delivery_id: 'do1' });
  const ack1 = JSON.parse(await (await room.fetch(postReq(delivery))).text());
  check('s21: broadcast acks the listener count', ack1.listeners === 1, JSON.stringify(ack1));
  check('s21: listener received the delivery', listenerA.sent.includes(delivery));

  listenerA.handlers.close();
  const ack0 = JSON.parse(await (await room.fetch(postReq(delivery))).text());
  check('s21: zero listeners reported after the socket closes', ack0.listeners === 0, JSON.stringify(ack0));

  await room.fetch(wsReq());
  const listenerB = lastPair.server;
  check('s21: reconnecting listener gets the held delivery replayed', listenerB.sent.includes(delivery), listenerB.sent.length + ' frames');

  room.lastDelivery.ts -= 3 * 60 * 1000; // age it past the replay window
  await room.fetch(wsReq());
  const listenerC = lastPair.server;
  check('s21: stale deliveries are not replayed', !listenerC.sent.includes(delivery), listenerC.sent.length + ' frames');

  const ackNonDelivery = JSON.parse(await (await room.fetch(postReq(JSON.stringify({ message_type: 'partial_transcript', text: 'x' })))).text());
  check('s21: transcript frames are not buffered as deliveries', room.lastDelivery.body === delivery && typeof ackNonDelivery.listeners === 'number');

  // GET /latest: native pollers (AHK) read the held delivery without joining
  const latestReq = () => ({ headers: { get: () => null }, method: 'GET', url: 'https://room/api/session/ABC123/latest' });
  const staleLatest = JSON.parse(await (await room.fetch(latestReq())).text());
  check('s21: /latest returns null for a stale delivery', staleLatest.ok === true && staleLatest.delivery === null, JSON.stringify(staleLatest));
  const delivery2 = JSON.stringify({ message_type: 'phone_delivery', text: 'DO note 2.', delivery_id: 'do2' });
  await room.fetch(postReq(delivery2));
  const freshLatest = JSON.parse(await (await room.fetch(latestReq())).text());
  check('s21: /latest returns the held delivery with its id', freshLatest.delivery && freshLatest.delivery.delivery_id === 'do2' && freshLatest.delivery.text === 'DO note 2.' && typeof freshLatest.age_ms === 'number', JSON.stringify(freshLatest));

  globalThis.Response = RealResponse;
  delete globalThis.WebSocketPair;
}

// ===== Scenario 22: phone link persistence — resume + rejoin across reloads =====
console.log('--- scenario 22: phone link persistence ---');
{
  // ---- Desktop: a persisted session resumes at boot; persisted delivery id dedupes the replay ----
  const socks22 = [];
  let w22;
  const dom22 = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://dictation.test/',
    beforeParse(win) {
      w22 = win;
      win.isSecureContext = true;
      win.navigator.clipboard = { writeText: (t) => { win._clip = t; return Promise.resolve(); } };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.AudioContext = MockAudioCtx;
      win.navigator.mediaDevices = { getUserMedia: () => Promise.resolve({ getTracks: () => [{ readyState: 'live', stop() {}, addEventListener() {} }], getAudioTracks: () => [{ readyState: 'live', enabled: true, stop() {}, addEventListener() {} }] }), addEventListener: () => {} };
      win.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true,"listeners":1}') });
      win.MediaRecorder = class { constructor(s) { this.state = 'inactive'; } static isTypeSupported() { return false; } start() { this.state = 'recording'; } stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.onstop) this.onstop(); } };
      const SockClass = class extends MockWS { constructor(url) { super(url); socks22.push(this); } };
      SockClass.CONNECTING = 0; SockClass.OPEN = 1; SockClass.CLOSING = 2; SockClass.CLOSED = 3;
      win.WebSocket = SockClass;
      // A desktop session was active before this "reload"
      win.localStorage.setItem('scribe_v2_settings_v9', JSON.stringify({ phoneSessionCode: 'ROOMZZ', lastDeliveryId: 'old1' }));
    },
  });
  await sleep(100);
  const doc22 = dom22.window.document;
  const settings22 = () => JSON.parse(w22.localStorage.getItem('scribe_v2_settings_v9'));

  const resumeSock = socks22.find((s) => s.url.includes('/api/session/ROOMZZ'));
  check('s22: persisted session reconnects at boot', !!resumeSock);
  check('s22: session UI restored (badge + stop button)', doc22.getElementById('phoneCodeBadge').style.display !== 'none' && doc22.getElementById('phoneStopBtn').style.display !== 'none');
  resumeSock.open();
  await sleep(10);

  w22._clip = 'PRISTINE';
  resumeSock.msg({ message_type: 'phone_delivery', text: 'Old note.', delivery_id: 'old1' }); // room replay of a pre-reload delivery
  await sleep(30);
  check('s22: persisted delivery id dedupes the replay across the reload', w22._clip === 'PRISTINE', JSON.stringify(w22._clip));
  resumeSock.msg({ message_type: 'phone_delivery', text: 'Post-reload note.', delivery_id: 'new1' });
  await sleep(30);
  check('s22: new delivery lands after the resume', (w22._clip || '').includes('Post-reload note.'), JSON.stringify(w22._clip));
  check('s22: new delivery id persisted immediately', settings22().lastDeliveryId === 'new1', JSON.stringify(settings22().lastDeliveryId));

  doc22.getElementById('phoneStopBtn').click();
  await sleep(20);
  check('s22: ending the session forgets the persisted code', settings22().phoneSessionCode === '', JSON.stringify(settings22().phoneSessionCode));
  doc22.getElementById('phoneStartBtn').click();
  await sleep(20);
  check('s22: starting a session persists its code', /^[A-Z2-9]{6}$/.test(settings22().phoneSessionCode), JSON.stringify(settings22().phoneSessionCode));
  doc22.getElementById('phoneStopBtn').click();

  // ---- Phone: a persisted join rides the next dictation after a "reload"; Leave forgets it ----
  const socks22p = [];
  let w22p;
  const dom22p = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://dictation.test/',
    beforeParse(win) {
      w22p = win;
      win.isSecureContext = true;
      win.navigator.clipboard = { writeText: (t) => { win._clip = t; return Promise.resolve(); } };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.AudioContext = MockAudioCtx;
      win.navigator.mediaDevices = { getUserMedia: () => Promise.resolve({ getTracks: () => [{ readyState: 'live', stop() {}, addEventListener() {} }], getAudioTracks: () => [{ readyState: 'live', enabled: true, stop() {}, addEventListener() {} }] }), addEventListener: () => {} };
      win.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true,"listeners":1}') });
      win.MediaRecorder = class { constructor(s) { this.state = 'inactive'; } static isTypeSupported() { return false; } start() { this.state = 'recording'; } stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.onstop) this.onstop(); } };
      const SockClass = class extends MockWS { constructor(url) { super(url); socks22p.push(this); } };
      SockClass.CONNECTING = 0; SockClass.OPEN = 1; SockClass.CLOSING = 2; SockClass.CLOSED = 3;
      win.WebSocket = SockClass;
      // The phone joined a desktop session before this "reload" (iOS PWA kill)
      win.localStorage.setItem('scribe_v2_settings_v9', JSON.stringify({ joinedSessionCode: 'ABC123', engine: 'realtime' }));
    },
  });
  await sleep(100);
  const doc22p = dom22p.window.document;
  const settings22p = () => JSON.parse(w22p.localStorage.getItem('scribe_v2_settings_v9'));

  check('s22p: join badge restored at boot', doc22p.getElementById('phoneJoinBadge').style.display !== 'none');
  check('s22p: leave button shown for the restored join', doc22p.getElementById('phoneLeaveBtn').style.display !== 'none');
  doc22p.getElementById('apiKey').value = 'test-key';
  doc22p.getElementById('sonioxKey').value = 'test-skey';
  doc22p.getElementById('recordBtn').click();
  await sleep(50);
  const rejoinedSock = socks22p.find((s) => s.url.includes('/api/transcribe'));
  check('s22p: restored join rides the next dictation', !!(rejoinedSock && rejoinedSock.url.includes('session=ABC123')), rejoinedSock && rejoinedSock.url.split('?')[1]);
  doc22p.getElementById('recordBtn').click();
  await sleep(6000); // let the never-opened socket time out and finalize

  doc22p.getElementById('phoneLeaveBtn').click();
  await sleep(20);
  check('s22p: leave forgets the persisted join', settings22p().joinedSessionCode === '', JSON.stringify(settings22p().joinedSessionCode));
  check('s22p: leave hides the badge', doc22p.getElementById('phoneJoinBadge').style.display === 'none');
}

// ===== Scenario 23: iOS mic resilience — wake lock, muted-track rebuild, re-warm fallback =====
console.log('--- scenario 23: iOS mic resilience ---');

// Leg A (main DOM): a dictation holds a screen wake lock until delivery
doc.getElementById('freshBtn').click();
fetchQueue.push({ status: 200, body: { text: 'Wake lock note.' } });
const wlBefore = wakeLockCalls;
doc.getElementById('recordBtn').click();
await sleep(120);
check('s23: wake lock acquired for the dictation', wakeLockCalls === wlBefore + 1 && activeWakeLock !== null, wakeLockCalls - wlBefore);
doc.getElementById('recordBtn').click();
await sleep(300);
check('s23: dictation delivered', clipboard.includes('Wake lock note.'), JSON.stringify(clipboard));
check('s23: wake lock released after delivery', activeWakeLock === null);

// Leg B (main DOM): an iOS-interrupted track ("live" but muted) forces a mic rebuild
doc.getElementById('freshBtn').click();
fetchQueue.push({ status: 200, body: { text: 'Rebuilt mic note.' } });
micTrack.muted = true;
const gumBefore = gumCalls;
doc.getElementById('recordBtn').click();
micTrack.readyState = 'live'; micTrack.muted = false; // the fresh acquisition hands back a working track
await sleep(120);
check('s23: muted track triggers a mic re-acquisition', gumCalls === gumBefore + 1, gumCalls - gumBefore);
doc.getElementById('recordBtn').click();
await sleep(300);
check('s23: dictation works on the rebuilt mic', clipboard.includes('Rebuilt mic note.'), JSON.stringify(clipboard));

// Leg C (fresh DOM, no Permissions API — the iOS Safari situation): the
// re-warm on visibilitychange must still re-engage a dead mic.
{
  const track23 = { readyState: 'live', muted: false, addEventListener() {}, stop() { this.readyState = 'ended'; } };
  const stream23 = { getAudioTracks: () => [track23], getTracks: () => [track23] };
  let gum23 = 0;
  let gumFail23 = 0; // make the next N acquisitions fail (iOS hands the audio session back late)
  let w23;
  const dom23 = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://dictation.test/',
    beforeParse(win) {
      w23 = win;
      win.isSecureContext = true;
      win.navigator.clipboard = { writeText: (t) => { win._clip = t; return Promise.resolve(); } };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.AudioContext = MockAudioCtx;
      // NOTE: no win.navigator.permissions — like iOS Safari for the mic
      // jsdom reports visibilityState 'prerender'; the re-warm only runs when visible
      Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
      win.navigator.mediaDevices = { getUserMedia: () => { gum23++; if (gumFail23 > 0) { gumFail23--; return Promise.reject(new Error('NotReadableError')); } track23.readyState = 'live'; track23.muted = false; return Promise.resolve(stream23); }, addEventListener: () => {} };
      win.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"text":"Warm note."}') });
      win.MediaRecorder = class {
        constructor(s) { this.state = 'inactive'; }
        static isTypeSupported() { return false; }
        start() { this.state = 'recording'; }
        stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.ondataavailable) this.ondataavailable({ data: new win.Blob([new Uint8Array(2048)], { type: 'audio/webm' }) }); if (this.onstop) this.onstop(); }
      };
      win.WebSocket = MockWS;
    },
  });
  await sleep(100);
  const doc23 = dom23.window.document;
  check('s23c: no warm-up without a prior grant (no prompt ambush)', gum23 === 0, gum23);
  doc23.getElementById('apiKey').value = 'test-key';
  doc23.getElementById('sonioxKey').value = 'test-skey';
  doc23.getElementById('recordBtn').click();
  await sleep(120);
  check('s23c: first dictation acquires the mic', gum23 === 1, gum23);
  doc23.getElementById('recordBtn').click();
  await sleep(300);
  check('s23c: batch note delivered', (w23._clip || '').includes('Warm note.'), JSON.stringify(w23._clip));
  track23.readyState = 'ended'; // iOS killed the stream while the page was hidden
  doc23.dispatchEvent(new dom23.window.Event('visibilitychange'));
  await sleep(80);
  check('s23c: visibility re-warm re-engages the mic without the Permissions API', gum23 === 2, gum23);

  // iOS hands the audio session back late: the first re-acquire fails, the
  // backoff retry must recover without any user action.
  gumFail23 = 1;
  track23.readyState = 'ended';
  doc23.dispatchEvent(new dom23.window.Event('visibilitychange'));
  await sleep(80);
  check('s23c: flaky first re-acquire attempted', gum23 === 3, gum23);
  await sleep(900); // > 700ms retry backoff
  check('s23c: re-warm retries and recovers on its own', gum23 === 4, gum23);

  // Standalone PWAs can fire only focus (no visibilitychange) on app switch
  track23.readyState = 'ended';
  dom23.window.dispatchEvent(new dom23.window.Event('focus'));
  await sleep(80);
  check('s23c: window focus re-engages a dead mic', gum23 === 5, gum23);
}

// Leg D (fresh DOM): the grant persists, so a killed-and-relaunched iOS PWA
// re-warms the mic at boot instead of staying cold until the first press.
{
  const track23d = { readyState: 'live', muted: false, addEventListener() {}, stop() { this.readyState = 'ended'; } };
  const stream23d = { getAudioTracks: () => [track23d], getTracks: () => [track23d] };
  let gum23d = 0;
  const dom23d = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://dictation.test/',
    beforeParse(win) {
      win.isSecureContext = true;
      win.navigator.clipboard = { writeText: (t) => Promise.resolve() };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.AudioContext = MockAudioCtx;
      // no Permissions API (iOS Safari); the persisted grant is the only signal
      Object.defineProperty(win.document, 'visibilityState', { value: 'visible', configurable: true });
      win.navigator.mediaDevices = { getUserMedia: () => { gum23d++; return Promise.resolve(stream23d); }, addEventListener: () => {} };
      win.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{}') });
      win.MediaRecorder = class { constructor(s) { this.state = 'inactive'; } static isTypeSupported() { return false; } start() { this.state = 'recording'; } stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.onstop) this.onstop(); } };
      win.WebSocket = MockWS;
      win.localStorage.setItem('scribe_v2_settings_v9', JSON.stringify({ micGranted: true }));
    },
  });
  await sleep(150);
  check('s23d: persisted grant re-warms the mic at boot after a PWA relaunch', gum23d === 1, gum23d);
}

// ===== Scenario 24: QR join =====
console.log('--- scenario 24: QR join ---');
{
  // ---- Desktop: the rendered QR must decode (with a real decoder) to the join URL ----
  const socks23 = [];
  const dom23 = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://dictation.test/',
    beforeParse(win) {
      win.isSecureContext = true;
      win.navigator.clipboard = { writeText: (t) => Promise.resolve() };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.AudioContext = MockAudioCtx;
      win.navigator.mediaDevices = { getUserMedia: () => Promise.resolve(mockStream), addEventListener: () => {} };
      win.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true,"listeners":1}') });
      win.MediaRecorder = class { constructor(s) { this.state = 'inactive'; } static isTypeSupported() { return false; } start() { this.state = 'recording'; } stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.onstop) this.onstop(); } };
      const SockClass = class extends MockWS { constructor(url) { super(url); socks23.push(this); } };
      SockClass.CONNECTING = 0; SockClass.OPEN = 1; SockClass.CLOSING = 2; SockClass.CLOSED = 3;
      win.WebSocket = SockClass;
    },
  });
  await sleep(100);
  const doc23 = dom23.window.document;

  doc23.getElementById('phoneStartBtn').click();
  await sleep(20);
  const qrEl = doc23.getElementById('phoneQr');
  const code23 = doc23.getElementById('phoneCodeBadge').textContent.trim();
  check('s24: QR rendered when the session starts', qrEl.style.display !== 'none' && qrEl.innerHTML.includes('<svg'));
  const joinUrl = qrEl.getAttribute('data-join-url');
  check('s24: QR advertises the join URL for this session', joinUrl === 'https://dictation.test/?join=' + code23, joinUrl);

  // Rasterize the SVG modules and decode with jsqr — proves the hand-rolled
  // encoder produces a genuinely scannable code, not just plausible pixels.
  const svg = qrEl.innerHTML;
  const dim = Number((svg.match(/viewBox="0 0 (\d+)/) || [])[1] || 0);
  check('s24: QR has a sane module count', dim >= 29 && dim <= 49, dim); // v1..v6 + quiet zones
  const grid = Array.from({ length: dim }, () => new Array(dim).fill(0));
  for (const mod of svg.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) grid[Number(mod[2])][Number(mod[1])] = 1;
  const scale = 4, W = dim * scale;
  const px = new Uint8ClampedArray(W * W * 4);
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) {
    const v = grid[Math.floor(y / scale)][Math.floor(x / scale)] ? 0 : 255;
    const o = (y * W + x) * 4;
    px[o] = px[o + 1] = px[o + 2] = v; px[o + 3] = 255;
  }
  const decoded = jsQR(px, W, W);
  check('s24: QR decodes to the join URL', !!decoded && decoded.data === joinUrl, decoded && decoded.data);

  doc23.getElementById('phoneStopBtn').click();
  check('s24: QR hidden when the session ends', qrEl.style.display === 'none' && qrEl.innerHTML === '');

  // ---- Phone: opening the scanned URL joins, persists, and cleans the address bar ----
  const socks23p = [];
  let w23p;
  const dom23p = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://dictation.test/?join=xyz234',
    beforeParse(win) {
      w23p = win;
      win.isSecureContext = true;
      win.navigator.clipboard = { writeText: (t) => Promise.resolve() };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.AudioContext = MockAudioCtx;
      win.navigator.mediaDevices = { getUserMedia: () => Promise.resolve(mockStream), addEventListener: () => {} };
      win.fetch = () => Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"ok":true,"listeners":1}') });
      win.MediaRecorder = class { constructor(s) { this.state = 'inactive'; } static isTypeSupported() { return false; } start() { this.state = 'recording'; } stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.onstop) this.onstop(); } };
      const SockClass = class extends MockWS { constructor(url) { super(url); socks23p.push(this); } };
      SockClass.CONNECTING = 0; SockClass.OPEN = 1; SockClass.CLOSING = 2; SockClass.CLOSED = 3;
      win.WebSocket = SockClass;
      win.localStorage.setItem('scribe_v2_settings_v9', JSON.stringify({ engine: 'realtime' }));
    },
  });
  await sleep(100);
  const doc23p = dom23p.window.document;
  const settings23p = () => JSON.parse(w23p.localStorage.getItem('scribe_v2_settings_v9'));

  check('s24p: scanned URL joins the session (code uppercased)', settings23p().joinedSessionCode === 'XYZ234', JSON.stringify(settings23p().joinedSessionCode));
  check('s24p: join badge + leave shown after scan', doc23p.getElementById('phoneJoinBadge').style.display !== 'none' && doc23p.getElementById('phoneLeaveBtn').style.display !== 'none');
  check('s24p: join param cleaned from the address bar', !w23p.location.search.includes('join'), w23p.location.href);
  doc23p.getElementById('apiKey').value = 'test-key';
  doc23p.getElementById('sonioxKey').value = 'test-skey';
  doc23p.getElementById('recordBtn').click();
  await sleep(50);
  const scanSock = socks23p.find((s) => s.url.includes('/api/transcribe'));
  check('s24p: scanned join rides the next dictation', !!(scanSock && scanSock.url.includes('session=XYZ234')));
  // Drain: finalize the abandoned session now so its 5s connect timer cannot
  // fire in the middle of a later scenario (finalizeSession clears it).
  if (scanSock) scanSock.serverClose();
  await sleep(50);
}

// ===== Scenario 25: big-button dictation layout =====
console.log('--- scenario 25: big-button layout ---');
{
  // Fresh phone-like DOM factory: batch engine (the default — no WS to drive),
  // controllable upload/deliver latency + deliver failure, and a vibration
  // spy for the haptic mirror.
  const mkBigDom = (opts) => {
    const state = {
      socks: [], fetches: [], vibes: [], win: null,
      deliverListeners: 1, deliverFail: false, deliverDelayMs: 0,
      batchText: 'Big note.', batchDelayMs: 0,
      clipFail: false, // simulate iOS denying clipboard writes outside a user gesture
    };
    state.dom = new JSDOM(html, {
      runScripts: 'dangerously', url: (opts && opts.url) || 'https://dictation.test/',
      beforeParse(win) {
        state.win = win;
        win.isSecureContext = true;
        win.navigator.clipboard = { writeText: (t) => { if (state.clipFail) return Promise.reject(new Error('NotAllowedError')); win._clip = t; return Promise.resolve(); } };
        win.URL.createObjectURL = () => 'blob:mock';
        win.URL.revokeObjectURL = () => {};
        win.AudioContext = MockAudioCtx;
        win.navigator.vibrate = (p) => { state.vibes.push(p); return true; };
        const track = { readyState: 'live', muted: false, addEventListener() {}, stop() { this.readyState = 'ended'; } };
        const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
        win.navigator.mediaDevices = { getUserMedia: () => { track.readyState = 'live'; return Promise.resolve(stream); }, addEventListener: () => {} };
        win.fetch = (url, fOpts) => {
          state.fetches.push({ url: String(url), opts: fOpts || {} });
          if (String(url).includes('/deliver')) {
            return new Promise((resolve) => setTimeout(() => resolve({
              ok: !state.deliverFail, status: state.deliverFail ? 500 : 200,
              text: () => Promise.resolve('{"ok":true,"listeners":' + state.deliverListeners + '}'),
            }), state.deliverDelayMs || 0));
          }
          return new Promise((resolve) => setTimeout(() => resolve({
            ok: true, status: 200,
            text: () => Promise.resolve(JSON.stringify({ text: state.batchText })),
          }), state.batchDelayMs || 0));
        };
        win.MediaRecorder = class {
          constructor(s) { this.state = 'inactive'; }
          static isTypeSupported() { return false; }
          start() { this.state = 'recording'; }
          stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.ondataavailable) this.ondataavailable({ data: new win.Blob([new Uint8Array(2048)], { type: 'audio/webm' }) }); if (this.onstop) this.onstop(); }
        };
        const SockClass = class extends MockWS { constructor(url) { super(url); state.socks.push(this); } };
        SockClass.CONNECTING = 0; SockClass.OPEN = 1; SockClass.CLOSING = 2; SockClass.CLOSED = 3;
        win.WebSocket = SockClass;
        if (opts && opts.settings) win.localStorage.setItem('scribe_v2_settings_v9', JSON.stringify(opts.settings));
      },
    });
    return state;
  };
  // jsdom has no PointerEvent; a generic Event with a pointerId rides the
  // same listeners. setPointerCapture is absent (the code try/catches it),
  // so every leg runs in the same no-capture regime as capture-less
  // browsers; the slide-away leg below releases on <body>, so the
  // document-level backstop is what catches it there.
  const pev = (win, el, type, id) => {
    const ev = new win.Event(type, { bubbles: true, cancelable: true });
    ev.pointerId = id;
    el.dispatchEvent(ev);
  };

  // ---- Leg A: joining flips the layout on; Leave reverts ----
  const A = mkBigDom();
  await sleep(100);
  const dA = A.dom.window.document;
  check('s25a: normal layout before joining', !dA.body.classList.contains('bigbtn'), dA.body.className);
  dA.getElementById('phoneJoinInput').value = 'BIG123';
  dA.getElementById('phoneJoinBtn').click();
  await sleep(20);
  check('s25a: joining activates the big-button layout', dA.body.classList.contains('bigbtn'), dA.body.className);
  check('s25a: joined badge shows the code', dA.getElementById('bigJoinedBadge').textContent.includes('BIG123'), dA.getElementById('bigJoinedBadge').textContent);
  check('s25a: big Leave visible while joined', dA.getElementById('bigLeaveBtn').style.display !== 'none');
  dA.getElementById('bigLeaveBtn').click();
  await sleep(20);
  check('s25a: Leave reverts to the normal layout', !dA.body.classList.contains('bigbtn'), dA.body.className);
  check('s25a: Leave forgot the persisted join', JSON.parse(A.win.localStorage.getItem('scribe_v2_settings_v9')).joinedSessionCode === '');

  // ---- Leg B: persisted join boots into the big button + button semantics ----
  const B = mkBigDom({ settings: { joinedSessionCode: 'BIGBOOT', saveApiKey: false } });
  await sleep(100);
  const dB = B.dom.window.document;
  const bigBtnB = dB.getElementById('bigBtn');
  const screenB = () => dB.getElementById('bigUi').getAttribute('data-screen');
  const statusB = () => dB.getElementById('status').textContent;
  check('s25b: persisted join boots straight into the big button', dB.body.classList.contains('bigbtn'), dB.body.className);
  check('s25b: boot badge shows the restored code', dB.getElementById('bigJoinedBadge').textContent.includes('BIGBOOT'));
  check('s25b: screen idle at boot', screenB() === 'idle', screenB());
  dB.getElementById('apiKey').value = 'test-key';
  dB.getElementById('sonioxKey').value = 'test-skey';

  // hold = push-to-talk: pointerdown starts, pointerup past the threshold stops
  const vibesAtStart = B.vibes.length;
  pev(B.win, bigBtnB, 'pointerdown', 1);
  await sleep(150);
  check('s25b: pointerdown started the normal session path', dB.getElementById('recordBtn').textContent.includes('Stop'));
  check('s25b: no parallel session machinery (no WS in batch mode)', B.socks.length === 0, B.socks.length);
  check('s25b: whole screen shows REC', screenB() === 'rec', screenB());
  check('s25b: start haptic mirrored the start beep', JSON.stringify(B.vibes[vibesAtStart]) === '30', JSON.stringify(B.vibes.slice(vibesAtStart)));
  await sleep(450); // total hold > HOTKEY_TAP_MS
  pev(B.win, bigBtnB, 'pointerup', 1);
  await sleep(400);
  check('s25b: hold release stopped + delivered', (B.win._clip || '').includes('Big note.'), JSON.stringify(B.win._clip));
  check('s25b: success turns the screen green', screenB() === 'ok', screenB());
  check('s25b: done haptic fired (the done pattern, not just any vibe)', JSON.stringify(B.vibes[B.vibes.length - 1]) === '[40,60,40]', JSON.stringify(B.vibes.slice(vibesAtStart)));

  // tap = toggle: a quick press keeps recording, the next tap stops
  B.batchText = 'Tap note.';
  pev(B.win, bigBtnB, 'pointerdown', 2);
  await sleep(80);
  pev(B.win, bigBtnB, 'pointerup', 2); // released under the tap threshold
  await sleep(200);
  check('s25b: tap keeps the recording running', dB.getElementById('recordBtn').textContent.includes('Stop'));
  pev(B.win, bigBtnB, 'pointerdown', 3); // second tap stops on press
  pev(B.win, bigBtnB, 'pointerup', 3);
  await sleep(400);
  check('s25b: second tap stopped + delivered', (B.win._clip || '').includes('Tap note.'), JSON.stringify(B.win._clip));

  // pointercancel (browser stole the pointer mid-hold) must behave as release
  B.batchText = 'Cancel note.';
  pev(B.win, bigBtnB, 'pointerdown', 4);
  await sleep(550);
  pev(B.win, bigBtnB, 'pointercancel', 4);
  await sleep(400);
  check('s25b: pointercancel never wedges the recording', (B.win._clip || '').includes('Cancel note.'), JSON.stringify(B.win._clip));

  // multi-touch: a second finger neither steals nor releases the press
  B.batchText = 'Multi note.';
  pev(B.win, bigBtnB, 'pointerdown', 5);
  await sleep(100);
  pev(B.win, bigBtnB, 'pointerdown', 6); // second finger lands
  pev(B.win, bigBtnB, 'pointerup', 6);   // and lifts
  await sleep(100);
  check('s25b: other fingers do not release the press', dB.getElementById('recordBtn').textContent.includes('Stop'));
  await sleep(350); // owning finger now past the tap threshold
  pev(B.win, bigBtnB, 'pointerup', 5);
  await sleep(400);
  check('s25b: owning finger release stops + delivers', (B.win._clip || '').includes('Multi note.'), JSON.stringify(B.win._clip));

  // peek strip: collapsed mirror, tap to expand, click-to-append from expanded
  const peekB = dB.getElementById('bigPeek');
  check('s25b: peek strip mirrors the latest transcript', dB.getElementById('bigPeekText').textContent.includes('Multi note.'), dB.getElementById('bigPeekText').textContent);
  check('s25b: peek starts collapsed', !peekB.classList.contains('expanded'));
  dB.getElementById('bigPeekBar').click();
  check('s25b: tapping the bar expands the peek', peekB.classList.contains('expanded'));
  dB.getElementById('bigPeekText').click(); // click-to-append via the shared handler
  check('s25b: expanded text click arms click-to-append', dB.getElementById('appendChip').style.display !== 'none' && peekB.classList.contains('armed'), dB.getElementById('appendChip').textContent);
  B.batchText = 'Appended.';
  pev(B.win, bigBtnB, 'pointerdown', 7);
  await sleep(550);
  pev(B.win, bigBtnB, 'pointerup', 7);
  await sleep(400);
  check('s25b: armed dictation appended onto the note', (B.win._clip || '').includes('Multi note.') && (B.win._clip || '').includes('Appended.'), JSON.stringify(B.win._clip));

  // relay outcome is part of the screen: a zero-listener ack reddens it even
  // though the local delivery already succeeded (and beeped done)
  B.deliverListeners = 0;
  B.batchText = 'Down note.';
  const vibesBeforeDown = B.vibes.length;
  pev(B.win, bigBtnB, 'pointerdown', 8);
  await sleep(550);
  pev(B.win, bigBtnB, 'pointerup', 8);
  await sleep(400);
  check('s25b: local delivery still landed', (B.win._clip || '').includes('Down note.'), JSON.stringify(B.win._clip));
  check('s25b: zero-listener ack is loud', statusB().includes('Desktop link is DOWN'), statusB());
  check('s25b: zero-listener ack reddens the screen', screenB() === 'fail', screenB());
  check('s25b: warn haptic accompanied the relay warning (warn pattern, not done/fail)', JSON.stringify(B.vibes[B.vibes.length - 1]) === '[90,90,90]', JSON.stringify(B.vibes.slice(vibesBeforeDown)));
  B.deliverListeners = 1;

  // no-capture slide-away: the finger slides off the button before lifting.
  // The release lands on <body>, so the button's own listeners never see it —
  // only the document-level backstop routes it to bigBtnRelease.
  B.batchText = 'Slide note.';
  pev(B.win, bigBtnB, 'pointerdown', 9);
  await sleep(550); // past HOTKEY_TAP_MS
  pev(B.win, dB.body, 'pointerup', 9); // release off the button
  await sleep(400);
  check('s25b: slide-off release caught by the document backstop', (B.win._clip || '').includes('Slide note.'), JSON.stringify(B.win._clip));
  check('s25b: slide-off release does not wedge the screen in REC', screenB() !== 'rec', screenB());
  B.batchText = 'After slide.';
  pev(B.win, bigBtnB, 'pointerdown', 10); // the cleared pointer id must not eat the next press
  await sleep(550);
  pev(B.win, bigBtnB, 'pointerup', 10);
  await sleep(400);
  check('s25b: next press after a slide-off works normally', (B.win._clip || '').includes('After slide.'), JSON.stringify(B.win._clip));

  // pointercancel UNDER the tap threshold: the release will never arrive
  // (gesture takeover) — it must stop the dictation, not convert it to a
  // toggle that leaves the mic open.
  B.batchText = 'Cancelled tap note.';
  pev(B.win, bigBtnB, 'pointerdown', 11);
  await sleep(150); // < HOTKEY_TAP_MS
  pev(B.win, bigBtnB, 'pointercancel', 11);
  await sleep(400);
  check('s25b: sub-threshold pointercancel stops the recording', dB.getElementById('recordBtn').textContent.includes('Start'));
  check('s25b: the cancelled dictation still delivered', (B.win._clip || '').includes('Cancelled tap note.'), JSON.stringify(B.win._clip));

  // a press queued during a finalize, then cancelled, must not auto-start a
  // session nobody is holding
  B.batchDelayMs = 400;
  B.batchText = 'CDF note.';
  pev(B.win, bigBtnB, 'pointerdown', 12);
  await sleep(450);
  pev(B.win, bigBtnB, 'pointerup', 12); // hold release -> slow upload (finishing)
  await sleep(100);
  pev(B.win, bigBtnB, 'pointerdown', 13); // queued during the finalize
  await sleep(100);
  pev(B.win, bigBtnB, 'pointercancel', 13); // and cancelled before it started
  B.batchDelayMs = 0;
  await sleep(600); // delivery + would-be queued start window
  check('s25b: cancelled queued press never auto-starts', dB.getElementById('recordBtn').textContent.includes('Start'));
  check('s25b: the slow note still delivered', (B.win._clip || '').includes('CDF note.'), JSON.stringify(B.win._clip));

  // F14 (CapsLock up) while a queued start is pending cancels it — a session
  // must never start after the last F14
  B.batchDelayMs = 400;
  B.batchText = 'F14 note.';
  pev(B.win, bigBtnB, 'pointerdown', 14);
  await sleep(450);
  pev(B.win, bigBtnB, 'pointerup', 14); // slow upload (finishing)
  await sleep(100);
  dB.dispatchEvent(new B.win.KeyboardEvent('keydown', { code: 'F13' })); // queue
  dB.dispatchEvent(new B.win.KeyboardEvent('keydown', { code: 'F14' })); // CapsLock released
  B.batchDelayMs = 0;
  await sleep(600);
  check('s25b: F14 cancels a queued start', dB.getElementById('recordBtn').textContent.includes('Start'));
  check('s25b: F14-cancelled flow still delivered the note', (B.win._clip || '').includes('F14 note.'), JSON.stringify(B.win._clip));

  // hold-through-delivery ghost: press queued during a finalize, the delivery
  // lands while the finger is STILL down, the release arrives in the queued-
  // start window — it must cancel the deferred start, not be erased by it
  B.batchDelayMs = 400;
  B.deliverFail = true; // relay failure -> err outcome -> long queued-start window
  B.batchText = 'Ghost note.';
  pev(B.win, bigBtnB, 'pointerdown', 15);
  await sleep(450);
  pev(B.win, bigBtnB, 'pointerup', 15); // slow upload starts
  await sleep(100);
  pev(B.win, bigBtnB, 'pointerdown', 16); // queued; finger stays down through the delivery
  await sleep(800); // delivery + relay failure land while holding
  pev(B.win, bigBtnB, 'pointerup', 16); // held release inside the queued-start window
  await sleep(1800); // past the deferred-start delay
  check('s25b: hold released after delivery cancels the queued start (no ghost mic)', dB.getElementById('recordBtn').textContent.includes('Start'));
  check('s25b: ghost-window note still delivered locally', (B.win._clip || '').includes('Ghost note.'), JSON.stringify(B.win._clip));
  check('s25b: relay failure stayed on screen', screenB() === 'fail', screenB());

  // queued TAP + relay failure: the failure gets screen time BEFORE the
  // queued session's REC paints over it, and the queued dictation still runs
  B.batchText = 'Redden note.';
  pev(B.win, bigBtnB, 'pointerdown', 17);
  await sleep(450);
  pev(B.win, bigBtnB, 'pointerup', 17); // slow upload (batchDelayMs still 400)
  await sleep(100);
  pev(B.win, bigBtnB, 'pointerdown', 18); // quick tap during the finalize: queue survives release
  pev(B.win, bigBtnB, 'pointerup', 18);
  await sleep(700); // delivery + relay failure done; queued start still pending (err delay)
  check('s25b: relay failure shown before the queued REC repaints', screenB() === 'fail' && dB.getElementById('recordBtn').textContent.includes('Start'), screenB());
  await sleep(1600); // err-delayed queued start fires
  check('s25b: queued dictation still starts after the failure beat', dB.getElementById('recordBtn').textContent.includes('Stop'));
  B.deliverFail = false;
  B.batchDelayMs = 0;
  B.batchText = 'After redden.';
  pev(B.win, bigBtnB, 'pointerdown', 19); // tap stops the queued session
  pev(B.win, bigBtnB, 'pointerup', 19);
  await sleep(400);
  check('s25b: queued session delivered cleanly', (B.win._clip || '').includes('After redden.'), JSON.stringify(B.win._clip));

  // no-speech outcome: the sentinel lands on the clipboard — the big screen
  // must read as a FAILURE, never as a success-family DONE
  B.batchText = '';
  pev(B.win, bigBtnB, 'pointerdown', 20);
  await sleep(550);
  pev(B.win, bigBtnB, 'pointerup', 20);
  await sleep(400);
  check('s25b: no-speech outcome copies the sentinel', B.win._clip === '##DICTATION_FAILED##', JSON.stringify(B.win._clip));
  check('s25b: sentinel outcome reddens the screen', screenB() === 'fail', screenB());
  check('s25b: headline never claims DONE on a sentinel outcome', dB.getElementById('bigState').textContent === 'FAILED', dB.getElementById('bigState').textContent);
  B.batchText = 'Big note.';

  // settings stay reachable behind the existing sections
  dB.getElementById('bigSettingsBtn').click();
  check('s25b: Settings reveals the normal layout', dB.body.classList.contains('bigbtn-settings'));
  check('s25b: settings view CSS reveals the normal grid', html.includes('body.bigbtn.bigbtn-settings main > .grid { display: grid; }'));
  dB.getElementById('bigReturnBtn').click();
  check('s25b: Back returns to the button', !dB.body.classList.contains('bigbtn-settings'));

  // per-device override: "never" wins over an active join, and persists
  dB.getElementById('bigButtonMode').value = 'never';
  dB.getElementById('bigButtonMode').dispatchEvent(new B.win.Event('change', { bubbles: true }));
  check('s25b: override "never" wins over the join', !dB.body.classList.contains('bigbtn'), dB.body.className);
  await sleep(400); // debounced settings save
  check('s25b: override persisted as an additive v9 field', JSON.parse(B.win.localStorage.getItem('scribe_v2_settings_v9')).bigButtonMode === 'never');
  dB.getElementById('bigButtonMode').value = 'joined';
  dB.getElementById('bigButtonMode').dispatchEvent(new B.win.Event('change', { bubbles: true }));
  check('s25b: back to "joined" restores the layout', dB.body.classList.contains('bigbtn'));

  // realtime unexpected close: the finalize gap must render WORKING…, never a
  // stale green DONE flash, before the red failure lands
  dB.getElementById('engRealtime').click();
  pev(B.win, bigBtnB, 'pointerdown', 21); // quick tap toggles on
  pev(B.win, bigBtnB, 'pointerup', 21);
  await sleep(150);
  const rtSock = B.socks[B.socks.length - 1];
  rtSock.open();
  await sleep(30);
  // Live realtime words must SHOW on the big screen while recording — the whole
  // point of the realtime engine on mobile. (Regression: they only reached the
  // collapsed, head-truncated peek strip, so the newest words scrolled off-screen
  // and the strip looked frozen as the note grew.)
  rtSock.msg({ message_type: 'partial_transcript', text: 'the patient is recovering well and' });
  await sleep(20);
  check('s25b: live realtime words show on the big screen while recording',
    dB.getElementById('bigPeekText').textContent.includes('recovering well and'), dB.getElementById('bigPeekText').textContent);
  check('s25b: peek enters live mode (wrapped, tail-pinned) during recording', peekB.classList.contains('live'));
  rtSock.msg({ message_type: 'committed_transcript', text: 'Doomed note.' });
  rtSock.serverClose(); // dies mid-dictation, no user stop
  check('s25b: finalize gap renders WORKING, not a stale success', screenB() === 'busy', screenB());
  await sleep(300);
  check('s25b: unexpected close lands on the red screen', screenB() === 'fail', screenB());
  check('s25b: partial still delivered on the unexpected close', (B.win._clip || '').includes('Doomed note.'), JSON.stringify(B.win._clip));
  check('s25b: peek leaves live mode once recording ends', !peekB.classList.contains('live'));

  // ---- Leg C: the QR /?join= boot path lands in the big button ----
  const C = mkBigDom({ url: 'https://dictation.test/?join=btn789' });
  await sleep(100);
  const dC = C.dom.window.document;
  check('s25c: /?join= boot lands in the big-button layout', dC.body.classList.contains('bigbtn'), dC.body.className);
  check('s25c: scanned code joined + shown', dC.getElementById('bigJoinedBadge').textContent.includes('BTN789'), dC.getElementById('bigJoinedBadge').textContent);

  // ---- Leg D: override boots — "always" without a join, "never" despite one ----
  const D1 = mkBigDom({ settings: { bigButtonMode: 'always' } });
  await sleep(100);
  const dD1 = D1.dom.window.document;
  check('s25d: "always" boots into the big button with no join (solo phone)', dD1.body.classList.contains('bigbtn'), dD1.body.className);
  check('s25d: no Leave button without a join', dD1.getElementById('bigLeaveBtn').style.display === 'none');
  const D2 = mkBigDom({ settings: { bigButtonMode: 'never', joinedSessionCode: 'XYZ111' } });
  await sleep(100);
  check('s25d: persisted "never" beats a persisted join at boot', !D2.dom.window.document.body.classList.contains('bigbtn'), D2.dom.window.document.body.className);

  // ---- Leg E: joined phone whose LOCAL clipboard is denied (iOS refuses
  // writes outside a user gesture). The deliverable is the DESKTOP clipboard
  // via the relay — a denied local copy on an otherwise-clean outcome must
  // defer to the relay ack, not brand the dictation a false FAILED. ----
  const E = mkBigDom({ settings: { joinedSessionCode: 'IOSPHN' } });
  await sleep(100);
  const dE = E.dom.window.document;
  const bigBtnE = dE.getElementById('bigBtn');
  const screenE = () => dE.getElementById('bigUi').getAttribute('data-screen');
  const statusE = () => dE.getElementById('status').textContent;
  E.clipFail = true;
  dE.getElementById('apiKey').value = 'test-key';
  dE.getElementById('sonioxKey').value = 'test-skey';

  // clean dictation, desktop listening: the relay ack announces the outcome
  E.batchText = 'Relay note.';
  const vibesE1 = E.vibes.length;
  pev(E.win, bigBtnE, 'pointerdown', 1);
  await sleep(550);
  pev(E.win, bigBtnE, 'pointerup', 1);
  await sleep(400);
  check('s25e: local-copy denial with a live desktop is NOT a failure', !statusE().includes('FAILED'), statusE());
  check('s25e: relay ack announces the desktop delivery', statusE().includes('Delivered to the desktop'), statusE());
  check('s25e: screen lands green', screenE() === 'ok', screenE());
  check('s25e: done haptic closes the dictation', JSON.stringify(E.vibes[E.vibes.length - 1]) === '[40,60,40]', JSON.stringify(E.vibes.slice(vibesE1)));
  check('s25e: no fail haptic anywhere in the clean flow', !E.vibes.slice(vibesE1).some((v) => JSON.stringify(v) === '[220,90,220]'), JSON.stringify(E.vibes.slice(vibesE1)));
  check('s25e: phone clipboard genuinely untouched', E.win._clip === undefined, JSON.stringify(E.win._clip));

  // desktop gone: the zero-listener ack stays a loud red failure (no done cue)
  E.deliverListeners = 0;
  E.batchText = 'Down note.';
  const vibesE2 = E.vibes.length;
  pev(E.win, bigBtnE, 'pointerdown', 2);
  await sleep(550);
  pev(E.win, bigBtnE, 'pointerup', 2);
  await sleep(400);
  check('s25e: zero-listener ack still fails loudly', statusE().includes('Desktop link is DOWN') && screenE() === 'fail', statusE() + ' / ' + screenE());
  check('s25e: warn haptic, and never a done cue', JSON.stringify(E.vibes[E.vibes.length - 1]) === '[90,90,90]' && !E.vibes.slice(vibesE2).some((v) => JSON.stringify(v) === '[40,60,40]'), JSON.stringify(E.vibes.slice(vibesE2)));
  E.deliverListeners = 1;

  // relay hard failure: red + fail cue
  E.deliverFail = true;
  E.batchText = 'Failed relay note.';
  pev(E.win, bigBtnE, 'pointerdown', 3);
  await sleep(550);
  pev(E.win, bigBtnE, 'pointerup', 3);
  await sleep(400);
  check('s25e: relay failure stays a loud red failure', statusE().includes('Desktop relay FAILED') && screenE() === 'fail', statusE() + ' / ' + screenE());
  check('s25e: fail haptic closes the relay failure', JSON.stringify(E.vibes[E.vibes.length - 1]) === '[220,90,220]', JSON.stringify(E.vibes.slice(vibesE2)));
  E.deliverFail = false;

  // NOT joined: the local clipboard IS the deliverable again — a denied copy
  // stays the loud failure it always was
  dE.getElementById('phoneLeaveBtn').click();
  await sleep(20);
  E.batchText = 'Solo note.';
  dE.getElementById('recordBtn').click();
  await sleep(120);
  dE.getElementById('recordBtn').click();
  await sleep(400);
  check('s25e: unjoined denied copy is still a loud failure', statusE().includes('clipboard copy FAILED') && dE.getElementById('status').className.includes('err'), statusE());
  check('s25e: unjoined denied copy fail-beeps', JSON.stringify(E.vibes[E.vibes.length - 1]) === '[220,90,220]', JSON.stringify(E.vibes[E.vibes.length - 1]));
}

// ── Scenario 26: Deepgram Nova-3 realtime frame translation (Worker side) ──
// Realtime streams to Deepgram Nova-3 on Workers AI; the Worker translates between
// the client's frame vocabulary and Deepgram's protocol. Pure functions, so they
// test without a browser. The translator is DEFENSIVE across the three plausible
// on-wire shapes (Cloudflare doesn't publish nova-3's streaming envelope) and
// surfaces an unrecognized frame loudly. Loud-failure is the floor: any error frame
// must surface as a client {error}.
{
  const c2b = worker.novaClientToBackend;

  // Audio chunk -> raw PCM bytes (base64-decoded into a Uint8Array).
  const append = c2b(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: 'QUJD', commit: false, sample_rate: 16000 }));
  check('s26: audio chunk -> decoded PCM bytes', append.length === 1 && append[0] instanceof Uint8Array && String.fromCharCode(...append[0]) === 'ABC', JSON.stringify([...(append[0]||[])]));

  // Final flush (commit) -> ONLY CloseStream control JSON (Deepgram-on-Workers-AI
  // rejects other control variants; CloseStream alone finalizes + ends the stream).
  const commit = c2b(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: '', commit: true, sample_rate: 16000 }));
  const commitTypes = commit.map((f) => { try { return JSON.parse(f).type; } catch { return f; } });
  check('s26: commit -> CloseStream only', commit.length === 1 && commitTypes[0] === 'CloseStream', JSON.stringify(commitTypes));

  // Audio + commit on the same frame -> bytes then the CloseStream control, in order.
  const both = c2b(JSON.stringify({ message_type: 'input_audio_chunk', audio_base_64: 'WA==', commit: true }));
  check('s26: audio+commit -> bytes then CloseStream', both.length === 2 && both[0] instanceof Uint8Array && JSON.parse(both[1]).type === 'CloseStream', JSON.stringify([both[0] instanceof Uint8Array, both[1]]));

  // Non-audio / garbage frames are ignored, never forwarded.
  check('s26: non-chunk frames are dropped', c2b(JSON.stringify({ message_type: 'something_else' })).length === 0);
  check('s26: malformed JSON is dropped, not thrown', c2b('{not json').length === 0);

  // Backend -> client: shape (A), native Deepgram streaming Results. The running
  // partial reflects locked finalText + the current interim tail.
  const mkResult = (transcript, isFinal, extra) => JSON.stringify(Object.assign({ type: 'Results', is_final: !!isFinal, channel: { alternatives: [{ transcript }] } }, extra || {}));
  const toC = worker.makeNova3ToClient();
  const first = toC(mkResult('How are', false)).map(JSON.parse);
  check('s26: first Results emits session_started then partial', first[0].message_type === 'session_started' && first[1].message_type === 'partial_transcript' && first[1].text === 'How are', JSON.stringify(first));

  // is_final locks a segment into finalText.
  const r2 = toC(mkResult('How are you', true)).map(JSON.parse);
  check('s26: is_final Results locks into finalText', r2[0].message_type === 'partial_transcript' && r2[0].text === 'How are you', r2[0].text);

  // A following interim appends to the locked finalText (running view).
  const r3 = toC(mkResult('doing', false)).map(JSON.parse);
  check('s26: interim appends to locked final', r3[0].text === 'How are you doing', r3[0].text);

  // is_final segments only ever update the running partial — committed is NOT
  // emitted per-final (that append-duplicated into "hello hello world"); it comes
  // once on Metadata. So another is_final just extends the partial.
  const r4 = toC(mkResult('doing well', true)).map(JSON.parse);
  check('s26: is_final extends partial, does NOT commit', r4[0].message_type === 'partial_transcript' && r4[0].text === 'How are you doing well' && !r4.some((f) => f.message_type === 'committed_transcript'), JSON.stringify(r4));

  // Metadata (end of stream after CloseStream) -> the ONE committed_transcript with
  // the full accumulated text. This is the single lock-in (no duplication).
  const meta = toC(JSON.stringify({ type: 'Metadata', request_id: 'x' })).map(JSON.parse);
  check('s26: Metadata -> single committed_transcript with full text', meta.length === 1 && meta[0].message_type === 'committed_transcript' && meta[0].text === 'How are you doing well', JSON.stringify(meta));

  // Connected (handshake) / SpeechStarted / UtteranceEnd are benign lifecycle
  // frames -> ignored, NOT surfaced as errors (a fresh translator so the first-frame
  // session_started doesn't mask the assertion).
  check('s26: SpeechStarted produces no client frame', toC(JSON.stringify({ type: 'SpeechStarted' })).length === 0);
  const conn = worker.makeNova3ToClient()(JSON.stringify({ type: 'Connected', request_id: 'x', sequence_id: 0 })).map(JSON.parse);
  check('s26: Connected handshake is ignored (only session_started, no error)', conn.length === 1 && conn[0].message_type === 'session_started' && !conn.some((f) => f.message_type === 'error'), JSON.stringify(conn));
  const unknownF = worker.makeNova3ToClient()(JSON.stringify({ type: 'SomethingNew', foo: 1 })).map(JSON.parse);
  check('s26: unknown frame is ignored, not a loud error', !unknownF.some((f) => f.message_type === 'error'), JSON.stringify(unknownF));

  // Error-shaped frames -> loud {error}.
  const e1 = worker.makeNova3ToClient()(JSON.stringify({ type: 'Error', description: 'bad audio' })).map(JSON.parse);
  check('s26: type:Error -> loud error frame', e1.find((f) => f.message_type === 'error' && /bad audio/.test(f.error)), JSON.stringify(e1));
  const e2 = worker.makeNova3ToClient()(JSON.stringify({ error: 'quota exceeded' })).map(JSON.parse);
  check('s26: string error field -> loud error frame', e2.find((f) => f.message_type === 'error' && /quota exceeded/.test(f.error)), JSON.stringify(e2));

  // Shape (B): batch-style envelope surfaces text as a running partial (committed
  // still comes once via Metadata / the close backstop — no per-frame duplication).
  const b1 = worker.makeNova3ToClient()(JSON.stringify({ results: { channels: [{ alternatives: [{ transcript: 'batch shape' }] }] } })).map(JSON.parse);
  check('s26: batch-shape frame -> partial (text surfaced)', b1.find((f) => f.message_type === 'partial_transcript')?.text === 'batch shape', JSON.stringify(b1));

  // Shape (C): Flux-style EndOfTurn extends the running partial.
  const c1 = worker.makeNova3ToClient()(JSON.stringify({ event: 'EndOfTurn', transcript: 'turn shape' })).map(JSON.parse);
  check('s26: flux-shape EndOfTurn -> partial (text surfaced)', c1.find((f) => f.message_type === 'partial_transcript')?.text === 'turn shape', JSON.stringify(c1));

  // Unknown shape with no transcript -> ignored (no fabricated text, no fatal error).
  const unk = worker.makeNova3ToClient()(JSON.stringify({ totally: 'unexpected', shape: 1 })).map(JSON.parse);
  check('s26: unknown shape ignored (no transcript, no error)', !unk.some((f) => f.message_type === 'error' || f.message_type === 'partial_transcript' || f.message_type === 'committed_transcript'), JSON.stringify(unk));
}

// ── Scenario 27: AudioWorklet frame pump (mobile realtime fix) ──
// Realtime/hybrid audio is pumped by an AudioWorklet (off the main thread, so it
// can't be starved on phones into slow/sparse transcripts) with a ScriptProcessor
// fallback. The bulk of the suite above runs the FALLBACK path (the harness's
// MockAudioCtx exposes no audioWorklet); this scenario mocks the worklet so the
// PRIMARY path is covered: the module loads, an AudioWorkletNode is created (not a
// ScriptProcessor), and a frame posted on its port drives the same downsample →
// PCM → stream chokepoint, sending a spec-shaped chunk on the realtime socket.
console.log('--- scenario 27: AudioWorklet pump ---');
{
  let workletNode = null;
  let addModuleCalls = 0;
  let scriptProcessorCalls = 0;

  class MockWorkletCtx extends MockAudioCtx {
    constructor() {
      super();
      this.audioWorklet = { addModule: () => { addModuleCalls++; return Promise.resolve(); } };
    }
    createScriptProcessor() { scriptProcessorCalls++; return super.createScriptProcessor(); }
  }
  class MockAudioWorkletNode {
    constructor(ctx, name) {
      this.name = name;
      this.port = { onmessage: null, postMessage() {} };
      workletNode = this;
    }
    connect() {} disconnect() {}
  }

  const wsocks = [];
  const dom27 = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://dictation.test/',
    beforeParse(win) {
      win.isSecureContext = true;
      win.navigator.clipboard = { writeText: (t) => { win._clip = t; return Promise.resolve(); } };
      win.URL.createObjectURL = () => 'blob:worklet-mock';
      win.URL.revokeObjectURL = () => {};
      win.AudioContext = MockWorkletCtx;
      win.AudioWorkletNode = MockAudioWorkletNode;
      const track = { readyState: 'live', muted: false, addEventListener() {}, stop() { this.readyState = 'ended'; } };
      const stream = { getAudioTracks: () => [track], getTracks: () => [track] };
      win.navigator.mediaDevices = { getUserMedia: () => Promise.resolve(stream), addEventListener: () => {} };
      win.MediaRecorder = class {
        constructor() { this.state = 'inactive'; }
        static isTypeSupported() { return false; }
        start() { this.state = 'recording'; }
        stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.ondataavailable) this.ondataavailable({ data: new win.Blob([new Uint8Array(2048)], { type: 'audio/webm' }) }); if (this.onstop) this.onstop(); }
      };
      const SockClass = class extends MockWS { constructor(url) { super(url); wsocks.push(this); } };
      SockClass.CONNECTING = 0; SockClass.OPEN = 1; SockClass.CLOSING = 2; SockClass.CLOSED = 3;
      win.WebSocket = SockClass;
    },
  });
  await sleep(100);
  const d27 = dom27.window.document;
  d27.getElementById('sonioxKey').value = 'test-skey';
  d27.getElementById('engRealtime').click();
  d27.getElementById('recordBtn').click();
  await sleep(120);

  check('s27: the worklet module was loaded (addModule called)', addModuleCalls === 1, 'addModule=' + addModuleCalls);
  check('s27: an AudioWorkletNode is the pump, not a ScriptProcessor', !!workletNode && scriptProcessorCalls === 0, 'node=' + !!workletNode + ' sp=' + scriptProcessorCalls);
  check('s27: the pump wired a port.onmessage handler', typeof workletNode.port.onmessage === 'function');

  const sock27 = wsocks[wsocks.length - 1];
  sock27.open();
  await sleep(20);
  const sentBefore = sock27.sent.length;
  // A frame posted on the worklet port must flow through handleAudioFrame and be
  // streamed as a spec-shaped input_audio_chunk (proof the off-thread pump feeds
  // the same chokepoint the old onaudioprocess did).
  workletNode.port.onmessage({ data: new dom27.window.Float32Array(4096).fill(0.05) });
  await sleep(20);
  const chunk = sock27.sent.slice(sentBefore).map((s) => JSON.parse(s)).find((m) => m.message_type === 'input_audio_chunk');
  check('s27: a posted frame streams a spec-shaped audio chunk', !!chunk && typeof chunk.audio_base_64 === 'string' && chunk.audio_base_64.length > 0 && chunk.sample_rate === 16000, JSON.stringify(chunk));
}

// ===== Scenario 28: DIRECT stream (browser -> Soniox via temp key) =====
// The lowest-latency transport: ?rt=direct mints a Soniox temp key from the
// Worker, opens the WS straight to Soniox, sends the config first, streams BINARY
// PCM (no base64/JSON), translates tokens on-device, and ends with an
// empty-string commit. A mint failure must fall back to the proxy (never a dead
// mic). Solo session (no join) — joined sessions stay on the proxy for now.
console.log('--- scenario 28: direct stream ---');
{
  // ---- Part A: direct happy path ----
  const socks28 = [];
  const fetchCalls28 = [];
  let w28;
  const mkStream = () => ({ getAudioTracks: () => [{ readyState: 'live', enabled: true, muted: false, stop() {}, addEventListener() {} }], getTracks: () => [{ readyState: 'live', stop() {}, addEventListener() {} }] });
  const dom28 = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://dictation.test/?rt=direct',
    beforeParse(win) {
      w28 = win;
      win.isSecureContext = true;
      win.navigator.clipboard = { writeText: (t) => { win._clip = t; return Promise.resolve(); } };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.AudioContext = MockAudioCtx;
      win.navigator.mediaDevices = { getUserMedia: () => Promise.resolve(mkStream()), addEventListener() {} };
      win.fetch = (url, opts) => {
        fetchCalls28.push({ url: String(url), opts: opts || {} });
        if (String(url).includes('/api/soniox-token')) {
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"api_key":"tmp-key-123","expires_at":"soon"}') });
        }
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"text":"x"}') });
      };
      win.MediaRecorder = class { constructor(s) { this.state = 'inactive'; } static isTypeSupported() { return false; } start() { this.state = 'recording'; } stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.onstop) this.onstop(); } };
      const SockClass = class extends MockWS { constructor(url) { super(url); socks28.push(this); } };
      SockClass.CONNECTING = 0; SockClass.OPEN = 1; SockClass.CLOSING = 2; SockClass.CLOSED = 3;
      win.WebSocket = SockClass;
    },
  });
  await sleep(80);
  const doc28 = dom28.window.document;
  const pump28 = (n = 3) => { for (let i = 0; i < n; i++) scriptNode.onaudioprocess({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.05) } }); };

  doc28.getElementById('engRealtime').click();
  doc28.getElementById('apiKey').value = 'test-key';
  doc28.getElementById('sonioxKey').value = 'test-skey';
  pump28(2); // speaking as the key lands -> pre-roll ring
  doc28.getElementById('recordBtn').click();
  await sleep(80); // let the async temp-key mint resolve, then the WS opens

  check('s28: token minted via /api/soniox-token', fetchCalls28.some((c) => c.url.includes('/api/soniox-token')));
  const dsock = socks28.find((s) => s.url.includes('stt-rt.soniox.com'));
  check('s28: opens the WS straight to Soniox (no proxy hop)', !!dsock, dsock && dsock.url);

  if (dsock) {
    pump28(2); // buffered while connecting
    check('s28: no frames sent while connecting', dsock.sent.length === 0);
    dsock.open();
    await sleep(20);
    let cfg = null; try { cfg = JSON.parse(dsock.sent[0]); } catch (e) {}
    check('s28: first frame is the Soniox config with the temp key', !!(cfg && cfg.api_key === 'tmp-key-123' && cfg.model === 'stt-rt-v5' && cfg.audio_format === 'pcm_s16le' && cfg.sample_rate === 16000), JSON.stringify(cfg && { k: cfg.api_key, m: cfg.model }));
    check('s28: PTT config keeps endpoint detection OFF', cfg && cfg.enable_endpoint_detection === false);
    pump28(3);
    const audioFrames = dsock.sent.slice(1); // everything after the config frame
    check('s28: audio streams as binary PCM, not base64 JSON', audioFrames.length > 0 && audioFrames.every((f) => typeof f !== 'string' && f && typeof f.byteLength === 'number'), 'frames=' + audioFrames.length + ' first=' + typeof audioFrames[0]);

    // Soniox tokens -> on-device translation -> live display (markers dropped).
    dsock.msg({ tokens: [{ text: 'Patient presents', is_final: false }, { text: '<end>', is_final: false }] });
    await sleep(10);
    const latest28 = doc28.getElementById('latest').textContent || '';
    check('s28: Soniox tokens render as a live partial', latest28.includes('Patient presents'), latest28);
    check('s28: control markers (<end>) are dropped', !latest28.includes('<end>'), latest28);

    doc28.getElementById('recordBtn').click(); // stop -> tail -> commit
    await sleep(700); // > TAIL_MS
    check('s28: commit is an empty-string end-of-audio (binary protocol)', dsock.sent.includes(''), JSON.stringify(dsock.sent.filter((x) => typeof x === 'string')));

    dsock.msg({ tokens: [{ text: 'Patient presents with chest pain.', is_final: true }], finished: true });
    await sleep(400); // > COMMIT_QUIET_MS -> close -> finalize -> deliver
    check('s28: committed text lands on the clipboard', (w28._clip || '').includes('Patient presents with chest pain'), w28._clip);
  }

  // ---- Part B: mint failure -> proxy fallback (never a dead mic) ----
  const socks28b = [];
  const fetchCalls28b = [];
  const dom28b = new JSDOM(html, {
    runScripts: 'dangerously', url: 'https://dictation.test/?rt=direct',
    beforeParse(win) {
      win.isSecureContext = true;
      win.navigator.clipboard = { writeText: (t) => { win._clip = t; return Promise.resolve(); } };
      win.URL.createObjectURL = () => 'blob:mock';
      win.URL.revokeObjectURL = () => {};
      win.AudioContext = MockAudioCtx;
      win.navigator.mediaDevices = { getUserMedia: () => Promise.resolve(mkStream()), addEventListener() {} };
      win.fetch = (url, opts) => {
        fetchCalls28b.push({ url: String(url) });
        if (String(url).includes('/api/soniox-token')) {
          return Promise.resolve({ ok: false, status: 500, text: () => Promise.resolve('{"error":"SONIOX_API_KEY not set"}') });
        }
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve('{"text":"x"}') });
      };
      win.MediaRecorder = class { constructor(s) { this.state = 'inactive'; } static isTypeSupported() { return false; } start() { this.state = 'recording'; } stop() { if (this.state === 'inactive') return; this.state = 'inactive'; if (this.onstop) this.onstop(); } };
      const SockClass = class extends MockWS { constructor(url) { super(url); socks28b.push(this); } };
      SockClass.CONNECTING = 0; SockClass.OPEN = 1; SockClass.CLOSING = 2; SockClass.CLOSED = 3;
      win.WebSocket = SockClass;
    },
  });
  await sleep(80);
  const doc28b = dom28b.window.document;
  doc28b.getElementById('engRealtime').click();
  doc28b.getElementById('apiKey').value = 'test-key';
  doc28b.getElementById('sonioxKey').value = 'test-skey';
  doc28b.getElementById('recordBtn').click();
  await sleep(80);
  const proxySock = socks28b.find((s) => s.url.includes('/api/transcribe'));
  const directSock = socks28b.find((s) => s.url.includes('stt-rt.soniox.com'));
  check('s28: mint failure falls back to the Worker proxy transport', !!proxySock && !directSock, 'proxy=' + !!proxySock + ' direct=' + !!directSock);
}

console.log(failures === 0 ? 'ALL SCENARIOS PASSED' : failures + ' FAILURES');
process.exit(failures ? 1 : 0);
