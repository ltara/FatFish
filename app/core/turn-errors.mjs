/** rc2's observed failure schema. Never return provider messages or raw stderr. */
export function classifyTurnFailure({ endReason, events = [], exception, stderr = "" } = {}) {
  if (exception?.message === "engine_exited" || /^dsh_exit_/.test(exception?.message || "")) return "engine_crashed";
  const attempt = events.filter((e) => e.type === "assistant/attempt").at(-1);
  const finish = attempt?.data?.stream?.filter((item) => item.type === "chunk" && item.chunk?.type === "finish").at(-1);
  const failure = endReason?.kind === "error" ? endReason.error : finish?.chunk?.reason?.failure;
  if (failure?.status === 401 || failure?.code === "AUTH") return "invalid_key";
  if (failure?.status === 402 || failure?.code === "QUOTA") return "insufficient_balance";
  if (failure?.status === 429 || failure?.code === "RATE_LIMIT") return "rate_limited";
  if (failure?.status === 404) return "model_unavailable";
  if (["TRANSPORT", "TIMEOUT"].includes(failure?.code) || exception?.message === "turn_timeout") return "network";
  // Only known transport errno tokens, not arbitrary digits/provider prose in stderr.
  if (!failure && /\b(?:ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|ETIMEDOUT)\b/.test(stderr)) return "network";
  return "turn_failed";
}
