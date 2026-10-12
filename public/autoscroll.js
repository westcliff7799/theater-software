// Keeps the live line in view without fighting the reader.
//   const auto = installAutoScroll(box)
//   auto.follow(element)   bring this element into view, unless the reader has scrolled away
//   auto.resume()          back to following (the "Back to live line" pill calls this)
// Any wheel, touch, keyboard or scrollbar movement by the reader pauses following and shows
// the pill; following resumes by itself after IDLE_MS without touching the scroll.
// Jumps are instant on purpose: a long animated scroll makes some people queasy.
function installAutoScroll(box, { idleMs = 30000 } = {}) {
  let paused = false;
  let ours = false;        // the scroll event we are about to cause is not the reader's
  let idleTimer = null;
  let target = null;

  const pill = document.createElement("button");
  pill.className = "back-to-live";
  pill.textContent = "↓ Back to live line";
  pill.hidden = true;
  pill.onclick = () => resume();
  document.body.appendChild(pill);

  function jump(el) {
    if (!el) return;
    ours = true;
    el.scrollIntoView({ block: "center", behavior: "instant" });
    requestAnimationFrame(() => requestAnimationFrame(() => (ours = false)));
  }
  function pause() {
    paused = true;
    pill.hidden = false;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(resume, idleMs);
  }
  function resume() {
    paused = false;
    pill.hidden = true;
    clearTimeout(idleTimer);
    jump(target);
  }
  function follow(el) {
    target = el;
    if (!paused) jump(el);
  }

  box.addEventListener("scroll", () => { if (!ours) pause(); });
  for (const ev of ["wheel", "touchmove", "pointerdown"]) box.addEventListener(ev, pause, { passive: true });
  document.addEventListener("keydown", (e) => {
    if (e.target.matches("input, textarea, select")) return;
    if (["PageUp", "PageDown", "Home", "End", " "].includes(e.key)) pause();
  });
  return { follow, resume, pause, get paused() { return paused; } };
}
