/** Explicit one-shot live sampling. Native UI and QQ channel objects are never constructed. */
import fs from 'node:fs';
import http from 'node:http';
import { createGzip } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import fixture from '../../app/core/dev/license-fixture.cjs';
import modelConfig from '../../app/core/model-config.cjs';
import persona from '../../app/electron-ui/persona-lib.js';
import { Budget, startBudgetProxy, sha } from './budget.mjs';
import { cases, evaluate } from './cases.mjs';
const AUTHORIZATION = 'call_9b6bc011512b4aca8ea8036ac70e0686';
const EVIDENCE = 'C:/Users/caidengfeng/.codex/visualizations/2026/10/24/01a16f76-c9b5-70c2-a81d-9b843307a01e/fatfish-persona-live-50';
const live = process.argv.includes('--live'), offline = process.argv.includes('--offline');
if (live === offline || live && !process.argv.includes('--allow-max-requests=50')) throw Error('explicit_mode_and_live_budget_required');
const home = fs.mkdtempSync(join(tmpdir(), 'fatfish-persona-sample-'));
const evidence = live ? EVIDENCE : join(EVIDENCE + '-offline', home.split(/[\\/]/).at(-1));
fs.mkdirSync(evidence, { recursive: true });
let budget, manager, proxy, fixtureProxy, compressionServer, fatal = null, stopped = null, nextTool = null;
const rows = [], toolRows = []; let sdkPid = null, memoryTotal = null, restarted = false;
const report = () => ({ at: new Date().toISOString(), authorization: live ? AUTHORIZATION : 'offline-only', live, nativeUI: false, realQQ: false, historicalDataRead: false,
  maxRequests: live ? 50 : 10, reservedRequests: budget?.data.entries.length || 0, completedTurns: rows.filter(r => r.completed).length, targetTurns: live ? 50 : 3,
  samplingPassed: live && rows.length === 50 && rows.every(r => r.completed && !Object.values(r.flags).some(Boolean)),
  semanticHumanReview: false, automatedSignalsOnly: true, stopped, fatal, restarted, memoryTotal, sdkPid, rows, tools: toolRows });
const emitReport = () => { if (budget) fs.writeFileSync(join(evidence, 'sample-report.json'), JSON.stringify(report(), null, 2)); };
const signal = () => { fatal = 'user_interrupted'; budget?.stop(fatal); manager?.stop().catch(() => {}); };
process.once('SIGINT', signal); process.once('SIGTERM', signal);
try {
  const selected = live ? modelConfig.read(join(tmpdir(), 'fatfish-m3e-live-UPJfi5')) : { key: 'sk-offline-synthetic-not-real', route: modelConfig.normalize() };
  if (!selected.key || selected.keyError || JSON.stringify(selected.route) !== JSON.stringify(modelConfig.normalize())) throw Error('authorized_temporary_route_unavailable');
  budget = new Budget(join(evidence, 'request-ledger.json'), { authorization: live ? AUTHORIZATION : 'offline-only', maxRequests: live ? 50 : 10, route: selected.route });
  const licensed = fixture.licensedFixture(home);
  process.env.FATFISH_APPDATA = home; Object.assign(process.env, licensed.env);
  // All module imports resolving app data must happen AFTER setting the fresh root.
  const { ensureDirs } = await import(pathToFileURL(join(licensed.core, 'paths.mjs')));
  const { InstanceManager } = await import(pathToFileURL(join(licensed.core, 'instance-manager.mjs')));
  const { EngineHost } = await import(pathToFileURL(join(licensed.core, 'engine-host.mjs')));
  const { MemoryStore } = await import(pathToFileURL(join(licensed.core, 'memory-store.mjs')));
  const { MemoryService } = await import(pathToFileURL(join(licensed.core, 'memory-service.mjs')));
  ensureDirs();
  fs.writeFileSync(join(home, 'config.json'), JSON.stringify({ channels: { qq: { enabled: false } } }));
  modelConfig.save(home, { ...selected.route, key: selected.key });
  persona.ensurePersonaLib(home);
  const patch = join(home, 'sampling.patch.json');
  fs.writeFileSync(patch, JSON.stringify([{ id: 'llm-retry', disabled: true }, { id: 'llm-deepseek', config: { thinking: 'disabled', reasoningEffort: 'off', maxTokens: 384 } }]));
  let transport;
  if (offline) {
    const { startModelProxy } = await import('../../app/core/dev/model-proxy.mjs');
    fixtureProxy = await startModelProxy({ reply: () => '桂花乌龙 纸风车732', tool: () => { const call = nextTool; nextTool = null; return call; } });
    const upstreamFixture = new URL(fixtureProxy.url);
    compressionServer = http.createServer((req, res) => {
      const request = http.request({ hostname: '127.0.0.1', port: upstreamFixture.port, path: req.url, method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, { 'content-type': response.headers['content-type'], 'content-encoding': 'gzip' });
        response.pipe(createGzip()).pipe(res);
      });
      request.on('error', () => { if (!res.headersSent) res.writeHead(502); res.end(); });
      req.pipe(request);
    });
    await new Promise(r => compressionServer.listen(0, '127.0.0.1', r));
    const u = new URL('http://127.0.0.1:' + compressionServer.address().port);
    transport = (options, callback) => http.request({ ...options, protocol: 'http:', hostname: '127.0.0.1', port: u.port, path: '/v1/messages' }, callback);
  }
  proxy = await startBudgetProxy({ budget, key: selected.key, request: transport, onFatal: code => { fatal ||= code; } });
  process.env.FATFISH_DEV_DEEPSEEK_BASE_URL = proxy.url;
  const store = new MemoryStore({ root: home }); let service;
  if (store.list().total !== 0) throw Error('fresh_memory_required');
  manager = new InstanceManager({ remoteEnabled: true, authorizeExternal: c => c.channel === 'qq' && c.account === '10001',
    onTool: request => {
      if (request.plugin !== 'fatfish-memory') { fatal ||= 'unexpected_reminder_operation'; budget.stop(fatal); return { ok: false, error: 'not_part_of_sampling' }; }
      const result = service.tool(request);
      toolRows.push({ instance: request.instance, op: request.op, ok: result.ok });
      if (!result.ok) { fatal ||= 'memory_tool_error'; budget.stop(fatal); }
      return result;
    }, createHost: opts => new EngineHost({ ...opts, extraPatches: [...opts.extraPatches, patch] }) });
  service = new MemoryService({ store, instances: manager, isOwner: (channel, account) => channel === 'qq' && account === '10001' });
  fs.writeFileSync(join(evidence, 'source-snapshot.json'), JSON.stringify({
    core: licensed.manifest, personaBodyHash: sha(persona.BUILTIN.body), patch: JSON.parse(fs.readFileSync(patch)),
    casesHash: sha(fs.readFileSync(new URL('./cases.mjs', import.meta.url))), budgetHash: sha(fs.readFileSync(new URL('./budget.mjs', import.meta.url))),
    route: selected.route, outputCap: 384, noRetries: true, usesStandardInstanceManagerAndMemoryService: true,
  }, null, 2));
  if (!await manager.start()) throw Error('engine_start_failed');
  sdkPid = manager.hosts.get('external').client.child.pid;
  const plan = live ? cases : [cases[0], cases[20], cases[21]];
  for (const test of plan) {
    if (fatal || budget.data.stopped) { stopped = fatal || budget.data.stopped; break; }
    if (budget.data.entries.length >= budget.data.maxRequests) { stopped = 'request_budget'; budget.stop(stopped); break; }
    // Exercise production session resume without modifying or reading any old user context.
    if (live && test.id === 26) {
      await manager.hosts.get('external').stop();
      if (!await manager.start()) throw Error('engine_restart_failed');
      restarted = true;
    }
    if (offline && test.expectedTool) nextTool = { name: test.expectedTool, input: test.expectedTool === 'memory_save' ? { text: '虚构测试饮品 桂花乌龙，不加糖' } : { query: '桂花乌龙' } };
    const before = budget.data.entries.length, started = Date.now();
    const result = await manager.turn('external', manager.externalSessionId, test.text, { channel: 'qq', account: '10001' });
    const entries = budget.data.entries.slice(before), tools = entries.flatMap(e => e.toolCalls || []);
    const text = result.text || '';
    const row = { id: test.id, category: test.category, promptHash: sha(test.text), responseHash: sha(text), chars: text.length, ms: Date.now() - started,
      requests: entries.length, toolCalls: tools, completed: result.ok && !fatal && entries.length > 0 && entries.every(e => e.state === 'completed'),
      flags: evaluate(text, test, tools), error: result.ok ? null : result.error };
    rows.push(row); emitReport();
    console.log(JSON.stringify({ sample: row.id, completed: row.completed, requestsUsed: budget.data.entries.length, flags: row.flags }));
    if (!row.completed || Object.values(row.flags).some(Boolean)) { stopped = fatal || (!row.completed ? 'turn_failed' : 'sample_quality_failure'); budget.stop(stopped); break; }
  }
  memoryTotal = store.list().total;
  stopped ||= rows.length === plan.length ? 'planned_samples_finished' : 'request_budget';
  budget.stop(stopped);
} catch (e) {
  if (offline) console.log(JSON.stringify({ offlineErrorCode: e.code || null, offlineErrorClass: e.name, location: e.stack?.split('\n').slice(1, 3).map(line => line.replace(/\([^)]*\)/g, '(location)')) }));
  // Do not emit SDK/provider exception messages or stacks (they may include content/secrets).
  stopped ||= e.code === 'EEXIST' ? 'one_shot_authorization_already_started' : 'sampling_runtime_error';
  if (stopped !== 'one_shot_authorization_already_started') budget?.stop(stopped);
  console.log(JSON.stringify({ stopped })); process.exitCode = 1;
} finally {
  await manager?.stop(); await proxy?.close();
  if (compressionServer) await new Promise(r => { compressionServer.close(r); compressionServer.closeAllConnections(); });
  await fixtureProxy?.close();
  emitReport();
  if (live && !report().samplingPassed) process.exitCode = 1;
  console.log(JSON.stringify({ report: live ? join(evidence, 'sample-report.json') : 'offline-only', live, stopped, reservedRequests: budget?.data.entries.length || 0, completedTurns: rows.filter(r => r.completed).length }));
  // The fresh SDK sessions and copied test key are deliberately not kept in evidence.
  if (resolve(home).startsWith(resolve(tmpdir()) + sep + 'fatfish-persona-sample-')) fs.rmSync(home, { recursive: true, force: true });
  process.removeListener('SIGINT', signal); process.removeListener('SIGTERM', signal);
}
