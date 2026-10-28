/** Generates 128-bit random codes into a new local directory; the server imports only hashes. */
import fs from "node:fs";
import { randomBytes, createHash } from "node:crypto";
import { resolve, join } from "node:path";
const count = Number(process.argv[2]), dir = process.argv[3] && resolve(process.argv[3]);
if (!Number.isSafeInteger(count) || count < 1 || count > 100 || !dir) throw new Error("用法：node scripts/generate-codes.mjs <1～100> <全新输出目录>");
fs.mkdirSync(dir, { recursive: false, mode: 0o700 });
const codes = Array.from({ length: count }, () => "FF-" + randomBytes(16).toString("hex").toUpperCase().match(/.{8}/g).join("-"));
const hashes = codes.map((c) => createHash("sha256").update(c.replaceAll("-", "")).digest("hex"));
fs.writeFileSync(join(dir, "delivery-codes.txt"), codes.join("\n") + "\n", { flag: "wx", mode: 0o600 });
fs.writeFileSync(join(dir, "import.json"), JSON.stringify({ code_hashes: hashes, edition: "v1", max_devices: 2 }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
console.log(`已生成 ${count} 个激活码：${dir}。明文只用于发货，勿入库或写日志。`);
