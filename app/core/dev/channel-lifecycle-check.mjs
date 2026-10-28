/** Loopback-only regression: a stopped channel's old reconnect timer must not duplicate a new connection. */
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { QQChannel } from "../channels/qq.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const wait = async (fn) => { for (let i = 0; i < 250; i++) { if (fn()) return; await sleep(20); } throw new Error("channel_lifecycle_timeout"); };
let connections = 0, channel;
const backend = new WebSocketServer({ host: "127.0.0.1", port: 0 });
backend.on("connection", (ws) => { connections++; ws.on("message", (buf) => { const m = JSON.parse(buf); ws.send(JSON.stringify({ status: "ok", retcode: 0, echo: m.echo, data: { user_id: 90000 } })); }); });
try {
  await once(backend, "listening"); channel = new QQChannel({ url: `ws://127.0.0.1:${backend.address().port}`, token: "fixture" });
  channel.start(); await wait(() => channel.state === "online");
  channel.stop(); await wait(() => channel.state === "offline");
  await sleep(100); channel.start(); await wait(() => connections === 2 && channel.state === "online");
  await sleep(3200);
  assert.equal(connections, 2, "stop/start must retain exactly one new connection, not fire the old reconnect timer");
  console.log("PASS channel stop/start cancels obsolete reconnects (2 total connections)");
} finally { channel?.stop(); for (const ws of backend.clients) ws.terminate(); await new Promise((r) => backend.close(r)); }
