/** Server-side key generation. Output is ignored; stdout contains paths only, never private material. */
import fs from "node:fs";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { resolve, join } from "node:path";
const dir = resolve(process.argv[2] || ".local/keys");
fs.mkdirSync(dir, { recursive: false, mode: 0o700 }); // Never overwrite an existing key directory.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const write = (name, value) => fs.writeFileSync(join(dir, name), value + "\n", { flag: "wx", mode: 0o600 });
write("private.pkcs8.base64", privateKey.export({ type: "pkcs8", format: "der" }).toString("base64"));
write("public.spki.base64", publicKey.export({ type: "spki", format: "der" }).toString("base64"));
write("admin-token.txt", randomBytes(32).toString("hex")); write("rate-salt.txt", randomBytes(32).toString("hex"));
console.log("密钥已写入：" + dir + "。私钥仅用于服务端，不得放入客户端或版本库。");
