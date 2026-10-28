import { callCore, operationOutput } from "./gateway-client.mjs";
export const name = "fatfish-remind";
export const inject = ["tools"];
export function apply(ctx) {
  for (const [tool, op, description, properties, required] of [
    ["remind_create", "create", "设置主人的提醒。when 可用 1m、1小时后、带时区的日期时间或 cron: 0 9 * * *（上海时区五字段）。repeat 可选 1d、daily 或 cron 表达式，最短一分钟；when 本身是 cron 时不要再传 repeat。不能指定实例、收件人或数据范围。", { when: { type: "string", maxLength: 160 }, text: { type: "string", maxLength: 1000 }, repeat: { type: "string", maxLength: 160 } }, ["when", "text"]],
    ["remind_list", "list", "查看主人已设置的提醒及送达状态。uncertain 表示收信结果未确认，不要擅自重复创建或发送。", {}, []],
    ["remind_delete", "delete", "删除一个提醒，并取消尚未发出的到期消息；id 必须来自提醒列表。", { id: { type: "string", maxLength: 100 } }, ["id"]],
  ]) ctx.tools.register({ name: tool, description, parameters: { type: "object", properties, required, additionalProperties: false }, output: operationOutput,
    execute: (args, exec) => callCore(name, op, args, exec) });
}
