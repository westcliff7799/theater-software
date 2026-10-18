try {
  process.loadEnvFile(".env");
} catch {} // puts GOOGLE_CLIENT_ID into process.env; no .env file is fine

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
const { attachListen } = require("./listen"); // speech recognition for the Follow page
const { importScript } = require("./script-import"); // .txt/.docx/.pdf -> script lines

// SANDBOX=1 runs the demo site: same app, everyone may do everything, nothing leaves the computer.
// No DMX, no MIDI, no sound desk, no uploads, and the show is never saved (a restart resets it).
const SANDBOX = process.env.SANDBOX === "1";
if (SANDBOX) console.log("SANDBOX: demo site, no outputs, nothing is saved");

// The demo site takes no uploads
function noDemoUploads(req, res, next) {
  if (SANDBOX) return res.status(403).send("Demo site: uploads are off");
  next();
}

app.use(express.json()); // routes read JSON bodies as req.body

// --- KEYS ---
const crypto = require("crypto");
const ACCESS_FILE = path.join(__dirname, "access.json");
let access = { locks: [], keys: {} };
try {
  access = JSON.parse(fs.readFileSync(ACCESS_FILE, "utf8"));
} catch {
  console.log("no access.json yet: only the admin can sign in");
}
function saveAccess() {
  fs.writeFileSync(ACCESS_FILE, JSON.stringify(access, null, 2));
}

// what keys are allowed to do
const ABILITIES = {
  sm: "Stage manager: cue list, GO and STOP",
  lights: "Lights: levels and recording cues",
  "lights.patch": "Lights: patch and output devices",
  sound: "Sound: playback and uploads",
  "sound.mixer": "Sound: mixer and desk",
  script: "Script: read along",
  "script.edit": "Script: import and edit",
  follow: "Follow: run the listener",
  mode: "Switch Edit / Show",
};
const ADMIN_USER = process.env.ADMIN_USER || "";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const AUTH_ON = !SANDBOX; //demo site

const sessions = new Map();

function cookieValue(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const [k, v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v || "");
  }
  return "";
}
function sessionOf(req) {
  return sessions.get(cookieValue(req, "sid")) || null;
}

//new ticket
function startSessions(res, data) {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, data);
  res.setHeader(
    "Set-Cookie",
    "sid=" + sid + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000",
  );
}

function localTicket() {
  const sid = crypto.randomBytes(24).toString("hex");
  sessions.set(sid, { name: "Desktop", key: null, admin: true });
  return sid;
}
module.exports = { localTicket };

function allowed(s, ability) {
  if (!AUTH_ON) return true;
  if (!s) return false;
  if (s.admin) return true;
  const k = access.keys[s.key];
  if (!k || access.locks.includes(ability)) return false;
  return (k.can || []).includes(ability);
}

app.post("/auth/key", (req, res) => {
  const key = String(req.body.key || "")
    .trim()
    .toUpperCase();
  const k = access.keys[key];
  if (!k) return res.status(401).json({ ok: false, error: "Unknown key" });
  startSessions(res, { name: k.label, key, admin: false });
  res.json({ ok: true });
});

app.post("/auth/admin", (req, res) => {
  const ok =
    ADMIN_PASSWORD !== "" &&
    req.body.user === ADMIN_USER &&
    req.body.password == ADMIN_PASSWORD;
  if (!ok)
    return res
      .status(401)
      .json({ ok: false, error: "Wrong username or password" });
  startSessions(res, { name: "Admin", key: null, admin: true });
  res.json({ ok: true });
});

app.get("/logout", (req, res) => {
  sessions.delete(cookieValue(req, "sid"));
  res.setHeader("Set-Cookie", "sid=; Path=/; Max-Age=0");
  res.redirect("/login.html");
});

app.get("/me", (req, res) => {
  const s = sessionOf(req);
  const can = Object.keys(ABILITIES).filter((a) => allowed(s, a));
  res.json({
    name: s ? s.name : null,
    admin: !!(s && s.admin),
    can,
    sandbox: SANDBOX,
  });
});

const OPEN_FILES = ["/style.css", "/login.html", "/admin.html"];
const PAGE_NEEDS = {
  "/sm.html": "sm",
  "/lights.html": "lights",
  "/sound.html": "sound",
  "/actor.html": "script",
  "/follow.html": "follow",
};
app.use((req, res, next) => {
  if (!AUTH_ON || OPEN_FILES.includes(req.path)) return next();
  const s = sessionOf(req);
  const wantsPage =
    req.method === "GET" && (req.headers.accept || "").includes("text/html");
  if (!s)
    return wantsPage
      ? res.redirect("/login.html")
      : res.status(401).send("Sign in first");
  const need = PAGE_NEEDS[req.path];
  if (need && !allowed(s, need))
    return res.redirect("/index.html?denied=" + need);
  next();
});

// Anything in /public becomes a web page. public/lights.html -> /lights.html
app.use(express.static(path.join(__dirname, "public")));

// The sound page uploads files here: PUT /audio/<name> with the file as the body
// The Script page posts a script file here and gets back the lines it would become (nothing is saved yet)
app.post(
  "/script/import",
  express.raw({ type: () => true, limit: "50mb" }),
  async (req, res) => {
    try {
      res.json(
        await importScript(req.body, String(req.query.name || "script.txt")),
      );
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  },
);

app.put(
  "/audio/:name",
  noDemoUploads,
  express.raw({ type: () => true, limit: "500mb" }),
  (req, res) => {
    const name = path.basename(req.params.name).replace(/[^\w .()&'-]/g, "_");
    if (!/\.(mp3|wav|m4a|aif|aiff|ogg)$/i.test(name))
      return res.status(400).send("Not an audio file");
    fs.writeFileSync(path.join(__dirname, "public", "audio", name), req.body);
    console.log("uploaded", name);
    broadcastState(); // every page gets the new file list
    res.send("ok");
  },
);
const show = JSON.parse(
  fs.readFileSync(path.join(__dirname, "show.json"), "utf8"),
);

// ---- Output protocols, like the Protocols panel in an Eos patch. Every fixture goes out on each
// protocol that is enabled here; the ✱ marks in the patch table just show which ones are on.
show.protocols = {
  sacn: {
    enabled: true,
    startUniverse: 1,
    priority: 100,
    ...((show.protocols || {}).sacn || {}),
  },
  artnet: {
    enabled: false,
    startUniverse: 0,
    ...((show.protocols || {}).artnet || {}),
  }, // ArtNet counts universes from 0
  dmx: {
    enabled: false,
    port: "",
    kind: "pro",
    output: 1, // which output the USB cable carries
    ...((show.protocols || {}).dmx || {}),
  }, // kind: "pro" (Enttec DMX USB Pro and compatibles) or "open" (Open DMX)
};
// How the Lights page lays out Live: only patched channels, a separator where the numbering skips, and the
// user's own separators and row breaks (channel numbers a break follows)
show.live = { onlyPatched: true, autoGaps: true, breaks: [], rows: [], tile: 72, ...(show.live || {}) };
// The Stage tab's plan: the room in metres, with named areas drawn on it (stage, house, wings, walls, curtains)
if (!show.live.map) {
  const s = show.live.stage || { w: 12, d: 8 };
  show.live.map = { w: s.w, d: s.d, areas: [{ name: "Stage", kind: "stage", x: 0, y: 0, w: s.w, d: s.d }] };
}
delete show.live.stage;
// Channel numbers are positions in show.patch, so channel 11 is show.patch[10]. An empty channel is null:
// a fixture patched at address 11 goes to channel 11 even if 2 to 10 are empty, as on a console.
function trimPatch() {
  const p = show.patch || [];
  while (p.length && !p[p.length - 1]) p.pop();
} // no empty channels past the last fixture
for (const f of show.patch || []) {
  if (!f) continue; // an empty channel
  // fixtures saved with the older single "protocol" field
  if (f.sacn === undefined) f.sacn = !f.protocol || f.protocol === "sacn";
  if (f.artnet === undefined) f.artnet = f.protocol === "artnet";
  if (f.dmx === undefined) f.dmx = f.protocol === "dmx";
  delete f.protocol;
}
// An address follows its channel (channel 11 = address 11) unless set by hand. Older shows have no flag:
// an address that doesn't match its channel was set by hand.
(show.patch || []).forEach((f, i) => {
  if (f && !f.addrFixed && f.address !== i + 1) f.addrFixed = true;
});

// ---- DMX output. Every network card gets the data; each fixture chooses sACN or Art-Net and a universe.
const ifaces = [];
let ifaceList = "";
function readIfaces() { // the cards this computer has right now: it may have changed networks since startup
  ifaces.length = 0;
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list) {
      if (net.family !== "IPv4" || net.internal) continue;
      const ip = (s) => s.split(".").reduce((n, o) => n * 256 + Number(o), 0);
      const bcast = ip(net.address) | ~ip(net.netmask); // the address Art-Net broadcasts to on this card
      ifaces.push({
        address: net.address,
        broadcast: [24, 16, 8, 0].map((s) => (bcast >>> s) & 255).join("."),
      });
    }
  }
  const now = ifaces.map((i) => i.address).join(" ");
  if (now !== ifaceList) { ifaceList = now; console.log("DMX output on", now || "no network"); }
}
readIfaces();

// A network card going away throws from inside a socket callback, where no try/catch can reach.
// Log it and keep running: the cue list, sound and lights must outlive a Wi-Fi hiccup.
process.on("uncaughtException", (err) => console.log("Unexpected error (server kept running):", err.stack || err));

// sACN: one sender per universe per card, made the first time that universe is used
const sacnSenders = new Map();
function sacnFor(universe) {
  if (!sacnSenders.has(universe)) {
    readIfaces(); // a sender bound to an address this computer no longer has would blow up later
    const list = [];
    for (const { address } of ifaces) {
      try {
        list.push(
          new Sender({
            universe,
            reuseAddr: true,
            iface: address,
            defaultPacketOptions: {
              sourceName: "Show Server",
              priority: 50,
              useRawDmxValues: true,
            }, // 0-255, not percent
          }),
        );
      } catch (err) {
        console.log("sACN skipped", address, err.message);
      }
    }
    sacnSenders.set(universe, list);
  }
  return sacnSenders.get(universe);
}

// Art-Net: plain UDP broadcast on port 6454. Output 1 here is Art-Net universe 0, as on most consoles.
const dgram = require("dgram");
const artnet = SANDBOX
  ? null
  : dgram.createSocket({ type: "udp4", reuseAddr: true });
if (artnet) {
  artnet.on("error", (err) => console.log("Art-Net socket error", err.message));
  artnet.bind(6454, () => artnet.setBroadcast(true));
}
let artSeq = 0;
function sendArtnet(universe, levels) {
  if (!artnet) return;
  artSeq = (artSeq % 255) + 1;
  const u = universe - 1;
  const head = Buffer.concat([
    Buffer.from("Art-Net\0"),
    Buffer.from([0x00, 0x50, 0, 14, artSeq, 0, u & 255, (u >> 8) & 127, 2, 0]),
  ]);
  for (const { broadcast } of ifaces)
    artnet.send(
      Buffer.concat([head, Buffer.from(levels)]),
      6454,
      broadcast,
      () => {},
    );
}

// How many DMX channels a fixture uses: library fixtures carry a profile, generics are listed here (keep in step with TYPES in lights.html).
const CHANNELS = { dimmer: 1, rgb: 3, rgbw: 4, irgb: 4 };
const channelsOf = (f) => (f.profile && f.profile.ch) || CHANNELS[f.type] || 1;
const cellsOf = (f) => (f.parts && f.parts.length ? f.parts : [f]); // a fixture with parts: every part has its own address and type

// Local DMX: a USB DMX interface on a serial port. Enttec DMX USB Pro (and DMXking etc.) take framed
// messages; Open DMX wants the raw DMX signal, which we make with a break on the line.
let SerialPort = null;
try {
  ({ SerialPort } = require("serialport"));
} catch (err) {
  console.log("serialport missing, Local DMX off:", err.message);
}
let dmxPort = null,
  dmxPortPath = "",
  dmxBusy = false;
function openDmxPort() {
  if (SANDBOX) return;
  const cfg = show.protocols.dmx;
  const want = cfg.enabled && cfg.port ? cfg.port : "";
  if (dmxPort && dmxPortPath === want) return;
  if (dmxPort) {
    try {
      dmxPort.close(() => {});
    } catch {}
    dmxPort = null;
  }
  dmxPortPath = want;
  if (!SerialPort || !want) return;
  const port = new SerialPort(
    {
      path: want,
      baudRate: cfg.kind === "open" ? 250000 : 57600,
      dataBits: 8,
      stopBits: 2,
      parity: "none",
    },
    (err) => {
      if (err) {
        console.log("Local DMX could not open", want, err.message);
        if (dmxPort === port) dmxPort = null;
        broadcastState();
      } else {
        console.log("Local DMX on", want);
        broadcastState();
      }
    },
  );
  port.on("error", (err) => console.log("Local DMX", err.message));
  port.on("close", () => {
    if (dmxPort === port) dmxPort = null;
  });
  dmxPort = port;
}
function sendLocalDmx(levels) {
  if (!dmxPort || !dmxPort.isOpen || dmxBusy) return;
  const frame = Buffer.from([0, ...levels]); // start code 0, then 512 channels
  if (show.protocols.dmx.kind === "open") {
    dmxBusy = true; // break, mark after break, then the frame
    dmxPort.set({ brk: true }, () =>
      dmxPort.set({ brk: false }, () =>
        dmxPort.write(frame, () => (dmxBusy = false)),
      ),
    );
    return;
  }
  const len = frame.length; // Enttec Pro: 7E, label 6 (send DMX), length low/high, data, E7
  dmxPort.write(
    Buffer.concat([
      Buffer.from([0x7e, 6, len & 255, len >> 8]),
      frame,
      Buffer.from([0xe7]),
    ]),
  );
}
async function serialPorts() {
  if (!SerialPort || SANDBOX) return [];
  try {
    return (await SerialPort.list()).map((p) => ({
      path: p.path,
      name: p.manufacturer || p.friendlyName || "",
    }));
  } catch (err) {
    console.log("serial list", err.message);
    return [];
  }
}

const midiOut = new midi.Output();
if (!SANDBOX && midiOut.getPortCount() > 0) {
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
const mixerConfig = {
  channels: 16,
  sqHost: "",
  midiChannel: 0,
  ...(show.mixer || {}),
};
const names =
  typeof mixerConfig.channels === "number"
    ? Array.from({ length: mixerConfig.channels }, (_, i) => "Ch " + (i + 1))
    : mixerConfig.channels;
const freshChannel = () => ({
  fader: 0.75,
  mute: false,
  gain: 30,
  phantom: false,
  hpf: false,
  hpfFreq: 100,
  pan: 0,
});
const mixer = {
  channels: names.map((name) => ({ name, ...freshChannel() })),
  master: { fader: 0.75, mute: false },
  sentToDesk: ["fader", "mute", "pan"], // the page tells the user which settings really reach the desk
};
const desk = { host: mixerConfig.sqHost || "", connected: false };
let scanning = false;
function saveMixerConfig() {
  show.mixer = {
    ...mixerConfig,
    sqHost: desk.host,
    channels: mixer.channels.map((c) => c.name),
  };
  saveShow();
}

// Parameter numbers [MSB, LSB] from the protocol's reference tables. Input channel i (0 = Ip1).
const P = {
  mute: (i) => [0x00, i], // Ip1..Ip48 = LSB 00..2F
  fader: (i) => [0x40, i], // input level to LR
  pan: (i) => [0x50, i], // input pan to LR
  masterMute: [0x00, 0x44],
  masterFader: [0x4f, 0x00],
};
// Level values are 14-bit numbers on the SQ's standard "linear taper" law. These rows come from the
// document's example table (dB -> value); anything in between is interpolated.
const LEVELS = [
  [-90, 4630],
  [-60, 8073],
  [-40, 10447],
  [-30, 11634],
  [-20, 12822],
  [-10, 14009],
  [-5, 14602],
  [0, 15196],
  [5, 15790],
  [10, 16383],
];
function interp(table, x, from, to) {
  // piecewise-linear lookup in a table of rows sorted by column "from"
  if (x <= table[0][from]) return table[0][to];
  for (let k = 1; k < table.length; k++) {
    if (x <= table[k][from]) {
      const t =
        (x - table[k - 1][from]) / (table[k][from] - table[k - 1][from]);
      return table[k - 1][to] + t * (table[k][to] - table[k - 1][to]);
    }
  }
  return table[table.length - 1][to];
}
// Our fader position (0..1) <-> dB: 0 dB sits at three quarters of the travel, like a real fader
const posToDb = (p) =>
  p < 0.75 ? -60 + (p / 0.75) * 60 : ((p - 0.75) / 0.25) * 10;
const dbToPos = (db) =>
  db <= -60 ? 0 : db <= 0 ? ((db + 60) / 60) * 0.75 : 0.75 + (db / 10) * 0.25;
const encodeFader = (p) =>
  p <= 0 ? 0 : Math.round(interp(LEVELS, posToDb(p), 0, 1));
const decodeFader = (v) =>
  v < LEVELS[0][1]
    ? 0
    : Math.round(dbToPos(interp(LEVELS, v, 1, 0)) * 1000) / 1000;
const encodePan = (pan) => Math.round(((pan + 1) / 2) * 16383); // L100% = 0, centre = 8191, R100% = 16383
const decodePan = (v) => Math.round(((v / 16383) * 2 - 1) * 100) / 100;

// ---- the TCP link to the desk
let sqSocket = null,
  retryTimer = null;
const rx = { status: 0, data: [], msb: 0, lsb: 0, vc: 0 }; // an NRPN message being received, byte by byte
function connectSq() {
  clearTimeout(retryTimer);
  if (!desk.host || SANDBOX) return;
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
  mixer.channels.forEach((_, i) => {
    nrpnGet(P.mute(i));
    nrpnGet(P.fader(i));
    nrpnGet(P.pan(i));
  });
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
    if (byte & 0x80) {
      rx.status = byte;
      rx.data = [];
      continue;
    } // a status byte starts a new message
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
  else if (msb === 0x4f && lsb === 0x00)
    mixer.master.fader = decodeFader(value);
  else if (lsb < mixer.channels.length && msb === 0x00)
    mixer.channels[lsb].mute = value === 1;
  else if (lsb < mixer.channels.length && msb === 0x40)
    mixer.channels[lsb].fader = decodeFader(value);
  else if (lsb < mixer.channels.length && msb === 0x50)
    mixer.channels[lsb].pan = decodePan(value);
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
    if (
      v === undefined ||
      !(k in freshChannel()) ||
      (isMaster && !["fader", "mute"].includes(k))
    )
      continue;
    target[k] = v;
    if (k === "fader")
      nrpn(isMaster ? P.masterFader : P.fader(i), encodeFader(v));
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

// The "state of the lights", per output: output n's address a is slot (n - 1) * 512 + a, 0 = off, 255 = full.
// Cues, faders and everything else key levels by slot, so an older cue (slots 1-512) is simply output 1.
const OUTPUTS = 8; // outputs the level table has room for
const SLOTS = 512 * OUTPUTS;
const dmx = new Array(SLOTS).fill(0);
let master = 255; // grand master: scales every channel on the way out, 0 = blackout

// ---- Faders outside the cue list (house lights, work lights, preshow). Each fader holds a look and its
// position scales it. What goes out is the highest of the cues and every fader, so a fader never pulls a light down.
const faderPos = []; // 0..1 per fader. Not saved: every fader starts at zero when the server starts.

// A { channel: level } map from a client, with only channels 1-512 and levels 0-255 kept
function cleanLevels(levels) {
  const out = {};
  if (!levels || typeof levels !== "object") return out;
  for (const [ch, lv] of Object.entries(levels)) {
    const c = Number(ch),
      l = Number(lv);
    if (c >= 1 && c <= SLOTS && Number.isInteger(c) && Number.isFinite(l))
      out[c] = Math.max(0, Math.min(255, Math.round(l)));
  }
  return out;
}
// Light check: while it is on, only these channels are lit ({ dmxChannel: level }). Cues, hand-set levels
// and faders underneath are left alone and come straight back when it ends.
let check = null;

function output() {
  const out = new Array(SLOTS).fill(0);
  if (check) {
    for (const [ch, lv] of Object.entries(check))
      if (ch >= 1 && ch <= SLOTS) out[ch - 1] = lv;
    return out;
  }
  for (let i = 0; i < SLOTS; i++) out[i] = dmx[i];
  (show.faders || []).forEach((f, k) => {
    const pos = faderPos[k] || 0;
    if (pos > 0)
      for (const [ch, lv] of Object.entries(f.levels || {}))
        out[ch - 1] = Math.max(out[ch - 1], Math.round(lv * pos));
  });
  return out;
}

let lastOut = []; // what the views were last told is going out
function emitOut(levels) { // the real output, for the views to show: changes only when something changes
  if (levels.length === lastOut.length && levels.every((v, i) => v === lastOut[i])) return;
  lastOut = levels;
  io.emit("out", levels);
}
setInterval(() => {
  const levels = output();
  emitOut(levels);
  if (SANDBOX) return; // nothing goes out of the demo site
  const buckets = new Map(); // "sacn:1" -> everything going out on that protocol and universe
  const bucket = (protocol, universe) => {
    const key = protocol + ":" + universe;
    if (!buckets.has(key))
      buckets.set(key, {
        protocol,
        universe,
        priority: 0,
        levels: new Array(512).fill(0),
        fixed: {}, // profile defaults (e.g. a shutter held open), sent as they are, never scaled by the master
      });
    return buckets.get(key);
  };
  const routed = new Set(); // channels some fixture claimed
  const P = show.protocols;
  const place = (b, f, out) => { // f: a fixture or one of its parts; out: the output it sits on
    const set = (f.profile && f.profile.set) || null; // profile defaults: used wherever nothing else drives that channel
    for (let i = 0; i < channelsOf(f); i++) {
      const a = f.address - 1 + i; // address within the universe, 0-based
      if (a >= 512) break;
      const slot = (out - 1) * 512 + a; // where the level table keeps it
      b.levels[a] = levels[slot];
      if (set && set[i] !== undefined && levels[slot] === 0) b.fixed[a] = set[i];
      routed.add(slot);
    }
  };
  for (const f of show.patch || []) {
    if (!f) continue; // an empty channel
    for (const c of cellsOf(f)) { // a multi-part fixture is several cells, each with its own address
      const out = Math.max(1, Number(c.universe || f.universe) || 1); // the Output column, 1-based
      if (out > OUTPUTS) continue; // beyond the level table: nothing to send
      if (P.sacn.enabled) {
        const b = bucket("sacn", Math.max(1, P.sacn.startUniverse + out - 1));
        b.priority = Math.max(b.priority, f.priority || P.sacn.priority); // sACN priority is per universe: the highest wins
        place(b, c, out);
      }
      if (P.artnet.enabled)
        place(bucket("artnet", Math.max(0, P.artnet.startUniverse + out - 1)), c, out);
      if (P.dmx.enabled && out === (Number(P.dmx.output) || 1)) place(bucket("dmx", 1), c, out); // the USB cable carries one chosen output
    }
  }
  // slots no fixture claims (raw DMX addresses) still go out on sACN, each on its own output
  if (P.sacn.enabled)
    for (let slot = 0; slot < SLOTS; slot++)
      if (!routed.has(slot) && levels[slot] > 0)
        bucket("sacn", Math.max(1, P.sacn.startUniverse + Math.floor(slot / 512))).levels[slot % 512] = levels[slot];
  for (const b of buckets.values()) {
    const scaled = b.levels.map((lv) => Math.round((lv * master) / 255));
    for (const [ch, v] of Object.entries(b.fixed)) scaled[ch] = v; // a shutter must not half-close at 50% master
    if (b.protocol === "artnet") {
      sendArtnet(b.universe, scaled);
      continue;
    }
    if (b.protocol === "dmx") {
      sendLocalDmx(scaled);
      continue;
    }
    const payload = {};
    scaled.forEach((lv, i) => {
      if (lv > 0) payload[i + 1] = lv;
    });
    for (const s of sacnFor(b.universe))
      s.send({ payload, priority: b.priority || P.sacn.priority }).catch(
        () => {},
      );
  }
}, 50);
openDmxPort();

let currentCue = -1; // -1 means "top of show, nothing fired yet"

function broadcastState() {
  io.emit("state", state());
}

// ---- Playback bookkeeping
// Light cues only store the channels they change; everything else carries on from earlier cues.
// Levels set by hand are "manual" (red on the lights page) until a cue takes them over, they are
// recorded, or they are released back to the cue.
const manual = new Set(); // DMX channel numbers (1-512) set by hand
const stale = new Set(); // channels whose cue data was changed in Blind while the stage kept the old level
let moves = {}; // channel -> "up" | "down", what the last cue did (blue / green on the lights page)
const isLight = (cue) => cue && cue.type === "light";
// The cue look last brought up by GO, Fire, Jump, Back or "Go to cue". A GO only plays its own changes when
// this is exactly the look of the cue before it; otherwise (after "Load as standby", Clear, edits...) it brings up its whole look.
let lookOnStage = new Array(SLOTS).fill(0);
const sameLook = (a, b) => a.every((lv, i) => lv === b[i]);
// Cue numbers are text; "2.50", "2.5" and "02.5" are the same cue
const sameNumber = (a, b) =>
  String(a) === String(b) ||
  (String(a).trim() !== "" && Number(a) === Number(b));
const cleanNumber = (n) =>
  Number.isFinite(Number(n)) && String(n).trim() !== ""
    ? String(Number(n))
    : String(n);
const findCue = (n) => show.cues.findIndex((c) => sameNumber(c.number, n));
// Find a cue again after the list was edited: same type and number, nearest to where it was
// (two cues can share a number). -1 if it is gone.
function relocate(cue, near, list = show.cues) {
  let best = -1;
  list.forEach((c, i) => {
    if (
      c.type === cue.type &&
      sameNumber(c.number, cue.number) &&
      (best < 0 || Math.abs(i - near) < Math.abs(best - near))
    )
      best = i;
  });
  return best;
}
// After the list changed: the pointer stays on the live cue, or if that cue is gone, just before where it was,
// so the next GO is the cue that took its place rather than skipping one
function keepPointer(live, oldIndex) {
  if (!live) return;
  const i = relocate(live, oldIndex);
  currentCue = i >= 0 ? i : Math.min(oldIndex, show.cues.length) - 1;
}

// A light cue by number. `index` is where the page last saw it, which picks the right one if two cues share a number.
function findLightCue(n, index) {
  if (isLight(show.cues[index]) && sameNumber(show.cues[index].number, n))
    return index;
  return show.cues.findIndex((c) => isLight(c) && sameNumber(c.number, n));
}

// The full lighting look at cue position `index`: every light cue up to it, applied in order
function stateAt(index) {
  const look = new Array(SLOTS).fill(0);
  for (let k = 0; k <= index && k < show.cues.length; k++)
    if (isLight(show.cues[k]))
      for (const [ch, lv] of Object.entries(show.cues[k].levels || {}))
        look[ch - 1] = lv;
  return look;
}
// Every channel any light cue touches
function cueChannels() {
  const set = new Set();
  for (const c of show.cues)
    if (isLight(c))
      for (const ch of Object.keys(c.levels || {})) set.add(Number(ch));
  return set;
}
// The whole look of cue position `index` as fade targets: every cue channel, plus anything left
// glowing that no cue owns (e.g. from a deleted cue). Hand-set levels on channels no cue uses stay.
function fullLook(index) {
  const look = stateAt(index),
    levels = {},
    cueChs = cueChannels();
  dmx.forEach((lv, i) => {
    if (cueChs.has(i + 1) || (lv > 0 && !manual.has(i + 1)))
      levels[i + 1] = look[i];
  });
  return levels;
}
// The light cue whose look is on stage (sound and mix cues don't change the lights)
function lightOnStage() {
  let i = currentCue;
  while (i >= 0 && !isLight(show.cues[i])) i--;
  return i;
}
// What a cue changes compared to the look before it: channel -> "up" | "down"
function movesOf(index) {
  const before = stateAt(index - 1),
    out = {};
  const cue = show.cues[index];
  if (isLight(cue))
    for (const [ch, lv] of Object.entries(cue.levels || {}))
      if (lv !== before[ch - 1]) out[ch] = lv > before[ch - 1] ? "up" : "down";
  return out;
}
// After any change to cue data: channels whose cue-on-stage level changed while the stage kept the old
// one become "stale" (dashed outline); a stale channel that matches its cue again stops being stale.
const stageLook = () => stateAt(lightOnStage());
function recheckStage(before) {
  const onStage = lightOnStage(),
    after = stateAt(onStage),
    live = targetLevels();
  if (before)
    after.forEach((lv, i) => {
      if (lv !== before[i] && lv !== live[i] && !manual.has(i + 1))
        stale.add(i + 1);
    });
  for (const ch of [...stale])
    if (after[ch - 1] === live[ch - 1] || manual.has(ch)) stale.delete(ch);
  moves = onStage >= 0 ? movesOf(onStage) : {};
}
// Saving show.json on every tick of a dragged slider is too much: wait for a pause
let saveTimer = null;
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveShow();
  }, 400);
}
process.on("exit", () => {
  if (saveTimer) saveShow();
}); // don't lose the last change on quit

function emitMarks() {
  io.emit("marks", { manual: [...manual], moves, stale: [...stale] });
}

// ---- Undo for the cue list, groups, palettes and faders: a copy is kept before each change (last 30).
// With `gather`, quick repeats of the same change (a slider being dragged) share one undo step.
const undoStack = [];
function remember(what, gather) {
  const last = undoStack[undoStack.length - 1];
  if (gather && last && last.what === what && Date.now() - last.at < 2000) {
    last.at = Date.now();
    return;
  }
  undoStack.push({
    what,
    at: Date.now(),
    patch: JSON.stringify(show.patch || []),
    cues: JSON.stringify(show.cues),
    groups: JSON.stringify(show.groups || {}),
    palettes: JSON.stringify(show.palettes || {}),
    faders: JSON.stringify(show.faders || []),
    faderPos: JSON.stringify(faderPos),
  });
  if (undoStack.length > 30) undoStack.shift();
}

// Fades. Each one is { timer, levels } and only moves the channels still in its own `levels`.
const activeFades = new Set();

// A newer fade or a hand-set level takes a channel over from any fade still running on it
function takeOver(channels) {
  for (const f of activeFades) for (const ch of channels) delete f.levels[ch];
}
function stopFades() {
  for (const f of activeFades) clearInterval(f.timer); // freeze lights where they are
  if ([...activeFades].some((f) => f.report !== undefined) && progress) {
    progress = { ...progress, paused: true };
    emitProgress();
  }
  activeFades.clear();
}
// Where the stage is heading: the live levels, with every running fade already at its end
function targetLevels() {
  const out = dmx.slice();
  for (const f of activeFades)
    for (const [ch, lv] of Object.entries(f.levels)) out[ch - 1] = lv;
  return out;
}

// How far the last cue's fade has got, for the playback list on the lights page
let progress = null; // { number, fraction, paused }
function emitProgress() {
  io.emit("progress", progress);
}

// Channels going up take `up` seconds, channels going down take `down`.
// `report`: the cue number whose progress the lights page shows (cue fades only).
function fadeTo(target, up, down = up, report) {
  const levels = { ...target }; // our own copy, so takeOver never edits a cue
  takeOver(Object.keys(levels));
  const start = dmx.slice();
  for (const ch of Object.keys(levels)) {
    manual.delete(Number(ch));
    stale.delete(Number(ch));
  } // the cue owns these now
  const began = Date.now();
  const fade = { levels, report };
  const total = Math.max(up, down) * 1000;
  let ticks = 0;
  if (report !== undefined) {
    for (const f of activeFades) f.report = undefined; // only the newest cue fade reports
    progress = { number: report, fraction: total > 0 ? 0 : 1, paused: false };
    emitProgress();
  }
  fade.timer = setInterval(() => {
    const ms = Date.now() - began;
    if (fade.report !== undefined && ++ticks % 4 === 0) {
      // ten times a second is plenty for a progress bar
      progress = {
        number: fade.report,
        fraction: total > 0 ? Math.min(1, ms / total) : 1,
        paused: false,
      };
      emitProgress();
    }
    let done = true;
    for (const [ch, target] of Object.entries(levels)) {
      const i = ch - 1;
      const secs = target >= start[i] ? up : down;
      const t = secs > 0 ? Math.min(1, ms / (secs * 1000)) : 1;
      if (t < 1) done = false;
      dmx[i] = Math.round(start[i] + (target - start[i]) * t);
    }
    io.emit("dmx", dmx);
    if (done) {
      clearInterval(fade.timer);
      activeFades.delete(fade);
      if (fade.report !== undefined) {
        progress = { number: fade.report, fraction: 1, paused: false };
        emitProgress();
      }
    }
  }, 25);
  activeFades.add(fade);
}
const upTime = (cue) => cue.fade ?? 0;
const downTime = (cue) => cue.downFade ?? cue.fade ?? 0;

let followTimer = null; // a pending auto-follow, so STOP can cancel it
function cancelFollow() {
  clearTimeout(followTimer);
  followTimer = null;
}

// Freeze every fade where it is (STOP, or Back during a fade). The frozen channels are now out of step with
// their cue, so they are marked (X Enter brings them in) and the next GO brings up its whole look.
function freeze() {
  for (const f of activeFades)
    for (const ch of Object.keys(f.levels))
      if (!manual.has(Number(ch))) stale.add(Number(ch));
  if (activeFades.size) lookOnStage = new Array(SLOTS).fill(-1);
  stopFades();
  emitMarks();
}

function stopAll() {
  freeze();
  cancelFollow();
  io.emit("stopSound"); // sound pages stop playback
  console.log("STOP");
}

// Run one cue. Straight after the cue before it, a light cue plays just its changes; from anywhere else
// it brings up its whole look, so jumping around the list still looks right.
function runCue(cue, index) {
  if (cue.type === "light") {
    const levels = sameLook(stateAt(index - 1), lookOnStage)
      ? { ...(cue.levels || {}) }
      : fullLook(index);
    lookOnStage = stateAt(index);
    moves = {};
    for (const [ch, lv] of Object.entries(levels))
      if (lv !== dmx[ch - 1]) moves[ch] = lv > dmx[ch - 1] ? "up" : "down";
    fadeTo(levels, upTime(cue), downTime(cue), cue.number);
    emitMarks();
  }
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
  const cue = show.cues[index];
  if (!cue) return;
  cancelFollow();
  currentCue = index;
  console.log("GO", cue.number, cue.label);
  runCue(cue, index);
  broadcastState();
  const next = show.cues[index + 1];
  if (cue.autoFollow && next)
    followTimer = setTimeout(
      () => {
        // find the cue again: the list may have been edited while we waited
        followTimer = null;
        const i = relocate(next, index + 1);
        if (i >= 0) fire(i);
      },
      (cue.wait || 0) * 1000,
    );
}

function go() {
  if (currentCue + 1 >= show.cues.length) return; // end of show, ignore
  fire(currentCue + 1);
}

// Jump: bring up the whole look of a cue (or the top of the show, index -1) without playing the cues between
function jumpTo(index, up, down) {
  if (index < -1 || index >= show.cues.length) return;
  cancelFollow();
  const cue = show.cues[index];
  moves = movesOf(index);
  lookOnStage = stateAt(index);
  fadeTo(
    fullLook(index),
    up ?? (isLight(cue) ? upTime(cue) : 3),
    down ?? up ?? (isLight(cue) ? downTime(cue) : 3),
    cue ? cue.number : "0",
  );
  currentCue = index;
  broadcastState();
  emitMarks();
}

// Back: a fade still running pauses where it is; otherwise fade to the cue before (in 1 second)
function back() {
  if (activeFades.size) {
    freeze();
    cancelFollow();
    return;
  }
  if (currentCue >= 0) jumpTo(currentCue - 1, 1);
}

// The next whole cue number after the highest one
function nextCueNumber() {
  const top = Math.max(
    0,
    ...show.cues.map((c) => Number(c.number)).filter(Number.isFinite),
  );
  return String(Math.floor(top) + 1);
}
// Fade times: up for channels going up, down (if different) for channels going down
function setTimes(cue, up, down) {
  if (Number.isFinite(up)) cue.fade = up;
  if (Number.isFinite(down) && down !== cue.fade) cue.downFade = down;
  else if (Number.isFinite(up)) delete cue.downFade;
}

// Insert a new cue where its number belongs (cue 2.5 lands between 2 and 3)
function insertCue(cue) {
  const n = Number(cue.number);
  let at = show.cues.findIndex((c) => Number(c.number) > n);
  if (at < 0) at = show.cues.length;
  show.cues.splice(at, 0, cue);
  if (at <= currentCue) currentCue++; // the live cue moved down one row
  return at;
}

function saveShow() {
  if (SANDBOX) return; // the demo site keeps its changes in memory only: a restart puts the real show back
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

// Which script line is live, set by the Follow page (speech) or by hand. -1 = top of show.
let scriptPosition = -1;

// The Follow page's switch. In the app, a hidden window does the actual listening and following,
// so it carries on while the operator looks at lights or sound. headless = such a window is connected.
// owner = the device whose microphone is open (the primary device). Nobody else may listen until it
// stops. headlessDevice = the device the app's hidden listener belongs to (only that device drives it).
const listenState = {
  listening: false,
  micId: "",
  minScore: 7,
  owner: null,
  headlessDevice: null,
};
let ownerSocket = null;
const listenPublic = () => ({ ...listenState, headless: headlessCount > 0 });
// A page asks to open its mic. Yes if nobody has it, or this device already has it.
function claimMic(socket, device) {
  if (!device || typeof device !== "string") return false;
  if (
    listenState.owner &&
    listenState.owner !== device &&
    ownerSocket &&
    ownerSocket.connected
  )
    return false;
  listenState.owner = device;
  ownerSocket = socket;
  socket.data.ownsMic = true;
  io.emit("listenState", listenPublic());
  return true;
}
function releaseMic(socket) {
  if (!socket.data.ownsMic) return;
  socket.data.ownsMic = false;
  if (ownerSocket === socket) {
    ownerSocket = null;
    listenState.owner = null;
  }
  io.emit("listenState", listenPublic());
}
// edit = build the show, everything editable · show = run it: editing locked, script instead of editors
let mode = "edit";
let headlessCount = 0;

function state() {
  return {
    listenState: listenPublic(),
    mode,
    currentCue,
    scriptPosition,
    cues: show.cues,
    title: show.title || "",
    script: show.script || [], // older show.json files have no script yet
    patch: show.patch || [], // fixtures: { name, type, address, x, y, priority, sacn, dmx, artnet, universe }
    protocols: show.protocols,
    live: show.live,
    outputs: {
      ifaces: ifaces.map((i) => i.address),
      dmxPort: dmxPort && dmxPort.isOpen ? dmxPortPath : "",
      serial: !!SerialPort,
    },
    groups: show.groups || {}, // "1": { label, channels: [fixture numbers] }
    palettes: show.palettes || {}, // colour palettes, "1": { label, colors: { fixtureNumber: {r,g,b} } }
    faders: show.faders || [], // [{ name, levels: { dmxChannel: level } }]; positions come in the "faders" event
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
  socket.emit("out", output());
  socket.emit("marks", { manual: [...manual], moves, stale: [...stale] });
  socket.emit("faderPos", faderPos);
  socket.emit("check", check);
  socket.emit("progress", progress);

  // ---- faders outside the cue list
  socket.on("faderPos", ({ index, pos } = {}) => {
    if (!(show.faders || [])[index]) return;
    faderPos[index] = Math.max(0, Math.min(1, Number(pos) || 0));
    io.emit("faderPos", faderPos);
  });
  // Add a fader (index = list length) or change one: { index, name, levels }
  socket.on("saveFader", ({ index, name, levels } = {}) => {
    show.faders = show.faders || [];
    if (!(index >= 0 && index <= show.faders.length)) return;
    remember(`fader ${index + 1}`);
    const f = show.faders[index] || { name: `Fader ${index + 1}`, levels: {} };
    if (name !== undefined) f.name = String(name);
    if (levels !== undefined) f.levels = cleanLevels(levels);
    show.faders[index] = f;
    saveShow();
    broadcastState();
  });
  socket.on("deleteFader", (index) => {
    if (!(show.faders || [])[index]) return;
    remember(`delete fader ${index + 1}`);
    show.faders.splice(index, 1);
    faderPos.splice(index, 1);
    saveShow();
    broadcastState();
    io.emit("faderPos", faderPos);
  });

  // Light check on ({ dmxChannel: level }) or off (null)
  socket.on("check", (levels) => {
    check = levels && typeof levels === "object" ? cleanLevels(levels) : null;
    io.emit("check", check);
  });

  // A lights page set some channels by hand: { "1": 255, "2": 128 }
  socket.on("setChannels", (levels) => {
    for (const [key, level] of Object.entries(levels || {})) {
      const ch = Number(key);
      if (!(ch >= 1 && ch <= SLOTS) || !Number.isFinite(Number(level))) continue;
      dmx[ch - 1] = Math.max(0, Math.min(255, Math.round(level)));
      takeOver([ch]);
      manual.add(ch);
    }
    io.emit("dmx", dmx);
    emitMarks();
  });

  socket.on("setMaster", (level) => {
    master = Math.max(0, Math.min(255, Math.round(level)));
    broadcastState();
  });

  // The fixture list was edited on the lights page
  socket.on("saveLive", (l) => { // one or more Live layout fields
    for (const k of ["onlyPatched", "autoGaps"]) if (typeof (l || {})[k] === "boolean") show.live[k] = l[k];
    for (const k of ["breaks", "rows"]) if (Array.isArray((l || {})[k])) show.live[k] = l[k].map(Number).filter((n) => n >= 1);
    if (Number((l || {}).tile) >= 40) show.live.tile = Math.min(160, Number(l.tile));
    if ((l || {}).map && typeof l.map === "object") { // the Stage tab's plan, in metres
      const m = l.map, w = Number(m.w), d = Number(m.d), num = (v, lo, fallback) => (Number.isFinite(Number(v)) ? Math.max(lo, Number(v)) : fallback);
      if (w >= 2 && w <= 100 && d >= 2 && d <= 100) { show.live.map.w = w; show.live.map.d = d; }
      if (Array.isArray(m.areas)) show.live.map.areas = m.areas.slice(0, 60).map((a) => ({
        name: String((a || {}).name || "").slice(0, 30),
        kind: ["stage", "area", "wall", "curtain"].includes((a || {}).kind) ? a.kind : "area",
        x: num(a.x, -100, 0), y: num(a.y, -100, 0), w: num(a.w, 0.1, 1), d: num(a.d, 0.1, 1),
      }));
    }
    saveShow();
    broadcastState();
  });
  socket.on("saveProtocols", (p) => {
    for (const k of ["sacn", "artnet", "dmx"])
      Object.assign(show.protocols[k], (p || {})[k] || {});
    saveShow();
    openDmxPort();
    broadcastState();
  });
  socket.on(
    "serialPorts",
    async (reply) => typeof reply === "function" && reply(await serialPorts()),
  );

  // Levels live per address, not per fixture, so when a fixture moves or changes type its old addresses
  // would stay lit and keep going out. After any patch change: what a fixture used to drive but no longer
  // does goes dark, and so does every address no fixture owns at all.
  const addressesOf = (f) => { // the slots a fixture occupies, across all its parts and outputs
    const set = new Set();
    for (const c of cellsOf(f)) {
      const base = ((Number(c.universe || f.universe) || 1) - 1) * 512;
      for (let i = 0; i < channelsOf(c); i++) if (c.address + i <= 512) set.add(base + c.address + i);
    }
    return set;
  };
  const patchAddresses = () => (show.patch || []).map((f) => (f ? addressesOf(f) : null));
  function releaseOrphans(before) {
    const after = patchAddresses();
    const owned = new Set(after.flatMap((a) => (a ? [...a] : [])));
    const dark = {};
    before.forEach((was, i) => { if (was) for (const a of was) if (!after[i] || !after[i].has(a)) dark[a] = 0; });
    for (let a = 1; a <= SLOTS; a++) if (!owned.has(a) && dmx[a - 1] > 0) dark[a] = 0;
    if (!Object.keys(dark).length) return;
    fadeTo(dark, 0);
    for (const a of Object.keys(dark)) { manual.delete(Number(a)); stale.delete(Number(a)); }
    emitMarks();
  }
  socket.on("savePatch", (patch) => {
    remember("patch", true);
    const before = patchAddresses();
    show.patch = patch;
    trimPatch();
    releaseOrphans(before);
    saveShow();
    broadcastState();
  });

  // Unpatch channel n (1-based). The channel goes empty; nothing else is renumbered, as on a console.
  // One step, so Undo puts the fixture, groups and palettes back together.
  socket.on("removeFixture", (n) => {
    if (!(show.patch || [])[n - 1]) return;
    remember(`remove fixture ${n}`);
    const before = patchAddresses();
    show.patch[n - 1] = null;
    trimPatch();
    releaseOrphans(before);
    for (const g of Object.values(show.groups || {}))
      g.channels = g.channels.filter((c) => c !== n);
    for (const cp of Object.values(show.palettes || {}))
      delete (cp.colors || {})[n];
    saveShow();
    broadcastState();
  });

  // Move fixture `from` to channel `to` (both 1-based). An empty channel just takes it; an occupied one swaps.
  // Groups and palettes name fixtures by number, so renumber those two channels.
  socket.on("moveFixture", ({ from, to }) => {
    const p = show.patch || [];
    to = Math.max(1, Math.min(9999, Math.round(Number(to) || 1)));
    if (!p[from - 1] || from === to) return;
    remember(`move fixture ${from} to ${to}`);
    const before = patchAddresses().map(() => null); // a move keeps every fixture's own addresses; only what ends up unowned goes dark
    const other = p[to - 1] || null;
    p[to - 1] = p[from - 1];
    p[from - 1] = other;
    trimPatch();
    for (const c of [from, to]) {
      // addresses that follow the channel follow it
      const x = p[c - 1];
      if (x && !x.addrFixed)
        x.address = Math.max(1, Math.min(512 - channelsOf(x) + 1, c));
    }
    releaseOrphans(before);
    const renum = (c) => (c === from ? to : c === to ? from : c);
    for (const g of Object.values(show.groups || {}))
      g.channels = g.channels.map(renum);
    for (const cp of Object.values(show.palettes || {})) {
      const colors = {};
      for (const [c, col] of Object.entries(cp.colors || {}))
        colors[renum(Number(c))] = col;
      cp.colors = colors;
    }
    saveShow();
    broadcastState();
  });

  // Header "Go to cue": bring up a cue's whole look without moving the show along (for building looks)
  socket.on("loadCue", (index) => {
    const cue = show.cues[index];
    if (!isLight(cue)) return;
    moves = movesOf(index);
    lookOnStage = stateAt(index);
    fadeTo(fullLook(index), upTime(cue), downTime(cue));
    emitMarks();
  });

  // ---- lights page command line. reply(text) shows up on that page's command line.
  const say = (reply, text) => typeof reply === "function" && reply(text);

  socket.on("back", back);
  socket.on("jump", ({ number, time } = {}) => {
    if (number === null || number === undefined) return jumpTo(-1, time);
    const i = findLightCue(number);
    if (i >= 0) jumpTo(i, time);
  });

  // Record [Cue n] [Label x] [Time up / down] [only: DMX channels]. A cue stores what differs from the
  // look before it, so later cues carry on from it.
  // from: in Blind, the number of the cue whose look is copied instead of the stage
  socket.on(
    "record",
    ({ number, label, up, down, only, from, fromIndex } = {}, reply) => {
      number =
        number === undefined || number === null || number === ""
          ? nextCueNumber()
          : cleanNumber(number);
      let index = findCue(number);
      if (index >= 0 && !isLight(show.cues[index]))
        return say(
          reply,
          `Cue ${number} is a ${show.cues[index].type} cue, not lights`,
        );
      const fromAt = from !== undefined ? findLightCue(from, fromIndex) : -1;
      if (from !== undefined && fromAt < 0)
        return say(reply, `No light cue ${from} to copy from`);
      const source = from !== undefined ? stateAt(fromAt) : null; // read before a new cue shifts the list
      const stageBefore = stageLook();
      remember(`record cue ${number}`);
      let cue = show.cues[index];
      if (!cue) {
        cue = {
          number,
          label: label || "",
          type: "light",
          fade: 3,
          levels: {},
        };
        index = insertCue(cue);
      }
      const before = stateAt(index - 1),
        live = source || targetLevels(); // a fade in progress counts as finished
      const chans = only
        ? only.map(Number).filter((ch) => ch >= 1 && ch <= SLOTS)
        : live.map((_, i) => i + 1);
      const levels = only ? { ...cue.levels } : {}; // recording just some channels keeps the rest of the cue
      for (const ch of chans) {
        if (live[ch - 1] !== before[ch - 1]) levels[ch] = live[ch - 1];
        else delete levels[ch];
      }
      cue.levels = levels;
      if (label !== undefined) cue.label = label;
      setTimes(cue, up, down);
      if (!source) {
        if (only) for (const ch of chans) manual.delete(ch);
        else manual.clear();
        // Building the show in order moves along with you; recording anywhere else (or only some channels)
        // leaves the show where it is
        if (index === currentCue + 1 && !only) {
          currentCue = index;
          lookOnStage = stateAt(index);
        }
      }
      recheckStage(stageBefore);
      saveShow();
      broadcastState();
      emitMarks();
      say(
        reply,
        `Recorded cue ${number} (${Object.keys(levels).length} channels)`,
      );
    },
  );

  // Update: put the hand-set (red) levels into a cue: the one named, or the light cue on stage
  socket.on("update", ({ number } = {}, reply) => {
    const index = number === undefined ? lightOnStage() : findLightCue(number);
    const cue = show.cues[index];
    if (!isLight(cue)) return say(reply, "No light cue on stage to update");
    if (!manual.size) return say(reply, "Nothing set by hand to update");
    remember(`update cue ${cue.number}`);
    const live = targetLevels();
    for (const ch of manual) cue.levels[ch] = live[ch - 1];
    const n = manual.size;
    manual.clear();
    recheckStage(null);
    saveShow();
    broadcastState();
    emitMarks();
    say(reply, `Updated cue ${cue.number} (${n} channels)`);
  });

  // Release: hand-set levels fade back to what the cue on stage says. channels = DMX numbers, or every hand-set one.
  socket.on("release", ({ channels, time } = {}) => {
    const look = stateAt(currentCue),
      levels = {};
    for (const ch of channels || [...manual, ...stale])
      if (ch >= 1 && ch <= SLOTS) levels[ch] = look[ch - 1];
    fadeTo(levels, Number.isFinite(time) ? time : 3);
    emitMarks();
  });

  // Cue n Label x / Cue n Time up / down
  socket.on("cueSettings", ({ number, label, up, down } = {}) => {
    const cue = show.cues[findLightCue(number)];
    if (!cue) return;
    remember(`change cue ${cue.number}`);
    if (label !== undefined) cue.label = label;
    setTimes(cue, up, down);
    saveShow();
    broadcastState();
  });

  socket.on("deleteCue", ({ number } = {}) => {
    const index = findLightCue(number);
    if (index < 0) return;
    const stageBefore = stageLook();
    remember(`delete cue ${number}`);
    show.cues.splice(index, 1);
    if (index <= currentCue) currentCue--;
    recheckStage(stageBefore);
    emitMarks();
    saveShow();
    broadcastState();
  });

  // Blind: change the levels stored in a cue without touching the stage. Changes carry on into later
  // cues until a cue moves that channel itself; with cueOnly, later cues keep looking exactly as before.
  socket.on(
    "blindSet",
    ({ number, index: seenAt, levels, cueOnly } = {}, reply) => {
      const index = findLightCue(number, seenAt),
        cue = show.cues[index];
      if (!cue) return say(reply, `No light cue ${number}`);
      const before = stateAt(index - 1),
        old = stateAt(index);
      const changes = Object.entries(levels || {})
        .map(([key, raw]) => [
          Number(key),
          Math.max(0, Math.min(255, Math.round(Number(raw)))),
        ])
        .filter(
          ([ch, lv]) =>
            ch >= 1 && ch <= SLOTS && Number.isFinite(lv) && lv !== old[ch - 1],
        );
      if (!changes.length) return say(reply, "No change");
      remember(`blind edit cue ${cue.number}`, true);
      const stageBefore = stageLook();
      let next = index + 1; // the next light cue, which gets the old values back for "only this cue"
      while (next < show.cues.length && !isLight(show.cues[next])) next++;
      let n = 0;
      for (const [ch, lv] of changes) {
        if (
          cueOnly &&
          show.cues[next] &&
          !(ch in (show.cues[next].levels || {}))
        ) {
          show.cues[next].levels = show.cues[next].levels || {};
          show.cues[next].levels[ch] = old[ch - 1];
        }
        if (lv === before[ch - 1])
          delete cue.levels[ch]; // same as the cue before: no need to store it
        else cue.levels[ch] = lv;
        n++;
      }
      recheckStage(stageBefore); // the stage didn't change, but the cue on it may now say something else
      saveSoon();
      broadcastState();
      emitMarks();
      say(
        reply,
        n
          ? `Cue ${cue.number}: ${n} channel${n > 1 ? "s" : ""} changed${cueOnly ? " (this cue only)" : ""}`
          : "No change",
      );
    },
  );

  socket.on("undo", (_, reply) => {
    const last = undoStack.pop();
    if (!last) return say(reply, "Nothing to undo");
    const stageBefore = stageLook();
    const live = show.cues[currentCue];
    show.cues = JSON.parse(last.cues);
    show.groups = JSON.parse(last.groups);
    show.palettes = JSON.parse(last.palettes);
    show.faders = JSON.parse(last.faders || "[]");
    faderPos.splice(0, faderPos.length, ...JSON.parse(last.faderPos || "[]")); // positions line up with the restored faders again
    io.emit("faderPos", faderPos);
    show.patch = JSON.parse(last.patch || "[]");
    keepPointer(live, currentCue);
    recheckStage(stageBefore); // undoing a cue change can leave the stage out of date, like a Blind edit
    saveShow();
    broadcastState();
    emitMarks();
    say(reply, `Undid ${last.what}`);
  });

  socket.on("saveGroups", (groups) => {
    remember("groups");
    show.groups = groups;
    saveShow();
    broadcastState();
  });
  socket.on("savePalettes", (palettes) => {
    remember("palettes");
    show.palettes = palettes;
    saveShow();
    broadcastState();
  });

  socket.emit("state", state()); // newcomer sees the list
  attachListen(
    socket,
    { ...(show.follow || {}), claim: claimMic, release: releaseMic },
    io,
  ); // show.json "follow": { "model": "onnx-community/whisper-tiny.en" } to change the model

  // The app's own Follow page (same device as the hidden listener) -> hidden listener window
  socket.on("listenControl", (changes) => {
    if (!changes || typeof changes !== "object") return;
    if (
      !listenState.headlessDevice ||
      changes.device !== listenState.headlessDevice
    )
      return; // not this device's listener
    if (
      changes.listening === true &&
      listenState.owner &&
      listenState.owner !== changes.device &&
      ownerSocket &&
      ownerSocket.connected
    )
      return; // someone else has the mic
    if (typeof changes.listening === "boolean")
      listenState.listening = changes.listening;
    if (typeof changes.micId === "string") listenState.micId = changes.micId;
    if (typeof changes.minScore === "number")
      listenState.minScore = Math.max(4, Math.min(14, changes.minScore));
    io.emit("listenState", listenPublic());
  });
  let isHeadless = false;
  socket.on("setMode", (m) => {
    if (!["edit", "show"].includes(m) || m === mode) return;
    mode = m;
    io.emit("mode", mode);
    broadcastState();
  });
  // Chrome's own recogniser doesn't stream audio here, but it still has to claim the mic
  socket.on("listenOwner", (p) => {
    if (p && p.device) {
      if (!claimMic(socket, p.device)) socket.emit("listenDenied");
    } else releaseMic(socket);
  });
  socket.on("disconnect", () => releaseMic(socket));
  socket.on("listenHello", (p) => {
    if (!isHeadless) headlessCount++;
    isHeadless = true;
    socket.data.headless = true;
    listenState.headlessDevice = (p && p.device) || listenState.headlessDevice;
    io.emit("listenState", listenPublic());
  });
  socket.on("disconnect", () => {
    if (!isHeadless) return;
    headlessCount = Math.max(0, headlessCount - 1);
    if (!headlessCount) {
      listenState.headlessDevice = null;
      listenState.listening = false;
    }
    io.emit("listenState", listenPublic());
  });
  socket.on("go", go);
  socket.on("reset", () => {
    cancelFollow();
    currentCue = -1;
    scriptPosition = -1;
    broadcastState();
  });

  // A new script from the Script page's import. Cue markers lived on the old lines, so they go too.
  socket.on("saveScript", (lines) => {
    if (!Array.isArray(lines)) return;
    show.script = lines.map((l) => ({
      speaker: String(l.speaker || ""),
      text: String(l.text || ""),
      ...(l.heading ? { heading: true } : {}),
      ...(l.cue ? { cue: l.cue } : {}), // cue markers survive a round trip
    }));
    scriptPosition = -1;
    saveShow();
    broadcastState();
    io.emit("scriptPosition", -1);
  });

  // The Follow page heard a line (or someone nudged it); tell every script view
  socket.on("scriptPosition", (index) => {
    const max = (show.script || []).length - 1;
    if (typeof index !== "number" || index < -1 || index > max) return;
    scriptPosition = index;
    io.emit("scriptPosition", index);
  });

  // Make a cue the next one to GO, without firing anything
  socket.on("setStandby", (index) => {
    if (index < 0 || index >= show.cues.length) return;
    cancelFollow();
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
    if (!Array.isArray(cues)) return;
    if (JSON.stringify(cues) === JSON.stringify(show.cues))
      return broadcastState(); // nothing changed: no undo step
    remember("cue list edit");
    const stageBefore = stageLook();
    const live = show.cues[currentCue];
    show.cues = cues;
    keepPointer(live, currentCue);
    recheckStage(stageBefore);
    saveShow();
    broadcastState();
    emitMarks();
  });

  // Header "Record": capture the whole stage into a cue
  socket.on("recordCue", ({ index, label }) => {
    if (show.cues[index] && !isLight(show.cues[index])) return; // only ever records into a light cue
    remember("record");
    const stageBefore = stageLook();
    const cue = show.cues[index];
    const before = stateAt((cue ? index : show.cues.length) - 1),
      live = targetLevels(),
      levels = {};
    live.forEach((lv, i) => {
      if (lv > 0 || before[i] > 0) levels[i + 1] = lv; // a channel pulled to 0 is stored as 0, or an earlier cue would bring it back
    });

    if (cue) {
      // Channels the cue used to have but are now dark must be recorded as 0,
      // otherwise the cue would leave them wherever they were.
      for (const ch of Object.keys(cue.levels || {}))
        if (!(ch in levels)) levels[ch] = 0;
      cue.levels = levels;
    } else {
      show.cues.push({
        number: nextCueNumber(),
        label: label || "New look",
        type: "light",
        fade: 3,
        levels,
      });
    }
    manual.clear();
    recheckStage(stageBefore);
    emitMarks();
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
    if (SANDBOX)
      return io.emit("desks", {
        scanning: false,
        found: [],
        scanned: 0,
        skipped: 0,
      }); // the demo site never sweeps a network
    scanning = true;
    const found = [];
    io.emit("desks", { scanning: true, found });
    const result = await discoverDesks((desk) => {
      found.push(desk);
      io.emit("desks", { scanning: true, found });
    });
    scanning = false;
    io.emit("desks", {
      scanning: false,
      found,
      scanned: result.scanned,
      skipped: result.skipped,
    });
  });
  // The desk's IP address was typed on the sound page: save it and (re)connect
  socket.on("setSqHost", (host) => {
    desk.host = String(host || "").trim();
    saveMixerConfig();
    if (sqSocket)
      sqSocket.destroy(); // its close handler reconnects with the new address
    else connectSq();
    io.emit("desk", desk);
  });
  // Save the current faders and mutes into a cue (a "mix" cue), like recording a light look
  socket.on("recordMix", ({ number, label } = {}) => {
    remember("record mix");
    const cue =
      number !== undefined
        ? show.cues.find(
            (c) => c.type === "mix" && sameNumber(c.number, number),
          )
        : null;
    if (cue)
      cue.mix = mixSnapshot(); // only ever overwrites a mix cue
    else if (number === undefined)
      show.cues.push({
        number: nextCueNumber(),
        label: label || "Mix scene",
        type: "mix",
        mix: mixSnapshot(),
      });
    else return;
    saveShow();
    broadcastState();
  });

  socket.on("clearAll", () => {
    stopFades(); // otherwise a running fade would bring the lights back
    cancelFollow();
    dmx.fill(0);
    lookOnStage = new Array(SLOTS).fill(0); // the next GO brings up its whole look
    manual.clear();
    stale.clear();
    moves = {};
    emitMarks();
    io.emit("dmx", dmx);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("Show server running at http://localhost:" + PORT);
});
