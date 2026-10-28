/** React/shadcn 呈现契约检查。不启动窗口、后台或模型。 */
"use strict";
const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict");
const root = path.resolve(__dirname, ".."), read = p => fs.readFileSync(path.join(root, p), "utf8");
const pkg = JSON.parse(read("package.json")), html = read("renderer/index.html"), app = read("renderer-src/App.tsx"), boot = read("renderer-src/bootstrap.ts"), css = read("renderer/styles.css");
let count = 0;
function check(name, value) { assert.ok(value, name); count++; console.log("PASS " + name); }
for (const name of ["react", "react-dom", "vite", "@vitejs/plugin-react", "tailwindcss", "@tailwindcss/vite", "class-variance-authority", "clsx", "tailwind-merge", "@radix-ui/react-slot", "typescript"]) {
  check(name + " is exactly pinned for local rendering", /^\d+\.\d+\.\d+$/.test(pkg.devDependencies[name]));
}
check("locked desktop dependencies are not upgraded", pkg.devDependencies.electron === "33.4.11" && pkg.devDependencies["electron-builder"] === "25.1.8");
check("real shadcn sources retain MIT license and provenance", ["button", "input", "textarea", "badge", "native-select"].every(name => read(`renderer-src/components/ui/${name}.tsx`).includes("shadcn/ui")) && read("renderer/SHADCN_LICENSE.txt").includes("MIT License") && JSON.parse(read("renderer-src/components/ui/provenance.json")).length === 5);
check("bundled dependencies retain MIT and Apache notices", read("renderer/THIRD_PARTY_NOTICES.txt").includes("react-dom 19.3.1") && read("renderer/THIRD_PARTY_NOTICES.txt").includes("Apache License") && read("renderer/THIRD_PARTY_NOTICES.txt").includes("tailwindcss 4.3.3"));
check("React UI renders real imported primitives rather than lookalike class names", ["Button", "Input", "Textarea", "Badge", "NativeSelect"].every(name => app.includes("<" + name) && app.includes("import { " + name)));
for (const slot of ["button", "input", "textarea", "badge", "native-select"]) check("built first frame includes " + slot, html.includes(`data-slot="${slot}"`));
check("static first frame is activation locked before any JavaScript", html.includes('<body class="activation-locked">') && css.includes("body.activation-locked #main-app"));
check("only one client entry is executable before controller mounting", (html.match(/<script defer src="assets\/ui.min.js"><\/script>/g) || []).length === 1 && (html.match(/type="application\/x-fatfish-controller"/g) || []).length === 9);
check("existing controllers retain their order and run once after mounting", boot.includes("if (startup) return startup") && app.includes("useEffect(() => { void startControllers() }, [])") && !read("renderer-src/main.tsx").includes("StrictMode") && html.indexOf('src="activation-view.js"') < html.indexOf('src="renderer.js"'));
check("mount failures keep the first-frame lock rather than bypassing activation", boot.includes('document.body.classList.add("activation-locked")') && boot.includes('document.querySelector("#activation-mask")?.classList.remove("hidden")'));
check("production and SSR use the same JSX runtime mode", read("scripts/build-ui.mjs").includes('process.env.NODE_ENV = "production"') && !read("renderer/assets/ui.min.js").includes("jsxDEV"));
check("sources and generated renderer are packaged without network dependencies", pkg.build.files.includes("renderer/**/*") && html.includes('href="assets/ui.min.css"') && html.includes('src="assets/ui.min.js"') && !/<(?:script|link)[^>]+(?:src|href)="https?:/.test(html));
check("Tailwind scans only source, never generated assets", read("renderer-src/shadcn.css").includes('source(none)') && read("renderer-src/shadcn.css").includes('@source "./"'));
check("original desktop security flags are unchanged", read("main.js").includes("contextIsolation: true") && read("main.js").includes("nodeIntegration: false"));
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
check("generated DOM has unique ids including new local-chat entry", ids.length === new Set(ids).size && ids.includes("btn-home-chat") && ids.includes("ui-root"));
check("product navigation includes a separate platform-neutral channel destination", [...html.matchAll(/data-page="([^"]+)"/g)].map(m => m[1]).join("|") === "home|chat|persona|memory|channels|settings");
check("main content hides its scrollbar without disabling scrolling", /\.content\s*\{[^}]*overflow:\s*auto;[^}]*scrollbar-width:\s*none;/.test(css) && /\.content::-webkit-scrollbar\s*\{\s*display:\s*none;\s*\}/.test(css));
check("scrollbar hiding stays scoped to the main content container", !/(?:^|\})\s*(?:\*|html|body|textarea)\s*(?:::?-webkit-scrollbar)?\s*\{[^}]*(?:scrollbar-width:\s*none|display:\s*none)/m.test(css));
check("framework uses uncontrolled fields compatible with existing controllers", !/<(?:Input|Textarea|NativeSelect)\b[^>]*\bvalue=/.test(app) && !app.includes("useState("));
check("chat primitive has no extra focus ring or outline", app.includes('focus-visible:ring-0') && /\.chat-composer \.field textarea:focus-visible\s*\{[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/.test(css));
check("composer indicates focus by background without adding a border or outline", /\.chat-composer:has\(textarea:focus\)\s*\{\s*background:\s*var\(--hover-fill-strong\);\s*\}/.test(css) && !css.includes('.chat-composer:has(textarea:focus-visible)') && !css.includes('.chat-composer:focus-within'));
check("form fields retain neutral borders and use background-only focus", /\.field input:focus, \.field textarea:focus, \.field select:focus, \.persona-search:focus\s*\{[^}]*border-color:\s*var\(--border-strong\);[^}]*background:\s*var\(--surface-2\);[^}]*outline:\s*none;[^}]*box-shadow:\s*none;/.test(css));
check("buttons and other keyboard controls retain their visible focus", /:where\(button, input, textarea, select, summary\):focus-visible\s*\{[^}]*outline:\s*var\(--focus-width\) solid var\(--focus-ring\)/.test(css));
check("chat shortcut hint is associated with the native textarea", html.includes('aria-describedby="chat-input-hint"') && html.includes('id="chat-input-hint"') && app.includes('maxLength={16000}'));
check("compact send control keeps its width when the controller switches to stop", /\.chat-send-row > button\s*\{[^}]*min-width:/.test(css) && html.includes('id="btn-chat-send"'));
check("chat reminder refresh preserves the navigation icon and accessible count", read("renderer/renderer.js").includes('const chatLabel = chatNav.querySelector("span") || chatNav;') && read("renderer/renderer.js").includes('chatNav.setAttribute("aria-label"'));
check("native selects remain native selects for model-controller compatibility", read("renderer-src/components/ui/native-select.tsx").includes("<select") && html.includes('id="model-provider"'));
check("native default and optional channel fields are retained", html.includes('id="qq-enabled"') && html.includes('id="risk-ok"') && html.includes('id="data-clear-keys"') && html.includes('id="data-clear-license"'));
check("no process workdir or reference image leaks into delivered resources", ![html, app, css, read("renderer/assets/ui.min.js")].some(s => /\.oil-ui|codex-clipboard|Post\./.test(s)));
console.log(`${count}/${count} UI framework checks passed (source/resource contracts, no native UI/network)`);
