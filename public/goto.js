// "Jump to act / scene…" menu, shared by the Script and Follow pages.
//   const goto = installGoto(select, onPick)   onPick(lineIndex, label)
//   goto.fill(script)                           rebuild from the script's heading lines
// Acts are groups, scenes the entries under them. An act with no scenes is an entry of its own.
// "ACT TWO SCENE TWO: CHEZ JEAN" is filed under Act Two. Title-page headings before the first act are left out.
function installGoto(sel, onPick) {
  const isAct = (t) => /^(act|prologue|epilogue)\b/i.test(t);
  const nice = (t) => t.toLowerCase().replace(/(^|[\s:])\w/g, (c) => c.toUpperCase());
  sel.onchange = () => {
    if (sel.value === "") return;
    onPick(Number(sel.value), sel.selectedOptions[0].textContent);
  };
  function fill(script) {
    sel.innerHTML = '<option value="">Jump to act / scene…</option>';
    let group = null, actLine = -1;
    const closeAct = () => { if (group && !group.children.length) { sel.removeChild(group); sel.appendChild(new Option(group.label, actLine)); } };
    const openAct = (label, i) => { closeAct(); group = document.createElement("optgroup"); group.label = nice(label); sel.appendChild(group); actLine = i; };
    script.forEach((l, i) => {
      if (!l.heading) return;
      const both = l.text.match(/^(act\s+\S+)\s+(scene\b.*)$/i);
      if (both) {
        if (!group || group.label.toLowerCase() !== nice(both[1]).toLowerCase()) openAct(both[1], i);
        group.appendChild(new Option(nice(both[2]), i));
      } else if (isAct(l.text)) openAct(l.text, i);
      else if (group) group.appendChild(new Option(nice(l.text.replace(new RegExp("^" + group.label + "\\s*", "i"), "")), i));
    });
    closeAct();
    sel.disabled = sel.options.length <= 1;
  }
  return { fill };
}
