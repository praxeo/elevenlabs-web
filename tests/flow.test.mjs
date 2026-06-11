// Session-flow simulation for the embedded client app.
//
// Run from the repo root:
//   npm install --no-save jsdom
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
// (scenario 0, asserted right after boot: legacy access-code migration shim,
//  batch default engine, append-mode off by default, latest transcript
//  restored from history, and the auth section's open/collapse behavior)
//
// Exits non-zero on any failure. Extend these scenarios whenever the session
// flow, beeps, clipboard behavior, or watchdog change.

import { JSDOM } from 'jsdom';
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
      value: { getUserMedia: () => Promise.resolve(mockStream), addEventListener() {} },
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
pump(4); // speak while connecting
check('no frames sent while connecting', s1.sent.length === 0);
s1.open();
await sleep(30);
check('pre-roll + buffered frames flushed on open', s1.sent.length === 7, s1.sent.length);
check('status shows live', status().includes('transcribing live'), status());
s1.msg({ message_type: 'session_started', session_id: 'sess-1', config: { keyterms: ['tachycardia', 'ascites'], no_verbatim: true } });
check('session_started surfaces server-confirmed keyterms', status().includes('(2 keyterms active)'), status());
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
doc.getElementById('recordBtn').click(); // stop -> tail -> commit -> await final
await sleep(700);
s12.msg({ message_type: 'committed_transcript', text: '' }); // final commit reply
await sleep(450); // quiet period passes -> finalize -> refine begins
check('refining status shown', status().includes('Refining via batch'), status());
check('link pill refining', doc.getElementById('linkPill').textContent === 'refining…', doc.getElementById('linkPill').textContent);
await sleep(600); // refine resolves
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
check('realtime 50-term cap respected', ktB.length <= 50, ktB.length);
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
    doc19b.getElementById('recordBtn').click();
    await sleep(50);

    const transcribeSock = socks19b.find((s) => s.url.includes('/api/transcribe'));
    check('phone WS URL includes session code', !!(transcribeSock && transcribeSock.url.includes('session=ABC123')));

    if (transcribeSock) {
      transcribeSock.open();
      transcribeSock.msg({ message_type: 'session_started', config: {} });
      // Use `text` field (ElevenLabs format); fires while recording so it seeds finalizedSegments
      transcribeSock.msg({ message_type: 'committed_transcript', text: 'Phone realtime.' });
      // Stop recording; tail window runs for TAIL_MS (600ms)
      doc19b.getElementById('recordBtn').click();
      await sleep(700); // > TAIL_MS — beginCommitPhase now sends commit:true
      // Server responds with a final committed transcript after the commit; this triggers
      // the COMMIT_QUIET_MS (350ms) close path instead of the 2500ms deadline
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

console.log(failures === 0 ? 'ALL SCENARIOS PASSED' : failures + ' FAILURES');
process.exit(failures ? 1 : 0);
