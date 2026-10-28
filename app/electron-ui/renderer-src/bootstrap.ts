// 只在静态组件完成挂载之后启动既有控制器，避免重复请求和 DOM 所有权竞争。
let startup: Promise<void> | undefined

export function startControllers(): Promise<void> {
  if (startup) return startup
  startup = (async () => {
    if (!window.fatfish) throw new Error("local_bridge_unavailable")
    for (const marker of document.querySelectorAll<HTMLScriptElement>("script[data-controller]")) {
      const source = marker.getAttribute("src")
      if (!source || !/^[a-z][a-z-]+\.js$/.test(source)) throw new Error("controller_source_invalid")
      await new Promise<void>((resolve, reject) => {
        const script = document.createElement("script")
        script.src = source
        script.onload = () => resolve()
        script.onerror = () => reject(new Error("controller_load_failed"))
        document.body.appendChild(script)
      })
    }
  })().catch(() => {
    // 启动失败保持激活锁，不把半挂载界面交给用户操作。
    document.body.classList.add("activation-locked")
    document.querySelector("#activation-mask")?.classList.remove("hidden")
    document.querySelector("#splash")?.classList.add("hidden")
    const message = document.querySelector("#activation-msg")
    if (message) message.textContent = "界面未能完整启动，请关闭后重新打开。"
  })
  return startup
}

declare global { interface Window { fatfish?: unknown } }
