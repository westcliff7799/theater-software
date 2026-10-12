// Live script panel, shared by the Stage Manager and Home pages. Read-only.
//   installLiveScript(container, socket)
// Shows the act and scene, one line of what was just said, the live line, and as much of what
// is coming as fits (no scrollbar), with the cue markers on those lines. Listens for "state" and
// "scriptPosition" on the socket it is given.
function installLiveScript(container, socket) {
  container.classList.add("livescript");
  container.innerHTML = `
    <h3>LIVE SCRIPT <a href="/actor.html">full script ›</a></h3>
    <div class="where"></div>
    <div class="lines"><p class="none">No script yet. Import one on the Script page.</p></div>`;
  const where = container.querySelector(".where"), box = container.querySelector(".lines");
  let script = [], scriptPosition = -1, cues = [], currentCue = -1;
  const BEFORE = 1, AFTER = 12; // one line of what was just said, then as much of what's coming as fits
  const isDirection = (l) => !l.heading && (!l.speaker || /^stage$/i.test(l.speaker));

  function draw() {
    if (!script.length) { box.innerHTML = '<p class="none">No script yet. Import one on the Script page.</p>'; where.textContent = ""; return; }
    const byNumber = new Map(cues.map((c, i) => [c.number, i]));
    const liveNumber = cues[currentCue]?.number, nextNumber = cues[currentCue + 1]?.number;
    // the live line: what the follower heard, or else the line whose cue just fired
    let live = scriptPosition;
    if (live < 0) live = script.findIndex((l) => [].concat(l.cue || []).includes(liveNumber));
    let act = "", scene = "";
    for (let i = 0; i <= live; i++) { const l = script[i]; if (!l?.heading) continue; if (/^(act|prologue|epilogue)\b/i.test(l.text)) { act = l.text; scene = ""; } else scene = l.text; }
    where.textContent = live < 0 ? "Top of show" : [act, scene].filter(Boolean).join(" · ");

    let from = Math.max(0, live), back = 0;
    while (from > 0 && back < BEFORE) { from--; if (!isDirection(script[from]) && !script[from].heading) back++; }
    let to = Math.max(0, live), fwd = 0;
    while (to < script.length - 1 && fwd < AFTER) { to++; if (!isDirection(script[to]) && !script[to].heading) fwd++; }
    if (live < 0) { from = 0; to = Math.min(script.length - 1, 12); }

    box.innerHTML = "";
    for (let i = from; i <= to; i++) {
      const l = script[i];
      for (const number of [].concat(l.cue || [])) {
        const cue = cues[byNumber.get(number)];
        const m = document.createElement("div");
        const fired = byNumber.has(number) && byNumber.get(number) <= currentCue;
        m.className = "cue" + (number === nextNumber ? " standby" : fired ? " done" : "");
        m.textContent = (number === nextNumber ? "STANDBY  " : "CUE ") + number + (cue ? " · " + cue.label : "");
        box.appendChild(m);
      }
      const d = document.createElement("div");
      d.className = "sl" + (i === live ? " live" : i > live ? " ahead" : "") + (l.heading ? " heading" : isDirection(l) ? " direction" : "");
      const text = (l.text || "").replace(/</g, "&lt;").replace(/\(([^)]*)\)/g, '<i class="note">($1)</i>');
      d.innerHTML = (l.heading || isDirection(l) ? "" : `<span class="who">${l.speaker}</span>`) + text;
      box.appendChild(d);
    }
    // drop lines off the bottom until nothing is cut off, so the panel never needs a scrollbar
    box.scrollTop = 0;
    if (!box.clientHeight) return; // not laid out yet (a panel mid-move): keep every line, we'll be drawn again
    while (box.children.length > 1 && box.scrollHeight > box.clientHeight && !box.lastElementChild.classList.contains("live")) box.lastElementChild.remove();
    if (box.lastElementChild && box.lastElementChild.previousElementSibling?.classList.contains("cue")) box.lastElementChild.previousElementSibling.remove();
    // a narrow panel may not even fit the line before: then it goes too, the live line always stays
    while (box.children.length > 1 && box.scrollHeight > box.clientHeight && !box.firstElementChild.classList.contains("live")) box.firstElementChild.remove();
  }
  socket.on("state", (s) => { script = s.script || []; scriptPosition = s.scriptPosition ?? -1; cues = s.cues || []; currentCue = s.currentCue ?? -1; draw(); });
  socket.on("scriptPosition", (i) => { scriptPosition = i; draw(); });
  window.addEventListener("resize", draw);
  return { draw };
}
