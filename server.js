// requirements
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const os = require("os");
const fs = require("fs");
const { Sender } = require("sacn"); // DMX out with sACN
const path = require("path");
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const midi = require("@julusian/midi");
const { discoverDesks } = require("./discover"); // finds sound desks on the network

// Anything in /public becomes a web page. public/lights.html -> /lights.html
app.use(express.static(path.join(__dirname, "public")));

// The sound page uploads files here: PUT /audio/<name> with the file as the body
app.put("/audio/:name", express.raw({ type: () => true, limit: "500mb" }), (req, res) => {
  const name = path.basename(req.params.name).replace(/[^\w .()&'-]/g, "_");
  if (!/\.(mp3|wav|m4a|aif|aiff|ogg)$/i.test(name)) return res.status(400).send("Not an audio file");
  fs.writeFileSync(path.join(__dirname, "public", "audio", name), req.body);
  console.log("uploaded", name);
  broadcastState(); // every page gets the new file list
  res.send("ok");
});
const show = JSON.parse(
  fs.readFileSync(path.join(__dirname, "show.json"), "utf8"),
);

// One sACN sender for every real network card we have right now
const senders = [];
for (const list of Object.values(os.networkInterfaces())) {
  for (const net of list) {
    if (net.family !== "IPv4" || net.internal) continue;
    try {
      senders.push(
        new Sender({
          universe: 1,
          reuseAddr: true,
          iface: net.address,
          defaultPacketOptions: {
            sourceName: "Show Server",
            priority: 100,
            useRawDmxValues: true, // 0-255, not percent
          },
        }),
      );
      console.log("sACN sending on", net.address);
    } catch (err) {
      console.log("sACN skipped", net.address, err.message);
    }
  }
}

const midiOut = new midi.Output();
if (midiOut.getPortCount() > 0) {
  midiOut.openPort(0);
  console.log("MIDI out:", midiOut.getPortName(0));
} else {
  console.log("No MIDI ports found, MIDI disabled");
}

// ---- Mixer: one settings object per channel, like the SQ MixPad's Processing view.
// Faders, mutes and pans talk to an Allen & Heath SQ as MIDI NRPN over TCP (port 51325), exactly as
// in the "SQ MIDI Protocol, Issue 5" document. Gain, 48V and HPF are not in that protocol, so they
// only live in this app. The desk also reports its own changes, so faders moved on the SQ show here.
const net = require("net");
const mixerConfig = { channels: 16, sqHost: "", midiChannel: 0, ...(show.mixer || {}) };
const names = typeof mixerConfig.channels === "number"
  ? Array.from({ length: mixerConfig.channels }, (_, i) => "Ch " + (i + 1))
  : mixerConfig.channels;
const freshChannel = () => ({ fader: 0.75, mute: false, gain: 30, phantom: false, hpf: false, hpfFreq: 100, pan: 0 });
const mixer = {
  channels: names.map((name) => ({ name, ...freshChannel() })),
  master: { fader: 0.75, mute: false },
  sentToDesk: ["fader", "mute", "pan"], // the page tells the user which settings really reach the desk
};
const desk = { host: mixerConfig.sqHost || "", connected: false };
let scanning = false;
function saveMixerConfig() {
  show.mixer = { ...mixerConfig, sqHost: desk.host, channels: mixer.channels.map((c) => c.name) };
  saveShow();
}

// Parameter numbers [MSB, LSB] from the protocol's reference tables. Input channel i (0 = Ip1).
const P = {
  mute: (i) => [0x00, i],  // Ip1..Ip48 = LSB 00..2F
  fader: (i) => [0x40, i], // input level to LR
  pan: (i) => [0x50, i],   // input pan to LR
  masterMute: [0x00, 0x44],
  masterFader: [0x4f, 0x00],
};
// Level values are 14-bit numbers on the SQ's standard "linear taper" law. These rows come from the
// document's example table (dB -> value); anything in between is interpolated.
const LEVELS = [[-90, 4630], [-60, 8073], [-40, 10447], [-30, 11634], [-20, 12822], [-10, 14009], [-5, 14602], [0, 15196], [5, 15790], [10, 16383]];
function interp(table, x, from, to) { // piecewise-linear lookup in a table of rows sorted by column "from"
  if (x <= table[0][from]) return table[0][to];
  for (let k = 1; k < table.length; k++) {
    if (x <= table[k][from]) {
      const t = (x - table[k - 1][from]) / (table[k][from] - table[k - 1][from]);
      return table[k - 1][to] + t * (table[k][to] - table[k - 1][to]);
    }
  }
  return table[table.length - 1][to];
}
// Our fader position (0..1) <-> dB: 0 dB sits at three quarters of the travel, like a real fader
const posToDb = (p) => (p < 0.75 ? -60 + (p / 0.75) * 60 : ((p - 0.75) / 0.25) * 10);
const dbToPos = (db) => (db <= -60 ? 0 : db <= 0 ? ((db + 60) / 60) * 0.75 : 0.75 + (db / 10) * 0.25);
const encodeFader = (p) => (p <= 0 ? 0 : Math.round(interp(LEVELS, posToDb(p), 0, 1)));
const decodeFader = (v) => (v < LEVELS[0][1] ? 0 : Math.round(dbToPos(interp(LEVELS, v, 1, 0)) * 1000) / 1000);
const encodePan = (pan) => Math.round(((pan + 1) / 2) * 16383); // L100% = 0, centre = 8191, R100% = 16383
const decodePan = (v) => Math.round(((v / 16383) * 2 - 1) * 100) / 100;

// ---- the TCP link to the desk
let sqSocket = null, retryTimer = null;
const rx = { status: 0, data: [], msb: 0, lsb: 0, vc: 0 }; // an NRPN message being received, byte by byte
function connectSq() {
  clearTimeout(retryTimer);
  if (!desk.host) return;
  sqSocket = net.connect(51325, desk.host);
  sqSocket.on("connect", () => {
    desk.connected = true;
    console.log("SQ desk connected at", desk.host);
    io.emit("desk", desk);
    requestDeskState();
  });
  sqSocket.on("data", onDeskData);
  sqSocket.on("error", (err) => console.log("SQ desk:", err.message));
  sqSocket.on("close", () => {
    const was = desk.connected;
    desk.connected = false;
    sqSocket = null;
    if (was) io.emit("desk", desk);
    if (desk.host) retryTimer = setTimeout(connectSq, 5000); // keep trying, the desk may be switched on later
  });
}
connectSq();

function sendMidi(bytes) {
  if (sqSocket && desk.connected) sqSocket.write(Buffer.from(bytes));
  else if (midiOut.isPortOpen()) midiOut.sendMessage(bytes); // e.g. the SQ's USB MIDI port
}
const midiCh = () => mixerConfig.midiChannel || 0; // the SQ's "MIDI Channel" setting minus one
// One NRPN message = four control changes: parameter MSB, LSB, then the 14-bit value in two halves
function nrpn([msb, lsb], value14) {
  const c = 0xb0 | midiCh();
  sendMidi([c, 0x63, msb]);
  sendMidi([c, 0x62, lsb]);
  sendMidi([c, 0x06, (value14 >> 7) & 0x7f]);
  sendMidi([c, 0x26, value14 & 0x7f]);
}
// "Get": ask the desk to send a parameter's current value (it replies with the normal message)
function nrpnGet([msb, lsb]) {
  const c = 0xb0 | midiCh();
  sendMidi([c, 0x63, msb]);
  sendMidi([c, 0x62, lsb]);
  sendMidi([c, 0x60, 0x7f]);
}
function requestDeskState() {
  mixer.channels.forEach((_, i) => { nrpnGet(P.mute(i)); nrpnGet(P.fader(i)); nrpnGet(P.pan(i)); });
  nrpnGet(P.masterMute);
  nrpnGet(P.masterFader);
}
// Scene recall = bank change then program change, scenes numbered from 1
function recallScene(n) {
  const idx = n - 1;
  sendMidi([0xb0 | midiCh(), 0x00, Math.floor(idx / 128)]);
  sendMidi([0xc0 | midiCh(), idx % 128]);
}

// Bytes arriving from the desk: rebuild control-change messages, then whole NRPNs
function onDeskData(buf) {
  for (const byte of buf) {
    if (byte & 0x80) { rx.status = byte; rx.data = []; continue; } // a status byte starts a new message
    rx.data.push(byte);
    if ((rx.status & 0xf0) !== 0xb0 || rx.data.length < 2) continue;
    const [cc, val] = rx.data;
    rx.data = [];
    if (cc === 0x63) rx.msb = val;
    else if (cc === 0x62) rx.lsb = val;
    else if (cc === 0x06) rx.vc = val;
    else if (cc === 0x26) applyFromDesk(rx.msb, rx.lsb, (rx.vc << 7) | val);
  }
}
function applyFromDesk(msb, lsb, value) {
  let changed = true;
  if (msb === 0x00 && lsb === 0x44) mixer.master.mute = value === 1;
  else if (msb === 0x4f && lsb === 0x00) mixer.master.fader = decodeFader(value);
  else if (lsb < mixer.channels.length && msb === 0x00) mixer.channels[lsb].mute = value === 1;
  else if (lsb < mixer.channels.length && msb === 0x40) mixer.channels[lsb].fader = decodeFader(value);
  else if (lsb < mixer.channels.length && msb === 0x50) mixer.channels[lsb].pan = decodePan(value);
  else changed = false;
  if (changed) io.emit("mixer", mixer);
}

// Apply some settings to a channel ("master" or an index), remember them, send what the desk understands
function setMix(ch, changes) {
  const isMaster = ch === "master";
  const i = Number(ch);
  const target = isMaster ? mixer.master : mixer.channels[i];
  if (!target) return;
  for (const [k, v] of Object.entries(changes)) {
    if (v === undefined || !(k in freshChannel()) || (isMaster && !["fader", "mute"].includes(k))) continue;
    target[k] = v;
    if (k === "fader") nrpn(isMaster ? P.masterFader : P.fader(i), encodeFader(v));
    if (k === "mute") nrpn(isMaster ? P.masterMute : P.mute(i), v ? 1 : 0);
    if (k === "pan" && !isMaster) nrpn(P.pan(i), encodePan(v));
  }
}
function mixSnapshot() {
  const mix = {};
  mixer.channels.forEach(({ name, ...settings }, i) => (mix[i] = settings));
  mix.master = { ...mixer.master };
  return mix;
}

// The "state of the lights": 512 channels, just like real DMX. 0 = off, 255 = full.
const dmx = new Array(512).fill(0);
let master = 255; // grand master: scales every channel on the way out, 0 = blackout

setInterval(() => {
  const payload = {};
  dmx.forEach((level, i) => {
    if (level > 0) payload[i + 1] = Math.round((level * master) / 255);
  });
  for (const s of senders) s.send({ payload });
}, 50);

let currentCue = -1; // -1 means "top of show, nothing fired yet"

function broadcastState() {
  io.emit("state", state());
}

// Fades
const activeFades = new Set();

function fadeTo(levels, seconds) {
  const start = dmx.slice();
  const steps = Math.max(1, Math.round(seconds * 40));
  let step = 0;
  const timer = setInterval(() => {
    step++;
    const t = step / steps;
    for (const [ch, target] of Object.entries(levels)) {
      const i = ch - 1;
      dmx[i] = Math.round(start[i] + (target - start[i]) * t);
    }
    io.emit("dmx", dmx);
    if (step >= steps) {
      clearInterval(timer);
      activeFades.delete(timer);
    }
  }, 25);
  activeFades.add(timer);
}

let followTimer = null; // a pending auto-follow, so STOP can cancel it

function stopAll() {
  for (const t of activeFades) clearInterval(t); // freeze lights where they are
  activeFades.clear();
  clearTimeout(followTimer);
  followTimer = null;
  io.emit("stopSound"); // sound pages stop playback
  console.log("STOP");
}

function runCue(cue) {
  if (cue.type === "light") fadeTo(cue.levels, cue.fade || 0);
  if (cue.type === "sound")
    io.emit("playSound", {
      file: cue.file,
      volume: cue.volume ?? 1,
      fadeIn: cue.fadeIn || 0,
      fadeOut: cue.fadeOut ?? 1,
      loop: !!cue.loop,
      label: cue.number + " · " + cue.label,
    });
  if (cue.type === "midi" && midiOut.isPortOpen())
    midiOut.sendMessage(cue.bytes);
  if (cue.type === "mix") {
    for (const [ch, v] of Object.entries(cue.mix || {})) setMix(ch, v);
    if (cue.scene) recallScene(cue.scene); // a scene saved on the desk itself
    io.emit("mixer", mixer);
  }
}

// Fire one cue by position. If it has auto-follow on, the next cue fires by itself after "wait" seconds.
function fire(index) {
  clearTimeout(followTimer);
  followTimer = null;
  currentCue = index;
  const cue = show.cues[index];
  console.log("GO", cue.number, cue.label);
  runCue(cue);
  broadcastState();
  if (cue.autoFollow && index + 1 < show.cues.length)
    followTimer = setTimeout(() => fire(index + 1), (cue.wait || 0) * 1000);
}

function go() {
  if (currentCue + 1 >= show.cues.length) return; // end of show, ignore
  fire(currentCue + 1);
}

function saveShow() {
  fs.writeFileSync(
    path.join(__dirname, "show.json"),
    JSON.stringify(show, null, 2),
  );
}

function audioFiles() {
  return fs
    .readdirSync(path.join(__dirname, "public", "audio"))
    .filter((f) => /\.(mp3|wav|m4a|aif|aiff|ogg)$/i.test(f));
}

function state() {
  return {
    currentCue,
    cues: show.cues,
    title: show.title || "",
    script: show.script || [], // older show.json files have no script yet
    patch: show.patch || [], // fixtures: { name, type, address, x, y }
    mixer,
    desk,
    master,
    audioFiles: audioFiles(),
  };
}

// Connection Block
io.on("connection", (socket) => {
  console.log("a view connected");

  // Send the newcomer the current levels so it isn't blank
  socket.emit("dmx", dmx);

  // A lights page moved a slider
  socket.on("setChannel", ({ channel, level }) => {
    dmx[channel - 1] = level;
    io.emit("dmx", dmx);
  });

  // A lights page set several channels at once: { "1": 255, "2": 128 }
  socket.on("setChannels", (levels) => {
    for (const [ch, level] of Object.entries(levels)) {
      if (ch >= 1 && ch <= 512)
        dmx[ch - 1] = Math.max(0, Math.min(255, Math.round(level)));
    }
    io.emit("dmx", dmx);
  });

  socket.on("setMaster", (level) => {
    master = Math.max(0, Math.min(255, Math.round(level)));
    broadcastState();
  });

  // The fixture list was edited on the lights page
  socket.on("savePatch", (patch) => {
    show.patch = patch;
    saveShow();
    broadcastState();
  });

  // Bring a cue's levels up live without moving the show along (for building looks)
  socket.on("loadCue", (index) => {
    const cue = show.cues[index];
    if (cue && cue.type === "light") fadeTo(cue.levels || {}, cue.fade || 0);
  });

  socket.emit("state", state()); // newcomer sees the list
  socket.on("go", go);
  socket.on("reset", () => {
    clearTimeout(followTimer);
    currentCue = -1;
    broadcastState();
  });

  // Make a cue the next one to GO, without firing anything
  socket.on("setStandby", (index) => {
    if (index < 0 || index >= show.cues.length) return;
    clearTimeout(followTimer);
    currentCue = index - 1;
    broadcastState();
  });

  // Fire one cue right now, out of order
  socket.on("fire", (index) => {
    if (index >= 0 && index < show.cues.length) fire(index);
  });

  socket.on("midi", (bytes) => {
    if (midiOut.isPortOpen()) midiOut.sendMessage(bytes);
  });

  socket.on("stop", stopAll);
  socket.on("stopSound", () => io.emit("stopSound")); // sound page: fade all audio, leave lights alone

  socket.on("saveCues", (cues) => {
    show.cues = cues;
    fs.writeFileSync(
      path.join(__dirname, "show.json"),
      JSON.stringify(show, null, 2),
    );
    broadcastState();
  });

  // Capture the current live levels into a cue
  socket.on("recordCue", ({ index, label }) => {
    const levels = {};
    dmx.forEach((lv, i) => {
      if (lv > 0) levels[i + 1] = lv;
    });

    const cue = show.cues[index];
    if (cue) {
      // Channels the cue used to have but are now dark must be recorded as 0,
      // otherwise the cue would leave them wherever they were.
      for (const ch of Object.keys(cue.levels || {}))
        if (!(ch in levels)) levels[ch] = 0;
      cue.type = "light";
      cue.levels = levels;
    } else {
      show.cues.push({
        number: String(show.cues.length + 1),
        label: label || "New look",
        type: "light",
        fade: 3,
        levels,
      });
    }
    saveShow();
    broadcastState();
  });

  // Sound page mixer: something moved. ch is a channel index or "master"; the rest are settings.
  socket.on("mixer", ({ ch, ...changes }) => {
    setMix(ch, changes);
    io.emit("mixer", mixer);
  });
  socket.on("renameMixChannel", ({ ch, name }) => {
    const c = mixer.channels[ch];
    if (!c) return;
    c.name = name;
    saveMixerConfig();
    io.emit("mixer", mixer);
  });
  // Sound page "Choose desk": sweep the network and report desks as they turn up
  socket.on("scanDesks", async () => {
    if (scanning) return;
    scanning = true;
    const found = [];
    io.emit("desks", { scanning: true, found });
    const result = await discoverDesks((desk) => {
      found.push(desk);
      io.emit("desks", { scanning: true, found });
    });
    scanning = false;
    io.emit("desks", { scanning: false, found, scanned: result.scanned, skipped: result.skipped });
  });
  // The desk's IP address was typed on the sound page: save it and (re)connect
  socket.on("setSqHost", (host) => {
    desk.host = String(host || "").trim();
    saveMixerConfig();
    if (sqSocket) sqSocket.destroy(); // its close handler reconnects with the new address
    else connectSq();
    io.emit("desk", desk);
  });
  // Save the current faders and mutes into a cue (a "mix" cue), like recording a light look
  socket.on("recordMix", ({ index, label }) => {
    const cue = show.cues[index];
    if (cue) {
      cue.type = "mix";
      cue.mix = mixSnapshot();
    } else {
      show.cues.push({ number: String(show.cues.length + 1), label: label || "Mix scene", type: "mix", mix: mixSnapshot() });
    }
    saveShow();
    broadcastState();
  });

  socket.on("clearAll", () => {
    dmx.fill(0);
    io.emit("dmx", dmx);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Show server running at http://localhost:" + PORT);
});
