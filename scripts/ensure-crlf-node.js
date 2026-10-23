#!/usr/bin/env node
/** Force CRLF on *.bat / *.cmd under vendor/napcat (and optional args). */
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : [path.join(root, "vendor", "napcat")];

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, out);
    else if (/\.(bat|cmd)$/i.test(ent.name)) out.push(p);
  }
  return out;
}

let fixed = 0;
for (const t of targets) {
  for (const file of walk(path.resolve(t))) {
    const data = fs.readFileSync(file);
    const norm = Buffer.from(
      data.toString("binary").replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n/g, "\r\n"),
      "binary"
    );
    if (!data.equals(norm)) {
      fs.writeFileSync(file, norm);
      console.log("[crlf] fixed", file);
      fixed++;
    }
  }
}
console.log("[crlf] done, fixed=" + fixed);
