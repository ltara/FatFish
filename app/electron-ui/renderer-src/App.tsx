import { useEffect } from "react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Badge } from "@/components/ui/badge"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import { startControllers } from "./bootstrap"

// 呈现壳只挂载一次；既有控制器拥有业务状态和空的动态内容区域。
export function App() {
  useEffect(() => { void startControllers() }, [])
  return <>

  <div id="shell-root">
    <header className="titlebar" id="titlebar">
      <div className="titlebar-brand">
        <span className="titlebar-dot" aria-hidden="true"></span>
        <span>肥鱼</span>
      </div>
      <div className="titlebar-controls">
        <Button variant="ghost" size="default" type="button" className="titlebar-btn" id="btn-win-min" title="最小化" aria-label="最小化">
          <svg viewBox="0 0 10 10"><rect y="5" width="10" height="1"/></svg>
        </Button>
        <Button variant="ghost" size="default" type="button" className="titlebar-btn" id="btn-win-max" title="最大化" aria-label="最大化">
          <svg viewBox="0 0 10 10"><rect x="1" y="1" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1"/></svg>
        </Button>
        <Button variant="ghost" size="default" type="button" className="titlebar-btn close" id="btn-win-close" title="关闭" aria-label="关闭">
          <svg viewBox="0 0 10 10"><path d="M1 1 L9 9 M9 1 L1 9" stroke="currentColor" strokeWidth="1.2"/></svg>
        </Button>
      </div>
    </header>

    <div id="splash" className="splash" aria-hidden="false">
      <div className="splash-inner">
        <span className="splash-mark" aria-hidden="true"></span>
        <p className="splash-title">肥鱼</p>
        <p className="splash-sub">Windows 本地客户端</p>
      </div>
    </div>

    <div id="activation-mask" className="onboard" role="dialog" aria-modal="true" aria-labelledby="activation-title">
      <div className="onboard-card">
        <p className="hint">第 1 步，共 4 步 · 激活</p><h1 id="activation-title">激活肥鱼</h1>
        <p>仅首次激活需要联网。</p>
        <label className="field"><span className="field-label">激活码</span><Input id="activation-code" className="activation-code" type="text" maxLength={44} autoComplete="off" autoCapitalize="characters" spellCheck="false" placeholder="FF 1234 ABCD …" /></label>
        <div className="btn-row activation-actions"><Button variant="outline" size="default" id="btn-activation-recheck" type="button" className="btn-secondary">重新检查</Button><Button variant="default" size="default" id="btn-activate" type="button" className="btn-primary" disabled>激活</Button></div>
        <p id="activation-msg" className="hint selectable" role="status" aria-live="polite"></p>
        <p className="hint">仅发送激活码和设备标识哈希；遇到问题请联系售后。</p>
      </div>
    </div>

    {/* S2 风险勾选 */}
    <div id="risk-mask" className="onboard hidden" role="dialog" aria-modal="true">
      <div className="onboard-card">
        <p className="hint">第 2 步，共 4 步 · 基础告知</p><h1>风险告知</h1>
        <p>对话会发送给所选模型服务商，费用由你的密钥承担。请保管好密钥，不要输入不愿外发的信息。</p>
        <p>电脑操作需逐次确认，请核对内容。配置与记录保存在本机。</p>
        <label className="check-row">
          <input type="checkbox" id="risk-ok" />
          <span>我已阅读并自愿承担上述风险</span>
        </label>
        <Button variant="default" size="default" type="button" id="risk-go" className="btn-primary" disabled style={{"width": "100%"}}>继续</Button>
        <p id="risk-save-msg" className="hint err" role="status" aria-live="polite"></p>
      </div>
    </div>

    {/* S3 扫码 + S4 手机验证 */}
    <div id="login-flow" className="onboard hidden" role="dialog" aria-modal="true">
      <div className="onboard-card" id="login-card">
        <div className="login-brand">
          <span className="login-mark" aria-hidden="true"></span>
          <h1>登录 QQ</h1>
        </div>
        <p id="login-lead" className="lead">请使用手机 QQ 扫描下方二维码</p>

        <div id="login-waiting-svc" className="login-state hidden">
          <div className="login-spinner" aria-hidden="true"></div>
          <p id="login-waiting-msg" className="hint">正在启动本机服务…</p>
        </div>

        <div id="login-qr-wrap" className="login-qr-wrap hidden">
          <div className="qr-frame">
            <img id="login-qr-img" alt="登录二维码" width="260" height="260" />
            <div id="login-qr-overlay" className="qr-overlay hidden">
              <p id="login-qr-overlay-text"></p>
            </div>
          </div>
          <p id="login-phase-msg" className="login-phase-msg">请使用手机 QQ 扫描二维码</p>
          <div className="btn-row login-actions">
            <Button variant="outline" size="default" type="button" id="btn-refresh-qr" className="btn-secondary">刷新二维码</Button>
          </div>
        </div>

        <div id="login-verify" className="login-state verify-card hidden">
          <p className="verify-title">请在手机上完成验证</p>
          <p className="hint">在手机 QQ 完成验证后，等待登录结果。</p>
        </div>

        <div id="login-success" className="login-state success-card hidden">
          <p className="success-title">登录成功</p>
          <p id="login-success-who" className="hint"></p>
          <p id="login-success-next" className="hint"></p>
          <div className="btn-row login-actions">
            <Button variant="default" size="default" type="button" id="btn-login-continue" className="btn-primary">继续</Button>
          </div>
        </div>

        <div id="login-error" className="login-state error-card hidden">
          <p id="login-error-msg" className="hint err">登录遇到问题</p>
          <div className="btn-row login-actions">
            <Button variant="default" size="default" type="button" id="btn-retry-login" className="btn-primary">重试</Button>
          </div>
        </div>
        <div className="btn-row"><Button variant="ghost" size="default" type="button" id="btn-login-back" className="btn-ghost">返回软件</Button></div>
      </div>
    </div>

    {/* 首次设置：基础本机四步，QQ 为独立可选分支。 */}
    <div id="first-setup" className="onboard hidden" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
      <div className="onboard-card">
        <p id="onboarding-step" className="hint">正在读取本机设置…</p><h1 id="onboarding-title">首次设置</h1>
        <div id="onboarding-model" className="hidden"><p className="hint">先保存，再测试连接。</p><div id="onboarding-model-slot"></div></div>
        <div id="onboarding-local" className="hidden"><p>到对话页发送「你好」，收到回复后完成设置。</p><p className="hint">试聊会产生模型费用；电脑操作逐次确认。中断后先查记录，不要重复提交。</p></div>
        <div id="onboarding-qq-risk" className="hidden"><p>请使用专用小号。非官方接入可能导致风控或封号，风险由你承担。</p><p>绑定后可远程聊天，不能操作电脑；模型费用由你的密钥承担。</p><label className="check-row"><input type="checkbox" id="onboarding-qq-risk-ok" /><span>我已了解，使用专用小号接入 QQ</span></label></div>
        <div id="onboarding-qq-login" className="hidden"><p>用专用小号扫码，并在手机确认。</p></div>
        <div id="onboarding-qq-pair" className="hidden"><p>用你的 QQ 私聊肥鱼小号，发送 6 位配对码。</p><p className="hint">配对码过期后可重新生成。</p></div>
        <div id="onboarding-qq-trial" className="hidden"><p>用已绑定账号发一句话，收到回复后完成设置。</p><p className="hint">试聊会产生模型费用，不会自动发送或重试。</p><p id="onboarding-qq-paused" className="hint hidden">自动回复已暂停。恢复后会回复消息和到期提醒。</p></div>
        <div id="onboarding-done" className="hidden"><p id="onboarding-done-hint">本机设置完成。QQ 可稍后接入。</p></div>
        <p id="onboarding-msg" className="hint selectable" role="status" aria-live="polite"></p>
        <div className="btn-row activation-actions"><div className="btn-row"><Button variant="ghost" size="default" type="button" id="btn-onboarding-back" className="btn-ghost hidden">上一步</Button><Button variant="ghost" size="default" type="button" id="btn-onboarding-later" className="btn-ghost">稍后继续</Button></div><Button variant="default" size="default" type="button" id="btn-onboarding-next" className="btn-primary" disabled>下一步</Button></div>
        <div className="btn-row"><Button variant="outline" size="default" type="button" id="btn-onboarding-qq" className="btn-secondary hidden">接入 QQ（可选）</Button><Button variant="outline" size="default" type="button" id="btn-onboarding-read" className="btn-secondary">重新读取</Button></div>
      </div>
    </div>
    {/* 主壳：本机使用与平台独立导航 */}
    <div className="app" id="main-app" style={{"visibility": "hidden"}}>
      <aside className="sidebar">
        <div className="sidebar-identity"><div className="brand"><img className="brand-mark" src="../assets/icon.png" width={32} height={32} alt="" aria-hidden="true" draggable={false} /><span className="brand-text">肥鱼</span></div><p className="brand-sub">住在你电脑里的伙伴</p></div>
        <nav aria-label="主导航">
          <Button variant="ghost" size="default" type="button" className="nav-btn active" data-page="home" aria-current="page"><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m3 10 9-7 9 7v10H3Z"/><path d="M9 20v-7h6v7"/></svg><span>首页</span></Button>
          <Button variant="ghost" size="default" type="button" className="nav-btn" data-page="chat"><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v12H9l-5 4Z"/><path d="M8 8h8M8 12h5"/></svg><span>对话</span></Button>
          <Button variant="ghost" size="default" type="button" className="nav-btn" data-page="persona"><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/></svg><span>人格</span></Button>
          <Button variant="ghost" size="default" type="button" className="nav-btn" data-page="memory"><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5c-3-2-6-2-9-1v15c3-1 6-1 9 1 3-2 6-2 9-1V4c-3-1-6-1-9 1Zm0 0v15"/></svg><span>记忆</span></Button>
          <Button variant="ghost" size="default" type="button" className="nav-btn" data-page="channels"><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="12" r="3"/><circle cx="18" cy="5" r="3"/><circle cx="18" cy="19" r="3"/><path d="m9 10 6-4M9 14l6 4"/></svg><span>平台</span></Button>
          <Button variant="ghost" size="default" type="button" className="nav-btn" data-page="settings"><svg className="nav-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7h8m6 0h4M3 17h4m6 0h8"/><circle cx="14" cy="7" r="3"/><circle cx="10" cy="17" r="3"/></svg><span>设置</span></Button>
        </nav>
        <div className="sidebar-note"><span>在平台中接入远程陪伴</span></div>
      </aside>

      <main className="content">
        <section id="page-home" className="page active">
          <header className="page-head">
            <div className="mod-head"><h2>首页</h2><Button variant="default" size="default" type="button" id="btn-home-chat" className="btn-primary">和它聊聊</Button></div>
          </header>

          <div className="home-overview">
          {/* 真实伙伴状态，不改变本机与远程的独立边界。 */}
          <div className="home-object-row" id="home-object-row">
            <Button variant="ghost" size="default" type="button" className="home-object" id="chip-qq" data-action="login" title="点击管理登录">
              <span className="dot" id="chip-qq-dot"></span>
              <span className="home-object-text" id="chip-qq-text" aria-live="polite">检测中…</span>
            </Button>
            <div className="home-primary">
              <Button variant="outline" size="default" type="button" id="btn-pause-toggle" className="btn-secondary btn-pause">暂停自动回复</Button>
              <input type="checkbox" id="outbound-paused" className="hidden" tabIndex={-1} aria-hidden="true" />
            </div>
          </div>

          {/* 仪器行：单行点+短词（回复 / Key） */}
          <div className="status-instrument" id="status-bar" aria-live="polite">
            <Button variant="ghost" size="default" type="button" className="status-meter" id="chip-reply" data-action="pause" title="点击暂停/恢复">
              <span className="dot"></span><strong id="chip-reply-text">检测中…</strong>
            </Button>
            <span className="status-sep" aria-hidden="true">·</span>
            <Button variant="ghost" size="default" type="button" className="status-meter" id="chip-key" data-action="settings" title="点击前往设置">
              <span className="dot"></span><span className="chip-label">密钥</span> <strong id="chip-key-text">检测中…</strong>
            </Button>
          </div>

          <p id="status-capsule" className="status-capsule selectable hidden" aria-live="polite" hidden>检测中…</p>
          <p id="st-hint" className="hint selectable home-hint"></p>
          <div className="home-links btn-row">
            <Button variant="outline" size="default" type="button" id="btn-relogin" className="btn-secondary">重新登录 QQ</Button>
          </div>
          </div>

          <div className="home-stack" id="home-stack">
            <div id="home-todo" className="home-mod hidden">
              <div className="mod-head"><h3>需要你处理</h3></div>
              <div id="home-todo-list" className="todo-list"></div>
            </div>

            <div id="home-today" className="home-mod">
              <div className="mod-head"><h3>今日互动</h3></div>
              <div id="home-today-empty" className="today-empty hint">今天还没有互动</div>
              <div id="home-today-grid" className="today-card hidden">
                <div className="today-grid">
                  <div className="today-cell">
                    <span className="today-label" id="today-count-label">今天私聊</span>
                    <div className="today-value" id="today-dm">—</div>
                  </div>
                  <div className="today-cell">
                    <span className="today-label" id="today-reply-label">上次自动回</span>
                    <div className="today-value" id="today-last-reply">—</div>
                  </div>
                  <div className="today-cell">
                    <span className="today-label" id="today-channel-label">远程回复</span>
                    <div className="today-value" id="today-paused">—</div>
                  </div>
                </div>
              </div>
            </div>

            <div id="home-persona-card-wrap" className="home-mod">
              <div className="mod-head"><h3>当前人格</h3></div>
              <div className="persona-card" id="home-persona-card">
                <div className="persona-main">
                  <div className="persona-name" id="home-persona-card-name">—</div>
                  <p className="persona-one" id="home-persona-card-one">还没有人格</p>
                </div>
                <Button variant="outline" size="default" type="button" className="btn-row-ghost" id="btn-home-change-persona">换人格</Button>
              </div>
            </div>

          </div>

          <details className="diag-fold" id="diag-fold">
            <summary className="diag-summary-link">详细状态</summary>
            <div className="card status-card diag-card">
              <ul className="status-list">
                <li><span className="label">本机服务</span><Badge variant="secondary" id="st-svc" className="badge selectable">检测中…</Badge></li>
                <li><span className="label">登录服务</span><Badge variant="secondary" id="st-login" className="badge selectable">检测中…</Badge></li>
                <li><span className="label">回复服务</span><Badge variant="secondary" id="st-reply" className="badge selectable">检测中…</Badge></li>
                <li><span className="label">自动回复</span><Badge variant="secondary" id="st-outbound" className="badge selectable">检测中…</Badge></li>
                <li><span className="label">模型密钥</span><Badge variant="secondary" id="st-key" className="badge selectable">检测中…</Badge></li>
                <li><span className="label">QQ 账号</span><Badge variant="secondary" id="st-qq" className="badge selectable">未登录</Badge></li>
                <li><span className="label">当前人格</span><Badge variant="secondary" id="st-persona" className="badge info selectable">检测中…</Badge></li>
              </ul>
              <div className="btn-row" style={{"marginTop": "12px"}}>
                <Button variant="outline" size="default" type="button" id="btn-refresh" className="btn-secondary">刷新状态</Button>
                <Button variant="outline" size="default" type="button" id="btn-restart" className="btn-secondary">重新启动本机服务</Button>
              </div>
            </div>
          </details>
        </section>

        <section id="page-chat" className="page">
          <p id="chat-onboarding-hint" className="hint hidden"><span id="chat-onboarding-text">第 4 步，共 4 步 · 发一句话完成试聊。</span><Button variant="outline" size="sm" type="button" id="btn-chat-onboarding" className="btn-secondary btn-sm">继续设置</Button></p>
          <header className="page-head">
            <div className="mod-head"><h2>对话</h2><Button variant="outline" size="sm" type="button" id="btn-chat-new" className="btn-secondary btn-sm">新开对话</Button></div>
            <p className="page-sub">电脑操作需逐次确认。</p>
          </header>
          <div className="chat-panel">
            <div id="chat-messages" className="chat-messages" role="log" aria-live="polite"></div>
            <div className="chat-composer">
              <label className="field"><Textarea id="chat-input" className="border-0 shadow-none focus-visible:ring-0" rows={1} maxLength={16000} aria-label="对它说点什么" aria-describedby="chat-input-hint" placeholder="想聊什么，或者想让它做什么…"></Textarea></label>
              <div className="chat-send-row"><span id="chat-input-hint" className="hint">Enter 发送，Shift + Enter 换行</span><Button variant="default" size="sm" type="button" id="btn-chat-send" className="btn-primary btn-sm">发送</Button></div>
              <p id="chat-error" className="hint err selectable" role="alert"></p>
              <p id="chat-reminder-error" className="hint err selectable" role="status"></p>
            </div>
          </div>
        </section>

        <section id="page-persona" className="page">
          <header className="page-head persona-head">
            <div>
              <h2>人格</h2>
              <p className="page-sub">本机与 QQ 共用，应用后下一句生效。</p>
            </div>
            <Button variant="ghost" size="default" type="button" className="persona-current-chip" id="persona-locate-btn" title="在列表中定位当前人格">
              当前：<strong id="persona-current-name">—</strong>
            </Button>
          </header>

          <div id="persona-list-view">
            <div className="persona-toolbar">
              <Input type="search" id="persona-list-search" className="persona-search" aria-label="搜索人格库" placeholder="搜索人格库…" autoComplete="off" />
              <div className="btn-row">
                <Button variant="default" size="default" type="button" id="btn-persona-new" className="btn-primary">新建</Button>
                <Button variant="outline" size="default" type="button" id="btn-persona-import" className="btn-secondary">从素材导入</Button>
              </div>
            </div>
            <div id="persona-empty" className="persona-empty hidden">
              <p className="persona-empty-title">还没有人格</p>
              <p className="hint">可新建或从素材导入。</p>
            </div>
            <div id="persona-list" className="persona-list"></div>
            <p id="persona-msg" className="hint selectable"></p>
            <div className="public-profile-block">
              <label className="field">
                <span className="field-label">关于你（公开资料）</span>
                <span id="public-profile-warning" className="hint">这些内容可对外公开，请勿填写隐私。</span>
                <Textarea id="public-profile-text" rows={3} maxLength={4000} aria-describedby="public-profile-warning public-profile-reset" disabled></Textarea>
              </label>
              <p id="public-profile-reset" className="hint">保存后开启新会话，旧聊天记录保留。</p>
              <div className="btn-row">
                <Button variant="outline" size="default" type="button" id="btn-public-save" className="btn-secondary" disabled>保存公开资料</Button>
                <Button variant="outline" size="default" type="button" id="btn-public-retry" className="btn-secondary hidden">重新读取</Button>
              </div>
              <p id="public-profile-msg" className="hint selectable" role="status" aria-live="polite"></p>
            </div>
          </div>

          <div id="persona-editor" className="card form-card persona-editor hidden">
            <div className="persona-editor-head">
              <Button variant="ghost" size="default" type="button" id="btn-persona-back" className="btn-ghost">← 返回列表</Button>
              <span id="persona-editor-title" className="persona-editor-title">编辑人格</span>
            </div>
            <input type="hidden" id="persona-edit-id" defaultValue="" />
            <label className="field">
              <span className="field-label">名称</span>
              <Input type="text" id="persona-edit-title" maxLength={40} placeholder="例如：大肥鱼风" />
            </label>
            <label className="field">
              <span className="field-label">一句话</span>
              <Input type="text" id="persona-edit-summary" maxLength={60} placeholder="简介，留空自动截取" />
            </label>
            <label className="field">
              <span className="field-label">正文</span>
              <Textarea id="persona-edit-body" rows={10} placeholder="描述它的性格、说话方式与边界…"></Textarea>
            </label>
            <div className="btn-row">
              <Button variant="default" size="default" type="button" id="btn-persona-save" className="btn-primary">保存</Button>
              <Button variant="outline" size="default" type="button" id="btn-persona-apply" className="btn-secondary">应用</Button>
              <Button variant="outline" size="default" type="button" id="btn-persona-delete" className="btn-secondary danger-text">删除</Button>
              <span id="persona-delete-confirm" className="owner-actions" hidden>
                <span className="owner-confirm">确定删除这个人格？</span>
                <Button variant="outline" size="sm" type="button" id="btn-persona-delete-yes" className="btn-secondary btn-sm danger-text">删除</Button>
                <Button variant="ghost" size="sm" type="button" id="btn-persona-delete-no" className="btn-ghost btn-sm">取消</Button>
              </span>
            </div>
            <p className="hint">删除当前人格会自动切换；空库会恢复内置人格。</p>
            <p id="persona-editor-msg" className="hint selectable" role="status" aria-live="polite"></p>
          </div>

          <div id="persona-import-panel" className="card form-card hidden">
            <div className="persona-editor-head">
              <Button variant="ghost" size="default" type="button" id="btn-import-cancel" className="btn-ghost">← 取消</Button>
              <span className="persona-editor-title">从素材导入</span>
            </div>
            <label className="field">
              <span className="field-label">粘贴素材文本</span>
              <Textarea id="persona-import-text" rows={12} placeholder="粘贴人格素材…"></Textarea>
            </label>
            <div className="btn-row">
              <Button variant="default" size="default" type="button" id="btn-import-go" className="btn-primary">进入编辑草稿</Button>
            </div>
            <p id="persona-import-msg" className="hint selectable" role="status" aria-live="polite"></p>
            <p className="hint">仅生成本地草稿，不会自动保存或应用。</p>
          </div>
        </section>


        <section id="page-memory" className="page">
          <header className="page-head">
            <div className="mod-head"><h2>记忆</h2><Button variant="outline" size="sm" type="button" id="btn-memory-refresh" className="btn-secondary btn-sm">刷新</Button></div>
          </header>
          <div className="memory-scopes" role="group" aria-label="记忆范围">
            <Button variant="outline" size="sm" type="button" className="btn-secondary btn-sm" data-memory-scope="owner" aria-pressed="true">关于你</Button>
            <Button variant="outline" size="sm" type="button" className="btn-secondary btn-sm" data-memory-scope="owner_public" aria-pressed="false">公开资料</Button>
            <Button variant="outline" size="sm" type="button" className="btn-secondary btn-sm" data-memory-scope="diary" aria-pressed="false">它的日记</Button>
          </div>
          <p id="memory-scope-hint" className="hint"></p>
          <div className="memory-list-head"><span id="memory-count" className="hint"></span></div>
          <p id="memory-msg" className="hint selectable" role="status" aria-live="polite"></p>
          <div id="memory-list" aria-busy="false"></div>
          <div className="memory-paging btn-row">
            <Button variant="outline" size="sm" type="button" id="btn-memory-prev" className="btn-secondary btn-sm" disabled>上一页</Button><span id="memory-page" className="hint"></span><Button variant="outline" size="sm" type="button" id="btn-memory-next" className="btn-secondary btn-sm" disabled>下一页</Button>
          </div>
          <div className="memory-footer btn-row">
            <Button variant="outline" size="default" type="button" id="btn-memory-export" className="btn-secondary">导出全部记忆</Button>
            <Button variant="outline" size="default" type="button" id="btn-memory-clear" className="btn-secondary danger-text" disabled>清空本组</Button>
          </div>
        </section>

        <section id="page-channels" className="page">
          <header className="page-head"><h2>平台</h2><p className="page-sub">统一管理各平台的接入与主人账号。</p></header>

          <div className="platform-list" aria-label="平台列表">
          <details className="platform-item" id="channel-qq" data-channel="qq">
            <summary className="platform-summary" id="platform-qq-summary" aria-label="QQ 平台设置">
              <span className="platform-identity"><span className="platform-name">QQ</span><span className="platform-description">私聊、记事与提醒</span></span>
              <span id="owners-channel-status" className="platform-status selectable" aria-live="polite">正在读取状态…</span>
              <span className="platform-disclosure"><span className="platform-expand">展开设置</span><span className="platform-collapse">收起设置</span></span>
            </summary>
            <div className="platform-options">
            <div className="feat-row">
              <div className="feat-main">
                <div className="feat-title" id="qq-enabled-title">接入 QQ</div>
                <p className="feat-desc" id="qq-enabled-note">开启后可远程私聊，关闭不影响本机对话。</p>
              </div>
              <label className="switch" title="接入 QQ">
                <input type="checkbox" id="qq-enabled" aria-labelledby="qq-enabled-title" aria-describedby="qq-enabled-note" />
                <span className="switch-ui" aria-hidden="true"></span>
              </label>
            </div>
            <div id="qq-risk-panel" className="hidden">
              <p className="hint">请使用专用小号，存在风控与封号风险。启用后需扫码、绑定；关闭即停止远程回复和渠道后台。</p>
              <label className="check-row"><input type="checkbox" id="qq-risk-ok" /><span>我已了解 QQ 接入风险</span></label>
              <div className="btn-row">
                <Button variant="default" size="default" type="button" id="btn-qq-enable-confirm" className="btn-primary" disabled>启用并登录 QQ</Button>
                <Button variant="ghost" size="default" type="button" id="btn-qq-enable-cancel" className="btn-ghost">暂不接入</Button>
              </div>
            </div>
            <p id="qq-setting-msg" className="hint selectable" role="status" aria-live="polite"></p>
            <div className="platform-owners">
            <h3 className="settings-danger-title">主人账号</h3>
            <div id="owners-list"></div>
            <p id="owners-empty" className="hint">正在读取绑定信息…</p>
            <p id="platform-qq-binding-note" className="hint">先开启 QQ 接入并登录小号，再绑定你的主人账号。</p>
            <div className="btn-row">
              <Button variant="outline" size="default" type="button" id="btn-pairing-start" className="btn-secondary" aria-describedby="platform-qq-binding-note">绑定主人账号</Button>
              <Button variant="outline" size="default" type="button" id="btn-owner-relogin" className="btn-secondary">重新登录</Button>
              <Button variant="outline" size="default" type="button" id="btn-owners-refresh" className="btn-secondary">刷新</Button>
            </div>
            <p id="owners-msg" className="hint selectable" role="status" aria-live="polite"></p>
            </div>
            </div>
          </details>
          <div className="platform-item platform-upcoming">
            <div className="platform-identity"><h3 className="platform-name">更多平台</h3><p className="platform-description">其他平台暂未开放。</p></div>
          </div>
          </div>

        </section>

        <section id="page-settings" className="page">
          <header className="page-head">
            <h2>设置</h2>
          </header>

          <div className="settings-block settings-card" id="settings-model" aria-busy="false">
            <h3 className="settings-block-title">模型</h3>
            <div className="model-fields">
            <label className="field"><span className="field-label">服务商</span>
              <NativeSelect id="model-provider" disabled>
                <NativeSelectOption value="deepseek-official">DeepSeek（默认）</NativeSelectOption><NativeSelectOption value="openai">OpenAI</NativeSelectOption><NativeSelectOption value="anthropic">Anthropic</NativeSelectOption>
                <NativeSelectOption value="moonshotai">Moonshot</NativeSelectOption><NativeSelectOption value="zai">智谱</NativeSelectOption><NativeSelectOption value="custom">自定义</NativeSelectOption>
              </NativeSelect>
            </label>
            <label className="field"><span className="field-label">模型名称</span><Input type="text" id="model-name" maxLength={200} placeholder="填写服务商提供的模型名称" disabled /></label>
            <div id="model-custom-fields" className="hidden">
              <label className="field"><span className="field-label">接口格式</span><NativeSelect id="model-api" disabled aria-describedby="model-api-hint">
                <NativeSelectOption value="openai-completions">通用对话格式（Chat Completions）</NativeSelectOption><NativeSelectOption value="openai-responses">通用响应格式（Responses）</NativeSelectOption><NativeSelectOption value="anthropic-messages">消息格式（Messages）</NativeSelectOption>
              </NativeSelect></label>
              <p id="model-api-hint" className="hint">按接口文档选择。</p>
              <label className="field"><span className="field-label">接口地址</span><Input type="url" id="model-base-url" maxLength={4096} placeholder="例如：https://api.example.com/v1" autoComplete="off" disabled aria-describedby="model-http-warning" /></label>
              <p id="model-http-warning" className="hint err hidden">连接未加密，密钥可能明文传输。请确认网络可信。</p>
            </div>
            </div>
            <label className="field">
              <span className="field-label">密钥</span>
              <Input type="password" id="api-key" maxLength={4096} autoComplete="off" placeholder="粘贴模型密钥" disabled aria-describedby="key-mask-hint" />
            </label>
            <p id="key-mask-hint" className="hint selectable"></p>
            <details id="model-advanced" className="settings-fold hidden"><summary>容量与输出上限</summary>
              <p className="hint">按接口限制填写，不会自动探测。</p>
              <label className="field"><span className="field-label">可用上下文容量</span><Input type="number" id="model-context" min="1024" max="2147483647" step="1" defaultValue="65536" disabled /></label>
              <label className="field"><span className="field-label">单次输出上限</span><Input type="number" id="model-max-tokens" min="1" max="2147483647" step="1" defaultValue="4096" disabled /></label>
            </details>
            <p id="model-change-note" className="hint model-safety-note">更改后开启新会话，旧聊天记录保留；人格和相关记忆会发给所选服务商。</p>
            <p id="model-test-note" className="hint model-safety-note">测试可能产生少量模型费用；不发送已有对话、人格或记忆，不保存设置。</p>
            <div className="btn-row"><Button variant="default" size="default" type="button" id="btn-save-key" className="btn-primary" disabled aria-describedby="model-change-note">保存到本机</Button>
              <Button variant="outline" size="default" type="button" id="btn-model-test" className="btn-secondary" disabled aria-describedby="model-test-note">测试连接</Button>
              <Button variant="outline" size="default" type="button" id="btn-model-reload" className="btn-secondary" aria-describedby="model-reload-note">重新读取</Button>
            </div>
            <p id="model-action-hint" className="hint"></p>
            <p id="model-reload-note" className="hint hidden">重新读取会丢弃未保存的修改。</p>
            <p id="settings-msg" className="hint selectable" role="status" aria-live="polite"></p>
          </div>

          <div className="settings-block settings-card" id="settings-workspace" aria-busy="false">
            <h3 className="settings-block-title">本机工作区</h3>
            <p id="workspace-path" className="hint selectable">正在读取…</p>
            <p className="hint">默认操作文件夹，操作仍需逐次确认。</p>
            <p id="workspace-change-note" className="hint">更改后开启新会话，旧聊天记录保留，文件不移动。</p>
            <div className="btn-row">
              <Button variant="outline" size="default" type="button" id="btn-workspace-choose" className="btn-secondary" aria-describedby="workspace-change-note">更改</Button>
              <Button variant="outline" size="default" type="button" id="btn-workspace-reset" className="btn-secondary" aria-describedby="workspace-change-note">恢复默认</Button>
              <Button variant="outline" size="default" type="button" id="btn-workspace-retry" className="btn-secondary hidden">重新读取</Button>
            </div>
            <p id="workspace-msg" className="hint selectable" role="status" aria-live="polite"></p>
          </div>

          <div className="settings-block settings-compact" id="settings-startup">
            <div className="settings-heading-row">
              <h3 className="settings-block-title" id="settings-startup-title">开机启动</h3>
              <label className="switch" title="开机启动">
                <input type="checkbox" id="autostart-enabled" aria-labelledby="settings-startup-title" aria-describedby="settings-startup-note" />
                <span className="switch-ui" aria-hidden="true"></span>
              </label>
            </div>
            <p className="feat-desc" id="settings-startup-note">登录系统后自动打开肥鱼</p>
            <p id="settings-startup-msg" className="hint selectable" role="status" aria-live="polite"></p>
          </div>

          <div className="settings-block settings-compact" id="settings-data">
            <h3 className="settings-block-title">数据管理</h3>
            <div className="btn-row">
              <Button variant="outline" size="default" type="button" id="btn-open-data" className="btn-secondary">打开数据文件夹</Button>
              <Button variant="outline" size="default" type="button" id="btn-export-settings" className="btn-secondary">导出设置</Button>
            </div>
            <p id="settings-data-msg" className="hint selectable" role="status" aria-live="polite"></p>
            <div className="settings-danger" id="settings-clear" role="group" aria-labelledby="settings-clear-title">
              <h4 className="settings-danger-title" id="settings-clear-title">清空本机数据</h4>
              <p className="feat-desc" id="data-clear-warning">会话、记忆等不可恢复；默认保留模型密钥和激活信息</p>
              <Button variant="outline" size="sm" type="button" id="btn-clear-data" className="btn-secondary btn-sm danger-text" aria-describedby="data-clear-warning">清空数据</Button>
              <div id="data-clear-confirm" hidden>
                <p id="data-clear-count" className="hint" aria-live="polite"></p>
                <p className="hint">删除会话、记忆、提醒、人格、绑定和设置进度。保留工作区文件和 QQ 登录状态；默认保留模型设置、密钥和激活信息。</p>
                <label className="check-row"><input type="checkbox" id="data-clear-keys" /><span>同时清除模型密钥，之后需重新填写</span></label>
                <label className="check-row"><input type="checkbox" id="data-clear-license" /><span>同时清除本机激活信息，之后需重新联网激活</span></label>
                <div className="btn-row">
                  <Button variant="ghost" size="default" type="button" id="btn-clear-data-cancel" className="btn-ghost">取消</Button>
                  <Button variant="outline" size="default" type="button" id="btn-clear-data-confirm" className="btn-secondary danger-text">清空并退出</Button>
                </div>
              </div>
              <p id="data-clear-msg" className="hint selectable" role="status" aria-live="polite"></p>
            </div>
          </div>

          <div className="settings-block about-block" id="settings-about">
            <h3 className="settings-block-title">关于</h3>
            <p className="about-name">肥鱼</p>
            <p id="about-version" className="hint selectable">版本 …</p>
            <p id="about-license" className="hint">正在读取激活状态…</p><Button variant="outline" size="default" id="btn-onboarding-resume" type="button" className="btn-secondary">继续首次设置</Button>
          </div>

          <details className="diag-fold settings-legal" id="settings-risk">
            <summary>风险与隐私</summary>
            <ul className="risk-bullets hint">
              <li>模型费用由你的密钥承担，对话发送给所选服务商。</li>
              <li>电脑操作需逐次确认；记录保存在本机。</li>
              <li>QQ 请使用专用小号，存在风控与封号风险。</li>
            </ul>
          </details>
        </section>
      </main>
    </div>
  </div>

  <div id="pairing-mask" className="pairing-mask hidden" role="dialog" aria-modal="true" aria-labelledby="pairing-title" aria-describedby="pairing-instructions">
    <div className="pairing-card">
      <h2 id="pairing-title">绑定你的账号</h2>
      <p id="pairing-instructions" className="hint">用<strong>你自己的</strong> QQ，把配对码私聊发给肥鱼小号。</p>
      <p id="pairing-receiver" className="hint selectable"></p>
      <div id="pairing-code" className="pairing-code selectable" aria-label="配对码"></div>
      <p id="pairing-countdown" className="hint selectable"></p>
      <p id="pairing-msg" className="hint selectable" role="status" aria-live="polite"></p>
      <div className="btn-row pairing-actions">
        <Button variant="outline" size="default" type="button" id="btn-pairing-refresh" className="btn-secondary">换一个</Button>
        <Button variant="ghost" size="default" type="button" id="btn-pairing-cancel" className="btn-ghost">取消</Button>
      </div>
    </div>
  </div>










  </>
}
