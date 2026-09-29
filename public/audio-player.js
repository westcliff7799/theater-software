// Shared audio player. Include it on a page, then call listenForSound(socket).
const players = new Map(); // Audio object -> file name
let playHere = true; // a page can switch this off
let onPlayersChange = () => {}; // a page can set this to redraw its list

function play(file, volume = 1) {
  const a = new Audio("/audio/" + file);
  a.volume = volume;
  a.play();
  players.set(a, file);
  a.onended = () => {
    players.delete(a);
    onPlayersChange();
  };
  onPlayersChange();
}

// Fade every playing sound out over one second, then stop it
function stopAll() {
  for (const a of players.keys()) {
    const fade = setInterval(() => {
      a.volume = Math.max(0, a.volume - 0.05);
      if (a.volume === 0) {
        clearInterval(fade);
        a.pause();
        players.delete(a);
        onPlayersChange();
      }
    }, 50);
  }
}

function listenForSound(socket) {
  socket.on("playSound", ({ file, volume }) => {
    if (playHere) play(file, volume);
  });
  socket.on("stopSound", stopAll);
}
