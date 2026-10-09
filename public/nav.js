// Shared navigation strip. Include it right after <body> on every page.
// The current page is highlighted; Cmd/Ctrl + 1..5 jumps between views.
const VIEWS = [
  ["index.html", "Home"],
  ["sm.html", "Stage Manager"],
  ["lights.html", "Lights"],
  ["sound.html", "Sound"],
  ["actor.html", "Script"],
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
document.body.prepend(nav);

document.addEventListener("keydown", (e) => {
  if (!(e.metaKey || e.ctrlKey)) return;
  const view = VIEWS[Number(e.key) - 1];
  if (view) location.href = "/" + view[0];
});
