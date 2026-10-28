/** Main-owned resumable setup metadata. Only verified runtime results can record model/trial completion. */
"use strict";
const fs = require("node:fs"), { join } = require("node:path"), { randomUUID, createHash } = require("node:crypto");
const hex = /^[0-9a-f]{64}$/;
const initial = () => ({ version: 1, deferred: false, baseComplete: false, tested: null, qqActive: false, qqComplete: false });
const bindingHash = (channel, account) => createHash("sha256").update(channel + "\0" + account).digest("hex");
function modelToken(state) { return state?.key ? createHash("sha256").update(JSON.stringify([state.route, state.generation, state.key])).digest("hex") : null; }
class OnboardingStore {
  constructor(root) { this.root = root; this.file = join(root, "onboarding.json"); this.pending = new Map(); }
  read() {
    try {
      const s = fs.lstatSync(this.file); if (!s.isFile() || s.isSymbolicLink() || s.size > 8192) throw new Error();
      const v = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!v || Object.keys(v).sort().join() !== Object.keys(initial()).sort().join() || v.version !== 1 || ["deferred", "baseComplete", "qqActive", "qqComplete"].some((k) => typeof v[k] !== "boolean") || v.tested !== null && (!v.tested || Object.keys(v.tested).sort().join() !== "generation,token" || !Number.isSafeInteger(v.tested.generation) || v.tested.generation < 0 || !hex.test(v.tested.token))) throw new Error();
      return v;
    } catch (e) { if (e.code === "ENOENT") return initial(); throw new Error("onboarding_invalid"); }
  }
  write(value) {
    const temp = this.file + "." + randomUUID() + ".tmp"; let fd;
    try {
      fs.mkdirSync(this.root, { recursive: true });
      try { const s = fs.lstatSync(this.file); if (!s.isFile() || s.isSymbolicLink()) throw new Error(); } catch (e) { if (e.code !== "ENOENT") throw e; }
      fd = fs.openSync(temp, "wx", 0o600); fs.writeFileSync(fd, JSON.stringify(value) + "\n", "utf8"); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined; fs.renameSync(temp, this.file);
    } catch { throw new Error("onboarding_save_failed"); }
    finally { if (fd !== undefined) fs.closeSync(fd); try { fs.unlinkSync(temp); } catch { /* only this transaction's temp */ } }
  }
  flush(facts) {
    const state = this.read(), before = JSON.stringify(state), applied = [];
    for (const kind of ["model", "local", "remote"]) {
      const proof = this.pending.get(kind); if (!proof) continue;
      if (kind === "model" && facts.riskAccepted && facts.model.token && facts.model.token === proof.token && facts.model.generation === proof.generation) state.tested = { generation: proof.generation, token: proof.token };
      if (kind === "local" && facts.riskAccepted && facts.model.token && proof.token === facts.model.token && proof.generation === facts.model.generation && state.tested?.token === proof.token && state.tested?.generation === proof.generation) { state.baseComplete = true; state.deferred = false; }
      if (kind === "remote" && state.baseComplete && state.qqActive && facts.qq.enabled && proof.generation === facts.model.generation && facts.qq.owners.includes(proof.bindingHash)) { state.qqComplete = true; state.qqActive = false; state.deferred = false; }
      applied.push(kind); // Stale proofs are discarded, never reassigned to newer settings.
    }
    if (JSON.stringify(state) !== before) this.write(state);
    for (const kind of applied) this.pending.delete(kind);
    return state;
  }
  record(kind, proof, facts) {
    if (!["model", "local", "remote"].includes(kind)) throw new Error("onboarding_args_invalid");
    if (kind !== "remote" && (!proof || !hex.test(proof.token) || !Number.isSafeInteger(proof.generation) || proof.generation < 0) || kind === "remote" && (!proof || !hex.test(proof.bindingHash) || !Number.isSafeInteger(proof.generation) || proof.generation < 0)) throw new Error("onboarding_args_invalid");
    this.pending.set(kind, { ...proof }); return this.snapshot(facts);
  }
  setDeferred(value, facts) {
    if (typeof value !== "boolean" || !facts.riskAccepted) throw new Error("onboarding_args_invalid");
    const state = this.flush(facts); state.deferred = value; this.write(state); return this.snapshot(facts);
  }
  startQQ(facts) {
    const state = this.flush(facts); if (!state.baseComplete) throw new Error("onboarding_base_incomplete");
    state.qqActive = true; state.qqComplete = false; state.deferred = false; this.write(state); return this.snapshot(facts);
  }
  snapshot(facts) {
    const state = this.flush(facts), modelReady = !!facts.model.token && state.tested?.token === facts.model.token && state.tested?.generation === facts.model.generation;
    let phase, step, total = 4, branch = "local";
    if (!facts.riskAccepted) { phase = "risk"; step = 2; }
    else if (!state.baseComplete) { phase = modelReady ? "local" : "model"; step = modelReady ? 4 : 3; }
    else if (state.qqActive) { branch = "qq"; phase = !facts.qq.enabled ? "qq-risk" : !facts.qq.online ? "qq-login" : !facts.qq.owners.length ? "qq-pair" : "qq-trial"; step = ["qq-risk", "qq-login", "qq-pair", "qq-trial"].indexOf(phase) + 1; }
    else { phase = "done"; step = 4; }
    return { phase, step, total, branch, baseComplete: state.baseComplete, qqActive: state.qqActive, qqComplete: state.qqComplete, qqPaused: facts.qq.paused === true, modelReady, deferred: state.deferred, needsWizard: !state.deferred && (!facts.riskAccepted || !state.baseComplete || state.qqActive) };
  }
}
module.exports = { OnboardingStore, modelToken, bindingHash };
