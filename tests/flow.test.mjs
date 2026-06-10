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

console.log(failures === 0 ? 'ALL SCENARIOS PASSED' : failures + ' FAILURES');
process.exit(failures ? 1 : 0);
