// Session-flow simulation for the embedded client app.
//
// Run from the repo root:
//   npm install --no-save jsdom
//   node tests/flow.test.mjs
//
// Renders the page through the real Worker fetch handler, boots it in jsdom
// with mocked WebSocket / audio graph / clipboard, and drives six scenarios:
//   1. happy path: buffer-while-connecting, tail streaming, commit, await-final
//   2. unexpected mid-dictation disconnect (must fail loudly, keep partial text)
//   3. dead-mic flatline alarm + empty-session sentinel
//   4. append-window expiry drops stale text
//   5. connect timeout fails loudly with sentinel
//   6. PTT pressed during finalization queues a new session
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
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  url: 'https://dictation.test/',
  beforeParse(window) {
    window.AudioContext = MockAudioCtx;
    window.WebSocket = MockWS;
    window.MediaRecorder = class {
      constructor() { this.state = 'inactive'; }
      static isTypeSupported() { return false; }
      start() { this.state = 'recording'; }
      stop() { this.state = 'inactive'; }
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
doc.getElementById('apiKey').value = 'test-key';

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

console.log(failures === 0 ? 'ALL SCENARIOS PASSED' : failures + ' FAILURES');
process.exit(failures ? 1 : 0);
