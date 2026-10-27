// netcheck.js - what is on the lighting network? Run it while the Mac is on the lighting network:
//   node tools/netcheck.js
// For about 10 seconds it: lists this Mac's network cards, asks every Art-Net node to identify itself
// (ArtPoll; most sACN nodes answer too and say whether each port is set to sACN or Art-Net), and
// listens for every sACN source on universes 1-8 with its priority. The report is printed and saved
// next to this file as netcheck-result.txt, so it can be read after switching networks back.
const os = require("os");
const fs = require("fs");
const path = require("path");
const dgram = require("dgram");
const { execSync } = require("child_process");
const { Receiver } = require("sacn");

const lines = [];
const log = (...a) => { const s = a.join(" "); console.log(s); lines.push(s); };
log("netcheck " + new Date().toLocaleString());

const cards = [];
for (const [name, list] of Object.entries(os.networkInterfaces()))
  for (const n of list)
    if (n.family === "IPv4" && !n.internal) {
      const ip = (s) => s.split(".").reduce((n, o) => n * 256 + Number(o), 0);
      const b = ip(n.address) | ~ip(n.netmask);
      cards.push({ name, address: n.address, netmask: n.netmask, broadcast: [24, 16, 8, 0].map((s) => (b >>> s) & 255).join(".") });
    }
log("Network cards: " + (cards.map((c) => `${c.name} ${c.address}/${c.netmask}`).join(", ") || "none"));

// ---- Art-Net: ArtPoll out, ArtPollReply in
const nodes = new Map();
const raw = new Map(); // full ArtPollReply packets, hex, saved with the report
const art = dgram.createSocket({ type: "udp4", reuseAddr: true });
art.on("error", (e) => log("Art-Net socket error: " + e.message));
art.on("message", (m, rinfo) => {
  if (m.length < 207 || m.toString("latin1", 0, 7) !== "Art-Net") return;
  if (m.readUInt16LE(8) !== 0x2100) return; // ArtPollReply
  const str = (a, n) => m.toString("latin1", a, a + n).replace(/\0.*$/, "").trim();
  const net = m[18], sub = m[19], ports = m.readUInt16BE(172);
  const out = [];
  for (let i = 0; i < Math.min(ports, 4); i++) {
    const type = m[174 + i], good = m[182 + i], sw = m[190 + i];
    if (!(type & 0x80)) continue; // not an output port
    const u = (net << 8) | (sub << 4) | (sw & 15); // Art-Net numbering, from 0
    out.push(`port ${i + 1}: ${good & 1 ? "sACN" : "Art-Net"} universe ${u} (Art-Net numbering, 0-based; as an sACN universe that is ${u + 1})`
      + (good & 0x80 ? ", outputting DMX" : ", output idle") + (good & 0x08 ? ", merging two sources" : ""));
  }
  const status2 = m.length > 212 ? m[212] : 0;
  const mac = m.length > 206 ? [...m.subarray(201, 207)].map((b) => b.toString(16).padStart(2, "0")).join(":") : "?";
  raw.set(rinfo.address, m.toString("hex"));
  nodes.set(rinfo.address, [
    `${rinfo.address}  "${str(26, 18)}" / "${str(44, 64)}"  firmware ${m.readUInt16BE(16)}  ${ports} port(s)`,
    `    ${out.join("; ") || "no output ports"}`,
    `    can switch to sACN: ${status2 & 0x10 ? "yes" : "no / not reported"}   report: ${str(108, 64) || "-"}`,
    `    oem code 0x${m.readUInt16BE(20).toString(16).padStart(4, "0")}  esta code 0x${m.length > 200 ? m.readUInt16LE(199).toString(16).padStart(4, "0") : "?"}  mac ${mac}  status1 0x${m[23].toString(16).padStart(2, "0")}`,
  ].join("\n"));
});
art.bind(6454, () => {
  art.setBroadcast(true);
  const poll = Buffer.concat([Buffer.from("Art-Net\0"), Buffer.from([0x00, 0x20, 0, 14, 0x06, 0])]);
  const targets = new Set(["255.255.255.255", "2.255.255.255", "10.255.255.255", ...cards.map((c) => c.broadcast)]);
  for (let i = 0; i < 3; i++) setTimeout(() => { for (const t of targets) art.send(poll, 6454, t, () => {}); }, i * 1500);
});

// ---- sACN: who is sending, on which universes, at what priority
const sources = new Map();
const rx = new Receiver({ universes: [1, 2, 3, 4, 5, 6, 7, 8], reuseAddr: true });
rx.on("error", (e) => log("sACN receive error: " + e.message));
rx.on("packet", (p) => {
  const k = `${p.sourceAddress} u${p.universe}`;
  const lit = Object.values(p.payload).filter((v) => v > 0).length;
  sources.set(k, `${k}  "${p.sourceName}"  priority ${p.priority}  ${lit} channels above 0`);
});

const http = require("http");
const fetchPage = (ip, p = "/") => new Promise((done) => {
  const req = http.get({ host: ip, port: 80, path: p, timeout: 3000 }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c)).on("end", () => done({ status: res.statusCode, body }));
  });
  req.on("timeout", () => { req.destroy(); done(null); });
  req.on("error", () => done(null));
});

setTimeout(async () => {
  log("");
  log("Art-Net / sACN nodes that answered ArtPoll:");
  if (nodes.size) for (const n of nodes.values()) log("  " + n); else log("  none");
  for (const ip of nodes.keys()) {
    const page = await fetchPage(ip);
    if (!page) { log("    web page at http://" + ip + "/: no answer"); continue; }
    const file = path.join(__dirname, "node-" + ip.replace(/\./g, "-") + ".html");
    fs.writeFileSync(file, page.body);
    const title = (page.body.match(/<title>([^<]*)<\/title>/i) || [])[1] || "";
    const text = page.body.replace(/<script[\s\S]*?<\/script>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    log("    web page at http://" + ip + "/: HTTP " + page.status + ", title \"" + title.trim() + "\", saved as " + path.basename(file));
    if (text) log("    page text: " + text.slice(0, 300));
    // Strand nodes fill their status page from /status.xml: <port status=".." mode=".." universe=".."/> per port
    const st = await fetchPage(ip, "/status.xml");
    if (st && st.status === 200) {
      fs.writeFileSync(path.join(__dirname, "node-" + ip.replace(/\./g, "-") + "-status.xml"), st.body);
      const ports = [...st.body.matchAll(/<port\b([^>]*)>/gi)];
      if (ports.length) ports.forEach((m, i) => log("    status.xml port " + (i + 1) + ": " + m[1].replace(/\s+/g, " ").trim()));
      else log("    status.xml: " + st.body.replace(/\s+/g, " ").trim().slice(0, 300));
    } else log("    status.xml: no answer");
  }
  log("");
  log("sACN sources heard on universes 1-8:");
  if (sources.size) for (const s of [...sources.values()].sort()) log("  " + s); else log("  none");
  log("");
  log("Devices this Mac has seen on its networks (ARP):");
  try {
    log(execSync("arp -an", { encoding: "utf8" }).split("\n").filter((l) => l && !l.includes("incomplete") && !/\(2(2[4-9]|3\d)\./.test(l)).slice(0, 40).map((l) => "  " + l).join("\n"));
  } catch (e) { log("  (arp failed: " + e.message + ")"); }
  const file = path.join(__dirname, "netcheck-result.txt");
  for (const [ip, hex] of raw) lines.push("", "raw ArtPollReply from " + ip + ": " + hex);
  fs.writeFileSync(file, lines.join("\n") + "\n");
  console.log("\nSaved to " + file);
  art.close(); rx.close(); process.exit(0);
}, 10000);
