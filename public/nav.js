// Shared navigation strip. Include it right after <body> on every page.
// The current page is highlighted; Cmd/Ctrl + 1..6 jumps between views.
const VIEWS = [
  ["index.html", "Home"],
  ["sm.html", "Stage Manager"],
  ["lights.html", "Lights"],
  ["sound.html", "Sound"],
  ["actor.html", "Script"],
  ["follow.html", "Follow"],
];
const here = location.pathname.split("/").pop() || "index.html";

const nav = document.createElement("nav");
nav.className = "nav";
VIEWS.forEach(([page, name], i) => {
  const a = document.createElement("a");
  a.href = "/" + page;
  a.textContent = name;
  a.title = "⌘" + (i + 1);
  if (page === here) a.className = "on";
  nav.appendChild(a);
});
// Edit / Show switch. The server keeps the mode; the body gets class mode-edit or mode-show, and
// anything marked data-edit-only disappears in Show, so a running show can't be edited by accident.
const modeBox = document.createElement("div");
modeBox.className = "mode";
modeBox.title = "Edit: build the show. Show: run it, with editing locked and the script in view.";
let modeSocket = null;
for (const [v, label] of [["edit", "Edit"], ["show", "Show"]]) {
  const b = document.createElement("button");
  b.textContent = label;
  b.dataset.mode = v;
  b.onclick = () => modeSocket && modeSocket.emit("setMode", v);
  modeBox.appendChild(b);
}
nav.appendChild(modeBox);
function showMode(m) {
  document.body.classList.remove("mode-edit", "mode-show");
  document.body.classList.add("mode-" + m);
  for (const b of modeBox.children) b.classList.toggle("on", b.dataset.mode === m);
}
showMode("edit");

// This device's id: the same for every page and window of one browser or one app, different on
// every other machine. The server records which device has the microphone open.
let DEVICE_ID = "";
try {
  DEVICE_ID = localStorage.getItem("deviceId") || "";
  if (!DEVICE_ID) { DEVICE_ID = (crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2)); localStorage.setItem("deviceId", DEVICE_ID); }
} catch (_) { DEVICE_ID = "nostorage"; }
window.DEVICE_ID = DEVICE_ID; // pages (follow.html) read it from here

// "Listening" badge on the right: the hidden listener (or a Follow page) has the mic open.
// It shows on every view, so leaving the Follow page never makes anyone wonder whether it stopped.
const badge = document.createElement("a");
badge.href = "/follow.html";
badge.className = "listening";
badge.title = "Speech follower is running. Click for the Follow page.";
badge.innerHTML = '<span class="dot"></span>Listening';
badge.hidden = true;
nav.appendChild(badge);
document.body.prepend(nav);

// The nav has its own socket so it works on pages that never load one. The badge follows
// listenState, which the server sends in "state" and again whenever it changes.
function watchListening() {
  const io = window.io;
  if (!io) return;
  const s = io();
  // Shown on every page of the primary device (the one whose microphone is open), nowhere else.
  let owner = null;
  const show = () => { badge.hidden = !(owner && owner === DEVICE_ID); };
  modeSocket = s;
  s.on("mode", showMode);
  s.on("state", (st) => { owner = st.listenState ? st.listenState.owner : null; show(); if (st.mode) showMode(st.mode); });
  s.on("listenState", (st) => { owner = st.owner; show(); });
  s.on("disconnect", () => { owner = null; show(); });
}
if (window.io) watchListening();
else {
  const tag = document.createElement("script");
  tag.src = "/socket.io/socket.io.js";
  tag.onload = watchListening;
  document.head.appendChild(tag);
}

document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const view = VIEWS[Number(e.key) - 1];
  if (view) location.href = "/" + view[0];
});
