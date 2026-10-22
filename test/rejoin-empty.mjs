// Empty-room rejoin + 回到房间: all humans leave -> the room stays joinable; 回到房间 restores the seats after the match.
import wsPkg from '../node_modules/ws/index.js';
const { WebSocket } = wsPkg;
import { startServer } from '../server/index.js';
import assert from 'node:assert/strict';

const srv = await startServer({ port: 0, quiet: true });
const url = `ws://127.0.0.1:${srv.port}/ws`;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[rejoin]', ...a);

const open = async () => {
  const ws = new WebSocket(url);
  const c = { ws, pub: null, room: null, last: null, pid: null };
  ws.on('message', (raw) => {
    const m = JSON.parse(String(raw));
    if (m.t === 'welcome') c.pid = m.playerId;
    if (m.t === 'm.public') c.pub = m;
    if (m.t === 'room.state') c.room = m;
    if (m.t === 'room.closed') c.closed = m;
  });
  await new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); });
  return c;
};
const req = (c, msg) => new Promise((res, rej) => {
  const rid = Math.floor(Math.random() * 1e9);
  const timer = setTimeout(() => { c.ws.off('message', h); rej(new Error(`timeout ${msg.t}`)); }, 10000);
  const h = (raw) => {
    const m = JSON.parse(String(raw));
    if (m.rid === rid) { clearTimeout(timer); c.ws.off('message', h); res(m); }
  };
  c.ws.on('message', h);
  c.ws.send(JSON.stringify({ ...msg, rid }));
});
const wait = async (pred, ms = 8000, label = 'state') => {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (pred()) return true; await pause(40); }
  throw new Error(`timeout ${label}`);
};

const clients = [];
try {
  const a = await open(); clients.push(a);
  a.ws.send(JSON.stringify({ t: 'hello', name: 'HostA', version: 1 }));
  await pause(200);
  const created = await req(a, { t: 'room.create', mode: 'coop', difficulty: 'FUNNY', capacity: 8 });
  assert.equal(created.t, 'ok');
  await wait(() => a.room && a.room.code, 3000, 'created room.state');
  const code = a.room.code;
  log('room', code);
  const b = await open(); clients.push(b);
  b.ws.send(JSON.stringify({ t: 'hello', name: 'HostB', version: 1 }));
  await pause(150);
  assert.equal((await req(b, { t: 'room.join', code })).t, 'ok');
  for (let i = 0; i < 6; i++) assert.equal((await req(a, { t: 'room.addBot' })).t, 'ok');
  assert.equal((await req(b, { t: 'room.ready', ready: true })).t, 'ok');
  assert.equal((await req(a, { t: 'room.start' })).t, 'ok');
  await wait(() => a.pub && a.pub.phase, 8000, 'match start');
  log('match started', a.pub.phase);

  // both humans exit to the lobby: the match ends, but the room must still be joinable
  assert.equal((await req(a, { t: 'g.leave' })).t, 'ok');
  assert.equal((await req(b, { t: 'g.leave' })).t, 'ok');
  await pause(500);
  const c = await open(); clients.push(c);
  c.ws.send(JSON.stringify({ t: 'hello', name: 'RejoinC', version: 1 }));
  await pause(150);
  let joined = null;
  for (let i = 0; i < 20 && !joined; i++) {
    const r = await req(c, { t: 'room.join', code });
    if (r.t === 'ok') joined = r; else await pause(150);
  }
  assert.ok(joined, 'a bot-only room is joinable again after every human left');
  await wait(() => c.room && c.room.code === code, 3000, 'room.state');
  assert.equal(c.room.inMatch, false, 'the abandoned match ended');
  assert.equal(c.room.hostId, c.pid, 'the joining human became host');
  log('rejoined room', code, 'seats', c.room.seats.filter(Boolean).length);

  // second match, both humans choose 回到房间: the match ends and both seats come back to the same room
  const d = await open(); clients.push(d);
  d.ws.send(JSON.stringify({ t: 'hello', name: 'StayD', version: 1 }));
  await pause(150);
  assert.equal((await req(d, { t: 'room.join', code })).t, 'ok');
  assert.equal((await req(d, { t: 'room.ready', ready: true })).t, 'ok');
  assert.equal((await req(c, { t: 'room.start' })).t, 'ok');
  await wait(() => c.pub && c.pub.phase, 8000, 'second match');
  assert.equal((await req(c, { t: 'g.leave', stay: true })).t, 'ok');
  assert.equal((await req(d, { t: 'g.leave', stay: true })).t, 'ok');
  await wait(() => c.room && c.room.inMatch === false, 8000, 'stay match end');
  await pause(200);
  const seats = (c.room.seats || []).filter(Boolean);
  const cSeat = seats.find((s) => s.playerId === c.pid || s.name === 'RejoinC');
  const dSeat = seats.find((s) => s.name === 'StayD');
  assert.ok(cSeat && !cSeat.waiting && !cSeat.left, 'the 回到房间 seat is restored to the lobby');
  assert.ok(dSeat && !dSeat.waiting && !dSeat.left, 'every 回到房间 seat is restored');
  assert.ok(c.room.hostId, 'the room has a host again');
  log('stay restored', code, 'seats', seats.length, 'host', c.room.hostId);
  console.log('\nREJOIN PASSED');
} finally {
  for (const c of clients) { try { c.ws.close(); } catch { /* ignore */ } }
  await srv.close();
}
