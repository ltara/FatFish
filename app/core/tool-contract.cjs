"use strict";
const external = Object.freeze(["memory_save", "memory_search", "memory_forget", "remind_create", "remind_list", "remind_delete"]);
const local = Object.freeze([...external, "edit", "glob", "grep", "interrupt_agent", "list_agents", "pwsh", "read", "read_image",
  "send_message", "skill", "subagent", "subagent_fork", "web_fetch", "working_directory", "write"]);
function matches(body, expected) {
  return Array.isArray(body.tools) && JSON.stringify(body.tools.map((t) => t.name).sort()) === JSON.stringify([...expected].sort());
}
function externalToolsMatch(body) {
  return matches(body, external);
}
const localToolsMatch = (body) => matches(body, local);
module.exports = { external, local, externalToolsMatch, localToolsMatch };
