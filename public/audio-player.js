// Shared audio player. Include it on a page, then call listenForSound(socket).
const players = new Map(); // Audio -> { file, label, volume, fadeOut, startedAt, fading }
let playHere = true;        // a page can switch this off
let masterVolume = 1;       // this page's own master, 0 to 1
let onPlayersChange = () => {}; // a page can set this to redraw its list
let onPlayerStart = () => {};   // a page can hook each new player (the sound page attaches a meter)

// play("song.mp3", { volume: 0.8, fadeIn: 2, fadeOut: 3, loop: false, label: "3 · Thunder" })
// play("song.mp3", 0.8) still works too.
function play(file, options = {}) {
  const { volume = 1, fadeIn = 0, fadeOut = 1, loop = false, label = file } =
    typeof options === "number" ? { volume: options } : options;
  const a = new Audio("/audio/" + file);
  a.loop = loop;
  const entry = { file, label, volume, fadeOut, startedAt: Date.now(), fading: null };
  players.set(a, entry);
  onPlayerStart(a);
  a.volume = fadeIn > 0 ? 0 : volume * masterVolume;
  a.play();
  if (fadeIn > 0) fadeTo(a, volume * masterVolume, fadeIn);
  a.onended = () => {
    players.delete(a);
    onPlayersChange();
  };
  onPlayersChange();
  return a;
}

// Move one player's volume to a target over some seconds, then run "then" if given
function fadeTo(a, target, seconds, then) {
  const entry = players.get(a);
  if (entry?.fading) clearInterval(entry.fading);
  const steps = Math.max(1, Math.round(seconds * 20));
  const start = a.volume;
  let step = 0;
  const timer = setInterval(() => {
    step++;
    a.volume = Math.max(0, Math.min(1, start + (target - start) * (step / steps)));
    if (step >= steps) {
      clearInterval(timer);
      if (entry) entry.fading = null;
      if (then) then();
    }
  }, 50);
  if (entry) entry.fading = timer;
}

// Fade one player out (over its own fadeOut time unless told otherwise) and remove it
function stopPlayer(a, seconds) {
  const entry = players.get(a);
  if (!entry) return;
  fadeTo(a, 0, seconds ?? entry.fadeOut, () => {
    a.pause();
    players.delete(a);
    onPlayersChange();
  });
}
function stopAll() {
  for (const a of [...players.keys()]) stopPlayer(a);
}

function setMasterVolume(v) {
  masterVolume = v;
  for (const [a, entry] of players) if (!entry.fading) a.volume = entry.volume * masterVolume;
}
function setPlayerVolume(a, v) {
  const entry = players.get(a);
  if (!entry) return;
  entry.volume = v;
  if (!entry.fading) a.volume = v * masterVolume;
}

function listenForSound(socket) {
  socket.on("playSound", (cue) => {
    if (playHere) play(cue.file, cue);
  });
  socket.on("stopSound", stopAll);
}
