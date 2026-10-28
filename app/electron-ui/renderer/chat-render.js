/** Small, DOM-only formatting subset. Never insert model HTML or load remote resources. */
(function () {
  function inline(parent, text) {
    const pattern = /`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
    let last = 0, match;
    while ((match = pattern.exec(text))) {
      parent.appendChild(document.createTextNode(text.slice(last, match.index)));
      if (match[1]) {
        const code = document.createElement("code"); code.textContent = match[1]; parent.appendChild(code);
      } else {
        const link = document.createElement("button"); link.type = "button"; link.className = "chat-link";
        link.textContent = match[2]; link.title = "复制链接";
        link.addEventListener("click", async () => {
          try { const r = await window.fatfish.copyText(matchUrl); if (r?.ok) link.title = "已复制链接"; }
          catch { link.title = "复制失败，请重试"; }
        });
        const matchUrl = match[3]; parent.appendChild(link);
      }
      last = pattern.lastIndex;
    }
    parent.appendChild(document.createTextNode(text.slice(last)));
  }
  function render(parent, text) {
    let code = null, list = null;
    for (const line of String(text).split("\n")) {
      if (/^\s*```/.test(line)) {
        if (code) code = null;
        else { const pre = document.createElement("pre"); code = document.createElement("code"); pre.appendChild(code); parent.appendChild(pre); }
        list = null; continue;
      }
      if (code) { code.appendChild(document.createTextNode(line + "\n")); continue; }
      const item = line.match(/^\s*(?:[-*]|\d+\.)\s+(.+)$/);
      if (item) {
        if (!list) { list = document.createElement("ul"); parent.appendChild(list); }
        const li = document.createElement("li"); inline(li, item[1]); list.appendChild(li); continue;
      }
      list = null;
      const p = document.createElement("p");
      if (/^#{1,6}\s/.test(line)) { const strong = document.createElement("strong"); inline(strong, line.replace(/^#{1,6}\s+/, "")); p.appendChild(strong); }
      else inline(p, line);
      if (!line) p.appendChild(document.createElement("br"));
      parent.appendChild(p);
    }
  }
  window.fatfishChatRenderer = { render };
})();
