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

// Anything in /public becomes a web page. public/lights.html -> /lights.html
app.use(express.static(path.join(__dirname, "public")));
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

// The "state of the lights": 512 channels, just like real DMX. 0 = off, 255 = full.
const dmx = new Array(512).fill(0);

setInterval(() => {
  const payload = {};
  dmx.forEach((level, i) => {
    if (level > 0) payload[i + 1] = level;
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

function stopAll() {
  for (const t of activeFades) clearInterval(t); // freeze lights where they are
  activeFades.clear();
  io.emit("stopSound"); // sound pages stop playback
  console.log("STOP");
}

function runCue(cue) {
  if (cue.type === "light") fadeTo(cue.levels, cue.fade || 0);
  if (cue.type === "sound")
    io.emit("playSound", { file: cue.file, volume: cue.volume ?? 1 });
  if (cue.type === "midi" && midiOut.isPortOpen())
    midiOut.sendMessage(cue.bytes);
}

function go() {
  if (currentCue + 1 >= show.cues.length) return; // end of show, ignore
  currentCue++;
  const cue = show.cues[currentCue];
  console.log("GO", cue.number, cue.label);
  runCue(cue);
  broadcastState();
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
    script: show.script,
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

  socket.emit("state", state()); // newcomer sees the list
  socket.on("go", go);
  socket.on("reset", () => {
    currentCue = -1;
    broadcastState();
  });

  socket.on("midi", (bytes) => {
    if (midiOut.isPortOpen()) midiOut.sendMessage(bytes);
  });

  socket.on("stop", stopAll);

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

  socket.on("clearAll", () => {
    dmx.fill(0);
    io.emit("dmx", dmx);
  });
});

server.listen(3000, () => {
  console.log("Show server running at http://localhost:3000");
});
