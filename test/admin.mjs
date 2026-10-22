// Admin console: off without the plugin, on with it; key/browser login and live actions.
import wsPkg from '../node_modules/ws/index.js';
const { WebSocket } = wsPkg;
import { startServer } from '../server/index.js';
import { renameSync, existsSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pluginDir = `${root}\\plugins\\admin-console`;
const parked = `${root}\\_tmp_ref\\admin-console-parked`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const json = async (url, opts = {}) => {
  const res = await fetch(url, opts);
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
};

if (!existsSync(parked)) mkdirSync(parked, { recursive: true });
// 1. OFF: with the plugin folder moved out, /admin must be absent and no key created.
renameSync(pluginDir, `${parked}\\admin-console`);
let srv;
try {
  srv = await startServer({ port: 0, quiet: true });
  assert.equal(srv.admin, null, 'no admin without the plugin');
  const off = await fetch(`${srv.url}/admin/`);
  assert.equal(off.status, 404, '/admin is 404 without the plugin');
  await srv.close();
  srv = null;
} finally {
  if (srv) await srv.close().catch(() => {});
  renameSync(`${parked}\\admin-console`, pluginDir);
}

// 2. ON: the installed plugin creates the gateway and prints its key.
srv = await startServer({ port: 0, quiet: true });
try {
  assert.ok(srv.admin?.key, 'admin key exists with the plugin');
  const page = await fetch(`${srv.url}/admin/`);
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.ok(html.includes('/admin/app.js'));
  const wrong = await json(`${srv.url}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: 'WRONG', name: 'Boss', browser: 'browser-a' }) });
  assert.equal(wrong.status, 401);
  const login = await json(`${srv.url}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: srv.admin.key, name: 'Boss', browser: 'browser-a' }) });
  assert.equal(login.status, 200);
  const other = await json(`${srv.url}/admin/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key: srv.admin.key, name: 'Boss', browser: 'browser-b' }) });
  assert.equal(other.status, 409, 'the same admin name is bound to one browser');

  // a real room + match for live actions
  const ws = new WebSocket(`${srv.url.replace('http', 'ws')}/ws`);
  let lastRoom = null;
  let lastPub = null;
  let welcome = null;
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'room.state') lastRoom = m;
    if (m.t === 'm.public') lastPub = m;
    if (m.t === 'welcome') welcome = m;
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  ws.send(JSON.stringify({ t: 'hello', name: 'AdminTest', version: 1 }));
  for (let i = 0; i < 100 && !welcome; i++) await pause(30);
  assert.ok(welcome?.playerId, 'hello welcome');
  const req = (msg) => new Promise((resolve, reject) => {
    const rid = Math.floor(Math.random() * 1e9);
    const timer = setTimeout(() => reject(new Error(`req ${msg.t} timeout`)), 10000);
    const h = (raw) => { const m = JSON.parse(String(raw)); if (m.rid === rid) { clearTimeout(timer); ws.off('message', h); resolve(m); } };
    ws.on('message', h);
    ws.send(JSON.stringify({ ...msg, rid }));
  });
  await pause(150);
  assert.equal((await req({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', capacity: 8 })).t, 'ok');
  for (let i = 0; i < 3; i++) assert.equal((await req({ t: 'room.addBot' })).t, 'ok');
  assert.equal((await req({ t: 'room.start' })).t, 'ok');
  for (let i = 0; i < 200 && !(lastPub && lastRoom?.inMatch); i++) await pause(30);
  assert.ok(lastRoom?.inMatch, 'room is in a match');
  const code = lastRoom.code;
  const auth = { 'X-SP-Admin': srv.admin.key, 'X-SP-Admin-Browser': 'browser-a', 'X-SP-Admin-Name': 'Boss' };
  const state1 = await json(`${srv.url}/admin/api/state`, { headers: auth });
  assert.equal(state1.status, 200);
  const room = state1.body.state.rooms.find((r) => r.code === code);
  assert.ok(room && room.players.some((p) => p.name === 'AdminTest'), 'admin sees the live player');
  assert.ok(state1.body.state.catalog.chess.length > 0 && state1.body.state.catalog.bonds.length > 0, 'catalog present');

  const action = (body) => json(`${srv.url}/admin/api/action`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const funds = await action({ room: code, player: welcome.playerId, action: 'funds', mode: 'set', amount: 777 });
  assert.equal(funds.status, 200);
  assert.equal(funds.body.funds, 777);
  const cap = await action({ room: code, player: welcome.playerId, action: 'deployCap', value: 99 });
  assert.equal(cap.body.deployCap, 99);
  const unite = await action({ room: code, action: 'unite', rounds: 6, helpers: 3 });
  assert.equal(unite.status, 200);
  assert.deepEqual(unite.body.unite, { rounds: 6, helpers: 3 });
  const bond = await action({ room: code, player: welcome.playerId, action: 'bond', id: state1.body.state.catalog.bonds[0].id, layers: 4 });
  assert.equal(bond.status, 200);
  const state2 = await json(`${srv.url}/admin/api/state`, { headers: auth });
  const room2 = state2.body.state.rooms.find((r) => r.code === code);
  assert.deepEqual(room2.unite, { rounds: 6, helpers: 3 });
  assert.equal(room2.players[0].funds, 777);
  assert.equal(room2.players[0].deployCap, 99);
  console.log('\nADMIN PASSED');
  ws.close();
} finally {
  await srv.close();
}

