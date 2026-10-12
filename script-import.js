// Turns a script file (.txt, .md, .fountain, .docx, .pdf) into show.json script lines:
//   { speaker: "Hamlet", text: "To be..." }        a speech
//   { speaker: "Stage",  text: "Enter Ophelia." }  a stage direction (never spoken, the follower skips it)
//   { speaker: "",       text: "ACT I", heading: true }
// Every script is laid out differently, so this is a set of guesses: capital-letter names,
// "Name: text", "Name. text", bold names and italic directions in Word files, Enter/Exit lines,
// [brackets] and (parentheticals). The page shows a preview before anything is replaced.

const path = require("path");

// ---- 1. get paragraphs out of the file -------------------------------------------------
// Each paragraph: { text, italic (whole paragraph), bold (leading bold run, e.g. the name) }

async function extract(buffer, filename) {
  const ext = path.extname(filename || "").toLowerCase();
  if (ext === ".docx") return fromDocx(buffer);
  if (ext === ".pdf") return fromPdf(buffer);
  return fromText(buffer.toString("utf8"));
}

function fromText(text) {
  return text.replace(/\r\n?/g, "\n").split("\n").map((t) => ({ text: t.replace(/\s+/g, " ").trim() }));
}

async function fromPdf(buffer) {
  const { PDFParse } = require("pdf-parse");
  const parser = new PDFParse({ data: buffer });
  const result = await parser.getText();
  await parser.destroy();
  return fromText(result.text);
}

async function fromDocx(buffer) {
  const mammoth = require("mammoth");
  const { value: html } = await mammoth.convertToHtml({ buffer });
  const out = [];
  const plain = (h) => h.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/\s+/g, " ").trim();
  for (const m of html.matchAll(/<(p|h\d|li)[^>]*>([\s\S]*?)<\/\1>/g)) {
    const inner = m[2];
    for (const part of inner.split(/<br\s*\/?>/)) {
      const text = plain(part);
      if (!text) { out.push({ text: "" }); continue; }
      const bold = part.match(/^\s*<strong>([\s\S]*?)<\/strong>/);
      const italicWhole = /^\s*<em>[\s\S]*<\/em>\s*$/.test(part) && plain(part.replace(/<\/?em>/g, "")) === plain(part.match(/<em>([\s\S]*)<\/em>/)[1]);
      // inline italics inside a speech are directions: mark them with brackets so the parser strips them
      const marked = plain(part.replace(/<em>([\s\S]*?)<\/em>/g, (_, s) => (/^\s*[\[(]/.test(plain(s)) ? s : ` [${plain(s)}] `)));
      out.push({ text: italicWhole ? text : marked, italic: italicWhole, bold: bold ? plain(bold[1]) : null, heading: /^h\d$/.test(m[1]) });
    }
  }
  return out;
}

// ---- 2. decide what each paragraph is --------------------------------------------------

const HEADING = /^(act|scene|prologue|epilogue|interlude|intermission|interval|(first|second|third|fourth|fifth) act)\b/i;
const DIRECTION_START = /^(enter|exit|exeunt|re-enter|lights|blackout|curtain|end of|the end)\b/i;
// a line that starts like stage business written in the third person: "They go and sit...", "He sits down."
const DIRECTION_LIKE = /^(he|she|they|it|the|a|an|both|all|everyone|lights|sound|music|pause|silence|enter|exit|exeunt|re-enter)\b/i;
const PARENS = /[\[(]([^\])]*)[\])]/g;
const stripParens = (s) => s.replace(PARENS, " ").replace(/\s+/g, " ").trim();
const parenthetical = (s) => [...s.matchAll(PARENS)].map((m) => m[1].trim()).filter(Boolean);
const PAGE_NUMBER = /^[\s\-–—]*(page\s*)?\d+(\s*(of|\/)\s*\d+)?[\s\-–—]*$/i;
const DOT_LEADER = /\.{4,}\s*\d*\s*$/;            // "ACT ONE........... 12" in a table of contents
const FOOTNOTE = /^\d{1,2}\s+[A-Z][a-z]+.*\(/;      // "2 Fastidious (adj): ..."
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s-])\w/g, (c) => c.toUpperCase());
const isCaps = (s) => /[A-Z]/.test(s) && s === s.toUpperCase();
const mostlyCaps = (s) => { const L = s.replace(/[^a-z]/gi, ""); return L.length > 0 && L.replace(/[^A-Z]/g, "").length >= L.length * 0.7; };
const wordCount = (s) => s.split(/\s+/).filter(Boolean).length;
const cleanName = (n) => { n = n.trim().replace(/[.:]+$/, "").replace(/\s+/g, " "); return mostlyCaps(n) ? titleCase(n) : n; };
// footnote marks glued to words: "EPICERIE1", "fastidiously2"
const unmark = (t) => t.replace(/([A-Za-z]{3,})\d\b/g, "$1");

// "Name: words" (the colon wins, so "MR. BOEUF: Hello" is Mr. Boeuf), then "Name. words"
// Typos happen in typed scripts: "BERENGER:They're", "BERENGER :", "BERENGER; words". The
// space after the colon is optional when the name is in capitals or one we already know.
const COLON_LABEL = /^([A-Z][A-Za-z'’.\- ]{0,34}?)(\s*\([^)]*\))?\s*[:;][.,]?(\s*)(\S.*)$/; // "JEAN (to Berenger): words", "NAME:.Words" too
// "JEAN is very fastidiously dressed: suit, tie" is a direction, not a speaker called that: a name
// may contain small joining words (Voice of Old Man's Wife) but not ordinary lowercase words
const looksLikeName = (n) => !n.split(/\s+/).some((w) => /^[a-z]/.test(w) && !/^(of|the|and|a|de|du|la|le|von|van|der|'s|’s)$/.test(w));
const BARE_LABEL = /^([A-Z][A-Z'’.\-]+(?: [A-Z'’.\-]+){0,2})\s+([A-Z"“'(].*)$/;       // "BERENGER They're..." (colon forgotten)
const PERIOD_LABEL = /^([A-Z][A-Za-z'’\- ]{0,30}?)\.\s+(\S.*)$/;

function parse(paras) {
  // first pass: who gets named as a speaker, so "Viola. ..." is trusted only when it repeats
  const seen = new Map();
  const bump = (name) => { const k = cleanName(name).toLowerCase(); seen.set(k, (seen.get(k) || 0) + 1); };
  for (const p of paras) {
    if (p.bold) bump(p.bold);
    const alone = stripParens(p.text);
    if (alone && isCaps(alone) && wordCount(alone) <= 4 && alone.length <= 32 && !HEADING.test(alone)) bump(alone);
    const m = p.text.match(COLON_LABEL);
    if (m && wordCount(m[1]) <= 5 && looksLikeName(m[1]) && (m[3] || isCaps(m[1]))) bump(m[1]);
  }
  const known = (name) => (seen.get(cleanName(name).toLowerCase()) || 0) >= 2;
  const capsNames = [...seen.keys()].filter((k) => (seen.get(k) || 0) >= 3).map((k) => k.toUpperCase());
  const mentionsName = (t) => capsNames.some((n) => n.length >= 3 && t.includes(n));

  // A speaker label buried mid-line ("He takes his coat off. BERENGER :I can't...") starts a new
  // paragraph there, so the usual rules see it at the start of a line. Only names we already know,
  // written in capitals, after the end of a sentence, with the colon typos allowed.
  const labelNames = [...seen.keys()].filter((k) => (seen.get(k) || 0) >= 1 && k.length >= 3).map((k) => k.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).sort((a, b) => b.length - a.length);
  if (labelNames.length) {
    const MID = new RegExp("([.!?…)\\]\"”'’]\\s+)(" + labelNames.join("|") + ")(\\s*\\([^)]*\\))?\\s*[:;][.,]?\\s*(?=\\S)", "g");
    paras = paras.flatMap((p) => {
      const pieces = [];
      let last = 0;
      for (const m of p.text.matchAll(MID)) {
        const cut = m.index + m[1].length;
        if (cut <= last) continue;
        pieces.push({ ...p, text: p.text.slice(last, cut).trim(), bold: pieces.length ? null : p.bold });
        last = cut;
      }
      if (!pieces.length) return [p];
      pieces.push({ ...p, text: p.text.slice(last).trim(), bold: null });
      return pieces.filter((x) => x.text);
    });
  }

  const lines = [];
  let speaker = null;      // who is talking in the paragraph we are building
  let text = "";           // their words so far
  let sawSpeech = false;   // before the first speech everything is title page / front matter
  let prevRaw = "";        // the previous non-blank line, to spot a direction after a finished sentence
  let openDirection = false; // the last line pushed is a direction we may still be adding to (PDF line wraps)

  // A finished speech. Short (notes) like "(admiringly)" stay in the line, in brackets, and the pages
  // show them in italics. Stage business, "[Enter Jack]" or anything long, becomes its own Stage
  // line at the spot where it happened, and the speaker carries on after it.
  const flush = () => {
    if (speaker && text.trim()) {
      let chunk = "", last = 0;
      const say = () => { if (chunk.trim()) lines.push({ speaker, text: chunk.replace(/\s+/g, " ").trim() }); chunk = ""; };
      for (const m of text.matchAll(PARENS)) {
        const note = m[1].trim();
        const business = m[0][0] === "[" || DIRECTION_START.test(note) || (wordCount(note) > 8 && !/^to\b/i.test(note));
        chunk += text.slice(last, m.index);
        if (business) { say(); if (note) lines.push({ speaker: "Stage", text: note }); }
        else if (note) chunk += ` (${note}) `;
        last = m.index + m[0].length;
      }
      chunk += text.slice(last);
      say();
    }
    text = "";
  };
  const direction = (t) => { flush(); speaker = null; lines.push({ speaker: "Stage", text: t }); openDirection = true; };
  let afterHeading = false; // right after ACT/SCENE, unlabelled text is the scene description, not a speech
  let sawSpeechSinceHeading = false;
  const heading = (t) => { flush(); speaker = null; lines.push({ speaker: "", text: t, heading: true }); openDirection = false; afterHeading = true; sawSpeechSinceHeading = false; };
  const startSpeech = (name, words) => { flush(); speaker = cleanName(name); text = words; sawSpeech = true; sawSpeechSinceHeading = true; openDirection = false; afterHeading = false; };

  paras.forEach((p, i) => {
    const raw = unmark(p.text);
    if (!raw) { flush(); openDirection = false; prevRaw = ""; return; } // blank line ends a speech or a direction
    if (PAGE_NUMBER.test(raw) || DOT_LEADER.test(raw) || FOOTNOTE.test(raw)) return; // page numbers, contents, footnotes
    const wasPrev = prevRaw;
    prevRaw = raw;

    // headings: ACT I, SCENE 2: THE TOWN SQUARE, or any Word heading style
    if (p.heading || (HEADING.test(raw) && raw.length < 80 && !/^[a-z]/.test(raw))) { heading(raw); return; } // "...of the / first act." is a wrapped line, not a heading

    // directions: italic paragraph, [bracketed], (parenthetical), Enter/Exit...
    const wrapped = /^[\[(].*[\])]$/.test(raw) && stripParens(raw) === "";
    if (p.italic || wrapped || DIRECTION_START.test(raw)) { direction(raw.replace(/^[\[(]|[\])]$/g, "")); return; }

    // "NAME: words" / "Name. words" / bold name in Word
    let name = null, rest = null;
    if (p.bold && raw.startsWith(p.bold)) {
      name = p.bold;
      rest = raw.slice(p.bold.length).replace(/^[.:]\s*/, "");
    } else {
      const c = raw.match(COLON_LABEL);
      const b = raw.match(BARE_LABEL);
      if (c && wordCount(c[1]) <= 5 && looksLikeName(c[1]) && (c[3] || isCaps(c[1]) || known(c[1]))) { name = c[1]; rest = (c[2] || "") + " " + c[4]; } // up to 5 words: "VOICE OF OLD MAN'S WIFE"
      else if (b && known(b[1]) && !HEADING.test(b[1])) { name = b[1]; rest = b[2]; } // a name we know, colon missing
      else {
        const d = raw.match(PERIOD_LABEL);
        if (d && wordCount(d[1]) <= 3 && (known(d[1]) || isCaps(d[1])) && !/^(mr|mrs|ms|dr|st|prof)$/i.test(d[1])) { name = d[1]; rest = d[2]; } // "MR. BOEUF. DUDARD will..." is not Mr talking
      }
    }
    // "BOTARD: former schoolteacher; short..." in a cast list reads lowercase after the colon; dialogue starts with a capital
    if (name && afterHeading && !sawSpeechSinceHeading && /^[a-z]/.test(rest.trim())) { direction(raw); afterHeading = true; return; }
    if (name) { startSpeech(name, rest); return; }

    // a name alone on its line, in capitals (or one we have met before), with words right under it:
    // the next lines are theirs. A capitals line followed by a blank is a title, not a speaker.
    const alone = stripParens(raw);
    const next = paras[i + 1]?.text || "";
    const nextFull = next && !/^by\b/i.test(next) && !(!sawSpeech && isCaps(stripParens(next))); // "HAMLET / by Shakespeare" and cast lists are not speakers
    if (alone && nextFull && wordCount(alone) <= 4 && alone.length <= 32 && (isCaps(alone) || known(alone)) && !/[.!?,]$/.test(alone)) {
      startSpeech(alone, parenthetical(raw).map((n) => `(${n}) `).join("")); // "HAMLET (aside)" keeps the note with the words
      return;
    }

    // a direction in the middle of dialogue, with no blank line to announce it (PDFs do this):
    // it names characters in CAPITALS, or reads like stage business after a finished sentence
    const words = stripParens(raw);
    const sentenceDone = !wasPrev || /[.!?…"”'’)\]]$/.test(wasPrev);
    const looksLikeBusiness = sentenceDone && DIRECTION_LIKE.test(words) && /[.)\]]$/.test(raw) && !/[?!]/.test(raw) && wordCount(words) <= 30;
    if (words && sawSpeech && !openDirection && (mentionsName(words) && !/^[a-z]/.test(words) || looksLikeBusiness)) { direction(raw); return; }

    // ordinary words
    if (!words) { direction(raw.replace(/^[\[(]|[\])]$/g, "")); return; }
    if (openDirection) { lines[lines.length - 1].text += " " + raw; return; }  // the direction wraps onto this line
    if (!sawSpeech) { if (wordCount(words) <= 8) heading(raw); else direction(raw); return; } // title page vs opening description
    if (speaker) { text += " " + raw; return; }           // the speech goes on
    // nobody is talking: a short paragraph is a direction, a long one is probably the last speaker continuing
    if (afterHeading || wordCount(words) <= 14 || !lines.length) direction(words);
    else { speaker = [...lines].reverse().find((l) => l.speaker && l.speaker !== "Stage")?.speaker || "Stage"; text = raw; }
  });
  flush();
  return mergeNames(splitLong(lines));
}

// Scanned scripts misspell names ("BERlNGER", "Bereger", "Papillon."): fold a rare name into a
// frequent one that is one edit away.
function mergeNames(lines) {
  const count = {};
  for (const l of lines) if (l.speaker && l.speaker !== "Stage" && !l.heading) count[l.speaker] = (count[l.speaker] || 0) + 1;
  const names = Object.keys(count).sort((a, b) => count[b] - count[a]);
  const fix = {};
  for (const rare of names) {
    if (count[rare] >= 10) continue;
    const common = names.find((n) => count[n] >= 10 && n !== rare && editDistance(n.toLowerCase(), rare.toLowerCase()) <= 1);
    if (common) fix[rare] = common;
  }
  for (const l of lines) if (fix[l.speaker]) l.speaker = fix[l.speaker];
  return lines;
}
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}

// Long speeches become several lines (cut at sentence ends), so cues can be placed inside them
function splitLong(lines, max = 260) {
  const out = [];
  for (const l of lines) {
    if (l.speaker === "Stage" || l.heading || l.text.length <= max) { out.push(l); continue; }
    let chunk = "";
    for (const s of l.text.match(/[^.!?]+[.!?]+["')\]]?\s*|[^.!?]+$/g) || [l.text]) {
      if (chunk && (chunk + s).length > max) { out.push({ ...l, text: chunk.trim() }); chunk = ""; }
      chunk += s;
    }
    if (chunk.trim()) out.push({ ...l, text: chunk.trim() });
  }
  return out;
}

function stats(lines) {
  const speakers = {};
  let directions = 0, headings = 0;
  for (const l of lines) {
    if (l.heading) headings++;
    else if (l.speaker === "Stage") directions++;
    else speakers[l.speaker] = (speakers[l.speaker] || 0) + 1;
  }
  return { lines: lines.length, speakers, directions, headings };
}

async function importScript(buffer, filename) {
  const lines = parse(await extract(buffer, filename));
  return { lines, stats: stats(lines) };
}

module.exports = { importScript, parse, extract };
