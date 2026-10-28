/** Static M3-C gate. Kept outside app so forbidden-token checks cannot match themselves. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function verifyCleanup() {
  const files = [];
  const visit = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (["node_modules", "dist", "out", ".git"].includes(e.name)) continue;
      const path = join(dir, e.name);
      if (e.isDirectory()) visit(path);
      else if (/\.(?:mjs|js|cjs|json|html|css|yml|yaml|md|txt)$/.test(e.name)) files.push(path);
    }
  };
  visit(join(root, "app"));
  for (const path of files) {
    const source = readFileSync(path, "utf8");
    assert.ok(!/8787|agent_engine|persona_rev|local_server|settings_port/.test(source), "legacy reference: " + path);
    for (const [i, line] of source.split(/\r?\n/).entries()) {
      if (!line.includes("bridge")) continue;
      assert.ok(path === join(root, "app", "electron-ui", "service-manager.js") &&
        (/pre-Core installs/.test(line) || /for \(const key of/.test(line)), `unexpected bridge reference: ${path}:${i + 1}`);
    }
  }
  for (const dir of ["shell", "bridge"]) {
    const p = join(root, "app", dir);
    assert.ok(!existsSync(p) || readdirSync(p).length === 0, "legacy directory still contains files");
  }
  const pkg = JSON.parse(readFileSync(join(root, "app", "electron-ui", "package.json"), "utf8"));
  assert.ok(pkg.build.extraResources.every((r) => r.to !== "shell" && r.to !== "bridge"));
  for (const name of ["start.ps1", "stop.ps1", "doctor.ps1"]) {
    const bytes = readFileSync(join(root, "scripts", name));
    assert.equal(bytes.subarray(0, 3).toString("hex"), "efbbbf", name + " must be UTF-8 BOM");
    assert.ok(!/8787|app\\bridge|app\\shell|agent_engine/.test(bytes.toString("utf8")));
  }
  return files.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log("cleanup_static_pass", verifyCleanup(), "files inspected");
}
