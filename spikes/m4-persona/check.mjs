/** Offline billing/security regressions. Never reads the authorized live key or ledger. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { gzipSync } from 'node:zlib';
import { Budget, startBudgetProxy } from './budget.mjs';
import { cases, evaluate } from './cases.mjs';
import contract from '../../app/core/tool-contract.cjs';
const home = fs.mkdtempSync(join(tmpdir(), 'fatfish-persona-budget-check-'));
let count = 0, serial = 0;
const check = (name, ok) => { assert.ok(ok, name); count++; console.log('PASS ' + name); };
const newBudget = (max = 2) => new Budget(join(home, 'ledger-' + serial++ + '.json'), { authorization: 'offline-only', maxRequests: max, route: { provider: 'fake' } });
const key = 'sk-offline-budget-synthetic', body = { model: 'deepseek-flash', max_tokens: 384, tools: contract.external.map(name => ({ name })), messages: [{ role: 'user', content: 'SYNTHETIC_SECRET_BODY' }] };
const send = (proxy, value = body, auth = key) => fetch(proxy.url + '/v1/messages', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': auth }, body: JSON.stringify(value) });
let server;
try {
  check('case plan has exactly fifty unique samples', cases.length === 50 && new Set(cases.map(c => c.id)).size === 50);
  let budget = newBudget(50);
  for (let i = 0; i < 50; i++) budget.reserve({ bytes: 1 });
  assert.throws(() => budget.reserve({ bytes: 1 }), /request_budget/);
  check('51st reservation refused and exactly fifty durable reservations', JSON.parse(fs.readFileSync(budget.file)).entries.length === 50 && budget.data.stopped === 'request_budget');
  assert.throws(() => new Budget(budget.file, { authorization: 'offline-only', maxRequests: 50, route: {} }), e => e.code === 'EEXIST');
  check('same authorization cannot reset after finish/crash', true);
  budget = newBudget(); budget.reserve({ bytes: 10 });
  check('unknown transport outcome consumes a reservation', JSON.parse(fs.readFileSync(budget.file)).entries[0].state === 'reserved_unknown');
  let mode = 'success', forwards = 0, durable = true, requestBudget;
  server = http.createServer((req, res) => {
    req.resume(); req.on('end', () => {
      if (mode === 'network') return req.socket.destroy();
      if (mode === 'http') return res.writeHead(429).end('not persisted');
      res.writeHead(200, { 'content-type': 'text/event-stream', ...(mode === 'gzip' ? { 'content-encoding': 'gzip' } : {}) });
      const events = mode === 'unknown-tool' ? [{ type: 'content_block_start', content_block: { type: 'tool_use', name: 'pwsh' } }] : mode === 'stream-error' ? [{ type: 'error' }] : [{ type: 'message_delta', delta: { stop_reason: mode === 'truncated' ? 'max_tokens' : 'end_turn' }, usage: { output_tokens: 2 } }];
      const payload = events.map(event => 'data: ' + JSON.stringify(event) + '\n\n').join('');
      res.end(mode === 'gzip' ? gzipSync(payload) : payload);
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const transport = (options, callback) => {
    forwards++;
    const saved = JSON.parse(fs.readFileSync(requestBudget.file));
    durable &&= saved.entries.at(-1)?.state === 'reserved_unknown';
    assert.equal(options.hostname, 'api.deepseek.com'); assert.equal(options.path, '/anthropic/v1/messages');
    return http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: server.address().port }, callback);
  };
  const run = async (name, input, auth = key) => {
    requestBudget = newBudget(); forwards = 0;
    const proxy = await startBudgetProxy({ budget: requestBudget, key, request: transport });
    try {
      const response = await send(proxy, input, auth); await response.text();
      return { budget: requestBudget, response, forwards };
    } finally { await proxy.close(); }
  };
  let row = await run('valid', body);
  check('official endpoint and auth preserved; reserve before transport; successful metadata only', row.forwards === 1 && durable && row.budget.data.entries[0].state === 'completed');
  const saved = fs.readFileSync(row.budget.file, 'utf8');
  check('ledger contains no API key or message body', !saved.includes(key) && !saved.includes('SYNTHETIC_SECRET_BODY'));
  mode = 'gzip'; row = await run('gzip', body);
  check('compressed stream decoded before SSE audit and downstream delivery', row.budget.data.entries[0].state === 'completed' && !row.budget.data.stopped);
  mode = 'success';
  for (const [name, input, auth] of [
    ['wrong auth', body, 'wrong'], ['missing cap', { ...body, max_tokens: undefined }], ['excess cap', { ...body, max_tokens: 385 }],
    ['extra local tool', { ...body, tools: [...body.tools, { name: 'pwsh' }] }], ['missing tool', { ...body, tools: [] }],
    ['session upload', { ...body, dsh_session_log: null }], ['package upload', { ...body, dsh_plugin_packages: [] }], ['wrong model', { ...body, model: 'other' }],
  ]) { row = await run(name, input, auth); check(name + ' rejected before outbound reservation', row.forwards === 0 && row.budget.data.entries.length === 0 && !!row.budget.data.stopped); }
  for (const fault of ['http', 'network', 'stream-error', 'truncated', 'unknown-tool']) {
    mode = fault; requestBudget = newBudget(); forwards = 0;
    const proxy = await startBudgetProxy({ budget: requestBudget, key, request: transport });
    try {
      await (await send(proxy)).text(); await (await send(proxy)).text();
      check(fault + ' stops permanently, retry not forwarded and failed call counted', forwards === 1 && requestBudget.data.entries.length === 1 && !!requestBudget.data.stopped);
    } finally { await proxy.close(); }
  }
  for (const text of ['**加粗**', '`代码`', '# 标题', '- 项目', '1、项目', '[链接](https://example.test)']) check('Markdown signal detected: ' + count, evaluate(text, cases[0], []).markdown);
  check('negative continuity reassurance not falsely labelled forgetting', !evaluate('不会忘记，聊天仍然在。', cases[0], []).forgettingClaim);
  check('explicit forgetting claim detected', evaluate('重启后会忘记。', cases[0], []).forgettingClaim);
  check('memory success needs a real matching tool', evaluate('桂花乌龙', cases[21], []).expectedToolMissing && !evaluate('桂花乌龙', cases[21], ['memory_search']).expectedToolMissing);
  console.log(JSON.stringify({ checks: count, liveRequests: 0, nativeUI: false }));
} finally {
  if (server) await new Promise(r => { server.close(r); server.closeAllConnections(); });
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + 'fatfish-persona-budget-check-')) fs.rmSync(home, { recursive: true, force: true });
}
