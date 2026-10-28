/** Core-owned memory. No paths/scopes from a model; JSONL snapshots live only under memory/. */
import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fsyncSync, renameSync, unlinkSync, statSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const MEMORY_SCOPES = Object.freeze(["owner", "owner_public", "diary"]);
const scopeOK = (scope) => MEMORY_SCOPES.includes(scope);
const textOK = (text) => typeof text === "string" && text.trim().length > 0 && text.length <= 4000;
const tagsOK = (tags) => Array.isArray(tags) && tags.length <= 16 && tags.every((t) => typeof t === "string" && t.trim().length > 0 && t.length <= 64);

export class MemoryStore {
  constructor({ root, now = Date.now }) {
    this.dir = join(root, "memory"); this.now = now;
    this.#checkDir(); mkdirSync(this.dir, { recursive: true });
  }
  #checkDir() {
    if (existsSync(this.dir) && (lstatSync(this.dir).isSymbolicLink() || !lstatSync(this.dir).isDirectory())) throw new Error("memory_path_invalid");
  }
  #file(scope) {
    if (!scopeOK(scope)) throw new Error("memory_scope_invalid");
    this.#checkDir();
    const file = join(this.dir, scope + ".jsonl");
    if (existsSync(file) && lstatSync(file).isSymbolicLink()) throw new Error("memory_path_invalid");
    return file;
  }
  #read(scope) {
    const file = this.#file(scope);
    try {
      if (!existsSync(file)) return [];
      if (statSync(file).size > 64 * 1024 * 1024) throw new Error();
      const rows = readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
      const ids = new Set();
      for (const r of rows) {
        if (!r || r.scope !== scope || typeof r.id !== "string" || ids.has(r.id) || !textOK(r.text) || !tagsOK(r.tags) || !Number.isFinite(r.createdAt) || typeof r.sourceSession !== "string") throw new Error();
        ids.add(r.id);
      }
      return rows;
    } catch { throw new Error("memory_invalid"); }
  }
  #atomic(file, text) {
    this.#checkDir();
    const temp = file + "." + randomUUID() + ".tmp";
    let fd;
    try {
      fd = openSync(temp, "wx", 0o600); writeFileSync(fd, text, "utf8"); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temp, file);
    } catch { throw new Error("memory_save_failed"); }
    finally { if (fd !== undefined) closeSync(fd); try { unlinkSync(temp); } catch { /* only this call's temp */ } }
  }
  #write(scope, rows) { this.#atomic(this.#file(scope), rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")); }
  generation() {
    this.#checkDir();
    const file = join(this.dir, "context-generation.json");
    if (!existsSync(file)) return 0;
    try {
      if (lstatSync(file).isSymbolicLink()) throw new Error();
      const { generation } = JSON.parse(readFileSync(file, "utf8"));
      if (!Number.isSafeInteger(generation) || generation < 0) throw new Error();
      return generation;
    } catch { throw new Error("memory_invalid"); }
  }
  advanceGeneration() {
    const generation = this.generation() + 1;
    if (!Number.isSafeInteger(generation)) throw new Error("memory_invalid");
    // Commit this first: a crash after deletion must never resume a context containing it.
    this.#atomic(join(this.dir, "context-generation.json"), JSON.stringify({ generation }) + "\n");
    return generation;
  }
  list(scope = "owner", { offset = 0, limit = 100 } = {}) {
    if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 200) throw new Error("memory_args_invalid");
    const rows = this.#read(scope).sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id));
    return { items: rows.slice(offset, offset + limit), total: rows.length };
  }
  export() { return { version: 1, exportedAt: this.now(), items: MEMORY_SCOPES.flatMap((s) => this.#read(s)) }; }
  search(scopes, query) {
    if (!Array.isArray(scopes) || scopes.some((s) => !scopeOK(s)) || typeof query !== "string" || query.length > 200) throw new Error("memory_args_invalid");
    const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
    return [...new Set(scopes)].flatMap((s) => this.#read(s)).filter((r) => words.every((word) => (r.text + " " + r.tags.join(" ")).toLocaleLowerCase().includes(word)))
      .sort((a, b) => b.createdAt - a.createdAt || b.id.localeCompare(a.id)).slice(0, 8);
  }
  saveOwner(text, tags = [], sourceSession = "") {
    if (!textOK(text) || !tagsOK(tags) || typeof sourceSession !== "string" || sourceSession.length > 200) throw new Error("memory_args_invalid");
    const rows = this.#read("owner"), body = text.trim(), normalizedTags = [...new Set(tags.map((t) => t.trim()))];
    const same = rows.find((r) => r.text === body && JSON.stringify(r.tags) === JSON.stringify(normalizedTags));
    if (same) return same;
    if (rows.length >= 5000) throw new Error("memory_limit");
    const row = { id: randomUUID(), scope: "owner", text: body, tags: normalizedTags, createdAt: this.now(), sourceSession };
    rows.push(row); this.#write("owner", rows); return row;
  }
  has(scope, id) { return this.#read(scope).some((r) => r.id === id); }
  forget(scope, id) {
    if (typeof id !== "string" || id.length > 100) throw new Error("memory_args_invalid");
    const rows = this.#read(scope), kept = rows.filter((r) => r.id !== id);
    if (kept.length === rows.length) throw new Error("memory_not_found");
    this.#write(scope, kept);
  }
  clear(scope) { const count = this.#read(scope).length; this.#write(scope, []); return count; }
  publicText() { return this.#read("owner_public").map((r) => r.text).join("\n"); }
  setPublic(text) {
    if (typeof text !== "string" || text.length > 4000) throw new Error("memory_args_invalid");
    this.#read("owner_public"); // Do not overwrite corrupt public data.
    this.#write("owner_public", text.trim() ? [{ id: "public-profile", scope: "owner_public", text: text.trim(), tags: [], createdAt: this.now(), sourceSession: "ui" }] : []);
  }
}

export function validateMemoryTool(op, args) {
  const fields = { save: ["text", "tags"], search: ["query"], forget: ["id"] }[op];
  if (!fields || !args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !fields.includes(key))) throw new Error("memory_args_invalid");
  if (op === "save" && (!textOK(args.text) || args.tags !== undefined && !tagsOK(args.tags))) throw new Error("memory_args_invalid");
  if (op === "search" && (typeof args.query !== "string" || args.query.length > 200)) throw new Error("memory_args_invalid");
  if (op === "forget" && (typeof args.id !== "string" || args.id.length > 100)) throw new Error("memory_args_invalid");
}
