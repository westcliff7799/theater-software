// Finds sound desks on the local network, the way MixPad's "Choose Unit" screen does.
// Every host on our subnets is asked a few quick questions in parallel:
//   Allen & Heath  : TCP 51325 (MIDI over TCP) open. SQ desks also open 51326 (MixPad), dLive opens 51321.
//   Behringer/Midas: UDP 10023, OSC "/xinfo" -> replies with ip, name, model, firmware (X32, M32, ...)
//   Behringer Wing : UDP 2222, "WING?" -> "WING,ip,name,model,serial,firmware"
//   Yamaha         : TCP 49280, "devinfo productname" -> OK devinfo productname "TF5"
// Only the SQ has a driver in this app; the others are listed so you can see them.
const net = require("net");
const dgram = require("dgram");
const os = require("os");

function hostsToScan() {
  const hosts = new Set((process.env.SCAN_EXTRA || "").split(",").filter(Boolean)); // for testing with fake desks
  const skipped = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list) {
      if (n.family !== "IPv4" || n.internal) continue;
      const ip = n.address.split(".").map(Number);
      const mask = n.netmask.split(".").map(Number);
      let bits = mask.reduce((sum, m) => sum + m.toString(2).split("1").length - 1, 0);
      let count = 2 ** (32 - bits);
      if (count <= 2) continue; // a point-to-point link, nothing to find
      if (count > 1024) { // a huge network: only sweep the 254 addresses nearest to us
        skipped.push(n.address + "/" + bits);
        bits = 24; count = 256; mask.fill(255); mask[3] = 0;
      }
      const base = ip.map((b, i) => b & mask[i]);
      const start = base[0] * 2 ** 24 + base[1] * 2 ** 16 + base[2] * 256 + base[3];
      for (let k = 1; k < count - 1; k++) {
        const v = start + k;
        const host = [v >>> 24, (v >>> 16) & 255, (v >>> 8) & 255, v & 255].join(".");
        if (host !== n.address) hosts.add(host);
      }
    }
  }
  return { hosts: [...hosts], skipped };
}

function tcpOpen(ip, port, ms = 500) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port });
    const done = (ok) => { s.destroy(); resolve(ok); };
    s.setTimeout(ms, () => done(false));
    s.on("connect", () => done(true));
    s.on("error", () => done(false));
  });
}
function tcpAsk(ip, port, text, ms = 700) {
  return new Promise((resolve) => {
    const s = net.connect({ host: ip, port });
    let reply = "";
    const done = () => { s.destroy(); resolve(reply || null); };
    s.setTimeout(ms, done);
    s.on("connect", () => s.write(text));
    s.on("data", (b) => { reply += b.toString(); if (reply.includes("\n")) done(); });
    s.on("error", done);
  });
}
function udpAsk(ip, port, payload, ms = 500) {
  return new Promise((resolve) => {
    const sock = dgram.createSocket("udp4");
    const done = (b) => { clearTimeout(t); sock.close(); resolve(b || null); };
    const t = setTimeout(done, ms);
    sock.on("message", (b) => done(b));
    sock.on("error", () => done());
    sock.send(payload, port, ip, (err) => { if (err) done(); });
  });
}

// OSC: a null-padded address, then a type tag string, then the arguments. We only need strings.
function osc(address) {
  const pad = (str) => Buffer.concat([Buffer.from(str + "\0"), Buffer.alloc((4 - ((str.length + 1) % 4)) % 4)]);
  return Buffer.concat([pad(address), pad(",")]);
}
function oscStrings(buf) {
  const out = [];
  let pos = 0;
  while (pos < buf.length) {
    const end = buf.indexOf(0, pos);
    if (end < 0) break;
    out.push(buf.toString("utf8", pos, end));
    pos = end + 1 + ((4 - ((end - pos + 1) % 4)) % 4);
  }
  return out; // [address, typetags, arg1, arg2, ...]
}

async function probe(ip) {
  const [ah, x32, wing, yamaha] = await Promise.all([
    tcpOpen(ip, 51325),
    udpAsk(ip, 10023, osc("/xinfo")),
    udpAsk(ip, 2222, Buffer.from("WING?")),
    tcpAsk(ip, 49280, "devinfo productname\n"),
  ]);
  if (ah) {
    const [sq, dlive] = await Promise.all([tcpOpen(ip, 51326), tcpOpen(ip, 51321)]);
    const model = sq ? "SQ series (SQ-5, 6 or 7)" : dlive ? "dLive" : "desk with MIDI over TCP";
    return { ip, brand: "Allen & Heath", model, driver: sq || !dlive ? "sq" : null };
  }
  if (x32) {
    const [, , , name, model] = oscStrings(x32); // /xinfo, ",ssss", ip, name, model, firmware
    return { ip, brand: model && model.startsWith("M") ? "Midas" : "Behringer", model: (model || "X32") + (name ? " “" + name + "”" : ""), driver: null };
  }
  if (wing) {
    const parts = wing.toString().split(",");
    return { ip, brand: "Behringer", model: (parts[3] || "Wing") + (parts[2] ? " “" + parts[2] + "”" : ""), driver: null };
  }
  if (yamaha) {
    const m = yamaha.match(/"([^"]+)"/);
    return { ip, brand: "Yamaha", model: m ? m[1] : "desk", driver: null };
  }
  return null;
}

// Scan everything, calling onFound(desk) as each one turns up. Resolves with { found, skipped }.
async function discoverDesks(onFound = () => {}, concurrency = 48) {
  const { hosts, skipped } = hostsToScan();
  const found = [];
  let next = 0;
  async function worker() {
    while (next < hosts.length) {
      const desk = await probe(hosts[next++]);
      if (desk) { found.push(desk); onFound(desk); }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, hosts.length) }, worker));
  return { found, skipped, scanned: hosts.length };
}

module.exports = { discoverDesks, hostsToScan, probe };
