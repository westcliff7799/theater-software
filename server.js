// server.js - the one brain every view talks to
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Anything in /public becomes a web page. public/lights.html -> /lights.html
app.use(express.static("public"));

// DMX out with sACN
const os = require("os");
const { Sender } = require("sacn");

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

// The "state of the lights": 512 channels, just like real DMX. 0 = off, 255 = full.
const dmx = new Array(512).fill(0);

setInterval(() => {
  const payload = {};
  dmx.forEach((level, i) => {
    if (level > 0) payload[i + 1] = level;
  });
  for (const s of senders) s.send({ payload });
}, 50);

const fs = require("fs");
const show = JSON.parse(fs.readFileSync("show.json", "utf8"));
let currentCue = -1; // -1 means "top of show, nothing fired yet"

function broadcastState() {
  io.emit("state", { currentCue, cues: show.cues });
}

// Move some channels from where they are to new levels over N seconds
function fadeTo(levels, seconds) {
  const start = dmx.slice(); // snapshot of where we began
  const steps = Math.max(1, Math.round(seconds * 40)); // 40 steps per second
  let step = 0;
  const timer = setInterval(() => {
    step++;
    const t = step / steps; // 0 at the start, 1 at the end
    for (const [ch, target] of Object.entries(levels)) {
      const i = ch - 1;
      dmx[i] = Math.round(start[i] + (target - start[i]) * t);
    }
    io.emit("dmx", dmx); // lights pages animate
    if (step >= steps) clearInterval(timer);
  }, 25);
}

function runCue(cue) {
  if (cue.type === "light") fadeTo(cue.levels, cue.fade || 0);
  if (cue.type === "sound") io.emit("playSound", cue.file);
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

// This runs once for every page that opens
io.on("connection", (socket) => {
  console.log("a view connected");

  // Send the newcomer the current levels so it isn't blank
  socket.emit("dmx", dmx);

  // A lights page moved a slider
  socket.on("setChannel", ({ channel, level }) => {
    dmx[channel - 1] = level;
    io.emit("dmx", dmx); // io.emit = tell EVERY page, not just the sender
  });

  // Someone hit a sound cue
  socket.on("playSound", (file) => {
    io.emit("playSound", file);
  });

  socket.on("midi", (bytes) => {
    midiOut.sendMessage(bytes);
  });

  socket.emit("state", { currentCue, cues: show.cues }); // newcomer sees the list
  socket.on("go", go);
  socket.on("reset", () => {
    currentCue = -1;
    broadcastState();
  });
});

const midi = require("@julusian/midi");
const midiOut = new midi.Output();
if (midiOut.getPortCount() > 0) {
  midiOut.openPort(0);
  console.log("MIDI out:", midiOut.getPortName(0));
} else {
  console.log("No MIDI ports found, MIDI disabled");
}

server.listen(3000, () => {
  console.log("Show server running at http://localhost:3000");
});
