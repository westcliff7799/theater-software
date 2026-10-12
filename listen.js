// Speech recognition on the server with a local Whisper model, so the Follow page
// works inside the app window (Chrome's own recogniser needs Google and is missing in Electron).
//
// The page streams 16 kHz mono audio over the socket. Every second we run Whisper
// over everything heard since the last "commit" and send back
//   { final: "words we are sure about", interim: "the sentence still growing" }
// which is the same shape the browser recogniser gives, so the page's matcher is unchanged.
// At a pause (or after 15 s) the growing sentence is committed and the buffer starts fresh.

const RATE = 16000;
const MIN_AUDIO = RATE * 0.8;     // don't bother Whisper with less than this
const COMMIT_AFTER = RATE * 3;    // once we have 3 s, commit at the next quiet moment...
const COMMIT_MAX = RATE * 8;      // ...or by force at 8 s, at the quietest point of the last 2 s, so the window stays short and fast
const QUIET_TAIL = RATE * 0.3;    // "quiet moment" = the last 0.3 s is near silent
const TICK_MS = 300;              // how often we look; Whisper runs back to back when there is speech
const SILENCE_RMS = 0.004;        // below this the mic is hearing nothing (Whisper hallucinates on silence)
const KEEP_WORDS = 200;           // how much committed text we keep sending back

let asr = null;
let loading = null;

// Load the model once, on first use. The first ever run downloads it (needs internet); after that it's cached.
function loadModel(model) {
  if (!loading) {
    loading = (async () => {
      const { pipeline } = require("@huggingface/transformers");
      asr = await pipeline("automatic-speech-recognition", model, { dtype: "fp32" });
      console.log("speech model ready:", model);
    })().catch((err) => {
      loading = null; // let the next click try again
      throw err;
    });
  }
  return loading;
}

const rms = (a, from = 0, to = a.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, to - from));
};

// fast talkers never pause: when the window is full, cut it where the last 2 s are quietest
function quietestCut(audio) {
  const win = RATE * 0.2, from = audio.length - RATE * 2;
  let best = audio.length, bestRms = Infinity;
  for (let i = from; i + win <= audio.length; i += win / 2) {
    const r = rms(audio, i, i + win);
    if (r < bestRms) { bestRms = r; best = i + win / 2; }
  }
  return best;
}

// Whisper writes "Thank you." / "you" / "." on silence; drop anything that short
const isJunk = (text) => text.replace(/[^a-z]/gi, "").length < 3;

function attachListen(socket, options = {}, io = null) {
  // WHISPER_MODEL env wins (the Pi runs the smaller tiny.en), then show.json "follow".model, then base.en
  const model = process.env.WHISPER_MODEL || options.model || "onnx-community/whisper-tiny.en"; // tiny: ~3x faster than base, accurate enough for following
  const tell = (event, data) => (io || socket).emit(event, data); // every page sees what the listener hears
  let L = null; // this socket's listener, while it is listening

  socket.on("listenStart", async (p) => {
    stop();
    if (options.claim && !options.claim(socket, p && p.device)) { // another device is already listening
      socket.emit("listenDenied");
      return;
    }
    L = { chunks: [], samples: 0, committed: "", busy: false, timer: null };
    tell("listenStatus", { ready: false, model, message: "Loading speech model…" });
    try {
      await loadModel(model);
    } catch (err) {
      tell("listenStatus", { ready: false, model, message: "Could not load the speech model: " + err.message });
      return stop();
    }
    if (!L) return; // stopped while loading
    tell("listenStatus", { ready: true, model, message: "Listening (" + model.split("/").pop() + ")" });
    L.timer = setInterval(tick, TICK_MS);
  });

  // Int16 little-endian samples at 16 kHz, straight from the page
  socket.on("listenAudio", (buf) => {
    if (!L || !Buffer.isBuffer(buf)) return;
    const f32 = new Float32Array(buf.length >> 1); // the Buffer may sit at an odd offset, so read sample by sample
    for (let i = 0; i < f32.length; i++) f32[i] = buf.readInt16LE(i * 2) / 32768;
    L.chunks.push(f32);
    L.samples += f32.length;
  });

  socket.on("listenStop", stop);
  socket.on("disconnect", stop);

  function stop() {
    if (L?.timer) clearInterval(L.timer);
    L = null;
    if (options.release) options.release(socket);
  }

  function takeAudio() {
    const audio = new Float32Array(L.samples);
    let p = 0;
    for (const c of L.chunks) { audio.set(c, p); p += c.length; }
    return audio;
  }

  async function tick() {
    if (!L || L.busy || !asr || L.samples < MIN_AUDIO) return;
    const audio = takeAudio();
    if (rms(audio) < SILENCE_RMS) {               // nothing being said: keep only the newest second
      if (L.samples > RATE * 3) { L.chunks = [audio.subarray(-RATE)]; L.samples = RATE; }
      return;
    }
    L.busy = true;
    const me = L;
    try {
      const quietTail = rms(audio, audio.length - QUIET_TAIL) < SILENCE_RMS * 2;
      const full = audio.length >= COMMIT_MAX;
      // what we transcribe and commit: everything (at a pause), or up to the quietest recent point (window full)
      const cut = full && !quietTail ? quietestCut(audio) : audio.length;
      const piece = cut < audio.length ? audio.subarray(0, cut) : audio;
      const { text } = await asr(piece);
      if (me !== L) return; // stopped (or restarted) while Whisper was thinking
      const interim = isJunk(text) ? "" : text.trim();
      if (full || (audio.length >= COMMIT_AFTER && quietTail)) {
        // the sentence is done: freeze it and start the next one from the cut
        L.committed = (L.committed + " " + interim).trim().split(/\s+/).slice(-KEEP_WORDS).join(" ");
        let drop = cut; // remove exactly the samples we committed; what came after the cut (and anything newer) stays
        while (drop > 0 && L.chunks.length) {
          const c = L.chunks[0];
          if (c.length <= drop) { drop -= c.length; L.chunks.shift(); L.samples -= c.length; }
          else { L.chunks[0] = c.subarray(drop); L.samples -= drop; drop = 0; }
        }
        tell("listenResult", { final: L.committed, interim: "" });
      } else {
        tell("listenResult", { final: L.committed, interim });
      }
    } catch (err) {
      tell("listenStatus", { ready: true, model, message: "Recognition error: " + err.message });
    } finally {
      if (me === L) L.busy = false;
    }
  }
}

module.exports = { attachListen };
