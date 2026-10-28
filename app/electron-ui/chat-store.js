/** Local conversation display records; engine history remains separate and private. */
"use strict";
const fs = require("node:fs");
const { join, dirname } = require("node:path");
const { randomUUID } = require("node:crypto");
const validId = (id) => typeof id === "string" && /^local-[A-Za-z0-9_-]{1,100}$/.test(id);
function read(file, fallback) {
  try { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : fallback; }
  catch { throw new Error("chat_store_invalid"); }
}
function write(file, data) {
  const temp = file + "." + randomUUID() + ".tmp";
  try {
    fs.mkdirSync(dirname(file), { recursive: true });
    fs.writeFileSync(temp, JSON.stringify(data) + "\n", { mode: 0o600 });
    fs.renameSync(temp, file);
  } catch { throw new Error("chat_save_failed"); }
  finally { try { fs.unlinkSync(temp); } catch { /* only this write's temp */ } }
}
function current(root) {
  const index = read(join(root, "chat/index.json"), { sessionId: "local-main" });
  if (!validId(index?.sessionId)) throw new Error("chat_store_invalid");
  return index.sessionId;
}
function get(root) {
  const sessionId = current(root);
  const messages = read(join(root, "chat", sessionId + ".json"), []);
  if (!Array.isArray(messages) || messages.some((m) => !m || !["user", "assistant", "status", "approval"].includes(m.role) || typeof m.text !== "string")) throw new Error("chat_store_invalid");
  return { sessionId, messages };
}
function append(root, sessionId, message) {
  if (!validId(sessionId)) throw new Error("invalid_session");
  const file = join(root, "chat", sessionId + ".json");
  const messages = read(file, []);
  if (!Array.isArray(messages)) throw new Error("chat_store_invalid");
  messages.push({ ...message, id: randomUUID(), at: Date.now() });
  write(file, messages.slice(-400));
}
function create(root) {
  const sessionId = "local-" + randomUUID();
  write(join(root, "chat", sessionId + ".json"), []);
  write(join(root, "chat/index.json"), { sessionId });
  return get(root);
}
function stats(root) {
  const date = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Shanghai" });
  let saved;
  try { saved = read(join(root, "chat/stats.json"), null); } catch { /* counts do not block a conversation */ }
  return saved?.date === date ? saved : { date, inbound: 0, replies: 0, lastReplyAt: 0 };
}
function bump(root, field) {
  if (!["inbound", "replies"].includes(field)) throw new Error("invalid_counter");
  const value = stats(root); value[field] = (Number(value[field]) || 0) + 1;
  if (field === "replies") value.lastReplyAt = Date.now();
  write(join(root, "chat/stats.json"), value);
}
module.exports = { get, append, create, stats, bump };
