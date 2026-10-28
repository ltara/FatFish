/** Dev-only, one-shot billing guard. No body, key or provider error text is persisted. */
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { createUnzip, createBrotliDecompress } from 'node:zlib';
import { StringDecoder } from 'node:string_decoder';
import contract from '../../app/core/tool-contract.cjs';
export const sha = (value) => createHash('sha256').update(value).digest('hex');
export class Budget {
  constructor(file, { authorization, maxRequests, route }) {
    if (!Number.isSafeInteger(maxRequests) || maxRequests < 1 || maxRequests > 50) throw Error('invalid_budget');
    this.file = file;
    fs.mkdirSync(dirname(file), { recursive: true });
    const fd = fs.openSync(file, 'wx', 0o600); // Never resume/reinitialize an authorization, even after a crash.
    this.data = { authorization, maxRequests, routeHash: sha(JSON.stringify(route)), pid: process.pid, started: new Date().toISOString(), stopped: null, entries: [] };
    try { fs.writeFileSync(fd, JSON.stringify(this.data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  }
  save() {
    const temp = this.file + '.' + randomUUID() + '.tmp';
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(this.data, null, 2)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, this.file);
  }
  stop(code) { if (!this.data.stopped) { this.data.stopped = code; this.save(); } }
  reserve(metadata) {
    if (this.data.stopped) throw Error('authorization_stopped');
    if (this.data.entries.length >= this.data.maxRequests) { this.stop('request_budget'); throw Error('request_budget'); }
    const entry = { ordinal: this.data.entries.length + 1, reservedAt: new Date().toISOString(), state: 'reserved_unknown', ...metadata };
    this.data.entries.push(entry); this.save(); // Must be durable BEFORE transport creation.
    return entry;
  }
  finish(entry, metadata) { Object.assign(entry, metadata); this.save(); }
}
export async function startBudgetProxy({ budget, key, maxTokens = 384, request = https.request, onFatal = () => {} }) {
  let active = null;
  const fail = (code) => { budget.stop(code); onFatal(code); };
  const server = http.createServer(async (req, res) => {
    const deny = (code) => { req.resume(); res.writeHead(409, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { type: 'guard_stopped', message: code } })); };
    if (budget.data.stopped || active) return deny('guard_stopped');
    let entry;
    try {
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 2 * 1024 * 1024) throw Error('body_too_large'); chunks.push(c); }
      const bytes = Buffer.concat(chunks), body = JSON.parse(bytes);
      if (req.method !== 'POST' || req.url !== '/v1/messages') throw Error('unexpected_endpoint');
      if (req.headers['x-api-key'] !== key && req.headers.authorization !== 'Bearer ' + key) throw Error('unexpected_auth');
      if (!contract.externalToolsMatch(body)) throw Error('unexpected_tools');
      if (Object.hasOwn(body, 'dsh_session_log') || Object.hasOwn(body, 'dsh_plugin_packages')) throw Error('private_upload_field');
      if (!Number.isSafeInteger(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > maxTokens) throw Error('output_cap_missing');
      if (body.model !== 'deepseek-flash') throw Error('unexpected_model');
      entry = budget.reserve({ bodyHash: sha(bytes), bytes: bytes.length, maxTokens: body.max_tokens, streamRequested: body.stream === true,
        compressionOffered: /(?:gzip|deflate|br)/.test(String(req.headers['accept-encoding'] || '')), toolNames: body.tools.map(t => t.name).sort(), privateUploadFields: false });
      const headers = { ...req.headers, host: 'api.deepseek.com', 'content-length': String(bytes.length) };
      delete headers.connection;
      const upstream = active = request({ protocol: 'https:', hostname: 'api.deepseek.com', port: 443, path: '/anthropic/v1/messages', method: 'POST', headers }, r => {
        const hash = createHash('sha256'), utf8 = new StringDecoder('utf8'); let responseBytes = 0, buffer = ''; const toolNames = [], stopReasons = []; let usage = null;
        const reject = code => { fail(code); upstream.destroy(); if (!res.headersSent) res.writeHead(502); res.end(); };
        if (r.statusCode !== 200) { budget.finish(entry, { state: 'http_error', status: r.statusCode }); r.resume(); return reject('upstream_http_' + r.statusCode); }
        const encoding = String(r.headers['content-encoding'] || 'identity').toLowerCase();
        budget.finish(entry, { contentType: r.headers['content-type'] || null, contentEncoding: encoding });
        if (!['identity', 'gzip', 'deflate', 'br'].includes(encoding)) return reject('unsupported_response_encoding');
        const stream = encoding === 'identity' ? r : encoding === 'br' ? r.pipe(createBrotliDecompress()) : r.pipe(createUnzip());
        // Audit and deliver the SAME decoded bytes. Never label compressed wire bytes as plain SSE.
        // Do not forward the original Content-Encoding/Content-Length after decompression.
        res.writeHead(200, { 'content-type': r.headers['content-type'] || 'text/event-stream' });
        r.on('data', chunk => { hash.update(chunk); responseBytes += chunk.length; });
        stream.on('data', chunk => {
          buffer += utf8.write(chunk);
          if (buffer.length > 1024 * 1024) return reject('response_overflow');
          const lines = buffer.split('\n'); buffer = lines.pop();
          for (const line of lines) if (line.startsWith('data:')) {
            let event; try { event = JSON.parse(line.slice(5).trim()); } catch { continue; }
            if (event.type === 'error') return reject('upstream_stream_error');
            if (event.content_block?.type === 'tool_use') { const name = event.content_block.name; toolNames.push(name); if (!contract.external.includes(name)) return reject('nonexistent_tool'); }
            if (event.delta?.stop_reason) stopReasons.push(event.delta.stop_reason);
            if (event.usage) usage = event.usage;
          }
          res.write(chunk);
        });
        stream.on('end', () => {
          active = null;
          const complete = stopReasons.length && stopReasons.every(v => ['end_turn', 'tool_use'].includes(v));
          budget.finish(entry, { state: complete ? 'completed' : 'incomplete_response', status: 200, responseHash: hash.digest('hex'), responseBytes, toolCalls: toolNames, stopReasons, usage });
          if (!complete) fail('incomplete_response');
          res.end();
        });
        r.on('aborted', () => reject('upstream_aborted'));
        r.on('error', () => reject('upstream_response_error'));
        if (stream !== r) stream.on('error', () => reject('response_decompression_error'));
      });
      upstream.setTimeout(60000, () => { fail('upstream_timeout'); upstream.destroy(); });
      upstream.on('error', () => {
        active = null;
        if (entry.state === 'reserved_unknown') budget.finish(entry, { state: 'transport_unknown' });
        fail(budget.data.stopped || 'upstream_transport_error');
        if (!res.headersSent) res.writeHead(502); res.end();
      });
      res.on('close', () => { if (!res.writableEnded) { fail('downstream_closed'); upstream.destroy(); } });
      upstream.end(bytes);
    } catch (e) { const code = ['request_budget', 'authorization_stopped', 'unexpected_endpoint', 'unexpected_auth', 'unexpected_tools', 'private_upload_field', 'output_cap_missing', 'unexpected_model', 'body_too_large'].includes(e.message) ? e.message : 'guard_internal_error'; fail(code); deny(code); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise(resolve => { active?.destroy(); server.close(resolve); server.closeAllConnections(); }) };
}
