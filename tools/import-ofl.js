// Turn an Open Fixture Library export (https://open-fixture-library.org, fixture data is CC0) into
// public/fixtures.json: { Manufacturer: { Model: { Mode: { ch, i?, r?, g?, b?, w?, pan?, tilt? } } } }.
// Usage: node tools/import-ofl.js <folder with the unzipped export>
const fs = require("fs");
const path = require("path");

const dir = process.argv[2];
if (!dir) { console.log("usage: node tools/import-ofl.js <unzipped OFL export folder>"); process.exit(1); }
const makers = JSON.parse(fs.readFileSync(path.join(dir, "manufacturers.json"), "utf8"));
const out = {};
let fixtures = 0, modes = 0;

// Which of our slots a channel fills, from its OFL capability
function slotOf(ch) {
  const cap = ch.capability || (ch.capabilities || [])[0] || {};
  const caps = ch.capabilities || [cap];
  if (caps.some((c) => c.type === "Intensity")) return "i";
  const col = caps.find((c) => c.type === "ColorIntensity");
  if (col) return { Red: "r", Green: "g", Blue: "b", White: "w", "Warm White": "w", "Cold White": "w" }[col.color] || null;
  if (caps.some((c) => c.type === "Pan")) return "pan";
  if (caps.some((c) => c.type === "Tilt")) return "tilt";
  return null;
}

// Expand a mode's channel list: names, nulls (unused), and matrix inserts (one set per pixel)
function expand(fx, list) {
  const names = [];
  for (const item of list) {
    if (item === null || typeof item === "string") { names.push(item); continue; }
    if (item.insert !== "matrixChannels") continue;
    const m = fx.matrix || {};
    let keys = m.pixelKeys ? m.pixelKeys.flat(2).filter(Boolean) : [];
    if (!keys.length && m.pixelCount) { const [x, y, z] = m.pixelCount; keys = []; for (let i = 1; i <= x * y * z; i++) keys.push(String(i)); }
    const pixels = Array.isArray(item.repeatFor) ? item.repeatFor.filter((k) => keys.includes(k) || !keys.length) : keys;
    const tpl = item.templateChannels || [];
    if (item.channelOrder === "perChannel") for (const t of tpl) for (const k of pixels) names.push(t === null ? null : t.replace(/\$pixelKey/g, k));
    else for (const k of pixels) for (const t of tpl) names.push(t === null ? null : t.replace(/\$pixelKey/g, k));
  }
  return names;
}

for (const key of Object.keys(makers)) {
  if (key.startsWith("$")) continue;
  const folder = path.join(dir, key);
  if (!fs.existsSync(folder)) continue;
  const makerName = makers[key].name;
  for (const file of fs.readdirSync(folder)) {
    if (!file.endsWith(".json")) continue;
    let fx;
    try { fx = JSON.parse(fs.readFileSync(path.join(folder, file), "utf8")); } catch { continue; }
    const avail = fx.availableChannels || {};
    const tpl = fx.templateChannels || {};
    const lookup = (name) => {
      if (avail[name]) return avail[name];
      for (const [tn, ch] of Object.entries(tpl)) { // template channel "$pixelKey Red" matched by shape
        const re = new RegExp("^" + tn.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\$pixelKey/g, ".+") + "$");
        if (re.test(name)) return ch;
      }
      return null;
    };
    const modesOut = {};
    for (const mode of fx.modes || []) {
      const names = expand(fx, mode.channels || []);
      const spec = { ch: names.length };
      names.forEach((n, idx) => {
        if (!n) return;
        const ch = lookup(n);
        if (!ch) return;
        const slot = slotOf(ch);
        // A channel we don't drive (shutter, speed, control...) with a non-zero default: the server holds it there,
        // so a mover's shutter is open without anyone touching it. OFL gives the default in the channel's own resolution.
        if (!slot && ch.defaultValue !== undefined) {
          const v = ch.defaultValue;
          const bits = ch.dmxValueResolution ? Number(String(ch.dmxValueResolution).replace("bit", "")) : 8 * (1 + (ch.fineChannelAliases || []).length);
          const v8 = typeof v === "string" ? Math.round(parseFloat(v) * 2.55) : Math.round((v / (2 ** bits - 1)) * 255);
          if (v8 > 0) (spec.set ||= {})[idx] = Math.min(255, v8);
        }
        if (slot && !(slot in spec)) spec[slot] = idx; // first of each kind wins (first pixel on a bar)
        else if (slot === null && !("b" in spec)) { // Indigo stands in for blue on fixtures that have no blue (ETC ColorSource etc.)
          const col = (ch.capabilities || [ch.capability || {}]).find((c) => c.type === "ColorIntensity");
          if (col && col.color === "Indigo") spec.b = idx;
        }
      });
      if (!spec.ch) continue;
      modesOut[mode.name || mode.shortName || `${spec.ch} channel`] = spec;
      modes++;
    }
    if (!Object.keys(modesOut).length) continue;
    (out[makerName] ||= {})[fx.name] = modesOut;
    fixtures++;
  }
}
fs.writeFileSync(path.join(__dirname, "..", "public", "fixtures.json"), JSON.stringify(out));
console.log(`wrote public/fixtures.json: ${Object.keys(out).length} manufacturers, ${fixtures} fixtures, ${modes} modes`);
