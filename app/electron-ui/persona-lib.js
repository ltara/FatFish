/**
 * 肥鱼人设库 — 本机持久化（AppData/personas.json）
 * 应用后同步 active body → persona.txt，供出站桥读取。
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const BUILTIN_ID = "builtin-dafeiyu";
const BUILTIN = {
  id: BUILTIN_ID,
  title: "大肥鱼风",
  summary: "嘴碎靠谱、爱抬杠但不翻车",
  body:
    "你是「大肥鱼」，主人的私人 QQ 伴侣。说话像损友：短句、带点抬杠和吐槽，但关键时刻靠谱温柔。" +
    "用简体中文回复；尽量控制在 1～3 句，除非主人明确要求展开。" +
    "不要自称官方 AI / 产品客服；不要提模型厂商或上游框架名。" +
    "遇到违法违规、危险自伤或泄露隐私的请求，明确拒绝并劝阻，语气仍保持熟人感。" +
    "偶尔用「哼」「行吧」「这就离谱」这类口头禅，但不要每句都用、不要玩梗过度。",
};

const SAMPLE_PERSONAS = [
  BUILTIN,
  {
    id: "builtin-wenrou",
    title: "温柔倾听",
    summary: "慢半拍、先接住情绪再给建议",
    body:
      "你是主人的私人 QQ 伴侣，语气温柔、耐心。先确认对方情绪，再简短给建议。" +
      "用简体中文；默认 1～3 句。不要提模型厂商或上游框架名。" +
      "遇到危险自伤、违法或隐私泄露请求，明确拒绝并劝阻。",
  },
  {
    id: "builtin-liluo",
    title: "利落助理",
    summary: "短句直给、少废话、条理清楚",
    body:
      "你是主人的私人 QQ 助理。回答短、准、可执行；先结论后要点。" +
      "用简体中文；默认不超过 3 句。不要提模型厂商或上游框架名。" +
      "遇到危险自伤、违法或隐私泄露请求，明确拒绝并劝阻。",
  },
];

function personasJsonPath(root) {
  return path.join(root, "personas.json");
}

function legacyPersonaPath(root) {
  return path.join(root, "persona.txt");
}

function personaRevPath(root) {
  return path.join(root, "runtime", "persona_rev");
}

function nowIso() {
  return new Date().toISOString();
}

function makeId() {
  return "p-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function summarize(body, title) {
  const t = String(body || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return title || "（空人设）";
  return t.length > 36 ? t.slice(0, 36) + "…" : t;
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = String(raw.id || "").trim();
  const title = String(raw.title || "").trim() || "未命名人设";
  const body = String(raw.body || "");
  const summary = String(raw.summary || "").trim() || summarize(body, title);
  const updatedAt = String(raw.updatedAt || nowIso());
  const lastAppliedAt = String(raw.lastAppliedAt || "");
  if (!id) return null;
  return { id, title, summary, body, updatedAt, lastAppliedAt };
}

function builtinStore() {
  const items = SAMPLE_PERSONAS.map((x) => ({ ...x, updatedAt: nowIso(), lastAppliedAt: "" }));
  return { activePersonaId: items[0].id, items };
}

function migrateFromLegacy(root) {
  const store = builtinStore();
  try {
    const p = legacyPersonaPath(root);
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, "utf8");
      if (text && text.trim() && text.trim() !== BUILTIN.body.trim()) {
        const id = makeId();
        const title = "我的人设";
        const item = {
          id,
          title,
          summary: summarize(text, title),
          body: text,
          updatedAt: nowIso(),
        };
        store.items.push(item);
        store.activePersonaId = id;
      }
    }
  } catch {
    /* ignore */
  }
  return store;
}

function readStore(root) {
  const jp = personasJsonPath(root);
  try {
    if (fs.existsSync(jp)) {
      const j = JSON.parse(fs.readFileSync(jp, "utf8"));
      const items = Array.isArray(j.items)
        ? j.items.map(normalizeItem).filter(Boolean)
        : [];
      if (items.length === 0) {
        const s = builtinStore();
        writeStore(root, s);
        return s;
      }
      // 补齐示例人设（不覆盖用户已有同 id）
      let changed = false;
      for (const sample of SAMPLE_PERSONAS) {
        if (!items.some((x) => x.id === sample.id)) {
          items.push({ ...sample, updatedAt: nowIso(), lastAppliedAt: "" });
          changed = true;
        }
      }
      let active = String(j.activePersonaId || "");
      if (!items.some((x) => x.id === active)) active = items[0].id;
      const store = { activePersonaId: active, items };
      if (changed) writeStore(root, store);
      return store;
    }
  } catch {
    /* fallthrough */
  }
  const migrated = migrateFromLegacy(root);
  writeStore(root, migrated);
  return migrated;
}

function writeStore(root, store) {
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(root, "runtime"), { recursive: true });
  const clean = {
    activePersonaId: store.activePersonaId,
    items: store.items.map(normalizeItem).filter(Boolean),
  };
  fs.writeFileSync(personasJsonPath(root), JSON.stringify(clean, null, 2) + "\n", "utf8");
  syncActiveFiles(root, clean);
  return clean;
}

function getActiveItem(store) {
  return store.items.find((x) => x.id === store.activePersonaId) || store.items[0] || null;
}

function syncActiveFiles(root, store) {
  const active = getActiveItem(store);
  const body = active && active.body ? active.body : BUILTIN.body;
  fs.writeFileSync(legacyPersonaPath(root), body.endsWith("\n") ? body : body + "\n", "utf8");
  const rev = String(Date.now());
  fs.writeFileSync(personaRevPath(root), rev + "\n", "utf8");
  return { body, rev, active };
}

function listPersonas(root) {
  const store = readStore(root);
  const active = getActiveItem(store);
  return {
    ok: true,
    activePersonaId: store.activePersonaId,
    activeTitle: active ? active.title : "",
    items: store.items.map((it) => ({
      id: it.id,
      title: it.title,
      summary: it.summary,
      updatedAt: it.updatedAt,
      lastAppliedAt: it.lastAppliedAt || "",
      bodyPreview: it.id === store.activePersonaId
        ? summarize(it.body, it.title)
        : "",
      active: it.id === store.activePersonaId,
    })),
  };
}

function getPersona(root, id) {
  const store = readStore(root);
  const it = store.items.find((x) => x.id === id);
  if (!it) return { ok: false, error: "not_found" };
  return {
    ok: true,
    item: { ...it, active: it.id === store.activePersonaId },
    activePersonaId: store.activePersonaId,
  };
}

function createPersona(root, payload) {
  const store = readStore(root);
  const title = String((payload && payload.title) || "").trim() || "未命名人设";
  const body = String((payload && payload.body) || "");
  const summary =
    String((payload && payload.summary) || "").trim() || summarize(body, title);
  const item = {
    id: makeId(),
    title,
    summary,
    body,
    updatedAt: nowIso(),
  };
  store.items.unshift(item);
  writeStore(root, store);
  return { ok: true, item, activePersonaId: store.activePersonaId };
}

function updatePersona(root, id, payload) {
  const store = readStore(root);
  const idx = store.items.findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false, error: "not_found" };
  const cur = store.items[idx];
  const title =
    payload && payload.title != null
      ? String(payload.title).trim() || cur.title
      : cur.title;
  const body = payload && payload.body != null ? String(payload.body) : cur.body;
  const summary =
    payload && payload.summary != null && String(payload.summary).trim()
      ? String(payload.summary).trim()
      : summarize(body, title);
  store.items[idx] = {
    ...cur,
    title,
    summary,
    body,
    updatedAt: nowIso(),
  };
  writeStore(root, store);
  return {
    ok: true,
    item: { ...store.items[idx], active: store.items[idx].id === store.activePersonaId },
    activePersonaId: store.activePersonaId,
  };
}

function deletePersona(root, id, confirmed) {
  if (!confirmed) return { ok: false, error: "confirm_required" };
  const store = readStore(root);
  const idx = store.items.findIndex((x) => x.id === id);
  if (idx < 0) return { ok: false, error: "not_found" };
  const wasActive = store.activePersonaId === id;
  store.items.splice(idx, 1);
  if (store.items.length === 0) {
    const fresh = builtinStore();
    writeStore(root, fresh);
    return {
      ok: true,
      restoredBuiltin: true,
      activePersonaId: fresh.activePersonaId,
      message: "人设已清空，已恢复内置「大肥鱼风」。",
    };
  }
  if (wasActive) {
    store.activePersonaId = store.items[0].id;
  }
  writeStore(root, store);
  return {
    ok: true,
    restoredBuiltin: false,
    switched: wasActive,
    activePersonaId: store.activePersonaId,
    message: wasActive
      ? "已删除使用中的人设，并切换到「" +
        (getActiveItem(store) || {}).title +
        "」。"
      : "已删除。",
  };
}

function applyPersona(root, id) {
  const store = readStore(root);
  const it = store.items.find((x) => x.id === id);
  if (!it) return { ok: false, error: "not_found" };
  store.activePersonaId = id;
  const now = nowIso();
  store.items = store.items.map((x) =>
    x.id === id ? { ...x, lastAppliedAt: now, updatedAt: now } : x
  );
  writeStore(root, store);
  return {
    ok: true,
    activePersonaId: id,
    activeTitle: it.title,
    message: "已应用「" + it.title + "」。下一句私聊起按新人设回复（对话记忆已重置）。",
  };
}

function importFromText(text) {
  const body = String(text || "");
  const lines = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let title = "导入的人设";
  if (lines.length) {
    const first = lines[0].replace(/^#+\s*/, "").slice(0, 24);
    if (first) title = first;
  }
  return {
    ok: true,
    draft: {
      title,
      summary: summarize(body, title),
      body,
    },
  };
}

function ensurePersonaLib(root) {
  return readStore(root);
}

function getActiveBody(root) {
  const store = readStore(root);
  const active = getActiveItem(store);
  return active && active.body ? active.body : BUILTIN.body;
}

function getActiveMeta(root) {
  const store = readStore(root);
  const active = getActiveItem(store);
  return {
    activePersonaId: store.activePersonaId,
    activeTitle: active ? active.title : "",
    summary: active ? active.summary : "",
  };
}

module.exports = {
  BUILTIN_ID,
  BUILTIN,
  listPersonas,
  getPersona,
  createPersona,
  updatePersona,
  deletePersona,
  applyPersona,
  importFromText,
  ensurePersonaLib,
  getActiveBody,
  getActiveMeta,
  syncActiveFiles,
  readStore,
};
