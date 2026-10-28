(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.fatfishPersonaActions = factory();
})(typeof window === "undefined" ? globalThis : window, function () {
  "use strict";
  function create(api, { query = (s) => document.querySelector(s), view, deleted = async () => {}, draft = async () => {},
    setTimer = setTimeout, clearTimer = clearTimeout, now = Date.now, activeElement = () => document.activeElement } = {}) {
    const el = {};
    for (const [name, id] of Object.entries({ id: "persona-edit-id", remove: "btn-persona-delete", group: "persona-delete-confirm", yes: "btn-persona-delete-yes", no: "btn-persona-delete-no", save: "btn-persona-save", apply: "btn-persona-apply", msg: "persona-editor-msg", list: "persona-msg", text: "persona-import-text", go: "btn-import-go", importMsg: "persona-import-msg" })) el[name] = query("#" + id);
    let epoch = 0, timer = null, armed = null, deleting = false, importing = false, disposed = false;
    const id = () => typeof el.id.value === "string" ? el.id.value.trim() : "";
    function message(node, text, kind = "") { node.textContent = text; node.className = "hint selectable" + (kind ? " " + kind : ""); }
    function controls() { el.remove.disabled = deleting || importing; el.yes.disabled = deleting; el.no.disabled = deleting; el.save.disabled = deleting; el.apply.disabled = deleting; el.go.disabled = importing || deleting; el.text.disabled = importing; }
    function reset(focus = false) {
      epoch++; if (timer !== null) clearTimer(timer); timer = null; armed = null;
      el.group.hidden = true; el.remove.hidden = false; message(el.importMsg, ""); controls();
      if (focus && !disposed && view() === "editor") el.remove.focus?.();
    }
    function askDelete() {
      if (disposed || deleting || importing || armed || view() !== "editor" || !id()) return;
      armed = { id: id(), epoch, deadline: now() + 5000 }; el.remove.hidden = true; el.group.hidden = false;
      message(el.msg, ""); el.yes.focus?.();
      timer = setTimer(() => { let focus = false; try { focus = el.group.contains(activeElement()); } catch {} reset(focus); }, 5000);
    }
    async function confirmDelete() {
      if (disposed || deleting || importing || !armed) return;
      if (view() !== "editor" || id() !== armed.id || armed.epoch !== epoch || now() >= armed.deadline) { reset(); return; }
      const target = armed.id, seq = epoch; let focus = false; if (timer !== null) clearTimer(timer); timer = null; deleting = true; controls(); message(el.msg, "正在删除…");
      try {
        const r = await api.personaDelete(target, true); if (disposed) return;
        const current = seq === epoch && view() === "editor" && id() === target;
        if (r?.ok !== true) {
          if (current) { reset(); focus = true; message(el.msg, r?.error === "not_found" ? "该人格已不存在，请返回列表重新读取。" : "未能完成删除，请返回列表核对后再试。", "err"); }
          return;
        }
        if (current) reset();
        message(el.list, r.restoredBuiltin === true ? "已删除，已恢复内置人格。" : r.switched === true ? "已删除，当前人格已切换。请核对列表中的当前标记。" : "已删除。", "ok");
        try { await deleted({ current }); }
        catch { if (!disposed) message(el.list, "已删除，但列表暂时未刷新。请重新读取。", "err"); }
      } catch {
        if (!disposed && seq === epoch && view() === "editor" && id() === target) { reset(); focus = true; message(el.msg, "删除结果暂时无法确认，请返回列表核对。", "err"); }
      } finally { deleting = false; if (!disposed) { controls(); if (focus && view() === "editor" && id() === target) el.remove.focus?.(); } }
    }
    async function importDraft() {
      if (disposed || importing || deleting || view() !== "import") return;
      const raw = typeof el.text.value === "string" ? el.text.value : "";
      if (!raw.trim()) { message(el.importMsg, "请先粘贴素材文本。", "err"); el.text.focus?.(); return; }
      const seq = epoch; importing = true; controls(); message(el.importMsg, "正在整理本机草稿…");
      try {
        const r = await api.personaImportText(raw); if (disposed || seq !== epoch || view() !== "import") return;
        if (el.text.value !== raw) { message(el.importMsg, "素材已变化，请重新整理，不会覆盖新输入。", "err"); return; }
        if (r?.ok !== true || !r.draft || typeof r.draft.title !== "string" || typeof r.draft.summary !== "string" || typeof r.draft.body !== "string") { message(el.importMsg, "导入失败，素材已保留，请稍后重试。", "err"); return; }
        await draft(r.draft);
        if (!disposed && el.text.value === raw) el.text.value = "";
      } catch { if (!disposed && seq === epoch && view() === "import") message(el.importMsg, "导入失败，素材已保留，请稍后重试。", "err"); }
      finally { importing = false; if (!disposed) controls(); }
    }
    const cancel = () => { if (!deleting) reset(true); };
    const escape = (event) => { if (event.key === "Escape" && !deleting) { event.preventDefault(); event.stopPropagation(); reset(true); } };
    el.yes.addEventListener("click", confirmDelete); el.no.addEventListener("click", cancel); el.group.addEventListener("keydown", escape);
    el.group.hidden = true; controls();
    return { askDelete, confirmDelete, importDraft, reset, dispose() { disposed = true; reset(); el.yes.removeEventListener("click", confirmDelete); el.no.removeEventListener("click", cancel); el.group.removeEventListener("keydown", escape); } };
  }
  return { create };
});
