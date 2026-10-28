/** Bounded schedule parser. No OS scheduler, commands, eval, or third-party runtime. */
const MINUTE = 60000, DAY = 86400000, OFFSET = 8 * 3600000;
const error = () => { throw new Error("reminder_time_invalid"); };
const aliases = { "@hourly": "0 * * * *", "@daily": "0 0 * * *", "@weekly": "0 0 * * 0", "@monthly": "0 0 1 * *", "@yearly": "0 0 1 1 *" };
const months = "jan feb mar apr may jun jul aug sep oct nov dec".split(" "), weekdays = "sun mon tue wed thu fri sat".split(" ");
function field(text, min, max, names = []) {
  const values = new Set(), wildcard = text.includes("*");
  const number = (s) => { const named = names.indexOf(s.toLowerCase()); const n = named >= 0 ? named + (min === 1 ? 1 : 0) : /^\d+$/.test(s) ? Number(s) : NaN; if (!Number.isInteger(n) || n < min || n > max) error(); return n; };
  for (const piece of text.split(",")) {
    const parts = piece.split("/"); if (parts.length > 2 || parts[1] !== undefined && !/^\d+$/.test(parts[1])) error();
    const step = parts[1] === undefined ? 1 : Number(parts[1]); if (!step || step > max - min + 1) error();
    let lo, hi;
    if (parts[0] === "*") [lo, hi] = [min, max];
    else if (parts[0].includes("-")) { const range = parts[0].split("-"); if (range.length !== 2) error(); [lo, hi] = range.map(number); }
    else { if (parts.length === 2) error(); lo = hi = number(parts[0]); }
    if (lo > hi) error();
    for (let n = lo; n <= hi; n += step) values.add(max === 7 && n === 7 ? 0 : n);
  }
  return { values: [...values].sort((a, b) => a - b), wildcard };
}
export function parseCron(value) {
  if (typeof value !== "string" || value.length > 120) error();
  const raw = value.trim().replace(/^cron:\s*/i, ""), expr = aliases[raw.toLowerCase()] || raw;
  const fields = expr.split(/\s+/); if (fields.length !== 5) error();
  const [minute, hour, dom, month, dow] = [field(fields[0], 0, 59), field(fields[1], 0, 23), field(fields[2], 1, 31), field(fields[3], 1, 12, months), field(fields[4], 0, 7, weekdays)];
  return { expr: fields.join(" "), minute, hour, dom, month, dow };
}
function dayMatches(cron, day) {
  if (!cron.month.values.includes(day.getUTCMonth() + 1)) return false;
  const d = cron.dom.values.includes(day.getUTCDate()), w = cron.dow.values.includes(day.getUTCDay());
  return cron.dom.wildcard || cron.dow.wildcard ? d && w : d || w;
}
/** Asia/Shanghai modern calendar (UTC+08:00), independent of host TZ. */
export function cronAt(expr, reference, direction = 1) {
  if (!Number.isSafeInteger(reference) || ![1, -1].includes(direction)) error();
  const cron = parseCron(expr), local = new Date(reference + OFFSET);
  const start = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate());
  const hours = direction === 1 ? cron.hour.values : [...cron.hour.values].reverse(), minutes = direction === 1 ? cron.minute.values : [...cron.minute.values].reverse();
  for (let d = 0; d < 366 * 8; d++) {
    const midnight = start + d * DAY * direction;
    if (!dayMatches(cron, new Date(midnight))) continue;
    for (const hour of hours) for (const minute of minutes) {
      const at = midnight + hour * 3600000 + minute * MINUTE - OFFSET;
      if (direction === 1 ? at > reference : at <= reference) return at;
    }
  }
  error(); // Impossible calendars (e.g. February 30) do not enter the timer.
}
export function duration(value) {
  if (typeof value !== "string") error();
  const match = /^(?:in\s+)?(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w|秒|分钟|分|小时|时|天|周)(?:后)?$/i.exec(value.trim());
  if (!match) error();
  const unit = { ms: 1, s: 1000, m: MINUTE, h: 3600000, d: DAY, w: 7 * DAY, 秒: 1000, 分钟: MINUTE, 分: MINUTE, 小时: 3600000, 时: 3600000, 天: DAY, 周: 7 * DAY }[match[2].toLowerCase()];
  const ms = Number(match[1]) * unit; if (!Number.isSafeInteger(ms) || ms < 1000 || ms >= 8640000000000000) error(); return ms;
}
function absolute(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) error();
  const [, y, m, d, h, minute, sec = "0", fraction = "0", zone = "+08:00"] = match;
  const date = new Date(Date.UTC(+y, +m - 1, +d, +h, +minute, +sec));
  if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +m - 1 || date.getUTCDate() !== +d || date.getUTCHours() !== +h || date.getUTCMinutes() !== +minute || date.getUTCSeconds() !== +sec) error();
  if (zone !== "Z" && (+zone.slice(1, 3) > 23 || +zone.slice(4) > 59)) error();
  const at = Date.parse(`${y}-${m}-${d}T${h}:${minute}:${sec.padStart(2, "0")}.${fraction.padEnd(3, "0")}${zone}`);
  if (!Number.isSafeInteger(at)) error(); return at;
}
export function parseSchedule(when, repeat, now = Date.now()) {
  if (typeof when !== "string" || when.length > 160 || !Number.isSafeInteger(now)) error();
  const input = when.trim(), cron = input.startsWith("@") || /^cron:/i.test(input) || input.split(/\s+/).length === 5;
  if (cron) { if (repeat !== undefined) error(); const expr = parseCron(input).expr; return { kind: "cron", expr, first: cronAt(expr, now) }; }
  let first;
  try { first = now + duration(input); } catch { first = absolute(input); }
  if (!Number.isSafeInteger(first) || first <= now || first >= 8640000000000000) error();
  if (repeat === undefined) return { kind: "once", first };
  if (typeof repeat !== "string") error();
  const normalized = { hourly: "1h", daily: "1d", weekly: "1w" }[repeat] || repeat;
  if (/^cron:|^@/.test(normalized) || normalized.trim().split(/\s+/).length === 5) { const expr = parseCron(normalized).expr; cronAt(expr, first); return { kind: "cron", expr, first }; }
  const every = duration(normalized); if (every < MINUTE) error(); return { kind: "interval", first, every };
}
export function nextAfter(schedule, at) {
  if (schedule.kind === "once") return null;
  if (at < schedule.first) return schedule.first;
  return schedule.kind === "interval" ? schedule.first + (Math.floor((at - schedule.first) / schedule.every) + 1) * schedule.every : cronAt(schedule.expr, at);
}
export function latestDue(schedule, now) {
  if (now < schedule.first) return null;
  return schedule.kind === "once" ? schedule.first : schedule.kind === "interval" ? schedule.first + Math.floor((now - schedule.first) / schedule.every) * schedule.every : Math.max(schedule.first, cronAt(schedule.expr, now, -1));
}
