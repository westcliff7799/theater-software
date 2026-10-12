// Script search, shared by the Script and Follow pages.
//   installSearch({ input, count, box, onPick })
// Typing highlights every .line in `box` whose text contains the words, and scrolls to the first.
// ◀ ▶ buttons (or the up/down arrow keys in the box) step through the hits. Enter runs
// onPick(lineElement) on the current hit (the Follow page uses it to make that line live), and
// also steps to the next one; Escape clears.
// Call .apply() after the page redraws its lines, so the highlights come back.
function installSearch({ input, count, box, onPick }) {
  let hits = [];
  let at = -1;

  // ◀ 1 of 2 ▶ : the count the page gave us, with a step button either side
  const prev = document.createElement("button"), next = document.createElement("button");
  prev.textContent = "◀"; next.textContent = "▶";
  prev.title = "Previous match (↑)"; next.title = "Next match (↓)";
  prev.className = next.className = "search-step";
  count.before(prev); count.after(next);
  count.classList.add("search-count");
  const step = (d) => { if (!hits.length) return; at = (at + d + hits.length) % hits.length; apply(true); input.focus(); };
  prev.onclick = () => step(-1);
  next.onclick = () => step(1);

  function apply(scroll = false) {
    const q = input.value.trim().toLowerCase();
    const lines = [...box.querySelectorAll(".line")];
    for (const l of lines) l.classList.remove("hit", "hit-current");
    hits = q ? lines.filter((l) => l.textContent.toLowerCase().includes(q)) : [];
    for (const h of hits) h.classList.add("hit");
    if (at >= hits.length) at = hits.length - 1;
    if (hits.length && at < 0) at = 0;
    count.textContent = q ? (hits.length ? `${at + 1} of ${hits.length}` : "no match") : "";
    prev.hidden = next.hidden = hits.length < 2;
    if (hits[at]) {
      hits[at].classList.add("hit-current");
      if (scroll) hits[at].scrollIntoView({ block: "center", behavior: "instant" });
    }
  }

  input.oninput = () => { at = 0; apply(true); };
  input.onkeydown = (e) => {
    if (e.key === "Escape") { input.value = ""; apply(); input.blur(); }
    if (e.key === "ArrowDown") { e.preventDefault(); step(1); }
    if (e.key === "ArrowUp") { e.preventDefault(); step(-1); }
    if (e.key !== "Enter" || !hits.length) return;
    e.preventDefault();
    if (onPick) onPick(hits[at]);   // act on the current hit...
    step(e.shiftKey ? -1 : 1);       // ...then move on to the next
  };
  // Cmd/Ctrl+F focuses the box instead of the browser's own find
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "f") { e.preventDefault(); input.focus(); input.select(); }
  });
  return { apply: () => apply(false) };
}
