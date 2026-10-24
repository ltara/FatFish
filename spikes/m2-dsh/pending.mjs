// Boot the profile once and print entries that did not activate (dependency debugging).
import { DshClient } from "../../app/core/dsh-client.mjs";

const c = new DshClient({
  exe: process.env.DSH_EXE,
  profile: process.argv[2] || "fatfish",
  env: { ...process.env, DSH_HOME: process.env.SPIKE_HOME },
  cwd: process.env.SPIKE_HOME,
});
c.start();
await c.request("initialize", { cwd: process.env.SPIKE_HOME, provider: "deepseek-official", model: "deepseek-flash" });
await c.shutdown();
const lines = c.stderrTail.split(/\r?\n/).filter((l) => /pending|did not|waiting|error/i.test(l));
console.log(lines.join("\n") || "all entries active");
process.exit();
