import { callCore, operationOutput } from "./gateway-client.mjs";
export const name = "fatfish-memory";
export const inject = ["tools"];
export function apply(ctx) {
  for (const [toolName, op, description, properties, required] of [
    ["memory_save", "save", "记住主人明确要求长期保存的事实。只能保存私有记忆，不能指定范围；不要自行创建记忆文件。", { text: { type: "string", maxLength: 4000 }, tags: { type: "array", items: { type: "string", maxLength: 64 }, maxItems: 16 } }, ["text"]],
    ["memory_search", "search", "用简短关键词查找以前的事实，按时间倒序返回；空关键词返回最近记忆。范围由核心决定，不能自行指定。公开资料只读。", { query: { type: "string", maxLength: 200 } }, ["query"]],
    ["memory_forget", "forget", "删除一条私有记忆。使用检索返回的 id；删除会中止旧模型上下文，下次从新会话继续，旧显示记录保留。", { id: { type: "string", maxLength: 100 } }, ["id"]],
  ]) ctx.tools.register({ name: toolName, description, parameters: { type: "object", properties, required, additionalProperties: false },
    output: operationOutput, execute: (args, exec) => callCore(name, op, args, exec) });
}
