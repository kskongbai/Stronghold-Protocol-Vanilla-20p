// server/admin/index.js — the optional live admin gateway.
//
// It exists ONLY while the `admin-console` plugin is installed and loaded (the plugin is the switch): a server without
// that folder has no /admin route, no key and no process state. Installing the plugin and restarting enables it; removing
// it and restarting disables it again.
//
//   GET  /admin/                 the console page (core-served; the plugin page only points here)
//   GET  /admin/app.js|app.css   its assets
//   POST /admin/api/login        { key, name, browser } → binds an admin name to one browser id
//   GET  /admin/api/state        rooms, matches, players and the catalog (key + browser headers)
//   POST /admin/api/action       one live action (key + browser headers)
//
// The key is generated once, kept in plugins/.admin-key and printed at startup. A name is bound to the first browser id
// that logs in with it in plugins/.admin-identity.json; another browser using the same name is refused.
import { timingSafeEqual, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { sendJson, sendError } from '../http/common.js';
import { studioAllowed } from '../studio/gate.js';
import { pinyin } from 'pinyin-pro';

const MAX_BODY = 64 * 1024;
const MAX_LOGIN = 120; // attempts per address per minute (a NAT/tunnel shares one address)
const pyCache = new Map();
const nameText = (v) => (typeof v === 'string' ? v : (v && (v.zh || v.en)) || '');
const pinyinOf = (name) => {
  const s = nameText(name);
  if (!s) return { py: '', initials: '' };
  if (pyCache.has(s)) return pyCache.get(s);
  let out;
  try { out = { py: pinyin(s, { toneType: 'none', type: 'array' }).join('').toLowerCase(), initials: pinyin(s, { pattern: 'first', toneType: 'none', type: 'array' }).join('').toLowerCase() }; }
  catch { out = { py: '', initials: '' }; }
  pyCache.set(s, out);
  return out;
};

const rand = (n) => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = randomBytes(n);
  let out = '';
  for (const b of bytes) out += alphabet[b % alphabet.length];
  return out;
};
const clampInt = (v, min, max, fallback) => (Number.isInteger(v) ? Math.min(max, Math.max(min, v)) : fallback);
const text = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const readBody = (req) => new Promise((resolve, reject) => {
  const len = Number(req.headers['content-length']);
  if (Number.isFinite(len) && len > MAX_BODY) { req.resume(); reject(new Error('body too large')); return; }
  const chunks = [];
  let n = 0;
  req.on('data', (chunk) => {
    n += chunk.length;
    if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); return; }
    chunks.push(chunk);
  });
  req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  req.on('error', reject);
});
const readJson = async (req) => {
  const raw = await readBody(req);
  let v;
  try { v = JSON.parse(raw || '{}'); } catch { throw new Error('body is not JSON'); }
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('body is not an object');
  return v;
};
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  try { return timingSafeEqual(Buffer.from(a), Buffer.from(b)); } catch { return false; }
};

/**
 * @param {{ lobby: any, registry: any, pluginsDir: string, log: any }} opts
 * @returns {null | { enabled: true, key: string, url: string, handles: Function, handle: Function }}
 */
export function createAdmin({ lobby, registry, pluginsDir, log }) {
  // The plugin is the switch; no plugin folder → this module is never created.
  let installed = false;
  try { installed = registry.plugins().some((p) => p && p.id === 'admin-console' && p.status === 'loaded'); } catch { installed = false; }
  if (!installed) return null;

  const keyPath = path.join(pluginsDir, '.admin-key');
  let key;
  try { key = readFileSync(keyPath, 'utf8').trim(); } catch { key = ''; }
  if (!/^[A-Za-z0-9]{8,32}$/.test(key)) {
    key = rand(16);
    try { mkdirSync(pluginsDir, { recursive: true }); writeFileSync(keyPath, `${key}\n`, { mode: 0o600 }); } catch (e) { log.warn(`[admin] cannot write ${keyPath}: ${e.message}`); }
  }
  const attempts = new Map();
  const pageDir = new URL('.', import.meta.url);
  const page = readFileSync(new URL('./page.html', pageDir), 'utf8');
  const appJs = readFileSync(new URL('./app.js', pageDir), 'utf8');
  const appCss = readFileSync(new URL('./app.css', pageDir), 'utf8');

  // The console is for this machine / the LAN by default. The owner may explicitly expose it through the NAT/tunnel
  // hostname below; the key + browser-bound admin name are still required for every API call.
  const PUBLIC_ADMIN_HOSTS = new Set(['ne.rainplay.cn']);
  const gate = (req) => {
    const host = String(req.headers.host || '').toLowerCase().replace(/:\d+$/, '');
    if (PUBLIC_ADMIN_HOSTS.has(host)) return true;
    const g = studioAllowed(req, { mode: 'lan' });
    return !!g.ok;
  };
  const headerKey = (req) => text(req.headers['x-sp-admin'], 64);
  const headerBrowser = (req) => text(req.headers['x-sp-admin-browser'], 64);
  const headerName = (req) => text(req.headers['x-sp-admin-name'], 32);
  const authed = (req) => {
    if (!safeEqual(headerKey(req), key)) return null;
    return { name: headerName(req) || 'Admin', browser: headerBrowser(req) || 'key' };
  };

  const pluginBonds = () => {
    const out = [];
    const seen = new Set();
    const add = (b) => {
      if (!b || typeof b.bondId !== 'string' || !b.bondId || seen.has(b.bondId)) return;
      const name = nameText(b.name) || b.bondId;
      const { py, initials } = pinyinOf(name);
      seen.add(b.bondId);
      out.push({ id: b.bondId, name, py, initials });
    };
    try {
      for (const d of readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!d.isDirectory() || d.name.startsWith('.')) continue;
        const dir = path.join(pluginsDir, d.name);
        let manifest;
        try { manifest = JSON.parse(readFileSync(path.join(dir, 'plugin.json'), 'utf8')); } catch { continue; }
        if (manifest?.class !== 'content') continue;
        for (const file of ['data/records.json', 'data/patch.json']) {
          let j;
          try { j = JSON.parse(readFileSync(path.join(dir, file), 'utf8')); } catch { continue; }
          for (const e of j?.entries || []) if (e?.file === 'bonds' && e.value) add(e.value);
          for (const op of j?.ops || []) if (op?.file === 'bonds' && op.value && typeof op.value === 'object' && op.path?.[0] !== 'members' && op.path?.[0] !== 'visibleMembers') add(op.value);
        }
      }
    } catch { /* plugins folder unreadable: official bonds only */ }
    return out;
  };

  const catalog = () => {
    // A match's GameData gives the lists; a room without a match still has the lobby's data through any room's gd.
    let gd = null;
    for (const r of lobby.rooms?.values?.() || []) { if (r && !r.disposed && r.match?.gd) { gd = r.match.gd; break; } }
    if (!gd) return { chess: [], bonds: [], items: [] };
    const chess = (gd.visibleChess || []).map((id) => {
      const c = gd.chess(id);
      if (!c) return null;
      const { py, initials } = pinyinOf(c.name);
      return { id: c.chessId, name: c.name, py, initials, tier: c.tier, profession: c.profession, bonds: Array.isArray(c.bonds) ? c.bonds : [] };
    }).filter(Boolean).slice(0, 600);
    const bonds = [];
    const bondSeen = new Set();
    for (const id of gd.bondIds || []) {
      const b = gd.bond(id);
      if (!b || bondSeen.has(b.bondId)) continue;
      const { py, initials } = pinyinOf(b.name);
      bondSeen.add(b.bondId);
      bonds.push({ id: b.bondId, name: b.name, py, initials });
    }
    for (const b of pluginBonds()) {
      if (bondSeen.has(b.id)) continue;
      bondSeen.add(b.id);
      bonds.push(b);
    }
    const items = Object.keys(gd.raw?.items || {}).map((id) => {
      const it = gd.item(id);
      if (!it) return null;
      const { py, initials } = pinyinOf(it.name || id);
      return { id: it.itemId || id, name: it.name || id, py, initials };
    }).filter(Boolean).slice(0, 400);
    return { chess, bonds, items };
  };

  const pluginChoices = () => {
    let list = [];
    try { list = registry.plugins?.() || []; } catch { list = []; }
    const classLabel = { content: '内容', cosmetic: '外观' };
    const out = [];
    for (const p of list) {
      if (!p || p.status !== 'loaded' || !['content', 'cosmetic'].includes(p.class)) continue;
      let meta = null;
      try { meta = JSON.parse(readFileSync(path.join(pluginsDir, p.id, 'plugin.json'), 'utf8')); } catch { meta = null; }
      out.push({
        id: p.id,
        name: nameText(meta?.name) || nameText(p.name) || p.id,
        version: String(meta?.version || p.version || ''),
        class: p.class, classLabel: classLabel[p.class] || p.class,
        desc: nameText(meta?.description) || nameText(p.description) || '',
      });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
  };

  const publicState = async () => {
    const rooms = [];
    for (const room of lobby.rooms?.values?.() || []) {
      if (!room || room.disposed) continue;
      const m = room.match;
      const players = [];
      let roomCatalog = null;
      if (m?.players && !m.hosted) {
        for (const ps of m.players.values()) {
          if (!ps || ps.isBot) continue;
          players.push({
            id: ps.playerId, name: ps.name, seat: ps.seat, left: !!ps.left, connected: ps.connected !== false,
            funds: ps.funds ?? 0, lp: ps.lp ?? 0, deployCap: ps.deployCap ?? 0, deployCount: ps.deployCount ?? 0,
            shopLevel: ps.shop?.level ?? 0, layers: { ...(ps.layers || {}) },
            bonds: Object.entries(ps.bonds || {}).filter(([, b]) => b && b.active).map(([id]) => id),
            items: (Array.isArray(ps.items) ? ps.items : []).map((i) => (i && (i.itemId || i.id)) || null).filter(Boolean).slice(0, 30),
          });
        }
      } else if (m?.hosted && typeof m.adminState === 'function') {
        // A plugin match lives in a match host subprocess: ask it for the same live snapshot.
        try {
          const live = await m.adminState();
          if (Array.isArray(live?.players)) players.push(...live.players);
          if (live?.catalog) roomCatalog = live.catalog;
        } catch { /* host busy/stopped: keep the room with seats only */ }
      }
      // Empty rooms / bot-only rooms are not management targets. A disconnected human still owns a seat, so it stays
      // manageable; only left/absent seats make a room empty. Match data can omit players for a plugin-hosted match, so
      // the seat list is the authority for "is someone here", not the match player table.
      const humanSeats = (room.seats || []).filter((s) => s && !s.isBot && !s.left);
      const humanSpectators = (room.spectators || []).filter((s) => s && !s.isBot && !s.left);
      if (!humanSeats.length && !humanSpectators.length) continue;
      rooms.push({
        code: room.code, mode: room.mode, inMatch: !!m, phase: m?.phase || null,
        hosted: !!m?.hosted, unite: { ...(room.uniteSettings || { rounds: 2, helpers: 2 }) },
        plugins: (room.content?.plugins || []).map((p) => p.id),
        seats: (room.seats || []).filter(Boolean).map((s) => ({ seat: s.seat, name: s.name, isBot: !!s.isBot, left: !!s.left, connected: s.connected !== false })),
        players,
        catalog: roomCatalog,
      });
    }
    return { server: { name: 'Stronghold Protocol', now: Date.now() }, rooms, catalog: catalog(), pluginChoices: pluginChoices(), uniteDefaults: { rounds: 2, helpers: 2 } };
  };

  const apply = async (body) => {
    const code = text(body.room, 16).toUpperCase();
    const room = [...(lobby.rooms?.values?.() || [])].find((r) => r && !r.disposed && r.code === code);
    if (!room) return { error: 'ROOM_NOT_FOUND' };
    const action = text(body.action, 32);
    if (action === 'plugins') {
      if (room.match) return { error: 'ROOM_STARTED' };
      const ids = Array.isArray(body.plugins) ? body.plugins.map((x) => text(x, 64)).filter(Boolean) : [];
      const r = lobby.adminSetPlugins(room, ids);
      return r && r.error ? { error: r.error, detail: r.detail } : { ok: true };
    }
    if (action === 'unite') {
      const rounds = clampInt(body.rounds, 2, 99, 2);
      const helpers = clampInt(body.helpers, 1, 99, 2);
      room.uniteSettings = { rounds, helpers };
      if (room.match && !room.match.hosted) room.match.uniteSettings = { rounds, helpers };
      return { ok: true, unite: { rounds, helpers } };
    }
    const m = room.match;
    if (!m) return { error: 'NO_MATCH' };
    if (m.hosted) {
      // Plugin matches run in a match host; forward the same bounded action to the worker Match.admin().
      if (typeof m.admin !== 'function') return { error: 'HOSTED_MATCH' };
      const r = await m.admin(body);
      return r && r.error ? r : r;
    }
    const ps = m.players?.get(text(body.player, 64));
    if (!ps || ps.isBot) return { error: 'PLAYER_NOT_FOUND' };
    if (action === 'funds') {
      const amount = clampInt(Number(body.amount), -9999, 99999, 0);
      if (body.mode === 'set') ps.funds = Math.max(0, amount);
      else ps.addFunds(amount);
      ps.dirty(); m.markPrivate(ps);
      return { ok: true, funds: ps.funds };
    }
    if (action === 'chess') {
      const id = text(body.id, 80);
      if (!id) return { error: 'BAD_TARGET' };
      const n = clampInt(body.count, 1, 20, 1);
      let given = 0;
      for (let i = 0; i < n; i++) if (ps.acquireChess(id, { source: 'grant' })) given++;
      ps.dirty(); m.markPrivate(ps);
      return { ok: given > 0, given };
    }
    if (action === 'grantAllOperators') {
      let given = 0;
      const list = (m.gd.visibleChess || []).slice(0, 600);
      for (const id of list) if (ps.acquireChess(id, { source: 'grant' })) given++;
      ps.dirty(); m.markPrivate(ps);
      return { ok: true, given };
    }
    if (action === 'item') {
      const id = text(body.id, 80);
      if (!id || !m.gd.item(id)) return { error: 'BAD_TARGET' };
      const n = clampInt(body.count, 1, 20, 1);
      let given = 0;
      for (let i = 0; i < n; i++) if (ps.acquireItem(id, { source: 'grant', displayed: true })) given++;
      ps.dirty(); m.markPrivate(ps);
      return { ok: given > 0, given };
    }
    if (action === 'bond') {
      const id = text(body.id, 80);
      const layers = clampInt(body.layers, 0, 999, 0);
      if (!m.gd.bond(id)) return { error: 'BAD_TARGET' };
      ps.layers[id] = layers;
      ps.recompute();
      ps.dirty(); m.markPrivate(ps);
      return { ok: true, layers: ps.layers[id] };
    }
    if (action === 'deployCap') {
      const value = clampInt(body.value, 1, 99, ps.deployCap);
      ps.deployCapMin = Math.max(ps.deployCapMin || 0, value);
      ps.dirty(); m.markPrivate(ps);
      return { ok: true, deployCap: ps.deployCap };
    }
    if (action === 'lp') {
      const value = clampInt(body.value, 0, 99999, ps.lp);
      ps.lp = value; ps.dirty(); m.markPrivate(ps);
      return { ok: true, lp: ps.lp };
    }
    if (action === 'teamLp') {
      m.teamLp = clampInt(body.value, 0, 99999, m.teamLp ?? 0);
      m.markPublic();
      return { ok: true, teamLp: m.teamLp };
    }
    if (action === 'bossHp') {
      if (!m.bossPool) return { error: 'NO_BOSS' };
      m.bossPool.hp = clampInt(body.value, 0, m.bossPool.maxHp || 99999, m.bossPool.hp);
      m.markPublic();
      return { ok: true, hp: m.bossPool.hp };
    }
    if (action === 'shopLevel') {
      const value = clampInt(body.value, 1, m.gd.maxShopLevel || 6, ps.shop?.level || 1);
      if (!ps.shop) return { error: 'NO_SHOP' };
      ps.shop.level = value; ps.dirty(); m.markPrivate(ps);
      return { ok: true, shopLevel: ps.shop.level };
    }
    return { error: 'BAD_ACTION' };
  };

  const handleApi = async (req, res, rawPath) => {
    if (rawPath === '/admin/api/login' && req.method === 'POST') {
      const ip = req.socket?.remoteAddress || '';
      const now = Date.now();
      const list = (attempts.get(ip) || []).filter((t) => now - t < 60_000);
      if (list.length >= MAX_LOGIN) { sendJson(req, res, 429, { error: 'TOO_MANY' }); return; }
      list.push(now); attempts.set(ip, list);
      let body;
      try { body = await readJson(req); } catch { sendJson(req, res, 400, { error: 'BAD_REQUEST' }); return; }
      if (!safeEqual(text(body.key, 64), key)) { sendJson(req, res, 401, { error: 'BAD_KEY' }); return; }
      const name = text(body.name, 32) || 'Admin';
      attempts.delete(ip);
      sendJson(req, res, 200, { ok: true, name, state: await publicState() });
      return;
    }
    if (rawPath === '/admin/api/state' && req.method === 'GET') {
      const who = authed(req);
      if (!who) { sendJson(req, res, 401, { error: 'UNAUTHORIZED' }); return; }
      sendJson(req, res, 200, { ok: true, me: who, state: await publicState() });
      return;
    }
    if (rawPath === '/admin/api/action' && req.method === 'POST') {
      const who = authed(req);
      if (!who) { sendJson(req, res, 401, { error: 'UNAUTHORIZED' }); return; }
      let body;
      try { body = await readJson(req); } catch { sendJson(req, res, 400, { error: 'BAD_REQUEST' }); return; }
      let result;
      try { result = await apply(body); } catch (e) { log.warn(`[admin] action failed: ${e.message}`); result = { error: 'ACTION_FAILED' }; }
      if (result.error) { sendJson(req, res, 400, result); return; }
      sendJson(req, res, 200, { ...result, state: await publicState() });
      return;
    }
    sendJson(req, res, 404, { error: 'NOT_FOUND' });
  };

  const handle = async (req, res, rawPath) => {
    if (!gate(req)) { sendError(req, res, 404, '页面不存在 · Not found'); return; }
    if (rawPath === '/admin') { res.writeHead(302, { Location: '/admin/' }); res.end(); return; }
    if (rawPath === '/admin/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(page);
      return;
    }
    if (rawPath === '/admin/app.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(appJs);
      return;
    }
    if (rawPath === '/admin/app.css') {
      res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(appCss);
      return;
    }
    if (rawPath.startsWith('/admin/api/')) { await handleApi(req, res, rawPath); return; }
    sendError(req, res, 404, '页面不存在 · Not found');
  };

  const pageUrl = (base) => `${String(base).replace(/\/$/, '')}/admin/`;
  log.info(`[admin] enabled by the admin-console plugin; key ${key} (${pageUrl('http://localhost')})`);
  return { enabled: true, key, pageUrl, handles: (p) => p === '/admin' || p.startsWith('/admin/'), handle };
}
