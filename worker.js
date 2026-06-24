import { KEYTERM_PRESETS } from './keyterms.js';

// Durable Object: one room per session code. The Worker posts transcript events
// here (fire-and-forget); desktop listeners receive them over a WebSocket.
// Resilience contract with the client:
//   - answers {"message_type":"ping"} with a pong (zombie-socket detection);
//   - retains the most recent phone_delivery and replays it to (re)connecting
//     listeners within the replay window (clients dedupe by delivery_id);
//   - acks /broadcast with the listener count, so the phone can fail loudly
//     when nobody was listening instead of assuming success.
const DELIVERY_REPLAY_WINDOW_MS = 2 * 60 * 1000;

export class SessionRoom {
  constructor(state, env) {
    this.listeners = new Map(); // id -> WebSocket
    this.lastDelivery = null;   // { body, ts } — most recent phone_delivery
  }

  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get("Upgrade") === "websocket") {
      const [client, server] = Object.values(new WebSocketPair());
      server.accept();

      const id = crypto.randomUUID();
      this.listeners.set(id, server);
      server.addEventListener("close", () => this.listeners.delete(id));
      server.addEventListener("error", () => this.listeners.delete(id));
      server.addEventListener("message", (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg && msg.message_type === "ping") {
            server.send(JSON.stringify({ message_type: "pong" }));
          }
        } catch {}
      });
      // A delivery that raced a listener drop must still reach the desktop.
      if (this.lastDelivery && Date.now() - this.lastDelivery.ts < DELIVERY_REPLAY_WINDOW_MS) {
        try { server.send(this.lastDelivery.body); } catch {}
      }
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "GET" && url.pathname.endsWith("/latest")) {
      const fresh = this.lastDelivery && Date.now() - this.lastDelivery.ts < DELIVERY_REPLAY_WINDOW_MS;
      const body = fresh
        ? '{"ok":true,"age_ms":' + (Date.now() - this.lastDelivery.ts) + ',"delivery":' + this.lastDelivery.body + '}'
        : '{"ok":true,"delivery":null}';
      return new Response(body, { headers: { "content-type": "application/json" } });
    }

    if (request.method === "POST" && url.pathname.endsWith("/broadcast")) {
      const message = await request.text();
      let isDelivery = false;
      try { isDelivery = JSON.parse(message).message_type === "phone_delivery"; } catch {}
      if (isDelivery) this.lastDelivery = { body: message, ts: Date.now() };
      let delivered = 0;
      for (const [id, ws] of this.listeners) {
        try { ws.send(message); delivered++; } catch { this.listeners.delete(id); }
      }
      return new Response(JSON.stringify({ ok: true, listeners: delivered }), {
        headers: { "content-type": "application/json" },
      });
    }

    return new Response("Not found", { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/transcribe") {
      // Batch-only: the recorded audio blob is POSTed for transcription.
      if (request.method === "POST") {
        return handleTranscribeBatch(request, env);
      }
      return new Response("Expected POST", { status: 400 });
    }

    if (url.pathname === "/" || url.pathname === "/index.html") {
      // Shared mode is on when both the master API key and a passphrase are set
      const sharedMode = Boolean(env && env.ELEVENLABS_API_KEY && env.APP_PASSPHRASE);
      return new Response(
        INDEX_HTML
          .replace("__SHARED_MODE__", sharedMode ? "true" : "false")
          // Function replacer: a plain string replacement would interpret
          // $-sequences inside the JSON as replacement patterns.
          .replace("__KEYTERM_PRESETS__", () => KEYTERM_PRESETS_CLIENT_JSON),
        {
          headers: {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
          },
        }
      );
    }

    if (url.pathname === "/manifest.webmanifest") {
      return new Response(JSON.stringify(MANIFEST), {
        headers: {
          "content-type": "application/manifest+json",
          "cache-control": "public, max-age=3600",
          // Some clinical/proxy middleboxes and extensions 302-redirect static
          // assets (adding params like ?_sm_byp=…); a redirected fetch is held
          // to CORS, so advertise it openly to keep the manifest loadable.
          "access-control-allow-origin": "*",
        },
      });
    }

    if (url.pathname === "/icon-192.png" || url.pathname === "/icon-512.png") {
      const b64 = url.pathname === "/icon-192.png" ? ICON_192_B64 : ICON_512_B64;
      const bin = atob(b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Response(bytes, {
        headers: {
          "content-type": "image/png",
          "cache-control": "public, max-age=86400",
          "access-control-allow-origin": "*",
        },
      });
    }

    if (url.pathname === "/favicon.ico") {
      return new Response(null, { status: 204 });
    }

    // Phone mic session relay via Durable Object
    if (url.pathname.startsWith("/api/session/")) {
      const parts = url.pathname.split("/"); // ["","api","session",code,?action]
      const code = (parts[3] || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      if (!code || code.length < 4 || code.length > 8) {
        return new Response("Invalid session code", { status: 400 });
      }
      if (!env || !env.SESSION_ROOM) {
        return new Response("Session rooms not available", { status: 503 });
      }
      const stub = env.SESSION_ROOM.get(env.SESSION_ROOM.idFromName(code));
      // Desktop listener: WebSocket upgrade
      if (request.headers.get("Upgrade") === "websocket") {
        return stub.fetch(request);
      }
      // Phone delivery: relay final authoritative text to desktop listeners
      if (request.method === "POST" && parts[4] === "deliver") {
        const body = await request.text();
        return stub.fetch("https://session-room/broadcast", {
          method: "POST",
          body: body,
        });
      }
      // Native pollers (e.g. the AHK script): read the held delivery without
      // joining the room — lets a native app write the clipboard with no
      // browser-focus requirement.
      if (request.method === "GET" && parts[4] === "latest") {
        return stub.fetch("https://session-room/latest");
      }
      return new Response("Not found", { status: 404 });
    }

    return new Response("Not found", { status: 404 });
  },
};

// Batch proxy: receives the recorded audio blob as multipart form data and
// forwards it to ElevenLabs batch Scribe v2. Serves pure batch mode and the
// hybrid mode's accuracy re-transcription pass.
async function handleTranscribeBatch(request, env) {
  try {
    const incoming = await request.formData();

    const clientKey  = String(incoming.get("api_key") || "").trim();
    const serverKey  = (env && env.ELEVENLABS_API_KEY) || "";
    const serverPass = ((env && env.APP_PASSPHRASE) || "").trim();

    let apiKey = clientKey;
    if (!apiKey && serverKey && serverPass) {
      const given = String(incoming.get("passphrase") || "").trim();
      if (!safeEqual(given, serverPass)) {
        return json({ error: "Invalid or missing access code." }, 401);
      }
      apiKey = serverKey;
    }

    const file = incoming.get("file");

    if (!apiKey) {
      return json({ error: "No ElevenLabs API key available (none provided, and no shared key/access code configured)." }, 400);
    }
    if (!file || typeof file === "string") return json({ error: "No audio file uploaded." }, 400);
    if (file.size < 1024) return json({ error: "Recording too short or empty." }, 400);
    if (file.size > 25 * 1024 * 1024) return json({ error: "Recording too large." }, 413);

    const form = new FormData();

    form.append("model_id", "scribe_v2");
    form.append("file", file, file.name || "recording.webm");
    form.append("file_format", String(incoming.get("file_format") || "other"));

    form.append("language_code", "en");

    // Diarization (keep-primary-speaker) is the lever against bystander voices
    // the mic picks up: noise suppression / iOS Voice Isolation strip *noise*,
    // but another person's speech is speech and survives both. When the client
    // asks for it, let Scribe label speakers (don't force num_speakers=1) and
    // return word-level data so the client can keep only the primary speaker.
    // The client does the filtering (the Worker stays a thin proxy); we just
    // shape the request so the per-word speaker_id is present.
    const diarize = incoming.get("diarize") === "true";
    if (diarize) {
      form.append("diarize", "true");
    } else {
      form.append("diarize", "false");
      form.append("num_speakers", "1");
    }
    form.append("temperature", "0");

    // Word-granular timestamps guarantee the words[] array (with speaker_id)
    // the client needs to drop other speakers; otherwise honor the client's ask.
    form.append(
      "timestamps_granularity",
      diarize ? "word" : String(incoming.get("timestamps_granularity") || "none")
    );

    const noVerbatim = incoming.get("no_verbatim") !== "false";
    form.append("no_verbatim", String(noVerbatim));

    form.append("tag_audio_events", String(incoming.get("tag_audio_events") === "true"));

    let keyterms = [];
    try {
      keyterms = JSON.parse(String(incoming.get("keyterms_json") || "[]"));
    } catch {
      keyterms = [];
    }

    // Batch API caps: 1000 terms, each < 50 chars and <= 5 words.
    for (const term of sanitizeKeyterms(keyterms, { maxChars: 49, maxWords: 5, maxTerms: 1000 })) {
      form.append("keyterms", term);
    }

    const eleven = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": apiKey },
      body: form,
    });

    const responseText = await eleven.text();

    return new Response(responseText, {
      status: eleven.status,
      headers: {
        "content-type":
          eleven.headers.get("content-type") || "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    return json(
      { error: "Worker transcription proxy failed.", message: err?.message || String(err) },
      500
    );
  }
}

function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

// Shared keyterm scrubber. The realtime and batch APIs accept different
// volumes/lengths, so the limits are parameters; the cleaning pipeline
// (strip risky chars, collapse whitespace, dedupe case-insensitively)
// is identical for both.
function sanitizeKeyterms(list, { maxChars, maxWords, maxTerms }) {
  const seen = new Set();
  return (Array.isArray(list) ? list : [])
    .filter((t) => typeof t === "string")
    .map((t) => t.trim().replace(/[<>{}\[\]\\]/g, "").replace(/\s+/g, " "))
    .filter(Boolean)
    .filter((t) => t.length <= maxChars && t.split(" ").length <= maxWords)
    .filter((t) => {
      const k = t.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, maxTerms);
}


// Scrubbed once at module init through the same pipeline the proxies use, so
// the JSON injected into the inline <script> can never carry <> { } [ ] \
// characters that could break out of the page.
const KEYTERM_PRESETS_CLIENT_JSON = JSON.stringify(
  KEYTERM_PRESETS.map((p) => ({
    id: String(p.id),
    label: String(p.label),
    always: Boolean(p.always),
    terms: sanitizeKeyterms(p.terms, { maxChars: 49, maxWords: 5, maxTerms: 1000 }),
  }))
);

// Web app manifest so the page is installable as a standalone app
// (Chrome/Edge: address-bar install icon, or menu -> "Install app").
const MANIFEST = {
  name: "Scribe Dictation",
  short_name: "Dictation",
  description: "Push-to-talk medical dictation via ElevenLabs Scribe v2 (batch)",
  start_url: "/",
  display: "standalone",
  background_color: "#0b0d10",
  theme_color: "#0b0d10",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
  ],
};

const ICON_192_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAMAAAADACAYAAABS3GwHAAAEb0lEQVR42u3dPVIbURRE4ZlXLME5iSMiSB2xJhbiNRGRQkREQs4ecILKKkpiZjT/r78T2VUGiVGf1/dKMmqbFbm5u/9sEM/r82O71m23wo5kKdo1Q//+9uKRRnP9+3Y1Gdqlgi/sGCvFHCK0go9kEdo5gi/0WEKGKURopwy/4GNpEcZKUIQfe+M4a2OfXWwFH8ltUIQfyW1QhB/JEhThR7IERfiRLEERfiRLUC75xsBeJBglwMEg4cdeJehqgSL8SJagdM39QA2cy3Qx9yN5HyhGHySPQsXlQTLF6Y/kFtAA0AA/bclAbRxnvQzdmoG9j0FGIOBYAMsvUpdhDQANABAAIACQRWsBRiKHX6eiAWAEAggAEADI4solWJaHp4/Of/P3zy8XigA5ge/6GkIQICL4Xd+LCASICj4RLMHCv+LtEACbDSUJjECRwTcSaQDh1wYEAAjg1NUCBBA2EhBAyEhAAIAATlctQACAANGnqhYgAEAAgAAAAfLmaXsAAQACAAQACAAQACAAQAAQwCUAAQACAAQACAAQACAAQACAAAABAAIABAAIABAAIABAAIAAAAEAAgAEqIK9fg6vzw8mAEAAgAAAAXLmafM/AQACJJ6qTn8CAARIPF2d/gSIDZnwEyA2bMJPAIAAiaeu0/9yrlyCacK3xmfyCr4GiG0D4SdArATCbwSKHIkEnwCRIgg+AaoZi/oIIfAEsCfAEgwQACAAQADAEjwVx8/GpC6mrkGYAOeegnx4+ogLwPdrcfh72nW4Sg09tELEDtD3QUwSxaFgCQZyBNACw3/GlF1AA0ADaIGMFnD6a4BYCSy+BBh0stUUmCE/S9rrABqgcgmc/ASIPuFcGwKMHoX2eIoOvd+pB0PsCDT0Ad+TBEPva3Ir2gEqk8DMT4BZT74tB+yS+5a+E8U3wKUSbEmES++PJwQIMCoIa4sw5vaFnwCTBWJpEcbenvD/x+8F+haMMcGa8z+TTCWY8BNgVgnOBXYLT7sKPwEGBWXKEK65Kwi+HSA2OMKvATbXBoKvAZyk7qsG0AaCTwAiCD4B9j8WLS2D0BMgTgahJ8Bul1Dv0d8mngVaUIq+oRZ+AgAEAAgAEAAgAEAAgAAAAQACAAQACAAQABiGd4N+sbVfdbgE3nSnAUAAgAAAAQACAAQACAAQAKgZL4R94UUhDQAQAIgS4PX5sW2aprn+fetqIIJD1l+fH1sNACMQQACAAECgABZhJC7AGgAa4JwhQK2n/0kBDpUA1M5x1o1AMAJ9N8MYhNqXXw0AnBJACyDl9O9sABKglvD3boBzpgB75lymS9cXaAHUOPr0GoFIgJrD3ymAfQA1zv2DBDg2iATYU/j77LK9GoAEqDH8g0YgEqC28A8SgASoLfyDBSABagp/0zTNqBe8bu7uPw9/fn978WhgN8G/uAG0AWoJ/+gGONUE2gBLBH+K8E8mwDkRyICpQz9V8GcRgAjYS/BnFeAnEUiBPmGfO/iLCDBEBmCp0K8iACmwdthP8Q9NZS5TPi79vAAAAABJRU5ErkJggg==";

const ICON_512_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAYAAAD0eNT6AAAOYklEQVR42u3dPVYcWRKA0aIOS8DHwZKFXCytiYWwJixcsLDkyGcPaqvPkRBVlT8vX76IuNec6emBzFLF9yILdHVgM9++//jtKgAs9/76fOUqbMOFNeQBxIEAwLAHEAUCwMA38AEEgQAw8AEQBALA0AdADAgAg/+zXz/f/AkDWOH27l4ICIAxh74hD5AnDirFQIlvtNXgN+wBakRBhRBI/Q22GPyGPkDdGMgcAim/sTWD38AHEAQVQiDVN7R08Bv6AGKgWgik+EYMfgCEQKEAWDL4DX0AWsVA5BAI+4XPHf4GPwBbhEDUCAj3RRv8AAiBYgEwZ/gb/AD0DoFIERDiCzX4ARACxQJg6vA3+AEYKQRGj4Cj4Q8A002dOaP/bbND1onBD4BtQLENgOEPgG1AsQ3AlAtk8AMQdRsw0iZgmA2A4Q9A9m3ASJuA3UvEyh+AapuAEbYBu/6fO/UDUDkE9oyA3R4BGP4AZDb6I4FdAsDwB0AE7BsB3QPA8AdABOwfAV2fPVz6Bg1+ADK79LmAnp8J6LYBMPwBsA14G2YT0CUADH8AGCsCNg8Awx8AxouA48gXAACqRkDoADhXMIY/ACLgbbctwGYBYPgDwLgRsEkAjPjXHgJARFvN1GPvL9TpHwDmzcYtIuA40jcIACKgj6YB4Lk/AGwTAa23AM0CwPAHgDgR0CQAfOgPAPpoNXM3/wyA0z8AjDc7VweA1T8A9I2AFluAVQFg+ANAzAg4urwAUM/iAHD6B4C4W4BFAWD4A0DsCPAIAAAKmh0ATv8AEH8LcOzxhQEAY83aWQHgN/4BwJjmzugmGwCnfwCItQWYHABO/wCQZwuwegPg9A8A8bYAkwLA6R8Acm0BVm0AnP4BIOYW4GIAOP0DQL4twOINgNM/AMTdAhyd/gGg3hZg0QbA6R8AYm8B/GVAAFDQyQCw/geA2M7N8tkbAOt/ABjLktl8dPoHgHpbgFkbAKd/AMixBfAhQAAo6J8AsP4HgFy+mu2TNwDW/wAwtjmz2iMAAChIAABA9QDw/B8Acvo84ydtADz/B4AYps5sjwAAoCABAACVA+DU83/rfwCI5dTs/nPW2wAAQOUNAAAgAAAAAQAApAsAHwAEgFwufRDQBgAAqm4AAAABAAAIAABAAAAAAgAAiOfKjwACQF63d/c2AACAAAAAAQAACAAAQAAAAAIAABAAAIAAAAAGd+0SQG6PLx+L/7dPDzcuIAgAIOugn/vvFAYgAIBEA3/p/7cgAAEAJB36U78uMQACAEg89MUACADA4D/7PQgBEABAgcEvBEAAAIUHvxAAAQAUHvxCAMbjNwGC4e/7BxsAwOCzDQAbAMDwd13ABgAw4GwDwAYAMPxdLxAAgGHmukEUHgGAATb8NfRIAGwAwPB3PQEBAIaV6woIADCkXF9AAIDh5DoDAgAMJdcbEABgGLnuIAAAAAEAOIW6/iAAAMPHfQABAIaOoeN+gAAAAAQAOG3ivoAAAEMG9wcEAAAgAMDpEvcJBAAYKrhfIAAAAAEATpO4byAAAAABAE6RuH8gAAAAAQBOj+4jIAAAQAAATo3uJwgAAEAAAAACAJKzLnZfQQAAAAIAABAAkI41sfsLAgAAEAAAgAAAAAQAxOf5sPsMAgAAEAAAgAAAAAQAACAAAAABABH4ZLj7DQIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAACAAAAABAAAIAABAAAAAAgAAEAAAgAAAAAQAAFR17RIQ2ePLh4vguu/q6eHGRcAGAAAQAACAAAAABAAAIAAAAAEAAAgAAEAAAAACAAAQAACAAAAABAAAIAAAQAAAAAIAABAAAIAAAAAEAAAgAAAAAQAACAAAQAAAAAIAABAAAIAAAADWunYJiOzp4cZFAFiyAXh/fb766r+4vbt3dQAgsFOz/P31+cojAACouAFwCQBAAAAAAgAAEAAAgAAAAAIHgB8FBIBczv0IoA0AAFTeAAAAAgAAEAAAQNoA8EFAAMjh0gcAbQAAoPoGAAAQAH/xGAAAYpg6s/8KgFOfAwAAYvs84z0CAICCBAAACIDTfA4AAMY2Z1b/EwA+BwAAuXw12z0CAICCZgWAxwAAMKa5M/rLAPAYAAByODXTZz8CsAUAgNin/7MBYAsAADlP/4s2AABAfIsCwGMAABjD0pl8NgA8BgCAmC7N8MWPAGwBACDm6X9SANgCAECu0/+qDYAtAADEPP1PDgBbAADIc/pfvQGwBQCAeKf/WQFgCwAAOU7/TTYAtgAAEOv0PzsAbAEAIP7pv9kGwBYAAOKc/hcFwLnCEAEA0H/4L9nQ+8uAAKCgRQFgCwAAcU//qzYAIgAAYg7/VQEAAMS1KgBsAQAg3um/yQZABABArOHfJADWfAMAwD6zs0kA+A2BANBHq5l77PEF2QIAwPrTf8sDd9NHACIAAMYf/s0DYM03BgCGfz/NA+BSoYgAAJg3G7f4rN0mGwAfCgSAsWfqcY8v2BYAAC7PxC0P1Jt+BkAEAMB4w3/zAFjzjQNA1eHfw+YB4EOBADBv9vX4LF2XDYAIAIBxhn+3ABABADDO8D8cDofuP6737fuP35f+mV8/37xKACgz+HsP/64bgDnfoG0AAIZ/sgAQAQAY/vsO/90CQAQAYPjv+5tzd/+VvVM+E3A4+FwAAHkG/97Df4gAmBMCIgAAp/42jqNcNI8EADD8C24A5mwCbAMAiDT4Rxv+Q20A5l4g2wAADP9EGwDbAAAM/oIbANsAAAz/4huAuZsA2wAA9h78EYZ/mAAQAgAY/IUDYG4ECAEAegz+aMM/ZAAIAQAM/sIBsCQChAAArQZ/5OEfPgDWhIAYAGDpT5FFHvypAkAIAGDwFw6AtSEgBgAM/eyDP3UAtAgBQQBQd+BnHvwlAqBlCIgBgBpDP/vgLxUArUNAFADkGfbVBn/JANg6BsQBwPhDvvLQFwCdQwCA8VQd/AJADAAY+gIAQQBg4AsABAGAgS8AEAUAhr0AQBwAGPLB/QfwL65wpcJThQAAAABJRU5ErkJggg==";

const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <meta name="theme-color" content="#0b0d10" />
  <link rel="manifest" href="/manifest.webmanifest" />
  <link rel="icon" type="image/png" href="/icon-192.png" />
  <link rel="apple-touch-icon" href="/icon-192.png" />
  <title>ElevenLabs Scribe v2 Dictation</title>
  <style>
    :root {
      --bg: #0b0d10;
      --panel: #151922;
      --panel2: #10141b;
      --text: #eef2f6;
      --muted: #9aa4b2;
      --line: #2a3140;
      --accent: #7dd3fc;
      --danger: #f87171;
      --ok: #86efac;
      --warn: #fde68a;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      background: var(--bg); color: var(--text); line-height: 1.35;
    }
    main { max-width: 1000px; margin: 0 auto; padding: 14px; }
    h1 { font-size: 18px; margin: 0 0 10px; }
    .grid { display: grid; grid-template-columns: 1fr; gap: 12px; }
    @media (min-width: 850px) { .grid { grid-template-columns: 1fr 380px; align-items: start; } }
    .card {
      background: var(--panel); border: 1px solid var(--line);
      border-radius: 14px; padding: 14px;
    }
    label { display: block; font-size: 13px; color: var(--muted); margin: 12px 0 6px; }
    textarea, input, select {
      width: 100%; background: var(--panel2); color: var(--text);
      border: 1px solid var(--line); border-radius: 10px; padding: 10px;
      font-size: 14px; outline: none;
    }
    input[type="range"] { padding: 0; }
    textarea { min-height: 120px; resize: vertical; }
    button {
      border: 1px solid var(--line); background: var(--panel2); color: var(--text);
      padding: 10px 12px; border-radius: 10px; font-size: 14px; cursor: pointer;
    }
    button:hover { border-color: var(--accent); }
    button.primary { background: #0c4a6e; border-color: #0369a1; }
    button.danger { background: #5f1717; border-color: #991b1b; }
    button:disabled { opacity: 0.5; cursor: not-allowed; }
    .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
    .row > * { flex: 1; }
    .row button { flex: 0 0 auto; }
    #recordBtn { flex: 1 1 auto; font-weight: 600; }
    .status {
      font-size: 13px; color: var(--muted); margin-top: 10px;
      min-height: 18px; white-space: pre-wrap;
    }
    .status.ok { color: var(--ok); }
    .status.warn { color: var(--warn); }
    .status.err { color: var(--danger); }
    .big {
      font-size: 18px; white-space: pre-wrap; min-height: 140px;
      background: var(--panel2); border: 1px solid var(--line);
      border-radius: 12px; padding: 14px;
    }
    .big[contenteditable="true"] { cursor: text; }
    .big[contenteditable="true"]:focus { outline: none; border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    .big.armed { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    .lastdict {
      margin-top: 12px; background: var(--panel2);
      border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px;
    }
    .lastdict-label { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .lastdict-text { white-space: pre-wrap; font-size: 14px; max-height: 96px; overflow: auto; caret-color: var(--accent); }
    /* While editing the slot, lift the height cap so the caret is never clipped
       by the overflow container (the "invisible caret on a new line" bug) and
       show the same accent edit ring as the active box (inset shadow = no reflow). */
    .lastdict-text[contenteditable="true"]:focus {
      outline: none; max-height: none; overflow: visible;
      box-shadow: inset 0 0 0 1px var(--accent); border-radius: 8px;
    }
    .hint { color: var(--muted); font-size: 13px; }
    .history-item { border-top: 1px solid var(--line); padding: 12px 0; }
    .history-meta { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
    .history-text { white-space: pre-wrap; font-size: 14px; }
    .history-text[contenteditable="true"] { outline: none; border: 1px solid var(--accent); border-radius: 8px; padding: 6px; background: var(--panel2); }
    button.active { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    .checkbox {
      display: flex; gap: 8px; align-items: center;
      color: var(--muted); font-size: 13px; margin-top: 10px;
    }
    .checkbox input { width: auto; }
    .meterwrap {
      position: relative; height: 14px; background: var(--panel2);
      border: 1px solid var(--line); border-radius: 8px; overflow: hidden; margin-top: 8px;
    }
    #meterBar { position: absolute; left: 0; top: 0; bottom: 0; width: 0%; background: var(--ok); }
    #openMark  { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--danger); left: 0%; }
    #closeMark { position: absolute; top: 0; bottom: 0; width: 2px; background: var(--warn);   left: 0%; }
    /* Live recording feedback: a scrolling voice waveform + timer + speech state,
       so a batch dictation visibly proves it is capturing (no realtime STT). */
    #recFeedback { margin-top: 10px; }
    .recfb-row { display: flex; align-items: center; gap: 8px; font-size: 13px; }
    #recDot { width: 10px; height: 10px; border-radius: 50%; background: var(--danger); flex: none; animation: recpulse 1.3s ease-in-out infinite; }
    @keyframes recpulse { 0%,100% { opacity: 1; } 50% { opacity: .25; } }
    #recState { color: var(--muted); }
    #recState.live { color: var(--ok); font-weight: 600; }
    #recTimer { margin-left: auto; font-variant-numeric: tabular-nums; font-weight: 600; color: var(--text); }
    #waveCanvas { width: 100%; height: 46px; margin-top: 6px; display: block; background: var(--panel2); border: 1px solid var(--line); border-radius: 8px; }
    .pill {
      display: inline-block; margin-left: 8px; font-size: 12px; padding: 1px 8px;
      border-radius: 999px; border: 1px solid var(--line); color: var(--muted);
    }
    .pill.open { color: #0b0d10; background: var(--ok); border-color: var(--ok); }
    .pill.ok   { color: var(--ok); border-color: var(--ok); }
    .pill.live { color: #0b0d10; background: var(--accent); border-color: var(--accent); }
    .pill.rec  { color: #fff; background: #b91c1c; border-color: #b91c1c; }
    .pill.fail { color: #fff; background: var(--danger); border-color: var(--danger); }
    .pill.warn { color: #0b0d10; background: var(--warn); border-color: var(--warn); }
    /* Phone-pairing overlay: the desktop's front-and-center QR, shown on demand
       from the compact "Pair a phone" button. Additive fixed overlay — the QR is
       big only WHILE pairing, then closes the moment a phone joins, so the
       primary card's tiny-window compactness rules are untouched. */
    #pairOverlay { display: none; position: fixed; inset: 0; z-index: 50;
      background: rgba(0,0,0,0.8); align-items: center; justify-content: center; padding: 16px; }
    #pairOverlay.show { display: flex; }
    body.bigbtn #pairOverlay { display: none !important; } /* a joined phone never hosts pairing */
    #pairCard { background: var(--panel); border: 1px solid var(--line); border-radius: 16px;
      padding: 22px; max-width: 360px; width: 100%; text-align: center; }
    #pairTitle { font-size: 18px; font-weight: 600; margin-bottom: 14px; }
    #pairQr { display: inline-block; line-height: 0; background: #fff; padding: 10px; border-radius: 12px; }
    #pairQr svg { width: min(64vmin, 280px); height: auto; display: block; }
    #pairCode { font-family: monospace; font-size: 34px; letter-spacing: 8px; color: var(--accent); margin: 16px 0 4px; }
    #pairInstr { font-size: 13px; color: var(--muted); line-height: 1.5; }
    #pairStatus { font-size: 13px; min-height: 18px; margin-top: 10px; color: var(--muted); }
    #pairStatus.ok { color: var(--ok); }
    #pairStatus.err { color: var(--danger); }
    #pairPhoneBtn { flex: 0 0 auto; }
    /* Desktop indicator that the paired phone is actively dictating. */
    #phoneRecBadge.rec { color: var(--danger); }
    #phoneRecBadge.xcribe { color: var(--muted); }
    #phoneRecBadge .recdot {
      display: inline-block; width: 10px; height: 10px; border-radius: 50%;
      background: var(--danger); animation: phoneRecPulse 1s ease-in-out infinite;
    }
    #phoneRecBadge.xcribe .recdot { background: var(--muted); animation: none; }
    @keyframes phoneRecPulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.25; } }
    /* Mic tips: a one-time, phone-first onboarding nudge for keeping OTHER
       people's voices out of the notes (iOS Voice Isolation + close-mic +
       push-to-talk discipline). Auto-shown once on the big-button surface,
       reopenable from the top row / Options. Highest-leverage accuracy lever. */
    #micTips { display: none; position: fixed; inset: 0; z-index: 60;
      background: rgba(0,0,0,0.8); align-items: center; justify-content: center; padding: 16px; }
    #micTips.show { display: flex; }
    #micTipsCard { background: var(--panel); border: 1px solid var(--line); border-radius: 16px;
      padding: 22px; max-width: 380px; width: 100%; max-height: 86vh; overflow-y: auto; }
    #micTipsTitle { font-size: 18px; font-weight: 600; margin-bottom: 6px; }
    #micTipsLede { font-size: 13px; color: var(--muted); margin-bottom: 6px; }
    #micTipsCard .mt-h { font-size: 13px; color: var(--accent); font-weight: 600; margin: 14px 0 6px; }
    #micTipsCard ol, #micTipsCard ul { margin: 0; padding-left: 20px; font-size: 14px; line-height: 1.55; }
    #micTipsCard li { margin: 5px 0; }
    #micTipsCard .mt-key { color: var(--text); font-weight: 600; }
    #micTipsCard .mt-note { font-size: 12px; color: var(--muted); margin-top: 6px; }
    .sliderval { color: var(--accent); font-size: 12px; }
    .legend { font-size: 11px; color: var(--muted); margin-top: 4px; }
    .legend .dr { color: var(--danger); }
    .legend .dy { color: var(--warn); }
    details.help {
      margin-top: 14px; border: 1px solid var(--line); border-radius: 10px;
      background: var(--panel2); padding: 0 12px;
    }
    details.help > summary {
      cursor: pointer; padding: 12px 0; font-size: 13px; color: var(--accent);
      list-style: none; user-select: none;
    }
    details.help > summary::-webkit-details-marker { display: none; }
    details.help > summary::before { content: "▸ "; }
    details.help[open] > summary::before { content: "▾ "; }
    details.help .body { padding: 0 0 12px; font-size: 13px; color: var(--text); }
    details.help h3 { font-size: 13px; margin: 12px 0 4px; color: var(--accent); }
    details.help p { margin: 4px 0; color: var(--muted); }
    details.help table { width: 100%; border-collapse: collapse; margin: 8px 0; font-size: 12px; }
    details.help td { border-top: 1px solid var(--line); padding: 6px 4px; vertical-align: top; }
    details.help td:first-child { color: var(--text); white-space: nowrap; padding-right: 10px; }
    details.help td:last-child { color: var(--muted); }
    details.help .tag { color: var(--danger); }
    details.help .tag.y { color: var(--warn); }
    kbd {
      background: #0f172a; border: 1px solid var(--line); border-radius: 6px;
      padding: 2px 6px; font-size: 12px; color: var(--text);
    }
    .divider { height: 1px; background: var(--line); margin: 18px 0 14px; }
    /* Tiny/minimized app window: shed chrome so record + status + transcript
       stay usable; everything else lives in the collapsible sections. */
    @media (max-width: 600px), (max-height: 600px) {
      main { padding: 8px; }
      h1 { display: none; }
      .grid { gap: 8px; }
      .card { padding: 10px; border-radius: 10px; }
      .big { min-height: 72px; font-size: 16px; padding: 10px; }
      textarea { min-height: 80px; }
      label { margin: 8px 0 4px; }
      .checkbox { margin-top: 8px; }
      details.help { margin-top: 8px; }
      .status { margin-top: 6px; }
    }
    /* Big-button dictation layout. Active only while body carries .bigbtn
       (joined to a desktop session, or forced by the per-device override) —
       NEVER keyed on screen size. Additive: a fixed overlay above the normal
       page, so the desktop layout and its tiny-window compactness rules above
       are untouched. */
    #bigUi, #bigReturnBtn { display: none; }
    body.bigbtn main > h1, body.bigbtn main > .grid { display: none; }
    body.bigbtn #bigUi {
      display: flex; flex-direction: column; position: fixed; inset: 0;
      z-index: 40; padding: 14px; gap: 10px; align-items: center;
      background: var(--bg); transition: background-color 0.25s;
    }
    body.bigbtn.bigbtn-settings #bigUi { display: none; }
    body.bigbtn.bigbtn-settings main > .grid { display: grid; }
    body.bigbtn.bigbtn-settings #bigReturnBtn {
      display: block; position: fixed; right: 12px; bottom: 12px; z-index: 41;
      background: #0c4a6e; border-color: #0369a1; font-weight: 600;
    }
    #bigTopRow { width: 100%; display: flex; gap: 8px; align-items: center; flex: 0 0 auto; }
    #bigJoinedBadge { font-family: monospace; letter-spacing: 2px; color: var(--accent); font-size: 14px; flex: 1 1 auto; }
    #bigCenter {
      flex: 1 1 auto; min-height: 0; width: 100%; display: flex;
      flex-direction: column; align-items: center; justify-content: center; gap: 14px;
    }
    #bigState { font-size: 30px; font-weight: 800; letter-spacing: 2px; min-height: 36px; text-align: center; }
    #bigBtn {
      width: min(64vw, 52vh); height: min(64vw, 52vh); border-radius: 50%;
      font-size: 20px; font-weight: 700; letter-spacing: 1px;
      border: 6px solid var(--line); background: var(--panel); color: var(--text);
      touch-action: none; user-select: none; -webkit-user-select: none;
      -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent;
    }
    #bigHint { font-size: 12px; color: var(--muted); }
    #bigStatus {
      font-size: 14px; color: var(--text); text-align: center;
      min-height: 18px; max-height: 18vh; overflow: auto; white-space: pre-wrap;
    }
    #bigPeek {
      flex: 0 0 auto; width: 100%; background: var(--panel2);
      border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
    }
    #bigPeek.armed { border-color: var(--accent); box-shadow: inset 0 0 0 1px var(--accent); }
    /* Accent the peek strip while it shows live text. */
    #bigPeek.live { border-color: var(--accent); }
    #bigPeekBar { padding: 8px 12px; font-size: 12px; color: var(--muted); cursor: pointer; user-select: none; -webkit-user-select: none; }
    #bigPeek.live #bigPeekBar { color: var(--accent); }
    #bigPeekText { padding: 0 12px 8px; font-size: 15px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; min-height: 20px; }
    #bigPeek.expanded #bigPeekText { white-space: pre-wrap; overflow: auto; text-overflow: clip; max-height: 38vh; cursor: pointer; }
    /* Live view: wrap and grow so the newest words stay on-screen instead of
       scrolling off the right edge of a head-truncated one-liner (the strip
       looked frozen as the note grew). updateBigPeek pins the scroll to the tail. */
    #bigPeek.live #bigPeekText { white-space: pre-wrap; overflow-y: auto; text-overflow: clip; max-height: 30vh; min-height: 48px; }
    /* Whole-screen status: the overlay background IS the at-arm's-length
       indicator, derived from the same transitions that drive the pills. */
    body.bigbtn #bigUi[data-screen="connecting"] { background: #3d3008; }
    body.bigbtn #bigUi[data-screen="rec"]        { background: #420d0d; }
    body.bigbtn #bigUi[data-screen="busy"]       { background: #3d3008; }
    body.bigbtn #bigUi[data-screen="ok"]         { background: #14532d; animation: bigFlash 0.7s ease-out; }
    body.bigbtn #bigUi[data-screen="warn"]       { background: #78350f; }
    body.bigbtn #bigUi[data-screen="fail"]       { background: #7f1d1d; }
    body.bigbtn #bigUi[data-screen="alarm"]      { background: #7f1d1d; animation: bigAlarm 0.5s linear infinite alternate; }
    #bigUi[data-screen="rec"] #bigBtn        { border-color: #ef4444; background: #b91c1c; color: #fff; animation: bigPulse 1.2s ease-in-out infinite; }
    #bigUi[data-screen="connecting"] #bigBtn { border-color: var(--warn); }
    #bigUi[data-screen="busy"] #bigBtn       { border-color: var(--warn); }
    #bigUi[data-screen="ok"] #bigBtn         { border-color: var(--ok); }
    #bigUi[data-screen="warn"] #bigBtn       { border-color: var(--warn); }
    #bigUi[data-screen="fail"] #bigBtn       { border-color: var(--danger); }
    #bigUi[data-screen="alarm"] #bigBtn      { border-color: var(--danger); }
    @keyframes bigPulse { 0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.55); } 50% { box-shadow: 0 0 0 24px rgba(239,68,68,0); } }
    @keyframes bigFlash { from { background: #22c55e; } }
    @keyframes bigAlarm { from { background: #7f1d1d; } to { background: #450a0a; } }
  </style>
</head>

<body>
<main>
  <h1>ElevenLabs Scribe v2 Dictation</h1>

  <div class="grid">
    <section class="card">
      <!-- Batch-only product: dictation uploads to ElevenLabs Scribe v2 on
           release. The live capture-feedback panel below proves the mic is
           hearing you while you record. -->
      <div class="row" style="margin-top: 10px;">
        <button id="recordBtn" class="primary">Start recording</button>
      </div>

      <label>Mic level
        <span id="micPill" class="pill">mic off</span>
        <span id="linkPill" class="pill">link idle</span>
        <span id="gateState" class="pill" title="Local noise gate state (affects the saved audio preview only)">closed</span>
      </label>
      <div class="meterwrap">
        <div id="meterBar"></div>
        <div id="closeMark"></div>
        <div id="openMark"></div>
      </div>

      <div id="recFeedback" style="display:none">
        <div class="recfb-row">
          <span id="recDot"></span>
          <span id="recState">Listening…</span>
          <span id="recTimer">0:00</span>
        </div>
        <canvas id="waveCanvas"></canvas>
      </div>

      <div class="status" id="status">
        Ctrl+Space: tap to start/stop, hold to talk (CapsLock via AHK also works).
        Browser beeps when text is ready on the clipboard — keep this tab focused
        until the beep, then switch windows and Ctrl+V.
      </div>

      <label>Latest transcript <span id="appendChip" class="pill" style="display:none;"></span></label>
      <div id="latest" class="big" title="Click to edit this text — clicking also arms 'Append next' so the next dictation adds onto this note."></div>

      <div class="row" style="margin-top: 10px;">
        <button id="copyBtn" title="Copy this note to the clipboard, then file it below and clear the box ready for a new dictation">Copy &amp; clear</button>
        <button id="appendToggleBtn" title="Arm 'append' so the next dictation is added to this note instead of starting a new one; tap again to cancel">➕ Append next</button>
        <button id="freshBtn" title="Clear the dictation box so the next dictation starts a new note (history is kept)">Clear dictation box</button>
      </div>

      <!-- "Last dictation" slot: the most recently filed note. The box above is
           the ACTIVE note; copying it (or starting a new dictation) files it here.
           Hidden until there's something filed (keeps the compact card compact). -->
      <div id="lastDictation" class="lastdict" style="display:none;">
        <div class="lastdict-label">Last dictation</div>
        <div id="lastDictationText" class="lastdict-text"></div>
        <div class="row" style="margin-top: 8px;">
          <button id="lastCopyBtn" title="Copy this filed note to the clipboard (leaves the box alone)">Copy</button>
          <button id="lastAppendBtn" title="Bring this note back into the box and arm append so the next dictation continues it">➕ Append to this</button>
        </div>
      </div>

      <div class="row" style="margin-top: 8px; align-items: center; gap: 8px;">
        <button id="pairPhoneBtn" title="Show a QR to pair your phone as the microphone — dictated text lands on this computer's clipboard">📱 Pair a phone</button>
        <!-- Live indicator: lights up when the paired phone starts dictating, so
             the desktop user knows audio is being captured before the text lands.
             Hidden until a phone_recording ping arrives (relayed, not buffered). -->
        <span id="phoneRecBadge" style="display:none; align-items: center; gap: 6px; font-size: 13px; font-weight: 600;"></span>
      </div>
    </section>

    <section class="card">
      <!-- Saved transcripts live at the TOP of this card for quick access to
           past dictations (moved up from the bottom). Collapsed by default; the
           persisted historyVisible toggle keeps the compact footprint. -->
      <div class="row">
        <button id="toggleHistoryBtn">Show saved transcripts</button>
        <button id="clearBtn">Clear history</button>
      </div>
      <div id="history" style="display:none;"></div>

      <details class="help" id="authSection">
        <summary id="authSummary">Access</summary>
        <div class="body">
          <div id="passphraseRow" style="display:none">
            <label for="passphrase">Passphrase</label>
            <input id="passphrase" type="password" placeholder="passphrase" autocomplete="off" />
          </div>

          <label for="apiKey" id="apiKeyLabel">ElevenLabs API key (batch)</label>
          <input id="apiKey" type="password" placeholder="xi-api-key" autocomplete="off" />

          <!-- Realtime now runs on Deepgram Nova-3 via Workers AI (no STT key). This
               legacy field is hidden but kept so saved settings/clear paths still resolve. -->
          <label for="sonioxKey" id="sonioxKeyLabel" style="display:none">Realtime STT key (unused — realtime runs on Workers AI)</label>
          <input id="sonioxKey" type="password" placeholder="unused" autocomplete="off" style="display:none" />

          <label class="checkbox">
            <input type="checkbox" id="saveApiKey" />
            Remember on this browser
          </label>

          <div class="row" style="margin-top: 10px;">
            <button id="forgetKeyBtn">Forget key</button>
          </div>
        </div>
      </details>

      <details class="help" id="optionsSection">
        <summary>Options</summary>
        <div class="body">
          <label class="checkbox" style="margin-top: 4px;">
            <input type="checkbox" id="autoCopy" checked />
            Auto‑copy transcript to clipboard
          </label>

          <label class="checkbox">
            <input type="checkbox" id="appendMode" />
            Append consecutive recordings (don't clear)
          </label>

          <div class="row" style="margin: 2px 0 0 24px;">
            <span class="hint">When on, every dictation adds to the note until you turn this off or clear the box. Off = each dictation starts fresh. (Use “➕ Append next” to append just once.)</span>
          </div>

          <label class="checkbox">
            <input type="checkbox" id="startBeep" checked />
            Start/done beeps (failure alarms always play)
          </label>

          <label for="hotkeyBtn">Push‑to‑talk hotkey</label>
          <div class="row">
            <button id="hotkeyBtn" title="Click, then press the key combo you want">Ctrl + Space</button>
            <button id="hotkeyResetBtn" title="Reset to Ctrl + Space">Reset</button>
          </div>
          <div class="hint" style="margin: 6px 0 12px;">
            Tap = start/stop · Hold = push‑to‑talk · F13/F14 (AutoHotkey) always work
          </div>

          <div class="hint" style="margin: 10px 0 4px; color: var(--text);">Phone mic</div>
          <div class="row" style="margin-bottom: 4px; flex-wrap: wrap; gap: 6px; align-items: center;">
            <button id="phoneStartBtn">Start phone session</button>
            <span id="phoneCodeBadge" style="display:none; font-family: monospace; font-size: 20px; letter-spacing: 3px; color: var(--accent);"></span>
            <button id="phoneStopBtn" style="display:none;">End session</button>
          </div>
          <div class="hint" id="phoneCodeHint" style="display:none; margin-bottom: 6px;"></div>
          <div id="phoneQr" style="display:none; width:148px; line-height:0; border-radius:6px; overflow:hidden; margin: 0 0 8px;"></div>
          <div class="row" style="align-items: center; margin-bottom: 8px; flex-wrap: wrap; gap: 6px;">
            <span class="hint" style="flex: 0 0 auto;">Join desktop:</span>
            <input id="phoneJoinInput" type="text" maxlength="6" placeholder="ABC123" style="flex: 0 0 72px; font-family: monospace; text-transform: uppercase; text-align: center;" />
            <button id="phoneJoinBtn">Join</button>
            <span id="phoneJoinBadge" style="display:none; color: var(--ok);">Joined</span>
            <button id="phoneLeaveBtn" style="display:none;">Leave</button>
          </div>

          <label for="bigButtonMode">Big-button layout (per device)</label>
          <select id="bigButtonMode">
            <option value="joined" selected>When joined to a desktop session</option>
            <option value="always">Always — solo phone dictation</option>
            <option value="never">Never — e.g. a desktop that joins</option>
          </select>
          <div class="hint" style="margin: 6px 0 4px;">
            Turns this device into a one-button dictation surface. Stored on this device only.
          </div>

          <div class="row" style="margin-top: 10px;">
            <button id="optionsMicTipsBtn" title="Tips for keeping other people's voices out of your notes">Mic tips — keep other voices out</button>
          </div>
        </div>
      </details>

      <details class="help" id="keytermsSection">
        <summary>Context / vocabulary keyterms</summary>
        <div class="body">
          <div id="presetRow"></div>

          <textarea id="keyterms" placeholder="One term per line. Examples:
tachycardia
ascites
right lower quadrant"></textarea>

          <div class="hint" id="keytermHint" style="margin-bottom: 12px;">
            Scribe v2 biases toward these terms. One per line, each &lt;= 20 chars, ≤5 words.
            <strong>Keyterms add ~20 % to cost.</strong> 0 / 50 terms.
          </div>
        </div>
      </details>

      <details class="help" id="advanced">
        <summary>Advanced audio &amp; noise settings</summary>
        <div class="body">
          <div class="legend">
            <span class="dr">red mark on meter = gate OPEN threshold</span> &nbsp;|&nbsp;
            <span class="dy">yellow = CLOSE threshold</span>
          </div>

          <label for="gateOpen">Gate open threshold <span class="sliderval" id="gateOpenVal"></span></label>
          <input id="gateOpen" type="range" min="0" max="0.12" step="0.001" value="0.030" />

          <label for="gateClose">Gate close threshold <span class="sliderval" id="gateCloseVal"></span></label>
          <input id="gateClose" type="range" min="0" max="0.12" step="0.001" value="0.008" />

          <label for="highpass">High‑pass filter <span class="sliderval" id="highpassVal"></span></label>
          <input id="highpass" type="range" min="0" max="200" step="5" value="85" />

          <div class="hint" id="gateHint" style="margin-top: 6px;"></div>

          <label class="checkbox">
            <input type="checkbox" id="noiseSuppress" checked />
            Browser noise suppression <span class="hint">(on by default; turn off to A/B if a close, quiet mic transcribes better)</span>
          </label>

          <label class="checkbox">
            <input type="checkbox" id="diarize" checked />
            Filter out other speakers <span class="hint">(on by default; keeps only the main voice — removes bystander speech the mic picks up. Noise suppression can't: another person's voice is speech. A status note reports anything removed.)</span>
          </label>

          <div id="batchOptsSection">
            <label class="checkbox">
              <input type="checkbox" id="tagEvents" />
              Tag audio events ((laughter), (cough), …) — batch transcription only
            </label>

            <label for="timestamps">Timestamps</label>
            <select id="timestamps">
              <option value="none" selected>none</option>
              <option value="word">word</option>
              <option value="character">character</option>
            </select>
          </div>

          <h3>How do these settings work?</h3>
          <p><strong>Local gate</strong>: the gate IS the recording — only audio loud enough to open it gets transcribed. With a close mic, raising the open threshold rejects quieter, more distant voices before they're ever recorded.</p>
          <p><strong>Noise filter</strong>: higher values ignore quiet hums, whispers, and background chatter.</p>
          <p><strong>Click filter</strong>: higher values stop brief clicks/rustling being read as speech.</p>
          <p><strong>Filter out other speakers</strong>: when a second person's voice is loud enough to clear the gate, the speaker filter is the only thing that can drop it — the gate can't tell two equally-loud voices apart. It keeps the main (most-spoken) voice and reports what it removed. Pair it with a close mic for the best result.</p>
        </div>
      </details>

      <details class="help">
        <summary>Last recorded audio &amp; downloads</summary>
        <div class="body">
          <label>Last recorded audio (captured locally)</label>
          <audio id="audioPreview" controls style="width:100%; margin-bottom:10px;"></audio>
          <div class="row">
            <button id="downloadAudioBtn">Download audio</button>
            <button id="downloadBtn">Download transcripts .txt</button>
          </div>
        </div>
      </details>

      <div class="hint" style="margin-top: 14px;">
        English‑only, Scribe v2. Mic stays warm between dictations for instant start.
        Audio uploads to ElevenLabs Scribe v2 on release.
      </div>
    </section>
  </div>

  <!-- Big-button dictation layout: hidden unless body.bigbtn (see CSS).
       A fixed overlay — the normal page above stays untouched for desktops. -->
  <div id="bigUi" data-screen="idle">
    <div id="bigTopRow">
      <span id="bigJoinedBadge"></span>
      <button id="bigTipsBtn" title="Tips for keeping other people's voices out of your notes">Mic tips</button>
      <button id="bigLeaveBtn">Leave</button>
      <button id="bigSettingsBtn" title="Engine, credentials, keyterms and all other settings">Settings</button>
    </div>
    <div id="bigCenter">
      <div id="bigState">READY</div>
      <button id="bigBtn">HOLD TO TALK</button>
      <div id="bigHint">hold = push‑to‑talk &middot; tap = start/stop</div>
      <div id="bigStatus"></div>
    </div>
    <div id="bigPeek">
      <div id="bigPeekBar">Latest transcript — tap to expand</div>
      <div id="bigPeekText"></div>
    </div>
  </div>
  <button id="bigReturnBtn">&#8592; Back to the button</button>

  <!-- Phone-pairing overlay: the desktop's front-and-center QR. Shown on demand
       from the compact "Pair a phone" button; auto-closes when a phone joins
       (the phone_join handshake) or on the first delivery. -->
  <div id="pairOverlay">
    <div id="pairCard">
      <div id="pairTitle">Scan to pair your phone</div>
      <div id="pairQr"></div>
      <div id="pairCode"></div>
      <div id="pairInstr">Point your phone camera at the code — or open this page on your phone and type the code below. Your phone becomes the microphone; dictated text lands on THIS computer's clipboard.</div>
      <div id="pairStatus"></div>
      <div class="row" style="justify-content: center; margin-top: 16px;">
        <button id="pairDoneBtn" class="primary">Done</button>
        <button id="pairEndBtn">End session</button>
      </div>
    </div>
  </div>

  <!-- Mic tips: a one-time onboarding nudge for keeping other people's voices
       out of the notes. Auto-shows once on the phone (big-button) surface;
       reopenable from the top row / Options. -->
  <div id="micTips">
    <div id="micTipsCard">
      <div id="micTipsTitle">Keep other voices out of your notes</div>
      <div id="micTipsLede">Dictation can pick up people talking near you. Two habits keep your notes clean:</div>

      <div id="micTipsIos">
        <div class="mt-h">On iPhone: turn on Voice Isolation — the single best fix</div>
        <ol>
          <li>Start a dictation (hold the button) so iPhone shows the mic control.</li>
          <li>Swipe down from the top‑right corner to open Control Center.</li>
          <li>Tap <span class="mt-key">Mic Mode</span> (it appears only while an app is using the mic).</li>
          <li>Choose <span class="mt-key">Voice Isolation</span>.</li>
        </ol>
        <div class="mt-note">You set it once — it sticks for this app. iOS removes other voices before they ever reach the page.</div>
      </div>

      <div id="micTipsAndroid" style="display:none">
        <div class="mt-h">On Android</div>
        <ul>
          <li>Turn on any <span class="mt-key">Voice Focus</span> / noise‑reduction option in your phone's mic or call settings.</li>
        </ul>
      </div>

      <div class="mt-h">Always</div>
      <ul>
        <li>Hold the phone <span class="mt-key">close to your mouth</span>, like a walkie‑talkie — this is the single biggest fix. The closer your voice, the more it drowns out the room, and the harder a distant talker is to pick up.</li>
        <li>Push‑to‑talk records <span class="mt-key">only while you hold</span> the button — let go the moment someone else speaks.</li>
        <li>Face away from other conversations, or step somewhere quieter, when you can.</li>
      </ul>

      <div class="mt-note">Voice Isolation and noise suppression remove background <em>noise</em> — fans, hums, clicks — but another person's voice is speech, so it can slip through even with them on. That's why a close mic matters. As a backstop this app also <span class="mt-key">automatically filters out other speakers</span> (keeps only the main voice) and tells you when it removed something — leave it on (Advanced) unless you have a reason not to.</div>

      <div class="row" style="justify-content: center; margin-top: 16px;">
        <button id="micTipsDoneBtn" class="primary">Got it</button>
      </div>
    </div>
  </div>
</main>

<script>
(() => {
  const SHARED_MODE      = (__SHARED_MODE__);
  // Deployer-curated keyterm lists (pre-sanitized), injected at serve time.
  const KEYTERM_PRESETS  = (__KEYTERM_PRESETS__);

  const apiKeyEl         = document.getElementById("apiKey");
  const apiKeyLabelEl    = document.getElementById("apiKeyLabel");
  const sonioxKeyEl     = document.getElementById("sonioxKey");
  const sonioxKeyLabelEl = document.getElementById("sonioxKeyLabel");
  const passphraseEl     = document.getElementById("passphrase");
  const passphraseRow    = document.getElementById("passphraseRow");
  const saveApiKeyEl     = document.getElementById("saveApiKey");
  const forgetKeyBtn     = document.getElementById("forgetKeyBtn");

  const recordBtn        = document.getElementById("recordBtn");
  const clearBtn         = document.getElementById("clearBtn");
  const copyBtn          = document.getElementById("copyBtn");
  const appendToggleBtn  = document.getElementById("appendToggleBtn");
  const freshBtn         = document.getElementById("freshBtn");
  const lastDictationEl     = document.getElementById("lastDictation");
  const lastDictationTextEl = document.getElementById("lastDictationText");
  const lastCopyBtn         = document.getElementById("lastCopyBtn");
  const lastAppendBtn       = document.getElementById("lastAppendBtn");
  const downloadBtn      = document.getElementById("downloadBtn");
  const downloadAudioBtn = document.getElementById("downloadAudioBtn");
  const toggleHistoryBtn = document.getElementById("toggleHistoryBtn");

  const statusEl         = document.getElementById("status");
  const latestEl         = document.getElementById("latest");
  const historyEl        = document.getElementById("history");
  const audioPreviewEl   = document.getElementById("audioPreview");

  const keytermsEl       = document.getElementById("keyterms");
  const keytermHintEl    = document.getElementById("keytermHint");
  const timestampsEl     = document.getElementById("timestamps");
  const tagEventsEl      = document.getElementById("tagEvents");
  const autoCopyEl       = document.getElementById("autoCopy");
  const appendModeEl     = document.getElementById("appendMode");
  const noiseSuppressEl  = document.getElementById("noiseSuppress");
  const diarizeEl        = document.getElementById("diarize");
  const startBeepEl      = document.getElementById("startBeep");

  const gateOpenEl       = document.getElementById("gateOpen");
  const gateCloseEl      = document.getElementById("gateClose");
  const gateOpenValEl    = document.getElementById("gateOpenVal");
  const gateCloseValEl   = document.getElementById("gateCloseVal");
  const highpassEl       = document.getElementById("highpass");
  const highpassValEl    = document.getElementById("highpassVal");

  const meterBar         = document.getElementById("meterBar");
  const openMark         = document.getElementById("openMark");
  const closeMark        = document.getElementById("closeMark");
  const gateStateEl      = document.getElementById("gateState");
  const recFeedbackEl    = document.getElementById("recFeedback");
  const waveCanvasEl     = document.getElementById("waveCanvas");
  const recTimerEl       = document.getElementById("recTimer");
  const recStateEl       = document.getElementById("recState");

  const appendChipEl     = document.getElementById("appendChip");
  const micPillEl        = document.getElementById("micPill");
  const linkPillEl       = document.getElementById("linkPill");
  const advancedEl       = document.getElementById("advanced");
  const authSectionEl    = document.getElementById("authSection");
  const authSummaryEl    = document.getElementById("authSummary");
  const optionsSectionEl = document.getElementById("optionsSection");
  const keytermsSectionEl = document.getElementById("keytermsSection");
  const presetRowEl       = document.getElementById("presetRow");
  const hotkeyBtn        = document.getElementById("hotkeyBtn");
  const hotkeyResetBtn   = document.getElementById("hotkeyResetBtn");
  const gateHintEl       = document.getElementById("gateHint");

  // Phone mic session elements
  const phoneStartBtnEl  = document.getElementById("phoneStartBtn");
  const phoneStopBtnEl   = document.getElementById("phoneStopBtn");
  const phoneCodeBadgeEl = document.getElementById("phoneCodeBadge");
  const phoneCodeHintEl  = document.getElementById("phoneCodeHint");
  const phoneQrEl        = document.getElementById("phoneQr");
  const phoneJoinInputEl = document.getElementById("phoneJoinInput");
  const phoneJoinBtnEl   = document.getElementById("phoneJoinBtn");
  const phoneJoinBadgeEl = document.getElementById("phoneJoinBadge");
  const phoneLeaveBtnEl  = document.getElementById("phoneLeaveBtn");
  const phoneRecBadgeEl  = document.getElementById("phoneRecBadge");

  // Front-and-center phone-pairing overlay elements
  const pairPhoneBtnEl   = document.getElementById("pairPhoneBtn");
  const pairOverlayEl    = document.getElementById("pairOverlay");
  const pairQrEl         = document.getElementById("pairQr");
  const pairCodeEl       = document.getElementById("pairCode");
  const pairStatusEl     = document.getElementById("pairStatus");
  const pairDoneBtnEl    = document.getElementById("pairDoneBtn");
  const pairEndBtnEl     = document.getElementById("pairEndBtn");

  // Mic-tips onboarding (keep other voices out)
  const micTipsEl        = document.getElementById("micTips");
  const micTipsIosEl     = document.getElementById("micTipsIos");
  const micTipsAndroidEl = document.getElementById("micTipsAndroid");
  const micTipsDoneBtnEl = document.getElementById("micTipsDoneBtn");
  const bigTipsBtnEl     = document.getElementById("bigTipsBtn");
  const optionsMicTipsBtnEl = document.getElementById("optionsMicTipsBtn");

  // Big-button dictation layout elements
  const bigUiEl          = document.getElementById("bigUi");
  const bigBtnEl         = document.getElementById("bigBtn");
  const bigStateEl       = document.getElementById("bigState");
  const bigStatusEl      = document.getElementById("bigStatus");
  const bigJoinedBadgeEl = document.getElementById("bigJoinedBadge");
  const bigLeaveBtnEl    = document.getElementById("bigLeaveBtn");
  const bigSettingsBtnEl = document.getElementById("bigSettingsBtn");
  const bigReturnBtnEl   = document.getElementById("bigReturnBtn");
  const bigPeekEl        = document.getElementById("bigPeek");
  const bigPeekBarEl     = document.getElementById("bigPeekBar");
  const bigPeekTextEl    = document.getElementById("bigPeekText");
  const bigButtonModeEl  = document.getElementById("bigButtonMode");

  let mediaRecorder = null;
  let chunks = [];
  let recording = false;
  let stopping = false;
  let stopRequested = false;
  let latestText = "";
  let lastAudioBlob = null;
  let lastAudioUrl = null;

  let finalizedSegments = [];
  let currentPartial = "";
  // The "Last dictation" slot: the most recently FILED note (the active box note
  // moves here when you Copy latest, clear the box, or start a fresh dictation).
  // In-memory only — re-derived from history at boot (restoreLatestFromHistory).
  let archivedText = "";
  // Diagnostic: ?debug=1 logs phone-link listener frames to the console AND an
  // on-screen overlay (foolproof when DevTools is filtered or unavailable). Off
  // by default; purely additive.
  var RT_DEBUG = (window.location.search.indexOf("debug=1") >= 0);
  function rtDebugLog(line) {
    if (!RT_DEBUG) return;
    try { console.log(line); } catch (e) {}
    try {
      var box = document.getElementById("rtdbg");
      if (!box) {
        box = document.createElement("pre");
        box.id = "rtdbg";
        box.style.cssText = "position:fixed;left:0;right:0;bottom:0;max-height:42vh;overflow:auto;margin:0;padding:6px;background:rgba(0,0,0,0.88);color:#3f6;font:11px/1.35 monospace;z-index:2147483647;white-space:pre-wrap;border-top:2px solid #3f6";
        (document.body || document.documentElement).appendChild(box);
      }
      box.textContent += line + "\\n";
      var dbgLines = box.textContent.split("\\n");
      if (dbgLines.length > 160) box.textContent = dbgLines.slice(dbgLines.length - 160).join("\\n");
      box.scrollTop = box.scrollHeight;
    } catch (e) {}
  }

  // Per-session flow state
  let sessionSeq = 0;          // bumps each recording; stale callbacks bail out
  let sessionFinalized = true;
  let userStopped = false;     // distinguishes clean PTT-release from unexpected disconnect
  let stopPhase = null;        // null while batch-only
  let pendingStart = false;    // F13 pressed while previous session was finalizing
  let pendingStartTimer = null; // armed deferred start from maybePendingStart; cancellable until it fires
  let lastWsError = "";
  let recStartedAt = 0;
  let speechDetected = false;
  let maxRmsSeen = 0;
  let micAlarmFired = false;
  let mutedSince = 0;
  let connectTimer = null;
  let tailTimer = null;
  let finalDeadlineTimer = null;
  let quietTimer = null;

  // Phone mic session state
  let phoneSessionCode  = "";   // desktop: generated code for the active session
  let phoneSessionWs    = null; // desktop: WebSocket listening for phone transcripts
  let phonePingTimer    = null; // desktop: heartbeat interval while a session is active
  let phoneLastPongAt   = 0;    // desktop: last time the room socket proved it is alive
  let phoneReconnectTimer = null; // desktop: pending reconnect attempt
  let phoneReconnectDelayMs = 0;  // desktop: current reconnect backoff
  let phoneFallbackTimer = null;  // desktop: grace timer before live-text fallback delivery
  let lastDeliveryId    = "";   // desktop: most recent phone_delivery id (migrated into recentDeliveryIds)
  let recentDeliveryIds = [];   // desktop: ring of recent ids — dedupes BOTH room replays and retried/out-of-order re-POSTs
  let pendingCopyText   = "";   // desktop: delivery whose clipboard write failed; retried on focus
  let joinedSessionCode = "";   // phone: code entered to join a desktop session
  let remoteCommitted   = "";   // desktop: accumulated committed text from phone
  let remoteHasDelivery = false; // desktop: phone_delivery received; suppress fallback
  let phoneJoined       = false; // desktop: a phone has joined this session (phone_join ping / first delivery) — drives the pairing overlay/button
  let phoneRecTimer     = null;  // desktop: safety auto-clear for the "phone is recording/transcribing" indicator (in case a stop/delivery ping is missed)
  let micTipsSeen       = false; // per-device: the "keep other voices out" onboarding nudge has been dismissed
  let micTipsAutoShown  = false; // session: the nudge has auto-shown once this load (re-show is guarded by micTipsSeen across loads)

  // Phone-side durable delivery queue (joined device): an undelivered relay is
  // persisted (pendingDeliveries) and retried — on link heal and at boot —
  // until a desktop listener acks it, so a phone that dies after transcribing
  // but before delivering still lands the text. See the queue functions below.
  let deliveryQueue       = [];   // [{id,text,ts}] awaiting a desktop listener ack
  let flushChain          = Promise.resolve(); // serializes flushes so re-POSTs never interleave (FIFO room ordering)
  let deliveryRetryTimer  = null; // scheduled re-flush while the queue is non-empty
  let deliveryRetryDelayMs = 0;   // current retry backoff

  // Big-button layout state. The screen indicator is DERIVED from the same
  // transitions that drive the status line and pills (recorded below) — the
  // layout adds no session machinery of its own.
  let lastStatusCls     = "";    // class of the most recent setStatus
  let lastMicPillState  = "off"; // most recent setMicPill state
  let lastLinkPillState = "idle"; // most recent setLinkPill state
  let bigBtnEngaged   = false;  // current button press started/queued a dictation
  let bigBtnDownAt    = 0;
  let bigBtnPointerId = null;   // owning pointer; other touches are ignored
  let bigPeekExpanded = false;

  // In-app push-to-talk hotkey (F13/F14 via AHK always work in addition)
  const DEFAULT_HOTKEY = { ctrl: true, alt: false, shift: false, meta: false, code: "Space" };
  let hotkey = Object.assign({}, DEFAULT_HOTKEY);
  let capturingHotkey = false;
  let hotkeyEngaged = false; // current press-cycle started/queued a dictation
  let hotkeyDownAt = 0;

  // Persistent audio nodes
  let stream = null;
  let audioCtx = null;
  let hpFilter = null;
  let analyserNode = null;
  let gateNode = null;
  let destNode = null;
  let gateTimer = null;
  let gateBuf = null;
  let micEverGranted = false; // getUserMedia has succeeded this session (iOS has no Permissions API for the mic)
  // iOS leaves a track that died while the PWA was backgrounded looking alive
  // (readyState "live", muted false, no "ended" event), so audioGraphHealthy()
  // trusts a corpse and ensureAudio() reuses a dead graph on resume — the mic
  // looks engaged but records silence. Any backgrounding sets this; ensureAudio
  // then forces a full rebuild (a fresh getUserMedia track is genuinely live).
  let audioSuspect = false;
  let wakeLock = null;        // screen wake lock: iOS auto-lock reclaims the mic (held per dictation, and across the phone's big-button surface — see wakeLockDesired)
  let gateIsOpen = false;
  let gateLastOpen = 0;
  let lastMeterPct = -1;

  let historyVisible = false;
  let historyExpanded = false; // session-only: false = show the last HISTORY_PAGE, true = show all
  const HISTORY_PAGE = 10;     // newest-N shown by default so the list stays compact
  let appendArmed = false; // one-shot: clicking the transcript box arms "append the next dictation"

  // Engine: batch-only. sessionEngine is snapshotted at session start.
  const DEFAULT_ENGINE = "batch";
  let engine = DEFAULT_ENGINE;
  let sessionEngine = DEFAULT_ENGINE;
  let sessionBaseText = "";  // note text this session appends onto (batch splices into it)
  let finishing = false;     // a finalize is still uploading; serializes sessions
  let precomputedBatchKeyterms = null; // [LATENCY] batch keyterms JSON snapshotted at session start, off the stop-to-upload critical path

  const METER_MAX    = 0.12;
  const HOLD_SECONDS = 0.9;
  const DICTATION_SENTINEL = "##DICTATION_FAILED##";

  const FLATLINE_RMS       = 0.0008; // below this for the whole session = mic is almost certainly dead
  const HOTKEY_TAP_MS      = 400;   // press shorter than this = tap (toggle); longer = hold (PTT)

  const BATCH_UPLOAD_TIMEOUT_MS = 15000; // [LATENCY] pure batch: 15s deadline fails faster on a hung request (was 30s)

  // Phone link (desktop listener <-> session room)
  const PHONE_PING_INTERVAL_MS  = 25000; // heartbeat cadence on the listener socket
  const PHONE_PONG_TIMEOUT_MS   = 90000; // no room traffic for this long = zombie socket; force a reconnect (sized for background-tab timer throttling, ~1 tick/min)
  const PHONE_RECONNECT_MAX_MS  = 15000; // reconnect backoff cap
  const PHONE_FALLBACK_GRACE_MS = 10000; // after phone_session_end, wait this long for the authoritative phone_delivery (hybrid refine worst case) before falling back to live text
  const RELAY_TIMEOUT_MS        = 10000; // phone->room delivery ack deadline; a hung relay must fail loudly, and the queued next session waits on the ack

  // Phone-side durable delivery queue: an undelivered relay (POST failed, or a
  // zero-listener ack means the desktop was down past the room's 2-min replay
  // buffer) is persisted and retried until a desktop listener acks it.
  const DELIVERY_QUEUE_RETRY_MS     = 5000;   // backoff floor for re-POSTing a queued delivery while the link is down
  const DELIVERY_QUEUE_RETRY_MAX_MS = 30000;  // retry backoff cap
  const DELIVERY_QUEUE_MAX          = 20;     // cap the queue (drop oldest, still in history) so it can never grow unbounded
  const DELIVERY_QUEUE_TTL_MS       = 30 * 60 * 1000; // drop a delivery too stale to safely auto-land on a chart hours later (still in history)
  const DELIVERY_DEDUPE_RING        = 12;     // desktop: remember this many recent ids so a retried/out-of-order re-POST can never re-copy stale text

  // Batch keyterm caps (the Worker re-enforces these server-side too)
  const BATCH_KEYTERM_MAX_CHARS    = 49;
  const BATCH_KEYTERM_MAX_TERMS    = 1000;

  const STORE_KEY              = "scribe_v2_transcripts_v9";
  const SETTINGS_KEY           = "scribe_v2_settings_v9";
  const API_KEY_STORAGE_KEY    = "elevenlabs_api_key_browser_v9";
  const SONIOX_KEY_STORAGE_KEY = "soniox_api_key_browser_v9";
  const PASSPHRASE_STORAGE_KEY = "scribe_v2_passphrase_v9";
  // The pre-merge batch app stored the shared access code under this key;
  // read it as a fallback so those users keep their saved code.
  const LEGACY_ACCESS_CODE_KEY = "scribe_v2_access_code_v9";

  /* ───── Audio cues ─────
     Beeps prefer the persistent (already running) AudioContext: a fresh
     AudioContext created while the tab is in the background often starts
     suspended and never sounds — exactly when you most need the cue. */
  // The desktop listener in a phone session never records, so audioCtx may not
  // exist when its cues must sound — beepCtx is warmed from the session-start
  // click (a user gesture) so those beeps stay audible in a background tab.
  let beepCtx = null;
  function warmBeepCtx() {
    try {
      if (!beepCtx) beepCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (beepCtx.state !== "running") beepCtx.resume();
    } catch (e) {}
  }

  function beep(freq, ms, when) {
    try {
      const reuse = (audioCtx && audioCtx.state === "running") ? audioCtx
                  : (beepCtx && beepCtx.state === "running") ? beepCtx : null;
      const ctx = reuse || new (window.AudioContext || window.webkitAudioContext)();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = freq;
      gain.gain.value = 0.06;
      osc.connect(gain);
      gain.connect(ctx.destination);
      const t0 = ctx.currentTime + (when || 0);
      osc.start(t0);
      osc.stop(t0 + ms / 1000);
      if (!reuse) setTimeout(() => ctx.close(), ((when || 0) + ms / 1000) * 1000 + 60);
    } catch (e) {}
  }

  // Haptics mirror the beep vocabulary where the device supports it. They
  // ride inside the beep functions so every call site gets both for free —
  // a vibration never replaces a sound, it accompanies it.
  function haptic(pattern) {
    try { if (navigator.vibrate) navigator.vibrate(pattern); } catch (e) {}
  }

  // Start/done cues respect the checkbox; failure sounds always play.
  function startBeep() { if (startBeepEl.checked) { beep(760, 130); haptic(30); } }
  function doneBeep()  { if (startBeepEl.checked) { beep(1046, 90, 0); beep(1568, 130, 0.10); haptic([40, 60, 40]); } }
  function failBeep()  { beep(300, 280); haptic([220, 90, 220]); }
  function micAlarmBeep() { beep(330, 170, 0); beep(280, 170, 0.22); beep(240, 260, 0.44); haptic([250, 100, 250, 100, 250]); }
  // Two-tone warn: degraded-but-usable outcomes (e.g. hybrid refine failed,
  // live text delivered instead). Always audible, like failBeep.
  function warnBeep()  { beep(520, 140, 0); beep(520, 140, 0.20); haptic([90, 90, 90]); }

  /* ───── Text processing ───── */
  function cleanTranscript(raw) {
    // Newline-strip, ellipsis-strip, and trailing-space were once toggles but
    // are now always on (the only sane defaults for paste-into-Cerner) — the
    // checkboxes were removed. Downstream paste workflows depend on this shape.
    let t = raw;
    // Scribe renders dictation pauses as ellipses; strip both forms.
    t = t.replace(/\\u2026/g, " ").replace(/\\.{3,}/g, " ");
    t = t.replace(/[\\r\\n]+/g, " ");
    t = t.replace(/ +/g, " ").trim();
    t = t.replace(/ ([,.;:!?])/g, "$1");
    if (t.length > 0) t += " ";
    return t;
  }

  function updateLiveDisplay() {
    const combined = finalizedSegments.join(" ") + (currentPartial ? " " + currentPartial : "");
    const cleaned = cleanTranscript(combined);
    latestText = cleaned;
    latestEl.textContent = cleaned;
    updateBigPeek();
    renderLastDictation();
  }

  // The "Last dictation" slot. The active box note moves here when it's filed
  // (Copy latest / Clear box / starting a fresh dictation); the slot is just a
  // read-only view of the last filed note with its own Copy + "Append to this".
  // Hidden when empty or mid-session so the compact card stays compact.
  function renderLastDictation() {
    if (!lastDictationEl) return;
    // The slot text is hand-editable while idle (contenteditable + persist on
    // blur, see the slot handlers) — so while it's being edited, keep it shown
    // and never rewrite textContent (that would collapse the caret).
    const editing = lastDictationTextEl && document.activeElement === lastDictationTextEl;
    const t = (archivedText || "").trim();
    // Always available for edits/append — it no longer disappears mid-session.
    // Only hidden when there is genuinely nothing filed (and not being edited),
    // so an empty box never clutters the compact card.
    if (!t && !editing) {
      lastDictationEl.style.display = "none";
      return;
    }
    lastDictationEl.style.display = "";
    if (lastDictationTextEl) {
      lastDictationTextEl.setAttribute("contenteditable", "true");
      if (!editing) lastDictationTextEl.textContent = t;
    }
    // "Append to this" pulls the slot note back into the box, so it only makes
    // sense when the box is empty and we're idle — otherwise it would clobber the
    // active note (use the box's own "Append next" then) or fight a live session.
    if (lastAppendBtn) lastAppendBtn.disabled =
      recording || stopping || finishing || Boolean(latestText && latestText.trim());
  }

  // File the given text into the slot (no-op for empty text, so filing an
  // already-empty box never wipes the slot). The note is already in history;
  // the slot is just the most-recent filed note surfaced next to the box.
  function fileToSlot(text) {
    if (text && text.trim()) {
      archivedText = text.trim();
      renderLastDictation();
    }
  }

  // Clear the active note box (Copy latest / Clear box / fresh-start all use it).
  function clearBox() {
    finalizedSegments = [];
    currentPartial = "";
    latestText = "";
    if (latestEl) latestEl.textContent = "";
    appendArmed = false;
  }

  // The transcript box is hand-editable only while idle — during a session the
  // live/finalize paths own its text (updateLiveDisplay) and an editable box
  // would fight the cursor. Derive editability from session state; never flip it
  // mid-edit (setAttribute to the same value would be a no-op anyway).
  function refreshLatestEditable() {
    if (!latestEl) return;
    const want = (!recording && !stopping && !finishing) ? "true" : "false";
    if (latestEl.getAttribute("contenteditable") !== want) latestEl.setAttribute("contenteditable", want);
  }

  // contenteditable accepts rich HTML on paste; force plain text so a pasted
  // snippet can't smuggle markup into a note that gets copied into a chart.
  function plainTextPaste(e) {
    e.preventDefault();
    let t = "";
    try { t = (e.clipboardData || window.clipboardData).getData("text/plain"); } catch (_) {}
    try { document.execCommand("insertText", false, t); }
    catch (_) {
      // Fallback for environments without execCommand: append at the end.
      const el = e.target;
      if (el && typeof el.textContent === "string") {
        el.textContent += t;
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
  }

  function setStatus(msg, cls) {
    statusEl.className = "status " + (cls || "");
    statusEl.textContent = msg;
    lastStatusCls = cls || "";
    updateBigScreen();
  }

  function setMicPill(state) {
    // state: "off" | "ready" | "rec" | "fail"
    lastMicPillState = state;
    if (state === "rec")        { micPillEl.textContent = "REC";       micPillEl.className = "pill rec"; }
    else if (state === "ready") { micPillEl.textContent = "mic ready"; micPillEl.className = "pill ok"; }
    else if (state === "fail")  { micPillEl.textContent = "MIC FAIL";  micPillEl.className = "pill fail"; }
    else                        { micPillEl.textContent = "mic off";   micPillEl.className = "pill"; }
    updateBigScreen();
  }

  function setLinkPill(state) {
    // state: "idle" | "connecting" | "live" | "fail" | "uploading" | "refining"
    lastLinkPillState = state;
    if (state === "live")            { linkPillEl.textContent = "LIVE";        linkPillEl.className = "pill live"; }
    else if (state === "connecting") { linkPillEl.textContent = "connecting…"; linkPillEl.className = "pill warn"; }
    else if (state === "uploading")  { linkPillEl.textContent = "uploading…";  linkPillEl.className = "pill warn"; }
    else if (state === "refining")   { linkPillEl.textContent = "refining…";   linkPillEl.className = "pill warn"; }
    else if (state === "fail")       { linkPillEl.textContent = "LINK FAIL";   linkPillEl.className = "pill fail"; }
    else                             { linkPillEl.textContent = "link idle";   linkPillEl.className = "pill"; }
    updateBigScreen();
  }

  function updateAppendChip() {
    const hasText = Boolean(latestText && latestText.trim());
    if (!hasText) appendArmed = false; // nothing left to append to
    renderLastDictation(); // mirror session/box state into the slot (hide on rec, button enable)
    latestEl.classList.toggle("armed", appendArmed && !recording);
    if (appendToggleBtn) {
      appendToggleBtn.classList.toggle("active", appendArmed && !recording);
      appendToggleBtn.disabled = !hasText || recording || stopping || finishing;
    }
    updateBigPeek(); // big layout mirrors the text + armed state (1s interval keeps it honest)
    if (!hasText || recording) {
      appendChipEl.style.display = "none";
      return;
    }
    if (appendArmed) {
      // One-shot arm from clicking the box — beats the checkbox/window.
      appendChipEl.style.display = "";
      appendChipEl.textContent = "next dictation appends (box clicked)";
      appendChipEl.className = "pill ok";
      return;
    }
    if (!appendModeEl.checked) {
      appendChipEl.style.display = "none";
      return;
    }
    appendChipEl.style.display = "";
    appendChipEl.textContent = "next dictation appends";
    appendChipEl.className = "pill ok";
  }

  /* ───── Engine UI (batch-only) ───── */
  function applyEngineUI() {
    if (gateHintEl) {
      gateHintEl.textContent =
        "Batch: the gate IS the recording — only audio loud enough to open it gets transcribed.";
    }
    if (gateStateEl) {
      gateStateEl.title =
        "Local noise gate state (decides what gets recorded and transcribed)";
    }
  }

  /* ───── Access section (API key / passphrase) ─────
     Collapses once credentials exist so the working UI stays compact;
     reopens whenever credentials are missing or forgotten. */
  function hasAuth() {
    if (apiKeyEl.value.trim()) return true;
    if (sonioxKeyEl && sonioxKeyEl.value.trim()) return true;
    return Boolean(SHARED_MODE && passphraseEl.value.trim());
  }

  function updateAuthUI() {
    if (!authSummaryEl) return;
    if (apiKeyEl.value.trim() || (sonioxKeyEl && sonioxKeyEl.value.trim())) {
      authSummaryEl.textContent = "Access — API key set ✓";
    } else if (SHARED_MODE && passphraseEl.value.trim()) {
      authSummaryEl.textContent = "Access — passphrase set ✓";
    } else {
      authSummaryEl.textContent = SHARED_MODE
        ? "Access — enter the passphrase"
        : "Access — enter your API key";
    }
  }

  /* ───── Configurable push-to-talk hotkey ───── */
  function hotkeyLabel(hk) {
    if (!hk || !hk.code) return "none";
    const parts = [];
    if (hk.ctrl)  parts.push("Ctrl");
    if (hk.alt)   parts.push("Alt");
    if (hk.shift) parts.push("Shift");
    if (hk.meta)  parts.push("Win");
    let k = hk.code;
    if (k.indexOf("Key") === 0) k = k.slice(3);
    else if (k.indexOf("Digit") === 0) k = k.slice(5);
    parts.push(k);
    return parts.join(" + ");
  }

  function hotkeyMatches(e) {
    if (!hotkey || !hotkey.code) return false;
    return e.code === hotkey.code &&
           e.ctrlKey  === !!hotkey.ctrl &&
           e.altKey   === !!hotkey.alt &&
           e.shiftKey === !!hotkey.shift &&
           e.metaKey  === !!hotkey.meta;
  }

  function updateHotkeyUI() {
    hotkeyBtn.textContent = capturingHotkey ? "press a key combo… (Esc cancels)" : hotkeyLabel(hotkey);
  }

  // Parses the custom-terms textarea; each call site filters to what its API
  // accepts (realtime: 50 terms <= 20 chars; batch: 1000 terms < 50 chars).
  // Call sites send effectiveKeyterms(), which merges the presets in.
  function parseKeyterms(raw, maxChars, maxTerms) {
    return raw
      .split(/[\\r\\n]+/)
      .map((s) => s.trim().replace(/\\s+/g, " ").replace(/[<>{}\\[\\]\\\\]/g, ""))
      .filter(Boolean)
      .filter((s) => s.length <= maxChars && s.split(" ").length <= 5)
      .slice(0, maxTerms);
  }

  // Preset checkboxes, rendered from the injected KEYTERM_PRESETS at boot —
  // before loadSettings, which re-checks the persisted ones.
  const presetInputs = {}; // preset id -> its checkbox input

  function renderPresetRow() {
    if (!presetRowEl || !Array.isArray(KEYTERM_PRESETS)) return;
    for (const p of KEYTERM_PRESETS) {
      if (p.always) continue; // always-on lists never render — they just apply
      const lab = document.createElement("label");
      lab.className = "checkbox";
      lab.title = p.terms.join(", "); // hover shows what the list biases toward
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.setAttribute("data-preset", p.id);
      cb.addEventListener("change", () => { updateKeytermHint(); saveSettings(); });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(p.label + " (" + p.terms.length + " terms)"));
      presetRowEl.appendChild(lab);
      presetInputs[p.id] = cb;
    }
  }

  // Effective keyterms for one API call: custom terms, then checked presets,
  // then the always-on lists — deduped case-insensitively, capped per API.
  // The order IS the trim priority when the realtime 50-term cap overflows;
  // batch (1000) effectively never trims, so in batch/hybrid the clipboard
  // text benefits from every list even when the live feed had to drop some.
  function effectiveKeyterms(maxChars, maxTerms) {
    const out = [];
    const seen = {};
    const push = (t) => {
      if (typeof t !== "string" || !t) return;
      if (t.length > maxChars || t.split(" ").length > 5) return;
      const k = t.toLowerCase();
      if (seen[k]) return;
      seen[k] = true;
      out.push(t);
    };
    for (const t of parseKeyterms(keytermsEl.value, maxChars, Infinity)) push(t);
    for (const p of KEYTERM_PRESETS) {
      if (!p.always && presetInputs[p.id] && presetInputs[p.id].checked) {
        for (const t of p.terms) push(t);
      }
    }
    for (const p of KEYTERM_PRESETS) {
      if (p.always) { for (const t of p.terms) push(t); }
    }
    return out.slice(0, maxTerms);
  }

  function updateKeytermHint() {
    let alwaysCount = 0;
    for (const p of KEYTERM_PRESETS) { if (p.always) alwaysCount += p.terms.length; }
    const bt = effectiveKeyterms(BATCH_KEYTERM_MAX_CHARS, BATCH_KEYTERM_MAX_TERMS).length;
    keytermHintEl.innerHTML =
      "Scribe biases toward these terms (one per line) plus the checked lists" +
      (alwaysCount ? " and " + alwaysCount + " always-on standard terms" : "") + ". " +
      "<strong>Keyterms add ~20 % to cost.</strong> " +
      "Batch sends " + bt + " / 1000 (each &lt; 50 chars).";
  }

  /* ───── Gate UI ───── */
  function enforceGateOrder(changed) {
    let open = Number(gateOpenEl.value);
    let close = Number(gateCloseEl.value);
    if (open < close) {
      if (changed === "open") gateCloseEl.value = String(open);
      else gateOpenEl.value = String(close);
    }
  }

  function updateGateLabels() {
    gateOpenValEl.textContent  = "(" + Number(gateOpenEl.value).toFixed(3) + ")";
    gateCloseValEl.textContent = "(" + Number(gateCloseEl.value).toFixed(3) + ")";
    highpassValEl.textContent  =
      Number(highpassEl.value) > 0 ? "(" + highpassEl.value + " Hz)" : "(off)";

    openMark.style.left  = Math.min(100, (Number(gateOpenEl.value)  / METER_MAX) * 100) + "%";
    closeMark.style.left = Math.min(100, (Number(gateCloseEl.value) / METER_MAX) * 100) + "%";
  }

  function setGateStateUI(isOpen) {
    gateStateEl.textContent = isOpen ? "OPEN" : "closed";
    gateStateEl.className  = isOpen ? "pill open" : "pill";
  }

  // ───── Live recording feedback (waveform + timer + speech state) ─────
  // Driven by the existing analyser (no STT). Proves a batch dictation is
  // capturing your voice: a scrolling level history + a "Hearing you" state when
  // the gate is open + an elapsed timer. Canvas is optional (jsdom has none) — it
  // degrades to just the timer/state when getContext is unavailable.
  let waveCtx = null;
  let waveLevels = [];
  let waveColor = "#3fb950";
  let waveColorDim = "#6b7280";
  let recTimerLastSec = -1;
  let recFeedbackOn = false;

  function showRecFeedback(on) {
    if (!recFeedbackEl) return;
    if (on === recFeedbackOn) return;
    recFeedbackOn = on;
    recFeedbackEl.style.display = on ? "" : "none";
    if (!on) return;
    waveLevels = [];
    recTimerLastSec = -1;
    if (recTimerEl) recTimerEl.textContent = "0:00";
    if (recStateEl) { recStateEl.textContent = "Listening…"; recStateEl.className = ""; }
    try {
      var cs = getComputedStyle(document.documentElement);
      waveColor = (cs.getPropertyValue("--ok") || "").trim() || waveColor;
      waveColorDim = (cs.getPropertyValue("--muted") || "").trim() || waveColorDim;
    } catch (e) {}
    try {
      var w = waveCanvasEl.clientWidth || 320;
      waveCanvasEl.width = w;
      waveCanvasEl.height = 46;
      waveCtx = waveCanvasEl.getContext ? waveCanvasEl.getContext("2d") : null;
    } catch (e) { waveCtx = null; }
  }

  // Called each gate-meter tick while recording: advance the timer, reflect the
  // speech state, push the level, and redraw.
  function updateRecFeedback(rms) {
    if (!recFeedbackOn) return;
    var elapsed = recStartedAt ? Math.floor((Date.now() - recStartedAt) / 1000) : 0;
    if (elapsed !== recTimerLastSec) {
      recTimerLastSec = elapsed;
      var mm = Math.floor(elapsed / 60), ss = elapsed % 60;
      if (recTimerEl) recTimerEl.textContent = mm + ":" + (ss < 10 ? "0" : "") + ss;
    }
    if (recStateEl) {
      if (gateIsOpen) { recStateEl.textContent = "Hearing you"; recStateEl.className = "live"; }
      else { recStateEl.textContent = "Listening…"; recStateEl.className = ""; }
    }
    waveLevels.push(Math.min(1, rms / METER_MAX));
    drawWave();
  }

  function drawWave() {
    if (!waveCtx) return;
    var W = waveCanvasEl.width, H = waveCanvasEl.height;
    var step = 4; // 3px bar + 1px gap
    var maxBars = Math.max(1, Math.floor(W / step));
    while (waveLevels.length > maxBars) waveLevels.shift();
    waveCtx.clearRect(0, 0, W, H);
    var mid = H / 2;
    for (var i = 0; i < waveLevels.length; i++) {
      var lv = waveLevels[i];
      var h = Math.max(2, lv * (H - 6));
      var x = W - (waveLevels.length - i) * step;
      waveCtx.fillStyle = lv > 0.05 ? waveColor : waveColorDim;
      waveCtx.fillRect(x, mid - h / 2, 3, h);
    }
  }

  /* ───── Storage / Persistence ───── */
  let saveTimer = null;
  function saveSettings() {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(saveSettingsNow, 250);
  }

  function saveSettingsNow() {
    const s = {
      engine:         engine,
      keyterms:       keytermsEl.value,
      presetIds:      Object.keys(presetInputs).filter((id) => presetInputs[id].checked),
      timestamps:     timestampsEl.value,
      tagEvents:      tagEventsEl.checked,
      autoCopy:       autoCopyEl.checked,
      appendMode:     appendModeEl.checked,
      saveApiKey:     saveApiKeyEl.checked,
      noiseSuppress:  noiseSuppressEl.checked,
      diarize:        diarizeEl.checked, // per-device: keep-primary-speaker filter (on by default)
      startBeep:      startBeepEl.checked,
      gateOpen:       gateOpenEl.value,
      gateClose:       gateCloseEl.value,
      highpass:       highpassEl.value,
      advancedOpen:   Boolean(advancedEl && advancedEl.open),
      optionsOpen:    Boolean(optionsSectionEl && optionsSectionEl.open),
      keytermsOpen:   Boolean(keytermsSectionEl && keytermsSectionEl.open),
      hotkey:         hotkey,
      historyVisible: historyVisible,
      // Phone link: survive reloads/PWA kills — the desktop resumes its room,
      // the phone rejoins automatically, and replay dedupe survives the reload.
      phoneSessionCode:  phoneSessionCode,
      joinedSessionCode: joinedSessionCode,
      lastDeliveryId:    lastDeliveryId,
      recentDeliveryIds: recentDeliveryIds, // desktop dedupe ring (per-device)
      pendingDeliveries: deliveryQueue,     // phone outbound queue, durable across reloads/PWA kills (per-device)
      // iOS has no Permissions API for the mic; persisting the grant is what
      // lets a relaunched PWA re-warm the mic at boot instead of staying cold.
      micGranted:        micEverGranted,
      // Big-button layout override — a PER-DEVICE setting by design (the
      // portable/per-device settings split planned in the roadmap): a phone
      // forced to "always" must not drag a desktop sharing its profile along.
      bigButtonMode:     bigButtonModeEl ? bigButtonModeEl.value : "joined",
      // Per-device: the "keep other voices out" onboarding nudge was dismissed.
      micTipsSeen:       micTipsSeen,
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));

    if (saveApiKeyEl.checked) {
      localStorage.setItem(API_KEY_STORAGE_KEY, apiKeyEl.value.trim());
      if (sonioxKeyEl) localStorage.setItem(SONIOX_KEY_STORAGE_KEY, sonioxKeyEl.value.trim());
      if (passphraseEl) localStorage.setItem(PASSPHRASE_STORAGE_KEY, passphraseEl.value.trim());
    } else {
      localStorage.removeItem(API_KEY_STORAGE_KEY);
      localStorage.removeItem(SONIOX_KEY_STORAGE_KEY);
      localStorage.removeItem(PASSPHRASE_STORAGE_KEY);
      localStorage.removeItem(LEGACY_ACCESS_CODE_KEY);
    }
  }

  function loadSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return;
      const s = JSON.parse(raw);
      // Batch-only product: migrate a saved Realtime/Hybrid engine to Batch (the
      // selector is hidden). Only Batch is restored.
      engine = (s.engine === "batch") ? "batch" : DEFAULT_ENGINE;
      if (s.keyterms) keytermsEl.value = s.keyterms;
      if (Array.isArray(s.presetIds)) {
        // Unknown ids (a preset later renamed/removed) are ignored harmlessly.
        for (const id of s.presetIds) {
          if (presetInputs[id]) presetInputs[id].checked = true;
        }
      }
      if (s.timestamps) timestampsEl.value = s.timestamps;
      if (typeof s.tagEvents     === "boolean") tagEventsEl.checked     = s.tagEvents;
      if (typeof s.autoCopy      === "boolean") autoCopyEl.checked      = s.autoCopy;
      if (typeof s.appendMode    === "boolean") appendModeEl.checked    = s.appendMode;
      if (typeof s.saveApiKey    === "boolean") saveApiKeyEl.checked    = s.saveApiKey;
      if (typeof s.noiseSuppress === "boolean") noiseSuppressEl.checked = s.noiseSuppress;
      if (typeof s.diarize       === "boolean") diarizeEl.checked       = s.diarize; // default stays ON (checked in HTML) when unset
      if (typeof s.startBeep     === "boolean") startBeepEl.checked     = s.startBeep;
      if (s.gateOpen  !== undefined) gateOpenEl.value  = s.gateOpen;
      if (s.gateClose !== undefined) gateCloseEl.value = s.gateClose;
      if (s.highpass  !== undefined) highpassEl.value  = s.highpass;
      if (typeof s.advancedOpen === "boolean" && advancedEl) advancedEl.open = s.advancedOpen;
      if (typeof s.optionsOpen === "boolean" && optionsSectionEl) optionsSectionEl.open = s.optionsOpen;
      if (typeof s.keytermsOpen === "boolean" && keytermsSectionEl) keytermsSectionEl.open = s.keytermsOpen;
      if (s.hotkey && typeof s.hotkey.code === "string" && s.hotkey.code) {
        hotkey = {
          ctrl:  !!s.hotkey.ctrl,
          alt:   !!s.hotkey.alt,
          shift: !!s.hotkey.shift,
          meta:  !!s.hotkey.meta,
          code:  s.hotkey.code,
        };
      }
      if (typeof s.historyVisible === "boolean") historyVisible = s.historyVisible;
      if (typeof s.phoneSessionCode  === "string") phoneSessionCode  = s.phoneSessionCode;
      if (typeof s.joinedSessionCode === "string") joinedSessionCode = s.joinedSessionCode;
      if (typeof s.lastDeliveryId    === "string") lastDeliveryId    = s.lastDeliveryId;
      if (Array.isArray(s.recentDeliveryIds)) {
        recentDeliveryIds = s.recentDeliveryIds.filter(function (x) { return typeof x === "string"; }).slice(-DELIVERY_DEDUPE_RING);
      }
      // Migrate a pre-ring single id into the ring so a reload still dedupes it.
      if (lastDeliveryId && recentDeliveryIds.indexOf(lastDeliveryId) === -1) recentDeliveryIds.push(lastDeliveryId);
      if (Array.isArray(s.pendingDeliveries)) {
        deliveryQueue = s.pendingDeliveries.filter(function (it) {
          return it && typeof it.id === "string" && typeof it.text === "string" && typeof it.ts === "number";
        });
      }
      if (s.micGranted === true) micEverGranted = true;
      if (s.micTipsSeen === true) micTipsSeen = true;
      if (bigButtonModeEl && (s.bigButtonMode === "joined" || s.bigButtonMode === "always" || s.bigButtonMode === "never")) {
        bigButtonModeEl.value = s.bigButtonMode;
      }

      if (saveApiKeyEl.checked) {
        const k = localStorage.getItem(API_KEY_STORAGE_KEY);
        if (k) apiKeyEl.value = k;
        const mk = localStorage.getItem(SONIOX_KEY_STORAGE_KEY);
        if (mk && sonioxKeyEl) sonioxKeyEl.value = mk;
        const p = localStorage.getItem(PASSPHRASE_STORAGE_KEY) ||
                  localStorage.getItem(LEGACY_ACCESS_CODE_KEY);
        if (p && passphraseEl) passphraseEl.value = p;
      }
    } catch (e) {}
  }

  function getHistory() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || "[]"); }
    catch (e) { return []; }
  }

  function setHistory(items) {
    localStorage.setItem(STORE_KEY, JSON.stringify(items.slice(0, 100)));
    renderHistory();
  }

  function addHistory(text, meta) {
    const items = getHistory();
    const entry = { text: text, createdAt: new Date().toISOString() };
    if (meta) {
      if (meta.language_code !== undefined) entry.language_code = meta.language_code;
      if (meta.engine) entry.engine = meta.engine;
      if (meta.liveText) entry.liveText = meta.liveText; // hybrid: the realtime rendering, kept for comparison
    }
    items.unshift(entry);
    setHistory(items);
  }

  // Boot restore: show the most recent saved transcript instead of an empty
  // box across reloads. The restored note clears like any other when the next
  // session starts fresh, and click-to-append can extend it.
  function restoreLatestFromHistory() {
    const items = getHistory();
    if (!items.length || !items[0].text || !items[0].text.trim()) return;
    finalizedSegments = [items[0].text.trim()];
    currentPartial = "";
    // The box shows the newest note, so the slot shows the one before it (so the
    // "Last dictation" view is consistent across reloads, not just in-session).
    if (items[1] && items[1].text && items[1].text.trim()) archivedText = items[1].text.trim();
    updateLiveDisplay();
  }

  function applyHistoryVisibility() {
    const items = getHistory();
    historyEl.style.display = historyVisible ? "block" : "none";
    toggleHistoryBtn.textContent =
      (historyVisible ? "Hide saved transcripts" : "Show saved transcripts") +
      " (" + items.length + ")";
  }

  function renderHistory() {
    applyHistoryVisibility();
    if (!historyVisible) return;

    const items = getHistory();
    historyEl.innerHTML = "";

    if (!items.length) {
      historyEl.innerHTML = '<div class="hint">No transcripts yet.</div>';
      return;
    }

    // Show only the newest HISTORY_PAGE by default — the full list takes too much
    // room in the expanded desktop view; the "Show N more" control below reveals
    // the rest. Editing/persistence keys off createdAt, so a sliced view is safe.
    const limit = historyExpanded ? items.length : HISTORY_PAGE;
    for (const item of items.slice(0, limit)) {
      const div = document.createElement("div");
      div.className = "history-item";

      const meta = document.createElement("div");
      meta.className = "history-meta";
      meta.textContent = new Date(item.createdAt).toLocaleString() +
        (item.engine ? " · " + item.engine : "") +
        (item.editedAt ? " · edited" : "");

      // Past transcripts are hand-editable in place — like the active box and
      // the "Last dictation" slot: the text is contenteditable, so a click lands
      // the caret and you just type. Edits persist on blur, keyed by createdAt
      // (a re-render can't hit the wrong row) and stamped editedAt ("· edited").
      // Escape reverts to the pre-edit text. Plain-text paste, no clipboard side
      // effects (persist never copies). A no-op edit (unchanged text) is skipped.
      const text = document.createElement("div");
      text.className = "history-text";
      text.setAttribute("contenteditable", "true");
      text.textContent = item.text;
      text.addEventListener("paste", plainTextPaste);

      let original = item.text;
      text.addEventListener("focus", () => { original = text.textContent; });
      text.addEventListener("keydown", (e) => {
        if (e.key === "Escape") { text.textContent = original; text.blur(); }
      });
      text.addEventListener("blur", () => {
        const newText = text.textContent;
        if (newText === original) return;
        const all = getHistory();
        const i = all.findIndex((it) => it.createdAt === item.createdAt);
        if (i < 0) return;
        all[i].text = newText;
        all[i].editedAt = new Date().toISOString();
        // Persist directly (not setHistory) so the live re-render can't tear down
        // this row mid-interaction; reflect the "edited" marker in place instead.
        localStorage.setItem(STORE_KEY, JSON.stringify(all.slice(0, 100)));
        meta.textContent = new Date(item.createdAt).toLocaleString() +
          (item.engine ? " · " + item.engine : "") + " · edited";
        original = newText;
        setStatus("Saved edit to the transcript.", "ok");
      });

      const row = document.createElement("div");
      row.className = "row";
      row.style.marginTop = "8px";

      const copy = document.createElement("button");
      copy.textContent = "Copy";
      // Copy the current (possibly mid-edit) text, not a stale snapshot.
      copy.onclick = () => copyText(text.textContent);

      row.append(copy);
      div.append(meta, text, row);
      historyEl.append(div);
    }

    // "Show N more" / "Show fewer" — only when there's more than one page. The
    // toggle button up top still shows the FULL count; this just paginates the list.
    if (items.length > HISTORY_PAGE) {
      const moreRow = document.createElement("div");
      moreRow.className = "row";
      moreRow.style.marginTop = "10px";
      const moreBtn = document.createElement("button");
      moreBtn.id = "historyMoreBtn";
      if (historyExpanded) {
        moreBtn.textContent = "Show fewer (last " + HISTORY_PAGE + ")";
        moreBtn.onclick = () => { historyExpanded = false; renderHistory(); };
      } else {
        moreBtn.textContent = "Show " + (items.length - HISTORY_PAGE) + " more";
        moreBtn.onclick = () => { historyExpanded = true; renderHistory(); };
      }
      moreRow.append(moreBtn);
      historyEl.append(moreRow);
    }
  }

  /* ───── Clipboard ───── */
  async function clipboardWrite(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e) { }
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.top = "-1000px";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus(); ta.select(); ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  async function copyText(text) {
    const ok = await clipboardWrite(text);
    setStatus(ok ? "Copied to clipboard."
                 : "Clipboard copy failed — keep this tab focused, then click 'Copy & clear'.",
              ok ? "ok" : "err");
    return ok;
  }

  async function writeSentinel() {
    await clipboardWrite(DICTATION_SENTINEL);
  }

  // Keep-primary-speaker: when diarization is on, Scribe returns a words[] array
  // with a speaker_id per token. Background voices the mic picked up land as a
  // SECOND speaker — drop them and keep only the dominant (most-words) speaker.
  // Returns null when there is nothing to filter (a single speaker, or no
  // labels), so the caller falls back to the unfiltered text — never silently
  // empties a note. removedWords lets finalize surface what was dropped.
  function keepPrimarySpeaker(words) {
    if (!Array.isArray(words) || !words.length) return null;
    var counts = {};
    for (var i = 0; i < words.length; i++) {
      var w = words[i];
      if (w && w.type === "word" && w.speaker_id != null) {
        counts[w.speaker_id] = (counts[w.speaker_id] || 0) + 1;
      }
    }
    var ids = Object.keys(counts);
    if (ids.length <= 1) return null; // single (or unlabeled) speaker: nothing to drop
    var dominant = ids[0];
    for (var j = 1; j < ids.length; j++) {
      if (counts[ids[j]] > counts[dominant]) dominant = ids[j];
    }
    var kept = [];
    var removed = 0;
    for (var k = 0; k < words.length; k++) {
      var t = words[k];
      if (!t) continue;
      var sid = t.speaker_id;
      // Keep the dominant speaker's tokens plus any unlabeled spacing; drop the
      // other speakers. cleanTranscript collapses the join spacing downstream.
      if (sid == null || String(sid) === String(dominant)) {
        if (t.text) kept.push(t.text);
      } else if (t.type === "word") {
        removed++;
      }
    }
    return { text: kept.join(" "), removedWords: removed, speakers: ids.length };
  }

  /* ───── Batch transcription call (pure batch mode + hybrid refine) ───── */
  async function batchTranscribe(blob, fileName, timeoutMs) {
    const form = new FormData();
    const apiKey = apiKeyEl.value.trim();
    if (apiKey) form.append("api_key", apiKey);
    if (SHARED_MODE) form.append("passphrase", passphraseEl.value.trim());
    form.append("file", blob, fileName);
    form.append("file_format", "other");
    form.append("timestamps_granularity", timestampsEl.value);
    form.append("no_verbatim", "true"); // always on — the "remove filler/false starts" toggle was removed
    form.append("tag_audio_events", String(tagEventsEl.checked));
    form.append("diarize", String(diarizeEl.checked)); // keep-primary-speaker: drop bystander voices the mic caught
    form.append("keyterms_json", precomputedBatchKeyterms || JSON.stringify(
      effectiveKeyterms(BATCH_KEYTERM_MAX_CHARS, BATCH_KEYTERM_MAX_TERMS)
    )); // [LATENCY] reuse the snapshot taken at session start; fall back if absent

    const ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    const killer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs) : null;

    try {
      const res = await fetch("/api/transcribe", {
        method: "POST",
        body: form,
        signal: ctrl ? ctrl.signal : undefined,
      });
      const raw = await res.text();
      let data;
      try { data = JSON.parse(raw); } catch (e) { data = { raw: raw }; }

      if (!res.ok) {
        const msg = (data && data.detail && data.detail.message) ||
                    (data && data.message) ||
                    (data && data.error) ||
                    raw || "transcription request failed";
        return { ok: false, text: "", error: String(msg) };
      }
      var text = String(data.text || data.transcript || "");
      var removedWords = 0;
      // Keep only the primary speaker when diarization is on. A failure to find a
      // second speaker (or any words[]) leaves the full text untouched — the
      // filter can only ever REMOVE bystander speech, never empty a clean note.
      if (diarizeEl.checked && Array.isArray(data.words) && data.words.length) {
        var prim = keepPrimarySpeaker(data.words);
        if (prim && prim.text.trim()) { text = prim.text; removedWords = prim.removedWords; }
      }
      return { ok: true, text: text, error: "", removedWords: removedWords };
    } catch (err) {
      const aborted = err && err.name === "AbortError";
      return {
        ok: false,
        text: "",
        error: aborted
          ? "timed out after " + Math.round(timeoutMs / 1000) + "s"
          : (err && err.message ? err.message : String(err)),
      };
    } finally {
      if (killer) clearTimeout(killer);
    }
  }

  /* ───── Real-time Audio Graph (mic → highpass → gate → script processor) ───── */
  // Screen wake lock: held from session start to delivery so iOS auto-lock
  // cannot reclaim the mic mid-dictation or suspend the page mid-upload/refine.
  // Unsupported/denied is fine — everything else still works.
  async function acquireWakeLock() {
    try {
      if (wakeLock && !wakeLock.released) return; // already held — don't stack sentinels
      if (navigator.wakeLock && navigator.wakeLock.request) {
        wakeLock = await navigator.wakeLock.request("screen");
      }
    } catch (e) {}
  }
  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }
  // The screen wake lock is wanted whenever letting the screen sleep would cost
  // us the mic: during a dictation, AND the whole time the phone sits on the
  // big-button surface (between push-to-talk presses). Keeping the screen awake
  // there is the load-bearing fix for "iOS keeps killing the mic" — iOS reclaims
  // the audio session on auto-lock, so preventing the lock prevents the
  // interruption, instead of only re-acquiring after the fact.
  function wakeLockDesired() {
    return recording || stopping || finishing || bigButtonActive();
  }

  function audioGraphHealthy() {
    // A stale graph (e.g. restored from bfcache, device unplugged, tab slept)
    // can leave all variables set while the track is silently dead. Validate
    // the actual track so reopening the app reliably re-engages the mic.
    if (!stream || !audioCtx || audioCtx.state === "closed" || !destNode) return false;
    const track = stream.getAudioTracks()[0];
    if (!track || track.readyState !== "live") return false;
    // iOS interruptions (screen lock, Siri, calls) leave the track "live" but
    // permanently muted — that is a dead mic, rebuild from scratch.
    if (track.muted) return false;
    return true;
  }

  async function ensureAudio() {
    // After ANY backgrounding the existing graph is suspect on iOS: the track can
    // be dead while still reporting readyState "live"/unmuted, so the reuse fast
    // path below would hand back a corpse that records silence. Skip it and force
    // a full rebuild — a fresh getUserMedia track is genuinely live.
    if (!audioSuspect && audioGraphHealthy()) {
      if (audioCtx.state === "suspended") {
        try { await audioCtx.resume(); } catch (e) {}
      }
      if (audioCtx.state === "running") {
        setMicPill(recording ? "rec" : "ready");
        return true;
      }
      // Context exists but will not run — fall through and rebuild from scratch.
    }

    releaseAudio();
    audioSuspect = false; // cleared by the rebuild we are about to do

    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: noiseSuppressEl.checked,
        autoGainControl: false,
        sampleRate: 48000,
      },
    });
    if (!micEverGranted) {
      micEverGranted = true; // enables the iOS re-warm fallback in tryWarmOnLoad
      saveSettingsNow();     // persisted (micGranted): a relaunched iOS PWA re-warms at boot
    }

    const micTrack = stream.getAudioTracks()[0];
    if (micTrack) {
      micTrack.addEventListener("mute", () => {
        // iOS interruptions (Siri, calls, app switches) mute the track without
        // ending it. Mid-dictation the watchdog handles it loudly; while idle,
        // self-heal so the next dictation does not start on a dead mic. The
        // delay lets transient mutes (iOS often unmutes on its own) pass.
        if (recording || stopping) return;
        setTimeout(() => {
          if (!recording && !stopping && !audioGraphHealthy() &&
              document.visibilityState === "visible") {
            releaseAudio();
            tryWarmOnLoad();
          }
        }, 1200);
      });
      micTrack.addEventListener("ended", () => {
        // OS/device revoked the mic (sleep, unplug, Citrix audio drop).
        if (recording && !sessionFinalized) {
          micAlarmFired = true;
          setMicPill("fail");
          micAlarmBeep();
          setStatus("⚠ Microphone was disconnected mid-dictation — check the device before trusting this text.", "err");
        } else {
          setMicPill("off");
        }
      });
    }

    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") {
      try { await audioCtx.resume(); } catch (e) {}
    }
    // Instant detection of a mid-dictation interruption: iOS fires statechange
    // when Siri / a call / another app takes the audio session ("suspended" or
    // "interrupted"). The 30ms watchdog catches it too, but the event fires even
    // when the gate timer is being throttled. Alarm only while recording and
    // after a short start-up grace; never auto-clear — fail loud, redictate.
    audioCtx.onstatechange = () => {
      if (recording && !stopping && !micAlarmFired &&
          audioCtx && audioCtx.state !== "running" &&
          Date.now() - recStartedAt > 200) {
        micAlarmFired = true;
        setMicPill("fail");
        micAlarmBeep();
        setStatus("⚠ AUDIO INTERRUPTED — the mic was taken over (call/Siri/another app). Stop and redictate.", "err");
      }
    };
    // Diagnostic (one-time): surface the true hardware sample rate so a stealth
    // hardware-rate surprise is never invisible.
    if (!window.__srLogged) {
      window.__srLogged = true;
      try {
        var msg = "[audio] AudioContext sampleRate = " + audioCtx.sampleRate + " Hz";
        if (audioCtx.sampleRate !== 48000) console.warn(msg + " — not 48000; verify capture"); else console.log(msg);
      } catch (e) {}
    }

    const source = audioCtx.createMediaStreamSource(stream);

    hpFilter = audioCtx.createBiquadFilter();
    hpFilter.type = "highpass";
    hpFilter.frequency.value = Number(highpassEl.value) || 0;
    hpFilter.Q.value = 0.707;

    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 1024;

    gateNode = audioCtx.createGain();
    gateNode.gain.value = 0;

    destNode = audioCtx.createMediaStreamDestination();

    source.connect(hpFilter);
    hpFilter.connect(analyserNode);

    // BATCH CAPTURE: the post-gate audio is what MediaRecorder records and uploads.
    // The analyser above drives the capture waveform + dead-mic watchdog (read off
    // the same pre-gate signal).
    hpFilter.connect(gateNode);
    gateNode.connect(destNode);

    gateBuf = new Float32Array(analyserNode.fftSize);
    gateIsOpen = false;
    gateLastOpen = 0;
    lastMeterPct = -1;
    setGateStateUI(false);

    if (gateTimer) clearInterval(gateTimer);
    gateTimer = setInterval(() => {
      if (!analyserNode || !audioCtx) return;

      analyserNode.getFloatTimeDomainData(gateBuf);
      let sum = 0;
      for (let i = 0; i < gateBuf.length; i++) sum += gateBuf[i] * gateBuf[i];
      const rms = Math.sqrt(sum / gateBuf.length);

      const pct = Math.min(100, (rms / METER_MAX) * 100);
      if (Math.abs(pct - lastMeterPct) > 0.5) {
        meterBar.style.width = pct + "%";
        lastMeterPct = pct;
      }

      // Live recording feedback: visible only while capturing (gateIsOpen is
      // updated just below, so the displayed state lags one tick — imperceptible).
      if (recording && !stopping) {
        showRecFeedback(true);
        updateRecFeedback(rms);
      } else if (recFeedbackOn && !recording) {
        showRecFeedback(false);
      }

      const openT  = Number(gateOpenEl.value);
      const closeT = Number(gateCloseEl.value);
      const now    = audioCtx.currentTime;

      if (!gateIsOpen) {
        if (rms > openT) {
          gateIsOpen = true;
          gateLastOpen = now;
          gateNode.gain.setTargetAtTime(1, now, 0.02);
          setGateStateUI(true);
        }
      } else {
        if (rms > closeT) {
          gateLastOpen = now;
        } else if (now - gateLastOpen > HOLD_SECONDS) {
          gateIsOpen = false;
          gateNode.gain.setTargetAtTime(0, now, 0.12);
          setGateStateUI(false);
        }
      }

      // Recording health watchdog: catch the "dictated into a dead mic"
      // disaster while it is happening, not after.
      if (recording && !stopping) {
        const nowMs = Date.now();
        if (rms > maxRmsSeen) maxRmsSeen = rms;
        if (rms > openT) speechDetected = true;

        const track = stream && stream.getAudioTracks ? stream.getAudioTracks()[0] : null;
        const trackDead = !track || track.readyState !== "live";
        if (track && track.muted) {
          if (!mutedSince) mutedSince = nowMs;
        } else {
          mutedSince = 0;
        }

        if (!micAlarmFired) {
          const flatline = nowMs - recStartedAt > 2500 && maxRmsSeen < FLATLINE_RMS;
          const mutedLong = mutedSince && nowMs - mutedSince > 1500;
          // A suspended/interrupted AudioContext mid-dictation freezes the
          // analyser at its last buffer (the spec says it returns the same
          // data), so the flatline check above goes blind on stale non-zero
          // peaks. Treat a non-running context as its own alarm, after a short
          // start-up grace so a momentary start blip cannot false-fire.
          const ctxDead = audioCtx && audioCtx.state !== "running" && nowMs - recStartedAt > 200;
          if (trackDead || mutedLong || flatline || ctxDead) {
            micAlarmFired = true;
            setMicPill("fail");
            micAlarmBeep();
            setStatus(ctxDead
              ? "⚠ AUDIO INTERRUPTED — the mic was taken over (call/Siri/another app). Stop and redictate."
              : "⚠ MIC NOT CAPTURING — no audio signal detected. Stop, check the microphone, then redictate.", "err");
          }
        }
      }
    }, 30);

    return true;
  }

  function releaseAudio() {
    if (gateTimer) { clearInterval(gateTimer); gateTimer = null; }
    if (audioCtx) { audioCtx.close().catch(() => {}); }
    if (stream) { for (const track of stream.getTracks()) track.stop(); }
    stream = null; audioCtx = null; hpFilter = null; analyserNode = null;
    gateNode = null; destNode = null; gateBuf = null; gateIsOpen = false;
    lastMeterPct = -1;
    meterBar.style.width = "0%";
    setGateStateUI(false);
    setMicPill("off");
  }

  async function tryWarmOnLoad() {
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const st = await navigator.permissions.query({ name: "microphone" });
        if (st.state === "granted") warmWithRetry(0);
        return;
      }
    } catch (e) {}
    // iOS Safari has no Permissions API entry for the microphone — the query
    // above throws, which used to make every re-warm path a silent no-op on
    // iOS. If this device held the mic before (micEverGranted persists as the
    // micGranted settings field, so PWA relaunches count), re-acquiring is
    // prompt-free — re-warm anyway: iOS interruptions routinely kill the
    // track while the page is hidden, and this is what re-engages it.
    if (micEverGranted) warmWithRetry(0);
  }

  // iOS hands the audio session back late after foregrounding: a getUserMedia
  // issued immediately on return can fail and then succeed moments later. A
  // single silent attempt leaves a cold mic until the next manual press, so
  // retry on a short backoff before giving up (loudly).
  let warmRetryTimer = null;
  function warmWithRetry(attempt) {
    if (recording || stopping) return;
    if (warmRetryTimer) { clearTimeout(warmRetryTimer); warmRetryTimer = null; }
    ensureAudio().catch(() => {
      if (attempt >= 4) {
        if (micEverGranted) setStatus("Microphone did not re-engage after returning — tap Start and it will reconnect.", "warn");
        return;
      }
      // iOS hand-back timing is variable (longer after a call/Siri/a long lock),
      // so keep retrying on a widening backoff (~700ms..5s, ~14s total) before
      // giving up — a single quick attempt left the mic cold until a manual press.
      warmRetryTimer = setTimeout(() => {
        warmRetryTimer = null;
        if (document.visibilityState === "visible") warmWithRetry(attempt + 1);
      }, attempt === 0 ? 700 : Math.min(1500 * attempt, 5000));
    });
  }

  /* ───── Stream Audio & Run WebSocket Session ───── */
  function clearSessionTimers() {
    if (connectTimer)       { clearTimeout(connectTimer);       connectTimer = null; }
    if (tailTimer)          { clearTimeout(tailTimer);          tailTimer = null; }
    if (finalDeadlineTimer) { clearTimeout(finalDeadlineTimer); finalDeadlineTimer = null; }
    if (quietTimer)         { clearTimeout(quietTimer);         quietTimer = null; }
  }

  async function startRecording() {
    if (recording || stopping || finishing) return;
    stopRequested = false;
    pendingStart = false;
    // A direct start supersedes any armed queued start (the timer would no-op
    // against recording=true anyway, but a dead handle must not linger where
    // the release guards read it).
    if (pendingStartTimer) { clearTimeout(pendingStartTimer); pendingStartTimer = null; }

    // Credential check. Batch uploads to ElevenLabs Scribe v2 and needs an
    // ElevenLabs key; in shared mode the passphrase covers it.
    const apiKey      = apiKeyEl.value.trim();        // ElevenLabs (batch)
    const shared      = SHARED_MODE && passphraseEl.value.trim();
    const needEleven  = true;
    let missing = null;
    if (!shared) {
      if (needEleven && !apiKey) missing = SHARED_MODE ? "pass" : "eleven";
    }
    if (missing) {
      await writeSentinel();
      if (authSectionEl) authSectionEl.open = true; // surface the collapsed credentials box
      setBigSettingsVisible(true); // the big-button layout hides it otherwise
      if (missing === "pass") {
        setStatus("Enter the shared passphrase first.", "err");
        passphraseEl.focus();
      } else {
        setStatus("Enter your ElevenLabs API key first (used for batch).", "err");
        apiKeyEl.focus();
      }
      failBeep();
      return;
    }

    saveSettingsNow();

    try {
      await ensureAudio();
      if (audioCtx && audioCtx.state === "suspended") await audioCtx.resume();
      if (!audioCtx || audioCtx.state !== "running") {
        await writeSentinel();
        setStatus("Audio not running. Click page once, then try again.", "err");
        failBeep();
        return;
      }
    } catch (e) {
      await writeSentinel();
      setMicPill("fail");
      setStatus("Microphone unavailable: " + (e && e.message ? e.message : e), "err");
      failBeep();
      return;
    }

    // Hold a screen wake lock for the dictation: iOS auto-lock reclaims the
    // microphone and suspends the page mid-upload/refine. Released by
    // deliverFinalText — except on the phone's big-button surface, where it is
    // kept across takes (wakeLockDesired) so the mic never goes cold mid-visit.
    acquireWakeLock();

    // New session bookkeeping; stale callbacks from a previous socket bail out
    const mySession = ++sessionSeq;
   sessionEngine = engine; // snapshot: selector changes only affect the NEXT session
    // [LATENCY] Snapshot the batch keyterms JSON now, while recording is starting,
    // so the stop->upload path doesn't pay the effectiveKeyterms merge/dedup
    // (which walks the full preset list) on the critical path.
    precomputedBatchKeyterms = JSON.stringify(
      effectiveKeyterms(BATCH_KEYTERM_MAX_CHARS, BATCH_KEYTERM_MAX_TERMS)
    );
    // [LATENCY] Pre-warm the TLS connection to the Worker for the upcoming batch
    // upload. An Image to /favicon.ico (204) opens TCP/TLS without going through
    // fetch() — so it never consumes a batch-upload queue slot or trips the test
    // harness's queue-driven fetch mock.
    try { new Image().src = "/favicon.ico?warm=" + Date.now(); } catch (e) {}
    sessionFinalized = false;
    userStopped = false;
    stopPhase = null;
    lastWsError = "";
    recStartedAt = Date.now();
    speechDetected = false;
    maxRmsSeen = 0;
    micAlarmFired = false;
    mutedSince = 0;
    clearSessionTimers();

    // Continue the current text when armed by clicking the transcript box
    // (one-shot), or when append mode is on. Otherwise start fresh. The
    // decision is explicit — no time window — so the same action always
    // gives the same result (append vs. fresh is never clock-dependent).
    if (joinedSessionCode) {
      // Joined to a desktop: THIS device is only the microphone — the desktop
      // owns the note and its append mode (see deliverRemoteText). Always deliver
      // a single dictation; accumulating here too would double-append on the
      // desktop (silent wrong text on a chart). A solo big-button device (not
      // joined) still appends locally via the branches below.
      appendArmed = false;
      finalizedSegments = [];
    } else if (appendArmed) {
      appendArmed = false; // consumed by this session
    } else if (!appendModeEl.checked) {
      // Starting fresh files the note being replaced into the "Last dictation"
      // slot (it stays visible there + in history) before the box is cleared.
      fileToSlot(finalizedSegments.join(" "));
      finalizedSegments = [];
    }
    currentPartial = "";
    updateLiveDisplay();

    // The note text this session extends. Batch delivery splices the freshly
    // transcribed text onto this base instead of live segments.
    sessionBaseText = finalizedSegments.join(" ");

    // Pure batch: no WebSocket, no pre-roll (the gate-in-path recording cannot
    // splice in pre-gate frames). The post-gate MediaRecorder IS the capture
    // path; upload happens on stop.
    startBatchRecording();
  }

  // Batch-mode recording: the same post-gate MediaRecorder the other engines
  // use for the preview, made load-bearing. Finalize is driven from onstop so
  // the final dataavailable flush is always in chunks[] before upload.
  function startBatchRecording() {
    setLinkPill("idle");
    chunks = [];

    const preferred = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
    ].find((type) => MediaRecorder.isTypeSupported(type));

    const opts = { audioBitsPerSecond: 64000 };
    if (preferred) opts.mimeType = preferred;

    try {
      mediaRecorder = new MediaRecorder(destNode.stream, opts);
    } catch (e) {
      // In batch mode the recorder IS the capture path — failing it is fatal.
      sessionFinalized = true;
      writeSentinel();
      setStatus("MediaRecorder failed in this browser — batch mode cannot record. Try realtime mode.", "err");
      failBeep();
      return;
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) chunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      if (sessionFinalized) return;
      finalizeSession(false);
    };
    mediaRecorder.start(1000); // [LATENCY] timeslice: chunks land during recording, so onstop only flushes the last <1s

    recording = true;
    stopping = false;
    refreshLatestEditable(); // lock the box: the live/finalize path owns its text now
    recordBtn.textContent = "Stop recording";
    recordBtn.classList.add("danger");
    setMicPill("rec");
    updateAppendChip();
    setStatus("Recording — release to upload for transcription…", "ok");
    startBeep();
    notifyDesktopRecording("start"); // joined phone: light the desktop's "recording" indicator (no-op if unpaired)

    if (stopRequested) {
      stopRequested = false;
      stopRecording();
    }
  }

  function stopRecording() {
    if (!recording || stopping) {
      stopRequested = true;
      return;
    }
    userStopped = true;
    stopping = true;
    refreshLatestEditable(); // keep the box locked through the upload phase

    // No tail/commit phases: stopping the recorder flushes the last chunk,
    // and its onstop handler drives the finalize/upload.
    stopPhase = null;
    setStatus("Stopping — preparing upload…", "warn");
    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.stop(); } catch (e) { finalizeSession(true); }
    } else {
      finalizeSession(false);
    }
  }

  async function finalizeSession(unexpected) {
    if (sessionFinalized) return;
    sessionFinalized = true;
    clearSessionTimers();
    showRecFeedback(false); // recording is over; the status line carries the upload state

    // Set BEFORE the button/pill updates below: those trigger the big-screen
    // recalc, and with finishing already true it renders WORKING… through the
    // delivery awaits instead of a stale (possibly green) status — an error
    // path must never flash the success screen.
    finishing = true; // cleared in deliverFinalText — the single delivery exit

    recording = false;
    stopping = false;
    stopPhase = null;
    stopRequested = false;
    recordBtn.textContent = "Start recording";
    recordBtn.classList.remove("danger");
    if (micAlarmFired) setMicPill("fail");
    else setMicPill(audioGraphHealthy() ? "ready" : "off");
    if (!unexpected) setLinkPill("idle");
    notifyDesktopRecording("stop"); // joined phone: flip the desktop indicator to "transcribing" while the upload runs (no-op if unpaired)

    if (mediaRecorder && mediaRecorder.state !== "inactive") {
      try { mediaRecorder.stop(); } catch (e) {}
    }

    if (chunks.length) {
      const blob = new Blob(chunks, { type: (chunks[0] && chunks[0].type) || "audio/webm" });
      lastAudioBlob = blob;
      if (lastAudioUrl) URL.revokeObjectURL(lastAudioUrl);
      lastAudioUrl = URL.createObjectURL(blob);
      audioPreviewEl.src = lastAudioUrl;
    }

    await finishBatchSession(unexpected);
  }

  // Pure batch delivery: upload the post-gate recording, splice the result
  // onto the note base, and hand off to the shared delivery exit.
  async function finishBatchSession(unexpected) {
    // Rebuild from this session's chunks — lastAudioBlob can be stale from a
    // previous session when nothing was captured in this one.
    const blob = chunks.length
      ? new Blob(chunks, { type: (chunks[0] && chunks[0].type) || "audio/webm" })
      : null;

    if (!blob || blob.size < 1024) {
      // Gate never opened / instant tap: nothing worth uploading.
      await deliverFinalText("", { unexpected: unexpected });
      return;
    }

    const fileName = (blob.type || "").includes("ogg") ? "recording.ogg" : "recording.webm";
    setLinkPill("uploading");
    setStatus("Uploading audio for transcription…", "warn");

    const r = await batchTranscribe(blob, fileName, BATCH_UPLOAD_TIMEOUT_MS);

    if (!r.ok) {
      lastWsError = r.error || "upload failed"; // surfaces in the failure status line
      setLinkPill("fail");
      await deliverFinalText("", { unexpected: true });
      return;
    }

    setLinkPill("idle");

    if (r.text && r.text.trim()) {
      finalizedSegments = sessionBaseText ? [sessionBaseText, r.text] : [r.text];
    } else {
      finalizedSegments = sessionBaseText ? [sessionBaseText] : [];
    }
    currentPartial = "";
    updateLiveDisplay();

    if (!r.text || !r.text.trim()) {
      await deliverFinalText("", { unexpected: unexpected });
      return;
    }

    // Surface diarization removals as a (non-beeping) status note: the clinician
    // must be able to see that speech was dropped, in case the primary-speaker
    // pick was wrong (the delivered text is still the cleaner, primary-only one).
    var note = r.removedWords
      ? "Filtered out " + r.removedWords + " word" + (r.removedWords === 1 ? "" : "s") + " from other speakers."
      : "";
    await deliverFinalText(cleanTranscript(latestText), { unexpected: unexpected, label: "Transcript", note: note });
  }

  // The single delivery exit: exactly one clipboard outcome and one beep per
  // session ends up here. opts:
  //   unexpected    — the session ended on a failure we did not request
  //   label         — what to call the text in the success status ("Transcript", …)
  //   unexpectedMsg — override for the unexpected status line
  async function deliverFinalText(cleaned, opts) {
    opts = opts || {};
    // On a plain desktop the screen may sleep again once the outcome is
    // delivered; on the phone's big-button surface we deliberately KEEP the lock
    // so iOS doesn't auto-lock between takes and reclaim the mic (wakeLockDesired).
    if (!bigButtonActive()) releaseWakeLock();
    const label = opts.label || "Transcript";

    if (!cleaned.trim()) {
      await writeSentinel();
      if (opts.unexpected) {
        setStatus("Dictation FAILED — " + (lastWsError || "connection lost") + ". Nothing was transcribed; sentinel copied.", "err");
      } else if (micAlarmFired) {
        setStatus("No speech detected — the microphone never produced a signal. Check the mic.", "err");
      } else {
        // The sentinel is on the clipboard and the fail beep plays — this IS
        // a failure outcome and must read as one everywhere (incl. the
        // big-button screen), even when the cause is just an accidental tap.
        setStatus("No speech detected — nothing transcribed; sentinel copied.", "err");
      }
      failBeep();
      finishing = false;
      updateBigScreen(); // the outcome status above was computed under finishing=true (busy)
      updateAppendChip();
      maybePendingStart();
      return;
    }

    // Save final clean output to browser storage. A storage failure (quota)
    // must not block the actual deliverable — the clipboard write and beep.
    try {
      addHistory(cleaned, { language_code: "en", engine: sessionEngine });
    } catch (e) {}

    // Joined + clean: the DESKTOP clipboard is the deliverable, so the relay
    // ack owns the SINGLE outcome cue (done on a listener ack, red warn/fail on
    // zero-listeners/relay failure — see relayDeliveryToDesktop). Suppress any
    // local beep on THIS device in that case: a local doneBeep before the relay
    // would be a second cue, and a doneBeep on a relay that then fails would
    // sound like success on a degraded outcome (CLAUDE.md: a joined degraded
    // outcome gets warnBeep, never doneBeep). The local copy is still attempted
    // (best-effort, so the text is on this device too) — it just never beeps
    // here. iOS denies that copy outright; an Android/desktop join may succeed —
    // both defer to the relay. Unexpected/mic-alarm joined dictations are NOT
    // clean, so they keep the loud local fail cue and the relay stays silent.
    const relayCarries = Boolean(joinedSessionCode && cleaned.trim());
    const cleanOutcome = !opts.unexpected && !micAlarmFired;
    let announceRelayOutcome = relayCarries && cleanOutcome;
    const noteSuffix = opts.note ? " " + opts.note : ""; // diarization "removed N words" note (no beep)

    if (autoCopyEl.checked) {
      const copied = await copyText(cleaned);
      if (announceRelayOutcome) {
        setStatus((copied
          ? "Transcript copied here and sent to the desktop — confirming delivery…"
          : "Transcript sent to the desktop — confirming delivery… (no local phone copy; tap 'Copy & clear' if you need it here)") + noteSuffix, "warn");
      } else if (!copied) {
        setStatus("Transcript saved but clipboard copy FAILED — do NOT paste yet; click 'Copy & clear'.", "err");
        failBeep();
      } else if (opts.unexpected) {
        setStatus(opts.unexpectedMsg || "⚠ Connection lost mid-dictation — PARTIAL transcript copied. Verify it before pasting!", "err");
        failBeep();
      } else if (micAlarmFired) {
        setStatus("⚠ Mic signal dropped during this dictation — verify the text before pasting!", "err");
        failBeep();
      } else {
        setStatus(label + " saved & copied. Done!" + noteSuffix, "ok");
        doneBeep();
      }
    } else {
      if (announceRelayOutcome) {
        setStatus("Transcript sent to the desktop — confirming delivery…" + noteSuffix, "warn");
      } else if (opts.unexpected) {
        setStatus(opts.unexpectedMsg || "⚠ Connection lost mid-dictation — partial transcript saved (not copied).", "err");
        failBeep();
      } else {
        setStatus(label + " saved." + noteSuffix, "ok");
        doneBeep();
      }
    }

    finishing = false;
    refreshLatestEditable(); // back to idle: the box is hand-editable again
    updateBigScreen(); // the outcome status above was computed under finishing=true (busy)
    updateAppendChip();

    // If this device is acting as a phone mic for a desktop session, relay the
    // authoritative final text so the desktop can deliver it to the clipboard.
    // The room acks with its listener count — a relay nobody received must be
    // loud here, never a false success. A queued next session waits for the
    // ack: its REC screen must not paint over a relay failure before the
    // failure was ever shown.
    if (joinedSessionCode && cleaned.trim()) {
      relayDeliveryToDesktop(cleaned, announceRelayOutcome).finally(maybePendingStart);
    } else {
      maybePendingStart();
    }
  }

  function maybePendingStart() {
    // PTT pressed again while the previous dictation was finalizing —
    // honor it so rapid consecutive dictations are never swallowed.
    if (pendingStart) {
      pendingStart = false;
      if (pendingStartTimer) clearTimeout(pendingStartTimer);
      // A failure outcome gets a beat of screen time before the queued
      // session's REC paints over it — only the failure path pays the delay.
      const delay = lastStatusCls === "err" ? 1500 : 60;
      pendingStartTimer = setTimeout(() => {
        pendingStartTimer = null;
        if (!recording && !stopping && !finishing) startRecording();
      }, delay);
    }
  }

  // A queued start must die when the press that queued it ends without a tap:
  // a hold released during the finalize/queued window, a cancelled pointer,
  // or F14 (CapsLock up). Otherwise the deferred startRecording opens a mic
  // nobody is holding — a silent open mic in a clinical room.
  function cancelQueuedStart() {
    pendingStart = false;
    if (pendingStartTimer) { clearTimeout(pendingStartTimer); pendingStartTimer = null; }
  }

  /* ───── Phone mic session ───── */

  /* Minimal QR encoder (byte mode, EC level M, versions 1-6 auto-selected) so
     the join link can be rendered locally — no external QR service ever sees
     the session code (it is the link's only credential). */
  var QR_EC_BLOCKS = { // version: [ecCodewordsPerBlock, [dataCodewordsPerBlock, ...]]
    1: [10, [16]],
    2: [16, [28]],
    3: [26, [44]],
    4: [18, [32, 32]],
    5: [24, [43, 43]],
    6: [16, [27, 27, 27, 27]],
  };
  var QR_ALIGN = { 2: 18, 3: 22, 4: 26, 5: 30, 6: 34 }; // single alignment pattern center (v2-6)

  function qrGf() { // GF(256) log/antilog tables, poly 0x11d
    var exp = new Array(512), log = new Array(256), x = 1;
    for (var i = 0; i < 255; i++) {
      exp[i] = x; log[x] = i;
      x <<= 1; if (x & 0x100) x ^= 0x11d;
    }
    for (var j = 255; j < 512; j++) exp[j] = exp[j - 255];
    return { exp: exp, log: log };
  }

  function qrEcc(data, ecLen, gf) {
    var gen = [1];
    for (var i = 0; i < ecLen; i++) {
      var next = [];
      for (var j = 0; j <= gen.length; j++) next.push(0);
      for (var j = 0; j < gen.length; j++) {
        if (!gen[j]) continue;
        next[j] ^= gen[j];
        next[j + 1] ^= gf.exp[(gf.log[gen[j]] + i) % 255];
      }
      gen = next;
    }
    var res = data.slice();
    for (var i = 0; i < ecLen; i++) res.push(0);
    for (var i = 0; i < data.length; i++) {
      var f = res[i];
      if (!f) continue;
      for (var j = 0; j < gen.length; j++) {
        if (gen[j]) res[i + j] ^= gf.exp[(gf.log[gen[j]] + gf.log[f]) % 255];
      }
    }
    return res.slice(data.length);
  }

  function qrCodewords(text, version) {
    var spec = QR_EC_BLOCKS[version];
    var dataCw = 0;
    for (var i = 0; i < spec[1].length; i++) dataCw += spec[1][i];
    var bits = [];
    var put = function (val, len) { for (var i = len - 1; i >= 0; i--) bits.push((val >> i) & 1); };
    put(4, 4);                 // byte mode
    put(text.length, 8);       // char count (8 bits for versions 1-9)
    for (var i = 0; i < text.length; i++) put(text.charCodeAt(i) & 0xff, 8);
    put(0, Math.min(4, dataCw * 8 - bits.length)); // terminator
    while (bits.length % 8) bits.push(0);
    var bytes = [];
    for (var i = 0; i < bits.length; i += 8) {
      var v = 0;
      for (var j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      bytes.push(v);
    }
    var pad = [0xec, 0x11], p = 0;
    while (bytes.length < dataCw) bytes.push(pad[(p++) % 2]);
    var gf = qrGf();
    var blocks = [], eccs = [], off = 0;
    for (var i = 0; i < spec[1].length; i++) {
      var blk = bytes.slice(off, off + spec[1][i]);
      off += spec[1][i];
      blocks.push(blk);
      eccs.push(qrEcc(blk, spec[0], gf));
    }
    var out = [], maxLen = 0;
    for (var i = 0; i < blocks.length; i++) maxLen = Math.max(maxLen, blocks[i].length);
    for (var c = 0; c < maxLen; c++) for (var i = 0; i < blocks.length; i++) {
      if (c < blocks[i].length) out.push(blocks[i][c]);
    }
    for (var c = 0; c < spec[0]; c++) for (var i = 0; i < eccs.length; i++) out.push(eccs[i][c]);
    return out;
  }

  function qrMatrix(text) {
    var version = 0;
    for (var v = 1; v <= 6; v++) {
      var spec = QR_EC_BLOCKS[v], cap = 0;
      for (var i = 0; i < spec[1].length; i++) cap += spec[1][i];
      if (text.length <= cap - 2) { version = v; break; } // 12-bit header overhead
    }
    if (!version) return null; // longer than v6-M holds (106 bytes) — caller hides the QR
    var size = 17 + 4 * version;
    var m = [], fn = [];
    for (var r = 0; r < size; r++) { m.push(new Array(size).fill(0)); fn.push(new Array(size).fill(false)); }
    var setFn = function (r, c, val) { m[r][c] = val ? 1 : 0; fn[r][c] = true; };

    var finder = function (r0, c0) {
      for (var dr = -1; dr <= 7; dr++) for (var dc = -1; dc <= 7; dc++) {
        var rr = r0 + dr, cc = c0 + dc;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        var dark = dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6 &&
                   (dr === 0 || dr === 6 || dc === 0 || dc === 6 || (dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4));
        setFn(rr, cc, dark);
      }
    };
    finder(0, 0); finder(0, size - 7); finder(size - 7, 0);

    for (var i = 8; i < size - 8; i++) { // timing
      if (!fn[6][i]) setFn(6, i, i % 2 === 0);
      if (!fn[i][6]) setFn(i, 6, i % 2 === 0);
    }

    if (QR_ALIGN[version]) { // single alignment pattern for v2-6
      var ap = QR_ALIGN[version];
      for (var dr = -2; dr <= 2; dr++) for (var dc = -2; dc <= 2; dc++) {
        setFn(ap + dr, ap + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
      }
    }

    setFn(size - 8, 8, 1); // dark module
    for (var i = 0; i <= 8; i++) { // reserve format areas (filled per-mask below)
      if (i !== 6) {
        if (!fn[8][i]) setFn(8, i, 0);
        if (!fn[i][8]) setFn(i, 8, 0);
      }
    }
    for (var i = 0; i < 8; i++) {
      if (!fn[8][size - 1 - i]) setFn(8, size - 1 - i, 0);
      if (!fn[size - 1 - i][8]) setFn(size - 1 - i, 8, 0);
    }

    var cw = qrCodewords(text, version);
    var dataBits = [];
    for (var i = 0; i < cw.length; i++) for (var j = 7; j >= 0; j--) dataBits.push((cw[i] >> j) & 1);
    var k = 0, upward = true;
    for (var col = size - 1; col > 0; col -= 2) { // zigzag placement
      if (col === 6) col--;
      for (var i = 0; i < size; i++) {
        var r = upward ? size - 1 - i : i;
        for (var dc = 0; dc < 2; dc++) {
          var c = col - dc;
          if (!fn[r][c]) m[r][c] = dataBits[k++] || 0; // missing = remainder bits (0)
        }
      }
      upward = !upward;
    }

    var maskBit = function (mask, r, c) {
      switch (mask) {
        case 0: return (r + c) % 2 === 0;
        case 1: return r % 2 === 0;
        case 2: return c % 3 === 0;
        case 3: return (r + c) % 3 === 0;
        case 4: return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
        case 5: return (r * c) % 2 + (r * c) % 3 === 0;
        case 6: return ((r * c) % 2 + (r * c) % 3) % 2 === 0;
        default: return ((r + c) % 2 + (r * c) % 3) % 2 === 0;
      }
    };
    var formatBits = function (mask) { // BCH(15,5) of EC level M (00) + mask, XOR 0x5412
      var d = mask, rem = d << 10, g = 0x537;
      for (var i = 14; i >= 10; i--) if ((rem >> i) & 1) rem ^= g << (i - 10);
      return ((d << 10) | (rem & 0x3ff)) ^ 0x5412;
    };
    var penalty = function (mm) { // adjacency runs + dark ratio: enough to pick a sane mask
      var p = 0, dark = 0;
      for (var r = 0; r < size; r++) {
        var runR = 1, runC = 1;
        for (var c = 0; c < size; c++) {
          if (mm[r][c]) dark++;
          if (c > 0) {
            if (mm[r][c] === mm[r][c - 1]) { runR++; if (runR === 5) p += 3; else if (runR > 5) p++; } else runR = 1;
            if (mm[c][r] === mm[c - 1][r]) { runC++; if (runC === 5) p += 3; else if (runC > 5) p++; } else runC = 1;
          }
        }
      }
      p += Math.floor(Math.abs(dark * 100 / (size * size) - 50) / 5) * 10;
      return p;
    };

    var best = null, bestScore = Infinity;
    for (var mask = 0; mask < 8; mask++) {
      var mm = [];
      for (var r = 0; r < size; r++) mm.push(m[r].slice());
      for (var r = 0; r < size; r++) for (var c = 0; c < size; c++) {
        if (!fn[r][c] && maskBit(mask, r, c)) mm[r][c] ^= 1;
      }
      var f = formatBits(mask);
      for (var i = 0; i < 15; i++) {
        var on = ((f >> i) & 1) === 1 ? 1 : 0;
        if (i < 6) mm[i][8] = on;
        else if (i < 8) mm[i + 1][8] = on;
        else mm[size - 15 + i][8] = on;
        if (i < 8) mm[8][size - 1 - i] = on;
        else if (i < 9) mm[8][7] = on;
        else mm[8][14 - i] = on;
      }
      var score = penalty(mm);
      if (score < bestScore) { bestScore = score; best = mm; }
    }
    return best;
  }

  function renderQrSvg(text, el) {
    var mtx = qrMatrix(text);
    if (!mtx) { el.style.display = "none"; el.innerHTML = ""; return false; }
    var n = mtx.length, q = 4; // spec quiet zone
    var d = "";
    for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) {
      if (mtx[r][c]) d += "M" + (c + q) + " " + (r + q) + "h1v1h-1z";
    }
    var dim = n + q * 2;
    el.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + dim + ' ' + dim + '" width="148" height="148" shape-rendering="crispEdges"><rect width="' + dim + '" height="' + dim + '" fill="#fff"/><path d="' + d + '" fill="#000"/></svg>';
    el.style.display = "";
    return true;
  }

  function generateSessionCode() {
    var chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I/l ambiguity
    var arr = new Uint8Array(6);
    crypto.getRandomValues(arr);
    var code = "";
    for (var i = 0; i < 6; i++) code += chars[arr[i] % chars.length];
    return code;
  }

  /* ───── Front-and-center pairing overlay (desktop) ─────
     A compact "Pair a phone" button on the primary card opens a big, centered
     QR overlay — the desktop's prominent pairing surface. It auto-closes the
     moment a phone joins (a phone_join ping relayed through the room, with the
     first delivery as a fallback). */
  function updatePairButton() {
    if (!pairPhoneBtnEl) return;
    pairPhoneBtnEl.textContent = phoneJoined ? "📱 Phone paired ✓" : "📱 Pair a phone";
  }

  function openPairOverlay() {
    if (!phoneSessionCode) startPhoneSession();
    if (!phoneSessionCode) return; // session start failed (no room support)
    var joinUrl = window.location.origin + "/?join=" + phoneSessionCode;
    if (pairQrEl) renderQrSvg(joinUrl, pairQrEl);
    if (pairCodeEl) pairCodeEl.textContent = phoneSessionCode;
    if (pairStatusEl) {
      pairStatusEl.textContent = phoneJoined ? "Phone paired — dictate away." : "Waiting for your phone to scan…";
      pairStatusEl.className = phoneJoined ? "ok" : "";
    }
    if (pairOverlayEl) pairOverlayEl.classList.add("show");
    updatePairButton();
  }

  function closePairOverlay() {
    if (pairOverlayEl) pairOverlayEl.classList.remove("show");
  }

  // The desktop learns a phone joined (phone_join ping, or the first delivery as
  // a fallback): close the QR overlay and reflect the paired state.
  function onPhoneJoined() {
    var wasJoined = phoneJoined;
    phoneJoined = true;
    closePairOverlay();
    updatePairButton();
    return wasJoined;
  }

  // Phone side: tell the desktop a phone has joined so its pairing QR overlay
  // can close immediately (instead of waiting for the first dictation). Best-
  // effort and fire-and-forget — relayed through the room to listeners, NOT
  // buffered (only phone_delivery is). If no desktop is listening yet, the
  // overlay simply closes on the first delivery instead.
  function notifyDesktopOfJoin(code) {
    if (!code) return;
    try {
      fetch("/api/session/" + code + "/deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_type: "phone_join" }),
      }).catch(function () {});
    } catch (e) {}
  }

  // Phone side: tell the desktop the phone has started/stopped capturing, so the
  // desktop can show a live "phone is recording" indicator before any text
  // lands. Like phone_join, this is best-effort, fire-and-forget, and relayed to
  // listeners but NOT buffered (only phone_delivery is) — a missed ping just
  // means the desktop misses the cue, never a lost dictation. Gated on a join so
  // an unpaired device never POSTs. state: "start" | "stop".
  function notifyDesktopRecording(state) {
    if (!joinedSessionCode) return;
    try {
      fetch("/api/session/" + joinedSessionCode + "/deliver", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message_type: "phone_recording", state: state }),
      }).catch(function () {});
    } catch (e) {}
  }

  // Desktop side: reflect the paired phone's capture state. "recording" while
  // the phone holds the button, "transcribing" after release (upload in flight),
  // "off" once the delivery lands. A safety timer auto-clears it if a stop/
  // delivery ping is missed (the indicator is a cue, never load-bearing). Only
  // the desktop (a paired-but-not-joined device) shows it.
  function setPhoneRecIndicator(state) {
    if (phoneRecTimer) { clearTimeout(phoneRecTimer); phoneRecTimer = null; }
    if (!phoneRecBadgeEl) return;
    if (joinedSessionCode || state === "off" || !state) {
      phoneRecBadgeEl.style.display = "none";
      phoneRecBadgeEl.textContent = "";
      phoneRecBadgeEl.className = "";
      return;
    }
    var label = state === "transcribing" ? "Phone finished — transcribing…" : "Phone is recording…";
    phoneRecBadgeEl.className = state === "transcribing" ? "xcribe" : "rec";
    phoneRecBadgeEl.innerHTML = "";
    var dot = document.createElement("span");
    dot.className = "recdot";
    phoneRecBadgeEl.appendChild(dot);
    phoneRecBadgeEl.appendChild(document.createTextNode(" " + label));
    phoneRecBadgeEl.style.display = "inline-flex";
    // Auto-clear: a long-but-bounded window for recording (a missed "stop" must
    // not leave the dot pulsing forever); a tight one for transcribing (the
    // batch upload deadline plus margin) so a missed delivery clears it too.
    var ttl = state === "transcribing" ? (BATCH_UPLOAD_TIMEOUT_MS + 8000) : 600000;
    phoneRecTimer = setTimeout(function () { setPhoneRecIndicator("off"); }, ttl);
  }

  /* ───── Mic tips: keep other voices out (onboarding nudge) ─────
     iOS Voice Isolation is the single most effective lever against bystander
     speech (it filters at the OS level), but it is manual and undetectable from
     the web — so we surface it as a one-time tip, plus the universal close-mic
     and push-to-talk-discipline habits. Shown once on the phone surface. */
  function isLikelyIOS() {
    try {
      var ua = navigator.userAgent || "";
      if (/iPad|iPhone|iPod/.test(ua)) return true;
      // iPadOS 13+ reports as Mac — distinguish by touch support.
      if (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1) return true;
    } catch (e) {}
    return false;
  }

  function showMicTips() {
    if (!micTipsEl) return;
    var ios = isLikelyIOS();
    if (micTipsIosEl)     micTipsIosEl.style.display     = ios ? "" : "none";
    if (micTipsAndroidEl) micTipsAndroidEl.style.display = ios ? "none" : "";
    micTipsEl.classList.add("show");
  }

  function closeMicTips() {
    if (micTipsEl) micTipsEl.classList.remove("show");
    if (!micTipsSeen) { micTipsSeen = true; saveSettingsNow(); } // a dismissal counts as seen — don't auto-nag again
  }

  // Auto-show once on the phone (big-button) surface, until dismissed.
  function maybeAutoShowMicTips() {
    if (micTipsSeen || micTipsAutoShown) return;
    if (!bigButtonActive()) return; // the nudge is for the phone surface, not a plain desktop
    micTipsAutoShown = true;
    showMicTips();
  }

  function setPhoneLinkUI(connected) {
    if (!phoneCodeBadgeEl || !phoneSessionCode) return;
    phoneCodeBadgeEl.textContent = connected ? phoneSessionCode : phoneSessionCode + " ⚠";
    phoneCodeBadgeEl.style.color = connected ? "var(--accent)" : "var(--danger)";
    phoneCodeBadgeEl.title = connected ? "" : "Link to the session room dropped — reconnecting";
  }

  function startPhoneSession() {
    if (phoneSessionCode) return; // already active (possibly mid-reconnect)
    phoneSessionCode   = generateSessionCode();
    remoteCommitted    = "";
    remoteHasDelivery  = false;
    phoneJoined        = false;
    lastDeliveryId     = "";
    recentDeliveryIds  = [];
    pendingCopyText    = "";
    phoneReconnectDelayMs = 0;

    // This click is a user gesture: warm the beep context now so this tab's
    // success/failure cues stay audible later, when it is behind Citrix/Cerner.
    warmBeepCtx();

    beginPhoneSession("Phone session ready. Code: " + phoneSessionCode);
    updatePairButton();
    saveSettingsNow(); // session survives a reload — see restorePhoneLink
  }

  // Shared by startPhoneSession and the boot-time resume: shows the session UI,
  // opens the listener socket, and arms the heartbeat.
  function beginPhoneSession(statusMsg) {
    phoneCodeBadgeEl.style.display = "";
    setPhoneLinkUI(true);
    phoneStopBtnEl.style.display = "";
    phoneStartBtnEl.style.display = "none";
    if (phoneCodeHintEl) {
      phoneCodeHintEl.textContent = "Scan the QR with the phone camera, or open this page on the phone and enter the code above.";
      phoneCodeHintEl.style.display = "";
    }
    if (phoneQrEl) {
      var joinUrl = window.location.origin + "/?join=" + phoneSessionCode;
      phoneQrEl.setAttribute("data-join-url", joinUrl);
      renderQrSvg(joinUrl, phoneQrEl);
    }
    connectPhoneSessionWs();
    phoneLastPongAt = Date.now();
    if (!phonePingTimer) phonePingTimer = setInterval(phoneHeartbeat, PHONE_PING_INTERVAL_MS);
    setStatus(statusMsg, "ok");
  }

  // Boot restore: the codes persist in settings so an iOS PWA kill or a tab
  // reload cannot break the pairing. The desktop reconnects to the same room
  // (the room replays a delivery it missed; lastDeliveryId also persists, so
  // the replay cannot double-copy); the phone simply keeps relaying to the
  // code it had.
  function restorePhoneLink() {
    // QR join: the desktop's QR encodes /?join=<code> — joining by scan is the
    // same one-tap action as entering the code, and it persists the same way.
    var joinParam = "";
    try {
      joinParam = (new URLSearchParams(window.location.search).get("join") || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    } catch (e) {}
    if (joinParam && joinParam.length >= 4 && joinParam.length <= 8) {
      joinedSessionCode = joinParam;
      saveSettingsNow();
      try { history.replaceState(null, "", window.location.pathname); } catch (e) {}
      notifyDesktopOfJoin(joinParam); // a fresh QR scan: close the desktop's pairing overlay
      setStatus("Joined session " + joinParam + " (scanned). Start recording to send audio to the desktop.", "ok");
    }
    if (phoneSessionCode) {
      beginPhoneSession("Phone session resumed (code " + phoneSessionCode + ").");
      // No user gesture at boot, so beepCtx cannot be warmed yet — arm it on
      // the first interaction instead, or the listener's cues stay silent.
      var warm = function() { warmBeepCtx(); };
      document.addEventListener("pointerdown", warm, { once: true });
      document.addEventListener("keydown", warm, { once: true });
    }
    if (joinedSessionCode) {
      if (phoneJoinInputEl) phoneJoinInputEl.value = joinedSessionCode;
      if (phoneJoinBadgeEl) phoneJoinBadgeEl.style.display = "";
      if (phoneLeaveBtnEl)  phoneLeaveBtnEl.style.display = "";
      // Crash recovery: a phone that died after transcribing but before its
      // delivery landed boots with the text still queued — flush it now.
      if (deliveryQueue.length) backgroundFlush();
    }
  }

  function connectPhoneSessionWs() {
    var code = phoneSessionCode;
    if (!code) return;
    var proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    var ws = new WebSocket(proto + "//" + window.location.host + "/api/session/" + code);
    phoneSessionWs = ws;

    ws.onopen = function() {
      if (phoneSessionWs !== ws || phoneSessionCode !== code) return;
      phoneReconnectDelayMs = 0;
      phoneLastPongAt = Date.now();
      setPhoneLinkUI(true);
    };
    ws.onmessage = function(evt) {
      if (phoneSessionWs !== ws) return;
      phoneLastPongAt = Date.now(); // any room frame proves the link is alive
      try { handlePhoneSessionMessage(JSON.parse(evt.data)); } catch(e) {}
    };
    ws.onclose = function() {
      if (phoneSessionWs !== ws) return;
      phoneSessionWs = null;
      if (phoneSessionCode) schedulePhoneReconnect();
    };
    ws.onerror = function() { /* onclose always follows and reconnects */ };
  }

  function phoneHeartbeat() {
    if (!phoneSessionCode) return;
    var ws = phoneSessionWs;
    if (!ws || ws.readyState !== 1) return;
    try { ws.send(JSON.stringify({ message_type: "ping" })); } catch (e) {}
    if (Date.now() - phoneLastPongAt > PHONE_PONG_TIMEOUT_MS) {
      // NAT/idle timeouts can kill the socket without ever firing onclose —
      // the link looks open but is deaf. Force the close; onclose reconnects.
      try { ws.close(); } catch (e) {}
    }
  }

  function schedulePhoneReconnect() {
    setPhoneLinkUI(false);
    setStatus("⚠ Phone link dropped — reconnecting… (code " + phoneSessionCode + " stays valid)", "err");
    warnBeep();
    phoneReconnectDelayMs = Math.min(phoneReconnectDelayMs ? phoneReconnectDelayMs * 2 : 1000, PHONE_RECONNECT_MAX_MS);
    phoneReconnectTimer = setTimeout(function() {
      phoneReconnectTimer = null;
      if (phoneSessionCode && !phoneSessionWs) connectPhoneSessionWs();
    }, phoneReconnectDelayMs);
  }

  function stopPhoneSession() {
    phoneSessionCode = ""; // cleared first so the onclose below does not reconnect
    if (phonePingTimer)      { clearInterval(phonePingTimer); phonePingTimer = null; }
    if (phoneReconnectTimer) { clearTimeout(phoneReconnectTimer); phoneReconnectTimer = null; }
    if (phoneFallbackTimer)  { clearTimeout(phoneFallbackTimer); phoneFallbackTimer = null; }
    if (phoneSessionWs) {
      var ws = phoneSessionWs;
      phoneSessionWs = null;
      try { ws.close(); } catch (e) {}
    }
    remoteCommitted   = "";
    remoteHasDelivery = false;
    phoneJoined       = false;
    pendingCopyText   = "";
    lastDeliveryId    = "";
    recentDeliveryIds = [];
    setPhoneRecIndicator("off"); // tear down the live "phone is recording" cue
    phoneCodeBadgeEl.style.display = "none";
    phoneStopBtnEl.style.display = "none";
    phoneStartBtnEl.style.display = "";
    if (phoneCodeHintEl) phoneCodeHintEl.style.display = "none";
    if (phoneQrEl) { phoneQrEl.style.display = "none"; phoneQrEl.innerHTML = ""; }
    closePairOverlay();
    updatePairButton();
    saveSettingsNow(); // forget the persisted session
    setStatus("Phone session ended.", "");
  }

  // Deliver text that arrived from the phone to this desktop's clipboard.
  // degraded = live-text fallback (the authoritative delivery never came).
  function deliverRemoteText(text, degraded) {
    // The desktop OWNS the note when a phone is the mic, so it honors THIS
    // device's append mode / one-shot box-click arm: a phone dictation extends
    // the current note instead of replacing it — mirroring single-desktop
    // append, which the user expects to apply no matter which mic dictated. The
    // joined phone delivers single segments (see startRecording) and the caller
    // dedupes by delivery_id BEFORE us, so a replayed/retried delivery can never
    // double-append. A one-shot arm is consumed here.
    var base = (latestText || "").trim();
    var wantAppend = Boolean(base) && (appendModeEl.checked || appendArmed);
    appendArmed = false;
    var combined = wantAppend ? cleanTranscript(base + " " + text) : text;
    latestText = combined;
    latestEl.textContent = combined;
    finalizedSegments = combined.trim() ? [combined] : []; // keep the box model in sync for further edits/append
    updateAppendChip(); // refresh the armed pill now the one-shot arm is consumed
    addHistory(combined, { language_code: "en", engine: "remote" });
    if (!autoCopyEl.checked) {
      if (degraded) { setStatus("⚠ Phone delivery never arrived — LIVE transcript saved, not copied. Verify it!", "warn"); warnBeep(); }
      else          { setStatus(wantAppend ? "Phone transcript appended." : "Phone transcript received.", "ok"); doneBeep(); }
      return;
    }
    copyText(combined).then(function(ok) {
      if (ok) {
        pendingCopyText = "";
        if (degraded) { setStatus("⚠ Phone delivery never arrived — LIVE transcript copied instead (less accurate). Verify it!", "warn"); warnBeep(); }
        else          { setStatus(wantAppend ? "Phone transcript appended & copied. Done!" : "Phone transcript copied. Done!", "ok"); doneBeep(); }
      } else {
        // Clipboard writes need document focus, and this tab is usually behind
        // Citrix/Cerner when a delivery lands. Hold the text; retry on refocus.
        pendingCopyText = combined;
        setStatus("⚠ Phone transcript received but clipboard copy FAILED — click this window and it will copy itself. Do NOT paste before that!", "err");
        failBeep();
      }
    });
  }

  // Retry a held delivery the moment this tab can write the clipboard again.
  window.addEventListener("focus", function() {
    if (!pendingCopyText) return;
    var text = pendingCopyText;
    copyText(text).then(function(ok) {
      if (!ok || pendingCopyText !== text) return;
      pendingCopyText = "";
      setStatus("Phone transcript copied. Done!", "ok");
      doneBeep();
    });
  });

  function handlePhoneSessionMessage(msg) {
    if (!msg || !msg.message_type) return;

    if (msg.message_type === "pong") return; // heartbeat reply; onmessage already timestamped it

    if (msg.message_type === "phone_join") {
      // The phone announced it joined — close the pairing QR overlay and show
      // the paired state (don't re-announce on a repeat ping).
      if (!onPhoneJoined()) {
        setStatus("Phone paired ✓ — dictate on the phone; the text lands on this clipboard.", "ok");
      }
      return;
    }

    if (msg.message_type === "phone_recording") {
      // The paired phone started/stopped capturing — surface a live indicator so
      // the desktop user knows audio is flowing before the text arrives. A
      // delivery proves a phone is on the link, same as phone_join.
      onPhoneJoined();
      if (msg.state === "stop") {
        setPhoneRecIndicator("transcribing");
        setStatus("📱 Phone finished — transcribing… (Code: " + phoneSessionCode + ")", "warn");
      } else {
        setPhoneRecIndicator("recording");
        setStatus("📱 Phone is recording — the text lands here on release. (Code: " + phoneSessionCode + ")", "ok");
      }
      return;
    }

    if (msg.message_type === "session_started") {
      setStatus("Phone connected. Listening... (Code: " + phoneSessionCode + ")", "ok");
      return;
    }

    if (msg.message_type === "partial_transcript") {
      var partial = (msg.transcript || msg.text || "").trim();
      rtDebugLog("[rt-listener " + Math.round(performance.now()) + "] partial(" + partial.length + "): " + JSON.stringify(partial));
      var combined = remoteCommitted + (remoteCommitted && partial ? " " : "") + partial;
      latestText = cleanTranscript(combined);
      latestEl.textContent = latestText;
      return;
    }

    if (msg.message_type === "committed_transcript" ||
        msg.message_type === "committed_transcript_with_timestamps") {
      var seg = (msg.transcript || msg.text || "").trim();
      rtDebugLog("[rt-listener " + Math.round(performance.now()) + "] COMMIT(" + seg.length + ") remoteCommitted.len=" + remoteCommitted.length + ": " + JSON.stringify(seg));
      if (seg) remoteCommitted += (remoteCommitted ? " " : "") + seg;
      latestText = cleanTranscript(remoteCommitted);
      latestEl.textContent = latestText;
      return;
    }

    if (msg.message_type === "phone_delivery") {
      // A delivery proves a phone is on the link — close the pairing overlay if
      // the phone_join ping was missed (it is not buffered/replayed).
      onPhoneJoined();
      setPhoneRecIndicator("off"); // the dictation landed — drop the recording/transcribing cue
      // The room replays the last delivery to (re)connecting listeners so a
      // link drop cannot lose it; the phone's delivery queue can also re-POST a
      // held delivery. Dedupe against a RING of recent ids, not just the last
      // one: a single-id check would let a retried delivery re-arriving AFTER a
      // newer one re-copy stale text onto a chart — the exact silent-wrong-text
      // failure this app exists to prevent.
      if (msg.delivery_id && recentDeliveryIds.indexOf(msg.delivery_id) !== -1) return;
      if (msg.delivery_id) {
        recentDeliveryIds.push(msg.delivery_id);
        while (recentDeliveryIds.length > DELIVERY_DEDUPE_RING) recentDeliveryIds.shift();
        lastDeliveryId = msg.delivery_id; // retained for back-compat persistence/migration
        saveSettingsNow();
      }
      if (phoneFallbackTimer) { clearTimeout(phoneFallbackTimer); phoneFallbackTimer = null; }
      remoteHasDelivery = true;
      var final = (msg.text || "").trim();
      if (final) deliverRemoteText(final, false);
      remoteCommitted   = "";
      remoteHasDelivery = false;
      return;
    }

    if (msg.message_type === "phone_session_end") {
      // The phone's dictation socket closed, but the authoritative
      // phone_delivery may still be seconds away (hybrid refine). Keep the
      // session alive for the next dictation and give the delivery a grace
      // window before falling back to the accumulated live text.
      if (remoteCommitted.trim() && !phoneFallbackTimer) {
        setStatus("Phone dictation ended — waiting for the final transcript…", "warn");
        phoneFallbackTimer = setTimeout(function() {
          phoneFallbackTimer = null;
          if (!remoteCommitted.trim()) return; // the delivery arrived meanwhile
          var fallback = cleanTranscript(remoteCommitted);
          remoteCommitted = "";
          deliverRemoteText(fallback, true);
        }, PHONE_FALLBACK_GRACE_MS);
      }
      return;
    }

    if (msg.error) {
      setStatus("Phone session error: " + msg.error, "err");
      warnBeep();
    }
  }

  /* ───── Phone-side durable delivery queue ─────
     A joined phone POSTs its final text to the room's /deliver. If that POST
     fails (phone network blip) or acks zero listeners (desktop down past the
     room's 2-min replay buffer), the text would survive only in this device's
     box/history — a desktop that reconnects later would get nothing. The queue
     makes an undelivered relay durable: persisted to localStorage, retried on
     link heal (online/visibility/focus/timer) and at boot, until a listener
     acks it. The desktop dedupes by a ring of recent ids, so a retried re-POST
     can never re-copy stale text. This narrows the never-lose-a-dictation gap;
     it never widens it. */

  function enqueueDelivery(text) {
    var item = {
      id: Date.now().toString(36) + "-" + Math.floor(Math.random() * 0xffffffff).toString(36),
      text: text,
      ts: Date.now(),
    };
    deliveryQueue.push(item);
    // An unbounded retry buffer is its own failure mode: drop the OLDEST
    // undelivered item (it stays in this device's history). The just-enqueued
    // item is at the tail, so it is never the one dropped.
    while (deliveryQueue.length > DELIVERY_QUEUE_MAX) deliveryQueue.shift();
    saveSettingsNow();
    return item;
  }

  function pruneStaleDeliveries() {
    if (!deliveryQueue.length) return;
    var now = Date.now();
    var before = deliveryQueue.length;
    // A delivery too old to land safely (the user has moved on) must NOT auto-
    // paste onto a chart hours later — drop it from the retry queue. It remains
    // in history, and the original failure was already announced loud.
    deliveryQueue = deliveryQueue.filter(function (it) { return now - it.ts < DELIVERY_QUEUE_TTL_MS; });
    if (deliveryQueue.length !== before) saveSettingsNow();
  }

  function scheduleDeliveryRetry() {
    if (deliveryRetryTimer || !deliveryQueue.length) return;
    deliveryRetryDelayMs = Math.min(deliveryRetryDelayMs ? deliveryRetryDelayMs * 2 : DELIVERY_QUEUE_RETRY_MS, DELIVERY_QUEUE_RETRY_MAX_MS);
    deliveryRetryTimer = setTimeout(function () {
      deliveryRetryTimer = null;
      flushDeliveryQueue();
    }, deliveryRetryDelayMs);
  }

  // POST one queued item to the room. Resolves to one of:
  //   "delivered" — a listener received it (drop it from the queue)
  //   "buffered"  — POST ok but zero listeners (room holds it; keep + retry)
  //   "failed"    — POST error/timeout (link down; keep + stop this round)
  async function postDelivery(item) {
    if (!joinedSessionCode) return "failed";
    var payload = JSON.stringify({ message_type: "phone_delivery", text: item.text, delivery_id: item.id });
    // A black-holed POST must still produce an outcome: without a deadline a
    // hung relay reports nothing at all (and would stall a queued session).
    var ctrl = (typeof AbortController !== "undefined") ? new AbortController() : null;
    var killer = ctrl ? setTimeout(function () { try { ctrl.abort(); } catch (e) {} }, RELAY_TIMEOUT_MS) : null;
    try {
      var res = await fetch("/api/session/" + joinedSessionCode + "/deliver", {
        method: "POST",
        body: payload,
        headers: { "Content-Type": "application/json" },
        signal: ctrl ? ctrl.signal : undefined,
      });
      if (!res.ok) throw new Error("HTTP " + res.status);
      var listeners = -1;
      try { listeners = JSON.parse(await res.text()).listeners; } catch (e) { listeners = -1; }
      return listeners > 0 ? "delivered" : "buffered";
    } catch (e) {
      return "failed";
    } finally {
      if (killer) clearTimeout(killer);
    }
  }

  // Flush the queue FIFO. Serialized through flushChain so concurrent triggers
  // (a fresh delivery racing a background retry) never interleave POSTs — room
  // ordering stays FIFO and every caller learns its own item's outcome.
  function flushDeliveryQueue(opts) {
    var run = flushChain.then(function () { return doFlush(opts); });
    flushChain = run.catch(function () {}); // one failure must not poison the chain
    return run;
  }

  async function doFlush(opts) {
    opts = opts || {};
    if (!joinedSessionCode) return "";
    pruneStaleDeliveries();
    // Process only items present when THIS flush began. An item enqueued mid-
    // flush (a new dictation racing a background retry) is left for its own
    // chained flush, so the dictation that enqueued it always learns its own
    // outcome — and FIFO order is preserved.
    var snapshot = deliveryQueue.map(function (it) { return it.id; });
    var blocked = "";          // the result that stopped the round (buffered/failed)
    var reachedCurrent = false;
    while (deliveryQueue.length) {
      var item = deliveryQueue[0];
      if (snapshot.indexOf(item.id) === -1) break; // enqueued after this flush began
      var isCurrent = Boolean(opts.currentId && item.id === opts.currentId);
      var result = await postDelivery(item);
      if (result === "delivered") {
        if (isCurrent) reachedCurrent = true;
        deliveryQueue.shift(); // index 0 is still this item (flushChain serializes mutation)
        saveSettingsNow();
        deliveryRetryDelayMs = 0;
      } else {
        blocked = result;            // buffered or failed
        if (isCurrent) reachedCurrent = true;
        break;                       // head-of-line: nothing behind it can land either
      }
    }
    if (deliveryQueue.length) scheduleDeliveryRetry();
    if (!opts.currentId) return "";
    // current delivered ⇒ "delivered"; current itself blocked ⇒ that result;
    // an EARLIER item blocked (current never reached) ⇒ current is behind a
    // down desktop, so mirror the blocker (it did not land).
    if (reachedCurrent) return blocked || "delivered";
    return blocked || "buffered";
  }

  // Drive queued deliveries silently when the link may have healed (no current
  // dictation to announce). The original failure already played its one outcome
  // cue; a successful drain gives quiet positive closure without a second beep.
  async function backgroundFlush() {
    if (!joinedSessionCode || !deliveryQueue.length) return;
    var had = deliveryQueue.length;
    await flushDeliveryQueue();
    // Quiet closure only when idle: a heal event firing mid-dictation must not
    // overwrite the live REC/upload status line with a stale "delivered".
    if (had && deliveryQueue.length === 0 && !recording && !stopping && !finishing) {
      setStatus("Queued transcript" + (had > 1 ? "s" : "") + " delivered to the desktop. Done!", "ok");
    }
  }

  // Phone side: relay the final text to the desktop via the durable queue.
  // Exactly one outcome cue for THIS dictation (one beep per session preserved):
  // the queue flush returns this item's fate and we translate it here.
  // announceOutcome: the local phone copy was denied (iOS, no gesture) on an
  // otherwise-clean outcome, so this ack carries the dictation's outcome cue.
  async function relayDeliveryToDesktop(text, announceOutcome) {
    var item = enqueueDelivery(text); // durable BEFORE the network call: a phone that dies now recovers at boot
    var outcome = await flushDeliveryQueue({ currentId: item.id });
    // announceOutcome FALSE ⇒ an unexpected/mic-alarm joined dictation:
    // deliverFinalText already played the loud local cue (fail beep + red
    // status). The queue still retries the text — we just never add a SECOND
    // cue (the one-outcome-beep-per-session invariant).
    if (!announceOutcome) return;
    if (outcome === "delivered") {
      // The deferred outcome cue: the desktop received it — the success moment.
      setStatus("Delivered to the desktop clipboard. Done!", "ok");
      doneBeep();
    } else if (outcome === "buffered") {
      // POST ok but nobody is listening: the desktop does not have it yet. The
      // text is queued + retried, but the user must hear that it did not land.
      setStatus("⚠ Desktop link is DOWN — transcript queued; it delivers when the desktop reconnects. VERIFY it lands before pasting!", "err");
      warnBeep();
    } else {
      // POST failed/timed out: link down. Loud, and queued for retry.
      setStatus("⚠ Desktop relay FAILED — transcript queued; it retries when the link is back. It has NOT reached the desktop yet!", "err");
      failBeep();
    }
  }

  /* ───── Big-button dictation layout ─────
     Active while this device is JOINED to a desktop session (or forced by the
     per-device override) — activation is the joined state, never the screen
     size. The button drives the exact same startRecording()/stopRecording()
     session paths as the record button, with the hotkey's tap/hold semantics;
     the whole-screen indicator is derived from the existing status/pill
     transitions. Everything here is additive: the normal layout (and the
     desktop tiny-window compactness contract) is untouched. */
  function bigButtonActive() {
    const mode = bigButtonModeEl ? bigButtonModeEl.value : "joined";
    if (mode === "never") return false;
    if (mode === "always") return true;
    return Boolean(joinedSessionCode);
  }

  function applyBigButtonUI() {
    const active = bigButtonActive();
    document.body.classList.toggle("bigbtn", active);
    // Keep the screen awake the whole time the phone sits on this surface so iOS
    // auto-lock can't reclaim the mic between push-to-talk presses; drop it on
    // leave unless a dictation is still mid-flight and wants it (wakeLockDesired).
    if (active) acquireWakeLock();
    else if (!wakeLockDesired()) releaseWakeLock();
    if (!active) {
      document.body.classList.remove("bigbtn-settings");
      bigPeekExpanded = false;
    }
    if (bigJoinedBadgeEl) {
      bigJoinedBadgeEl.textContent = joinedSessionCode
        ? "Joined " + joinedSessionCode
        : "Not joined — dictating to this device";
    }
    if (bigLeaveBtnEl) bigLeaveBtnEl.style.display = joinedSessionCode ? "" : "none";
    updateBigScreen();
    maybeAutoShowMicTips(); // first time on the phone surface: nudge about other-voice rejection
  }

  function setBigSettingsVisible(show) {
    document.body.classList.toggle("bigbtn-settings", Boolean(show) && bigButtonActive());
  }

  // Whole-screen state, derived from the SAME transitions that drive the
  // status line and the mic/link pills — no new state machinery. Because the
  // deliverable goes to the DESKTOP in joined mode, relay outcomes are part of
  // the picture automatically: a zero-listener ack or relay failure lands as
  // an "err" status after the local delivery, turning the screen red even
  // though the local done beep already played.
  function updateBigScreen() {
    if (!bigUiEl) return;
    let state;
    if (lastMicPillState === "fail") state = "alarm";
    else if (recording && !stopping) state = lastLinkPillState === "connecting" ? "connecting" : "rec";
    else if (stopping || finishing || lastLinkPillState === "uploading" || lastLinkPillState === "refining") state = "busy";
    else if (lastStatusCls === "err") state = "fail";
    else if (lastStatusCls === "warn") state = "warn";
    else if (lastStatusCls === "ok") state = "ok";
    else state = "idle";
    bigUiEl.setAttribute("data-screen", state);
    if (bigStateEl) {
      // The warn headline must never claim DONE: warn covers both degraded
      // deliveries AND idle advisories (mic re-warm failed, …) — "CHECK"
      // points at the status line below without asserting a delivery.
      bigStateEl.textContent =
        state === "alarm" ? "⚠ MIC FAIL" :
        state === "rec" ? "● REC" :
        state === "connecting" ? "CONNECTING…" :
        state === "busy" ? "WORKING…" :
        state === "ok" ? "DONE" :
        state === "warn" ? "⚠ CHECK" :
        state === "fail" ? "FAILED" : "READY";
    }
    if (bigBtnEl) {
      bigBtnEl.textContent =
        (recording && !stopping) ? "STOP" :
        (stopping || finishing) ? "…" : "HOLD TO TALK";
    }
    if (bigStatusEl) bigStatusEl.textContent = statusEl.textContent;
    updateBigPeek();
  }

  // The latest transcript collapses to a one-line peek strip; tap to expand.
  function updateBigPeek() {
    if (!bigPeekEl) return;
    bigPeekTextEl.textContent = latestText || "";
    // While a dictation is live, show the realtime words wrapped and pinned to the
    // newest line — a collapsed one-liner truncates from the end, so the latest
    // recognized words scroll off-screen and the strip looks frozen (the realtime
    // feedback the mobile/joined user actually needs). Batch has no live text, so
    // gate on latestText: nothing to show until delivery.
    var live = (recording || stopping) && !!latestText;
    bigPeekEl.classList.toggle("live", live);
    bigPeekEl.classList.toggle("expanded", bigPeekExpanded);
    bigPeekEl.classList.toggle("armed", appendArmed && !recording);
    bigPeekBarEl.textContent = live
      ? "Live transcript"
      : bigPeekExpanded
        ? "Latest transcript — tap here to collapse · tap the text to append the next dictation"
        : "Latest transcript — tap to expand";
    if (live) bigPeekTextEl.scrollTop = bigPeekTextEl.scrollHeight;
  }

  // Press/release handling. Pointer capture plus the cancel/lost/document
  // backstops guarantee that EVERY way a press can end routes through
  // bigBtnRelease — long-press-and-slide-away or multi-touch must never wedge
  // the recording state (never-lose-a-dictation, applied to input handling).
  function bigBtnPress(e) {
    if (e.preventDefault) e.preventDefault();
    if (bigBtnPointerId !== null) return; // a second finger never steals the press
    bigBtnPointerId = e.pointerId !== undefined ? e.pointerId : -1;
    try { bigBtnEl.setPointerCapture(e.pointerId); } catch (err) {}
    if (!recording && !stopping && !finishing) {
      bigBtnEngaged = true;
      bigBtnDownAt = Date.now();
      startRecording();
    } else if (stopping || finishing) {
      bigBtnEngaged = true;
      bigBtnDownAt = Date.now();
      pendingStart = true; // press while finalizing queues the next dictation
    } else {
      bigBtnEngaged = false; // second tap: toggle off
      bigBtnDownAt = 0;
      stopRecording();
    }
  }

  function bigBtnRelease(e) {
    if (bigBtnPointerId === null) return;
    if (e && e.pointerId !== undefined && e.pointerId !== bigBtnPointerId) return; // not the owning finger
    bigBtnPointerId = null;
    if (!bigBtnEngaged) return;
    bigBtnEngaged = false;
    // pointercancel / lostpointercapture mean the real release will NEVER
    // arrive (gesture takeover, capture loss). Unlike a quick tap, that is a
    // stop regardless of hold duration — an open mic nobody can release is
    // never the right interpretation. (If this press toggled an existing
    // recording off, bigBtnPress already cleared bigBtnEngaged — no re-stop.)
    const cancelled = Boolean(e && (e.type === "pointercancel" || e.type === "lostpointercapture"));
    const held = bigBtnDownAt && Date.now() - bigBtnDownAt > HOTKEY_TAP_MS;
    bigBtnDownAt = 0;
    if (!held && !cancelled) return; // quick tap: keep recording, next tap stops
    if (stopping || finishing || pendingStartTimer) { cancelQueuedStart(); return; } // press ended during a finalize/queued window: don't auto-start an unheld mic
    stopRecording();
  }

  if (bigBtnEl) {
    bigBtnEl.addEventListener("pointerdown", bigBtnPress);
    bigBtnEl.addEventListener("pointerup", bigBtnRelease);
    bigBtnEl.addEventListener("pointercancel", bigBtnRelease);
    bigBtnEl.addEventListener("lostpointercapture", bigBtnRelease);
    // Long-press context menus would swallow the release.
    bigBtnEl.addEventListener("contextmenu", (e) => e.preventDefault());
    // Backstop for environments where pointer capture is unavailable: the
    // release is caught at the document even if the finger slid off the button.
    document.addEventListener("pointerup", bigBtnRelease);
    document.addEventListener("pointercancel", bigBtnRelease);
  }

  if (bigPeekBarEl) bigPeekBarEl.addEventListener("click", () => {
    bigPeekExpanded = !bigPeekExpanded;
    updateBigPeek();
  });
  if (bigPeekTextEl) bigPeekTextEl.addEventListener("click", () => {
    if (!bigPeekExpanded) { bigPeekExpanded = true; updateBigPeek(); return; }
    // Expanded: tapping the text arms append. Call the shared arm helper so the
    // one-shot rules live in exactly one place (the box click now edits, not arms).
    toggleAppendArm();
  });

  if (bigLeaveBtnEl) bigLeaveBtnEl.onclick = () => { if (phoneLeaveBtnEl) phoneLeaveBtnEl.click(); };
  if (bigSettingsBtnEl) bigSettingsBtnEl.onclick = () => setBigSettingsVisible(true);
  if (bigReturnBtnEl) bigReturnBtnEl.onclick = () => setBigSettingsVisible(false);
  if (bigButtonModeEl) bigButtonModeEl.addEventListener("change", () => {
    saveSettings();
    applyBigButtonUI();
  });

  /* ───── Controls & Event Listeners ───── */
  recordBtn.onclick = () => {
    if (recording) stopRecording();
    else startRecording();
  };

  forgetKeyBtn.onclick = () => {
    apiKeyEl.value = "";
    if (sonioxKeyEl) sonioxKeyEl.value = "";
    if (passphraseEl) passphraseEl.value = "";
    saveApiKeyEl.checked = false;
    localStorage.removeItem(API_KEY_STORAGE_KEY);
    localStorage.removeItem(SONIOX_KEY_STORAGE_KEY);
    localStorage.removeItem(PASSPHRASE_STORAGE_KEY);
    localStorage.removeItem(LEGACY_ACCESS_CODE_KEY);
    saveSettingsNow();
    updateAuthUI();
    if (authSectionEl) authSectionEl.open = true;
    setStatus(SHARED_MODE ? "Shared passphrase / key removed." : "API key removed.", "ok");
  };

  clearBtn.onclick = () => {
    localStorage.removeItem(STORE_KEY);
    latestText = "";
    latestEl.textContent = "";
    finalizedSegments = []; // Fixed: Make sure screen buffer is cleared alongside history
    currentPartial = "";
    archivedText = ""; // the slot mirrors history — wiping history empties it too
    renderHistory();
    updateAppendChip();
    setStatus("History cleared.");
  };

  freshBtn.onclick = () => {
    // Clearing the box files the note into the "Last dictation" slot first, so
    // it stays visible (and one tap of "Append to this" can bring it back).
    fileToSlot(latestText);
    clearBox();
    updateLiveDisplay();
    updateAppendChip();
    setStatus("Dictation box cleared — the next dictation starts a new note (it's in 'Last dictation' and history).", "ok");
  };

  // Copy latest = copy AND file it: the note goes to the clipboard, then moves
  // to the "Last dictation" slot and the box clears, ready for a fresh note. A
  // failed copy keeps the box (the loud copyText status stands) so nothing is
  // lost before the deliverable actually landed.
  copyBtn.onclick = async () => {
    if (!latestText || !latestText.trim()) return;
    const text = latestText;
    const ok = await copyText(text);
    if (!ok) return;
    fileToSlot(text);
    clearBox();
    updateLiveDisplay();
    updateAppendChip();
    setStatus("Copied — filed below as 'Last dictation'. The box is ready for a new note.", "ok");
  };

  // The "Last dictation" slot text is hand-editable too (like the active box and
  // history rows): the caret lands where you click, edits keep archivedText live
  // (so the slot's Copy/Append use the edited text), and on blur the edit is
  // persisted back to its history entry (matched by the pre-edit text, stamped
  // editedAt). A blanked slot never wipes the saved note. Plain-text paste.
  var slotEditBase = "";
  function persistSlotEdit() {
    if (!lastDictationTextEl) return;
    const newText = (lastDictationTextEl.textContent || "").trim();
    archivedText = lastDictationTextEl.textContent;
    if (!newText || newText === (slotEditBase || "").trim()) return;
    const all = getHistory();
    const i = all.findIndex(function (it) { return (it.text || "").trim() === (slotEditBase || "").trim(); });
    if (i >= 0) {
      all[i].text = lastDictationTextEl.textContent;
      all[i].editedAt = new Date().toISOString();
      setHistory(all); // persist + re-render the list (the slot DOM is separate)
      setStatus("Saved edit to the last dictation.", "ok");
    }
    slotEditBase = newText;
  }
  if (lastDictationTextEl) {
    lastDictationTextEl.addEventListener("focus", function () { slotEditBase = (archivedText || "").trim(); });
    lastDictationTextEl.addEventListener("input", function () { archivedText = lastDictationTextEl.textContent; });
    lastDictationTextEl.addEventListener("blur", persistSlotEdit);
    lastDictationTextEl.addEventListener("paste", plainTextPaste);
  }

  // Slot "Copy": copy the filed note straight to the clipboard, leaving the box
  // (and the slot) untouched — a re-grab of an older note, not a state change.
  if (lastCopyBtn) lastCopyBtn.onclick = () => { if (archivedText && archivedText.trim()) copyText(archivedText); };

  // Slot "Append to this": bring the filed note back into the box and arm a
  // one-shot append so the next dictation continues it. Only valid when the box
  // is empty (renderLastDictation disables it otherwise) — append targets what's
  // in the box, and we must never clobber a different active note.
  if (lastAppendBtn) lastAppendBtn.onclick = () => {
    if (recording || stopping || finishing) return;
    const t = (archivedText || "").trim();
    if (!t) return;
    if (latestText && latestText.trim()) return; // box busy — guard (button is also disabled)
    finalizedSegments = [t];
    currentPartial = "";
    archivedText = ""; // it's the active note now, not the archived one
    appendArmed = true;
    updateLiveDisplay();
    updateAppendChip();
    setStatus("Loaded the last dictation into the box — the next dictation will append to it.", "ok");
  };

  if (phoneStartBtnEl) phoneStartBtnEl.onclick = () => startPhoneSession();
  if (phoneStopBtnEl)  phoneStopBtnEl.onclick  = () => stopPhoneSession();
  if (phoneJoinBtnEl) phoneJoinBtnEl.onclick = () => {
    var code = (phoneJoinInputEl ? phoneJoinInputEl.value : "").toUpperCase().replace(/[^A-Z0-9]/g, "");
    if (!code || code.length < 4) { setStatus("Enter the 6-character code shown on the desktop.", "err"); return; }
    if (code !== joinedSessionCode) {
      // Switching to a different desktop: queued deliveries target the OLD code
      // and must never misdeliver to the new one (stale text on the wrong
      // chart). Drop them (still in history) and start the backoff over.
      deliveryQueue = [];
      if (deliveryRetryTimer) { clearTimeout(deliveryRetryTimer); deliveryRetryTimer = null; }
      deliveryRetryDelayMs = 0;
    }
    joinedSessionCode = code;
    if (phoneJoinBadgeEl) phoneJoinBadgeEl.style.display = "";
    if (phoneLeaveBtnEl)  phoneLeaveBtnEl.style.display = "";
    saveSettingsNow(); // join survives reloads/PWA kills — see restorePhoneLink
    notifyDesktopOfJoin(code); // close the desktop's pairing QR overlay right away
    applyBigButtonUI(); // joining flips this device into the big-button layout
    setStatus("Joined session " + code + ". Start recording to send audio to the desktop.", "ok");
  };
  if (pairPhoneBtnEl) pairPhoneBtnEl.onclick = () => openPairOverlay();
  if (pairDoneBtnEl)  pairDoneBtnEl.onclick  = () => closePairOverlay();
  if (pairEndBtnEl)   pairEndBtnEl.onclick   = () => { stopPhoneSession(); closePairOverlay(); };

  if (micTipsDoneBtnEl)    micTipsDoneBtnEl.onclick    = () => closeMicTips();
  if (bigTipsBtnEl)        bigTipsBtnEl.onclick        = () => showMicTips();
  if (optionsMicTipsBtnEl) optionsMicTipsBtnEl.onclick = () => showMicTips();
  // Tapping the dark backdrop dismisses the tips (counts as seen).
  if (micTipsEl) micTipsEl.addEventListener("click", (e) => { if (e.target === micTipsEl) closeMicTips(); });

  if (phoneLeaveBtnEl) phoneLeaveBtnEl.onclick = () => {
    joinedSessionCode = "";
    // Abandon any deliveries queued for the code we left (they target that
    // code and can never be acked now; the text stays in this device's history).
    deliveryQueue = [];
    if (deliveryRetryTimer) { clearTimeout(deliveryRetryTimer); deliveryRetryTimer = null; }
    deliveryRetryDelayMs = 0; // a fresh join must start the retry backoff over (cf. phoneReconnectDelayMs)
    if (phoneJoinBadgeEl) phoneJoinBadgeEl.style.display = "none";
    phoneLeaveBtnEl.style.display = "none";
    saveSettingsNow();
    applyBigButtonUI(); // leaving reverts to the normal layout (unless the override is "always")
    setStatus("Left the desktop session — dictations stay on this device now.", "ok");
  };

  // "Append next" arms a one-shot: the next dictation is added onto the current
  // note instead of starting fresh — independent of the append-mode checkbox;
  // tap again to cancel. (Clicking into the box arms this too via its focus
  // handler; this button is the explicit toggle/cancel.) Ignored mid-session.
  function toggleAppendArm() {
    if (recording || stopping || finishing) return;
    // Joined to a desktop: append is the DESKTOP's job (this device is only the
    // mic — see startRecording/deliverRemoteText), so arming here would mislead.
    if (joinedSessionCode) return;
    if (!latestText || !latestText.trim()) return;
    appendArmed = !appendArmed;
    updateAppendChip();
    setStatus(appendArmed
      ? "Next dictation will append to this text (tap 'Append next' again to cancel)."
      : "Next dictation starts fresh.", "");
  }
  if (appendToggleBtn) appendToggleBtn.onclick = toggleAppendArm;

  // The transcript box is hand-editable while idle (contenteditable, toggled by
  // refreshLatestEditable). Typing rewrites the in-memory note so Copy/Append/
  // delivery all use the edited text; collapse to one segment so a later append
  // splices cleanly onto it. Skip cleanTranscript here — it would fight the
  // cursor (trailing space, collapsing) mid-type; delivery still cleans output.
  latestEl.addEventListener("input", () => {
    if (recording || stopping || finishing) return; // not editable then; guard anyway
    latestText = latestEl.textContent;
    finalizedSegments = latestText.trim() ? [latestText] : [];
    if (!latestText.trim()) appendArmed = false;
    updateAppendChip(); // mirrors text + armed state into the big peek too
  });
  latestEl.addEventListener("paste", plainTextPaste);

  // Clicking into the box also arms a one-shot append: the next dictation adds
  // onto this note instead of starting fresh. The box already lights up on
  // :focus with the same accent glow as the .armed state, so click-to-edit and
  // click-to-append are now one gesture. The click places the caret normally
  // (no select-all — a stray keystroke must never wipe the note). Guarded to
  // idle + non-empty, mirroring toggleAppendArm; tap "Append next" to cancel.
  latestEl.addEventListener("focus", function () {
    if (recording || stopping || finishing) return;
    if (joinedSessionCode) return; // joined: append is the desktop's job; still editable, just don't arm
    if (!latestText || !latestText.trim()) return;
    if (appendArmed) return;
    appendArmed = true;
    updateAppendChip();
    setStatus("Next dictation will append to this text (tap 'Append next' to cancel).", "");
  });
  refreshLatestEditable();

  hotkeyBtn.onclick = () => {
    capturingHotkey = !capturingHotkey;
    updateHotkeyUI();
  };

  hotkeyResetBtn.onclick = () => {
    hotkey = Object.assign({}, DEFAULT_HOTKEY);
    capturingHotkey = false;
    updateHotkeyUI();
    saveSettingsNow();
    setStatus("Hotkey reset to " + hotkeyLabel(hotkey) + ".", "ok");
  };

  toggleHistoryBtn.onclick = () => {
    historyVisible = !historyVisible;
    saveSettingsNow();
    renderHistory();
  };

  downloadBtn.onclick = () => {
    const items = getHistory();
    const body = items.map((i) => {
      return "=== " + new Date(i.createdAt).toLocaleString() + " ===\\n" + i.text;
    }).join("\\n\\n");

    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([body], { type: "text/plain" }));
    a.download = "scribe-v2-transcripts.txt";
    a.click();
    URL.revokeObjectURL(a.href);
  };

  downloadAudioBtn.onclick = () => {
    if (!lastAudioBlob) {
      setStatus("No audio recorded yet.", "warn");
      return;
    }
    const a = document.createElement("a");
    const url = URL.createObjectURL(lastAudioBlob);
    a.href = url;
    a.download = "last-recording.webm";
    a.click();
    URL.revokeObjectURL(url);
  };

  gateOpenEl.addEventListener("input", () => {
    enforceGateOrder("open"); updateGateLabels(); saveSettings();
  });
  gateCloseEl.addEventListener("input", () => {
    enforceGateOrder("close"); updateGateLabels(); saveSettings();
  });
  highpassEl.addEventListener("input", () => {
    if (hpFilter) hpFilter.frequency.value = Number(highpassEl.value) || 0;
    updateGateLabels();
    saveSettings();
  });

  // Dynamic Scribe event listeners

  keytermsEl.addEventListener("input", updateKeytermHint);

  noiseSuppressEl.addEventListener("change", () => {
    releaseAudio();
    tryWarmOnLoad();
  });

  appendModeEl.addEventListener("change", updateAppendChip);
  if (advancedEl) advancedEl.addEventListener("toggle", saveSettings);
  if (optionsSectionEl) optionsSectionEl.addEventListener("toggle", saveSettings);
  if (keytermsSectionEl) keytermsSectionEl.addEventListener("toggle", saveSettings);

  // Credentials box: live summary while typing; collapse once credentials are
  // entered (change fires on blur). Reopen any time via the summary.
  for (const el of [apiKeyEl, sonioxKeyEl, passphraseEl]) {
    el.addEventListener("input", updateAuthUI);
    el.addEventListener("change", () => {
      updateAuthUI();
      if (hasAuth() && authSectionEl) authSectionEl.open = false;
    });
  }

  // Keep the "appending vs fresh" countdown honest
  setInterval(updateAppendChip, 1000);

  for (const el of [
    apiKeyEl, sonioxKeyEl, passphraseEl, saveApiKeyEl, keytermsEl, timestampsEl, tagEventsEl,
    autoCopyEl, appendModeEl, startBeepEl, diarizeEl,
  ]) {
    el.addEventListener("change", saveSettings);
    el.addEventListener("input", saveSettings);
  }

  document.addEventListener("keydown", (e) => {
    // Hotkey capture mode: the next non-modifier keypress becomes the hotkey
    if (capturingHotkey) {
      e.preventDefault();
      if (e.code === "Escape") {
        capturingHotkey = false;
        updateHotkeyUI();
        return;
      }
      if (/^(Control|Shift|Alt|Meta)(Left|Right)$/.test(e.code)) return; // wait for the main key
      hotkey = { ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, meta: e.metaKey, code: e.code };
      capturingHotkey = false;
      updateHotkeyUI();
      hotkeyBtn.blur();
      saveSettingsNow();
      setStatus("Push-to-talk hotkey set to " + hotkeyLabel(hotkey) + ".", "ok");
      return;
    }

    if (e.repeat) return;

    // F13/F14 are the AutoHotkey contract (CapsLock relay) — always active.
    if (e.code === "F13") {
      e.preventDefault();
      if (!recording && !stopping && !finishing) startRecording();
      else if (stopping || finishing) pendingStart = true; // PTT again while finalizing: queue it
      return;
    }
    if (e.code === "F14") {
      e.preventDefault();
      if (recording || stopRequested) stopRecording();
      // CapsLock released while a queued start was armed (or still pending a
      // finalize): a session starting AFTER the last F14 would violate the
      // contract — and open a mic nobody is holding.
      else cancelQueuedStart();
      return;
    }

    // In-app hotkey (default Ctrl+Space): tap toggles, hold is push-to-talk.
    if (hotkeyMatches(e)) {
      const t = e.target;
      const inField = t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable);
      // An unmodified key (e.g. plain Space) must stay typable in form fields
      if (inField && !(hotkey.ctrl || hotkey.alt || hotkey.meta)) return;
      e.preventDefault();
      if (!recording && !stopping && !finishing) {
        hotkeyEngaged = true;
        hotkeyDownAt = Date.now();
        startRecording();
      } else if (stopping || finishing) {
        hotkeyEngaged = true;
        hotkeyDownAt = Date.now();
        pendingStart = true; // tap while finalizing queues the next dictation
      } else {
        hotkeyEngaged = false; // second tap: toggle off
        hotkeyDownAt = 0;
        stopRecording();
      }
      return;
    }
  });

  document.addEventListener("keyup", (e) => {
    if (capturingHotkey || !hotkey || !hotkey.code || e.code !== hotkey.code) return;
    if (!hotkeyEngaged) return;
    hotkeyEngaged = false;
    const held = hotkeyDownAt && Date.now() - hotkeyDownAt > HOTKEY_TAP_MS;
    hotkeyDownAt = 0;
    if (!held) return; // quick tap: keep recording, next tap stops
    if (stopping || finishing || pendingStartTimer) { cancelQueuedStart(); return; } // held through a finalize/queued window: don't auto-start an unheld mic
    stopRecording();
  });

  window.addEventListener("beforeunload", () => {
    try { releaseAudio(); } catch (e) {}
  });

  // pagehide fires on iOS PWA suspend/app-switch even when visibilitychange and
  // beforeunload don't — it is also a backgrounding, so the audio graph must be
  // treated as suspect (and rebuilt) on return. See ensureAudio / audioSuspect.
  window.addEventListener("pagehide", () => { audioSuspect = true; });

  // Re-engage the mic when the app comes back: bfcache restores and slept
  // tabs can leave a dead MediaStream behind that looks alive.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) releaseAudio();
    if (!recording && !stopping) tryWarmOnLoad();
    if (wakeLockDesired()) acquireWakeLock(); // re-arm keep-awake on the phone surface after a bfcache restore
  });

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") {
      // Backgrounding: iOS can silently kill the mic track while it keeps
      // reporting "live"/unmuted. Mark the graph suspect so the next
      // ensureAudio() rebuilds from a fresh getUserMedia instead of reusing a
      // corpse that records silence (the resume silent-capture bug).
      audioSuspect = true;
      return;
    }
    backgroundFlush(); // a queued phone delivery may now reach a reconnected desktop
    if (wakeLockDesired()) acquireWakeLock(); // the OS auto-releases wake locks whenever the page hides — reclaim it
    // Reopened/focused while idle: re-engage a mic iOS reclaimed while hidden
    // (audioSuspect forces a real rebuild inside ensureAudio). Mid-session we
    // leave the live graph alone (the lock above is enough).
    if (!recording && !stopping && !finishing) tryWarmOnLoad();
  });

  // Standalone PWAs (iOS home-screen installs) sometimes fire only focus —
  // not visibilitychange — when switching back from another app.
  window.addEventListener("focus", () => {
    backgroundFlush(); // retry any queued phone deliveries on app-switch return
    if (wakeLockDesired()) acquireWakeLock(); // keep the phone surface awake on app-switch return
    if (!recording && !stopping && (audioSuspect || !audioGraphHealthy())) tryWarmOnLoad();
  });

  // The link healing is the cue to retry: drain the phone delivery queue the
  // moment connectivity returns.
  window.addEventListener("online", () => { backgroundFlush(); });

  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener("devicechange", () => {
      if (!recording && !stopping && !audioGraphHealthy()) {
        releaseAudio();
        tryWarmOnLoad();
      }
    });
  }

  if (SHARED_MODE) {
    passphraseRow.style.display = "";
    if (apiKeyLabelEl) apiKeyLabelEl.textContent = "ElevenLabs API key (optional — shared passphrase access in use)";
    apiKeyEl.placeholder = "optional — leave blank to use the shared passphrase";
    if (sonioxKeyLabelEl) sonioxKeyLabelEl.textContent = "Soniox API key (optional — shared passphrase access in use)";
    sonioxKeyEl.placeholder = "optional — leave blank to use the shared passphrase";
  }

  renderPresetRow(); // must precede loadSettings, which re-checks persisted presets
  loadSettings();
  applyEngineUI();
  updateGateLabels();
  updateKeytermHint();
  updateHotkeyUI();
  restoreLatestFromHistory();
  restorePhoneLink(); // resume/rejoin a persisted phone-link pairing
  applyBigButtonUI(); // after restorePhoneLink: a persisted/QR join boots straight into the big button
  updatePairButton(); // reflect any resumed phone session on the "Pair a phone" button
  updateAuthUI();
  if (authSectionEl) authSectionEl.open = !hasAuth(); // collapsed once credentials exist
  renderHistory();
  updateAppendChip();
  tryWarmOnLoad();
})();
</script>
</body>
</html>`;
