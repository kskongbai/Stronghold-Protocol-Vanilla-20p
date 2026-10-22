// 20-player capacity smoke test: a real server + 20 real WebSocket sessions. Run with `node test/capacity-20p.mjs`.
// Covers room creation/join/display/spectate/resize/ready/start, fixed pool groups, parallel band drafts,
// the round-1 prep shop per group and every seat readying into combat. Room capacities are 4/8/10/16/20.
import wsPkg from '../node_modules/ws/index.js';
const { WebSocket } = wsPkg;
import { startServer } from '../server/index.js';
import { getData } from '../server/data.js';

const N = 20;
const CAPACITY = 20;
const BANDS = Object.keys(getData().bands);

const srv = await startServer({ port: 0, quiet: true });
const url = `ws://127.0.0.1:${srv.port}/ws`;
const log = (...a) => console.log('[smoke]', ...a);
let failed = 0;
const assert = (cond, msg) => { if (cond) log('ok  ', msg); else { failed++; log('FAIL', msg); } };

class Client {
  constructor(i) {
    this.i = i;
    this.name = `P${i + 1}`;
    this.ws = new WebSocket(url);
    this.frames = [];
    this.waiters = [];
    this.ridSeq = 1;
    this.pending = new Map();
    this.ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      this.frames.push(msg);
      if (msg.rid && this.pending.has(msg.rid)) { this.pending.get(msg.rid)(msg); this.pending.delete(msg.rid); }
      for (const w of [...this.waiters]) if (w.pred(msg)) { this.waiters.splice(this.waiters.indexOf(w), 1); w.resolve(msg); }
      if (msg.t === 'm.public') this.pub = msg;
      if (msg.t === 'room.state') this.room = msg;
    });
  }
  opened() {
    if (this.ws.readyState === 1) return Promise.resolve();
    return new Promise((res, rej) => { this.ws.once('open', res); this.ws.once('error', rej); });
  }
  send(msg) { this.ws.send(JSON.stringify(msg)); }
  wait(pred, ms = 15000, label = 'frame') {
    // a broadcast may have arrived before this waiter was installed: match the newest recorded frame first
    for (let i = this.frames.length - 1; i >= 0; i--) if (pred(this.frames[i])) return Promise.resolve(this.frames[i]);
    return new Promise((resolve, reject) => {
      const w = { pred, resolve: (m) => { clearTimeout(t); resolve(m); }, reject };
      const t = setTimeout(() => { this.waiters.splice(this.waiters.indexOf(w), 1); reject(new Error(`${this.name}: timeout waiting for ${label}`)); }, ms);
      this.waiters.push(w);
    });
  }
  waitType(t, ms) { return this.wait(this.predFirst(undefined, t), ms, t); }
  predFirst(pred, t) { return (m) => m.t === t && (!pred || pred(m)); }
  /** request -> its ok/error reply, echoing rid */
  async req(msg, ms = 15000) {
    const rid = this.ridSeq++;
    const p = new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${this.name}: timeout ${msg.t}`)), ms);
      this.pending.set(rid, (m) => { clearTimeout(t); resolve(m); });
    });
    this.send({ ...msg, rid });
    return p;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  log('server on', url, 'bands', BANDS.length);
  const clients = [];
  for (let i = 0; i < N; i++) clients.push(new Client(i));
  await Promise.all(clients.map((c) => c.opened()));
  const welcomes = await Promise.all(clients.map((c, i) => {
    c.send({ t: 'hello', name: c.name, version: 1, rid: 1000 + i });
    return c.waitType('welcome', 20000);
  }));
  assert(welcomes.every((w) => typeof w.playerId === 'string'), 'all 20 sessions got a welcome with playerId');
  const host = clients[0];

  // create a 20-seat room
  const created = await host.req({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', capacity: CAPACITY });
  assert(created.t === 'ok', `room.create capacity 20 -> ${created.t}${created.code ? ` ${created.code}` : ''}`);
  let state = await host.waitType('room.state');
  const code = state.code || created.code;
  assert(state.capacity === CAPACITY, `room.state.capacity ${state.capacity}`);
  assert(Array.isArray(state.seats) && state.seats.length === CAPACITY, `room.state.seats ${state.seats?.length}`);

  // host resizes down while empty and back up
  const down = await host.req({ t: 'room.setCapacity', capacity: 10 });
  assert(down.t === 'ok', `room.setCapacity 10 (empty) -> ${down.t}`);
  state = await host.wait(host.predFirst((m) => m.capacity === 10, 'room.state'), 5000, 'state 10');
  assert(state.seats.length === 10, `resized seats ${state.seats.length}`);
  const up = await host.req({ t: 'room.setCapacity', capacity: CAPACITY });
  assert(up.t === 'ok', `room.setCapacity 20 -> ${up.t}`);
  state = await host.wait(host.predFirst((m) => m.capacity === 20, 'room.state'), 5000, 'state 20');
  assert(state.seats.length === 20, `resized back to ${state.seats.length} seats`);

  // invalid capacities are refused (before any seat is occupied)
  const badCapEarly = await host.req({ t: 'room.setCapacity', capacity: 7 });
  assert(badCapEarly.t === 'error' && badCapEarly.code === 'BAD_MSG', `room.setCapacity 7 refused (${badCapEarly.code})`);
  const badCreate = await clients[N - 2].req({ t: 'room.create', mode: 'coop', difficulty: 'FUNNY', capacity: 5 });
  assert(badCreate.t === 'error' && badCreate.code === 'BAD_MSG', `room.create capacity 5 refused (${badCreate.code})`);

  // one spectator (does not take a player seat)
  const spectator = clients[N - 1];
  const sp = await spectator.req({ t: 'room.spectate', code });
  assert(sp.t === 'ok', `room.spectate -> ${sp.t} ${sp.code || ''} ${sp.detail || ''}`);
  state = await host.wait(host.predFirst((m) => (m.spectators || []).length === 1, 'room.state'), 5000, 'spectator state');
  assert(state.spectators[0].playerId === welcomes[N - 1].playerId, 'spectator listed without a player seat');
  const spSeat = state.seats.find((s) => s && s.playerId === welcomes[N - 1].playerId);
  assert(!spSeat, 'spectator owns no player seat');

  // 19 players join (the spectator sits it out)
  for (let i = 1; i < N - 1; i++) {
    const r = await clients[i].req({ t: 'room.join', code });
    assert(r.t === 'ok', `${clients[i].name} joined (${r.t}${r.code || ''})`);
  }
  state = await host.wait(host.predFirst((m) => m.seats.filter(Boolean).length === N - 1, 'room.state'), 5000, 'full-ish state');
  assert(state.seats.filter(Boolean).length === N - 1, `room.state lists ${state.seats.filter(Boolean).length} players (spectator excluded)`);
  assert(state.seats[0].playerId === welcomes[0].playerId, 'host owns seat 0');

  // everyone readies
  for (let i = 1; i < N - 1; i++) {
    const r = await clients[i].req({ t: 'room.ready', ready: true });
    if (r.t !== 'ok') assert(false, `${clients[i].name} ready ${r.t} ${r.code || ''}`);
  }
  state = await host.wait(host.predFirst((m) => m.seats.filter((s) => s && s.ready).length >= N - 2, 'room.state'), 5000, 'all ready');
  assert(state.seats.filter((s) => s && s.ready).length === N - 2, `ready seats ${state.seats.filter((s) => s && s.ready).length}/${N - 1}`);

  // start
  const started = await host.req({ t: 'room.start' });
  assert(started.t === 'ok', `room.start -> ${started.t}${started.code ? ` ${started.code}` : ''}`);
  const pub0 = await host.wait(host.predFirst((m) => m.phase === 'INFO_CHECK', 'm.public'), 15000, 'INFO_CHECK');
  assert(pub0.playerCount === N - 1, `m.public.playerCount ${pub0.playerCount}`);
  assert(Array.isArray(pub0.poolGroups) && pub0.poolGroups.length === 5, `pool groups ${pub0.poolGroups?.map((g) => g.playerIds.length).join('+')}`);
  assert(pub0.poolGroups.every((g) => g.playerIds.length >= 3), 'each pool group holds 3-4 seats');
  const flat = pub0.poolGroups.flatMap((g) => g.playerIds);
  assert(new Set(flat).size === N - 1, `pool groups cover every player once (${flat.length})`);

  // the running match really gives one shared pool to each group (not one per player, not one for all)
  const liveMatch = srv.lobby.rooms.get(code)?.match;
  assert(!!liveMatch, 'server holds the running match');
  if (liveMatch) {
    const groupA = liveMatch.poolGroups[0];
    const groupB = liveMatch.poolGroups[1];
    const a1 = groupA.playerIds[0], a2 = groupA.playerIds[1], b1 = groupB.playerIds[0];
    assert(liveMatch.poolFor(a1) === liveMatch.poolFor(a2), 'two players of one group share the same chess pool object');
    assert(liveMatch.poolFor(a1) !== liveMatch.poolFor(b1), 'different groups hold different chess pools');
    assert(liveMatch.itemPoolFor(a1) === liveMatch.itemPoolFor(a2), 'two players of one group share the same equipment pool');
    assert(liveMatch.itemPoolFor(a1) !== liveMatch.itemPoolFor(b1), 'different groups hold different equipment pools');
    const base = [...groupA.pool.entries.keys()].find((id) => groupA.pool.left(id) > 0);
    const beforeA = groupA.pool.left(base);
    const beforeB = groupB.pool.left(base);
    const other = groupA.playerIds[1];
    liveMatch.players.get(other).poolOf(base).take(base, 1, { overdraw: true });
    assert(groupA.pool.left(base) === beforeA - 1, `a group purchase lowers its shared pool (${beforeA} -> ${groupA.pool.left(base)})`);
    assert(!groupB.pool.has(base) || groupB.pool.left(base) === beforeB, 'another group pool is untouched');
  }

  // info ready
  const revision = pub0.setupRevision;
  for (let i = 0; i < N - 1; i++) {
    const r = await clients[i].req({ t: 'g.infoReady', setupRevision: revision });
    if (r.t !== 'ok') assert(false, `${clients[i].name} infoReady ${r.t}`);
  }

  // strategy draft: each group drafts in parallel with its own page
  const pub = await host.wait(host.predFirst((m) => m.phase === 'BAND_DRAFT', 'm.public'), 20000, 'BAND_DRAFT');
  assert(pub.draft?.groups?.length === 5, `band draft groups ${pub.draft?.groups?.length}`);
  assert(typeof pub.draft.id === 'string', `band draft id ${pub.draft.id}`);
  const picked = new Map(); // playerId -> bandId
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const p = host.pub;
    if (p.phase !== 'BAND_DRAFT') break;
    let acted = false;
    for (let i = 0; i < N - 1; i++) {
      const pid = welcomes[i].playerId;
      const grp = p.draft.groups.find((x) => x.playerIds.includes(pid));
      if (!grp || grp.done || grp.turn !== pid || picked.has(pid)) continue;
      const taken = new Set(Object.values(grp.picks || {}));
      const bandId = BANDS.find((b) => !taken.has(b)) || BANDS[0];
      const r = await clients[i].req({ t: 'g.band', bandId, draftId: p.draft.id, groupId: grp.id });
      if (r.t !== 'ok') assert(false, `${clients[i].name} g.band ${r.t} ${r.code || ''}`);
      picked.set(pid, bandId);
      acted = true;
    }
    if (!acted) await sleep(60);
  }
  assert(picked.size === N - 1, `strategy picks ${picked.size}/${N - 1}`);
  // picks per fixed group (public draft views are coalesced: the last round may only reach BATTLE_CHECK)
  const perGroupPicks = pub0.poolGroups.map((g) => g.playerIds.filter((pid) => picked.has(pid)).length);
  const sumPicks = perGroupPicks.reduce((s, n) => s + n, 0);
  assert(perGroupPicks.length === 5 && perGroupPicks.every((n) => n > 0), `picks per group ${perGroupPicks.join('+')}`);
  assert(sumPicks === N - 1, `group picks total ${sumPicks}/${N - 1}`);

  // the draft finishes; every player has a strategy and the match enters BATTLE_CHECK / ROUND_START
  const battle = await host.wait(host.predFirst((m) => m.phase === 'BATTLE_CHECK' || m.phase === 'ROUND_START' || m.phase === 'PREP', 'm.public'), 20000, 'after band draft');
  assert(true, `phase after the draft: ${battle.phase}`);
  const players = battle.players || [];
  assert(players.length === N - 1, `m.public players ${players.length}`);
  const noBand = players.filter((x) => !x.bandId);
  assert(noBand.length === 0, `every player has a strategy (missing: ${noBand.map((x) => x.name).join(',') || 'none'})`);

  // the finished draft lists no player twice
  const seen = new Set(host.frames.flatMap((m) => (m.t === 'm.public' && m.phase === 'BAND_DRAFT' && m.draft?.groups ? m.draft.groups.flatMap((g) => g.playerIds) : [])));
  assert(seen.size === N - 1, 'draft groups cover every player once');

  // round 1 prep: every seat got its own private view, can shop from its group's pool, and readies into combat
  const prep = await host.wait(host.predFirst((m) => m.phase === 'PREP' && m.round === 1, 'm.public'), 30000, 'PREP');
  assert(prep.phase === 'PREP', `round ${prep.round} prep reached`);
  const privCount = clients.slice(0, N - 1).filter((c) => c.frames.some((m) => m.t === 'm.private' && m.playerId)).length;
  assert(privCount === N - 1, `${privCount}/${N - 1} players received their own m.private`);
  const buyCodes = [];
  for (let i = 0; i < N - 1; i++) {
    const r = await clients[i].req({ t: 'g.buy', slot: 0 });
    buyCodes.push(r.t === 'ok' ? 'ok' : r.code || 'err');
  }
  const buysOk = buyCodes.filter((c) => c === 'ok').length;
  assert(buysOk === N - 1 || buysOk >= N - 4, `shop buys from the group pools: ${buysOk}/${N - 1} ok (${[...new Set(buyCodes)].join(',')})`);
  for (let i = 0; i < N - 1; i++) {
    const r = await clients[i].req({ t: 'g.ready', ready: true });
    if (r.t !== 'ok') assert(false, `${clients[i].name} prep ready ${r.t} ${r.code || ''}`);
  }
  const combat = await host.wait(host.predFirst((m) => m.phase === 'COMBAT', 'm.public'), 30000, 'COMBAT');
  assert(combat.phase === 'COMBAT', 'all seats ready -> COMBAT');
  assert(combat.fields.length === N - 1, `combat fields ${combat.fields.length}/${N - 1}`);
  assert(combat.players.filter((p) => p.status === 'combat' || p.status === 'done').length === N - 1, 'every seat has a field status');

  // pool groups: the owner's table for 5-10 players, then the reference layouts (shared/playerCapacity.js)
  const { createPoolGroups, SharedPool } = await import('../server/match/pool.js');
  const fakeGd = { visibleChess: ['a', 'b', 'c'], tierOf: (id) => ({ a: 3, b: 1, c: 5 })[id], poolCopies: (id) => ({ a: 18, b: 12, c: 8 })[id], itemPoolCopies: () => 4 };
  const mk = (n) => createPoolGroups(fakeGd, Array.from({ length: n }, (_, i) => ({ seat: i, playerId: `x${i}` })));
  const sizes = (groups) => groups.map((g) => g.playerIds.length).join('+');
  const p1 = mk(1);
  const p4 = mk(4);
  const p5 = mk(5);
  const p6 = mk(6);
  const p7 = mk(7);
  const p8 = mk(8);
  const p9 = mk(9);
  const p10 = mk(10);
  const p11 = mk(11);
  const p20 = mk(20);
  assert(p1.length === 1 && sizes(p1) === '1', 'pool groups: 1 player -> 1');
  assert(p4.length === 1 && sizes(p4) === '4', 'pool groups: 4 players -> 4 (one pool)');
  assert(sizes(p5) === '3+2', `pool groups: 5 players -> ${sizes(p5)}`);
  assert(sizes(p6) === '3+3', `pool groups: 6 players -> ${sizes(p6)}`);
  assert(sizes(p7) === '4+3', `pool groups: 7 players -> ${sizes(p7)}`);
  assert(sizes(p8) === '4+4', `pool groups: 8 players -> ${sizes(p8)}`);
  assert(sizes(p9) === '3+3+3', `pool groups: 9 players -> ${sizes(p9)}`);
  assert(sizes(p10) === '5+5', `pool groups: 10 players -> ${sizes(p10)}`);
  assert(sizes(p11) === '4+4+3', `pool groups: 11 players -> ${sizes(p11)}`);
  assert(sizes(p20) === '4+4+4+4+4', `pool groups: 20 players -> ${sizes(p20)}`);
  assert(p5[0].pool.cap('b') === 12 && p5[1].pool.cap('b') === 12, `3+2 groups keep the original stock (${p5[0].pool.cap('b')}, ${p5[1].pool.cap('b')})`);
  assert(p10[0].pool.cap('b') === 15 && p10[1].pool.cap('b') === 15, `5+5 groups expand (${p10[0].pool.cap('b')}, ${p10[1].pool.cap('b')})`);
  const g5 = new SharedPool(fakeGd, { scale: 1.25 });
  assert(g5.cap('b') === 15, `five-player group: I-tier cap ${g5.cap('b')} (12 x 1.25)`);
  assert(g5.cap('a') === 22, `five-player group: III-tier cap ${g5.cap('a')} (18 x 1.25 floored)`);

  // browser-side group scoping: the draft screens read the requester's own page, never another group's
  const { normalizeDraft, normalizeSp } = await import('../public/js/ui/gameLogic/draft.js');
  const draftView = {
    id: 'band:test', untimed: false,
    groups: [
      { id: 1, playerIds: ['a', 'b', 'c'], order: ['b', 'a', 'c'], picks: { b: 'band_x' }, skipsLeft: { a: 1 }, turn: 'a', turnDeadline: 111, turnSeconds: 50, done: false },
      { id: 2, playerIds: ['d', 'e'], order: ['e', 'd'], picks: {}, skipsLeft: { d: 1 }, turn: 'e', turnDeadline: 222, turnSeconds: 50, done: false },
    ],
  };
  const mineDraft = normalizeDraft(draftView, [{ playerId: 'a' }, { playerId: 'd' }], 'a');
  assert(mineDraft.groupId === 1 && mineDraft.order.join(',') === 'b,a,c', `draft scoping: group ${mineDraft.groupId}, order ${mineDraft.order.join(',')}`);
  assert(mineDraft.turnPid === 'a' && mineDraft.turnDeadline === 111 && mineDraft.turnSeconds === 50, 'draft scoping: own turn and clock');
  assert(mineDraft.picks.get('b') === 'band_x', 'draft scoping: own group picks');
  const otherDraft = normalizeDraft(draftView, [{ playerId: 'd' }], 'd');
  assert(otherDraft.groupId === 2 && otherDraft.turnPid === 'e' && otherDraft.turnDeadline === 222, 'draft scoping: the other group sees its own turn');
  const spView = {
    untimed: false, family: 'bounty',
    groups: [
      { id: 1, playerIds: ['a', 'b'], order: ['a', 'b'], cards: [{ id: 'c1' }, { id: 'c2' }], picks: {}, taken: {}, turn: 'a', turnDeadline: 333, turnSeconds: 30 },
      { id: 2, playerIds: ['d'], order: ['d'], cards: [{ id: 'c9' }], picks: {}, taken: {}, turn: 'd', turnDeadline: 444, turnSeconds: 30 },
    ],
  };
  const mineSp = normalizeSp(spView, [{ playerId: 'a' }, { playerId: 'd' }], 'a');
  assert(mineSp.groupId === 1 && mineSp.cards.length === 2 && mineSp.turnPid === 'a' && mineSp.turnDeadline === 333, 'sp scoping: own page, turn and clock');
  const otherSp = normalizeSp(spView, [{ playerId: 'd' }], 'd');
  assert(otherSp.groupId === 2 && otherSp.cards[0].id === 'c9' && otherSp.turnDeadline === 444, 'sp scoping: the other group sees its own page');

  // group sections / badges: A-E labels and the players of each fixed pool group
  const { poolGroupSections, poolGroupOf, groupedMatch, previewPoolGroups } = await import('../public/js/ui/gameLogic/groups.js');
  const groupPub = {
    players: [
      { playerId: 'a', seat: 0, name: 'A0' }, { playerId: 'b', seat: 1, name: 'A1' },
      { playerId: 'c', seat: 2, name: 'B0' }, { playerId: 'd', seat: 3, name: 'B1' },
    ],
    poolGroups: [{ id: 1, playerIds: ['a', 'b'], scale: 1 }, { id: 2, playerIds: ['c', 'd'], scale: 1 }],
  };
  const groupSections = poolGroupSections(groupPub);
  assert(groupedMatch(groupPub) === true, 'group helper: a multi-group match is grouped');
  assert(groupSections.length === 2 && groupSections[0].group.label === 'A' && groupSections[1].group.label === 'B', 'group helper: A/B sections');
  assert(groupSections[0].players.map((p) => p.name).join(',') === 'A0,A1', 'group helper: section players follow the group');
  assert(poolGroupOf(groupPub, 'c')?.label === 'B' && poolGroupOf(groupPub, 'zzz') === null, 'group helper: player to group, unknown -> null');
  assert(poolGroupSections({ players: [{ playerId: 's', seat: 0 }] }).length === 1, 'group helper: a solo match has one unlabelled section');

  // waiting-room preview: the seat badges follow the same table as the server
  const seatList = (n) => Array.from({ length: n }, (_, i) => ({ seat: i, playerId: `p${i}`, name: `P${i}` }));
  const preview5 = previewPoolGroups([...seatList(5), null, null, null]);
  assert(preview5.grouped && preview5.sizes.join('+') === '3+2', `room preview: 5 players -> ${preview5.sizes.join('+')}`);
  assert(preview5.bySeat.get(0)?.label === 'A' && preview5.bySeat.get(2)?.label === 'A' && preview5.bySeat.get(3)?.label === 'B', 'room preview: A takes seats 1-3, B seats 4-5');
  const preview4 = previewPoolGroups(seatList(4));
  assert(!preview4.grouped && preview4.bySeat.size === 0 && preview4.count === 4, 'room preview: 4 players stay one pool (no badges)');
  const preview10 = previewPoolGroups(seatList(10));
  assert(preview10.sizes.join('+') === '5+5', `room preview: 10 players -> ${preview10.sizes.join('+')}`);

  // Unite: humans before AI, up to the group-count rounds, remaining enemies carry into the next wave
  const { planUnite, nextUnitePlan, uniteSurvivors, plannedUniteSurvivors } = await import('../server/match/unite.js');
  const P = (id, seat, isBot, units, extra = {}) => ({
    playerId: id, seat, isBot, name: id, connected: true, alive: true, left: false, autoplay: false,
    deployCount: units, bonds: {}, layers: {}, pendingLayerGains: null, board: new Map(), bounties: [], ...extra,
  });
  const uPlayers = [P('h1', 0, false, 1), P('h2', 1, false, 1), P('ai1', 2, true, 9), P('ai2', 3, true, 9), P('leak', 4, false, 1)];
  const results = new Map([
    ['h1', { leaked: [], perfect: true }], ['h2', { leaked: [], perfect: true }],
    ['ai1', { leaked: [], perfect: true }], ['ai2', { leaked: [], perfect: true }],
    ['leak', { leaked: [{ enemyKey: 'e1', sourcePlayerId: 'leak', lpr: 1, mods: null }], perfect: false }],
  ]);
  const fakeMatch = {
    isSolo: false, poolGroups: [{}, {}, {}], alivePlayers: () => uPlayers,
    gd: { unite: { maxHelpers: 2 }, enemy: (id) => (id === 'e1' ? { id } : null) },
  };
  const plan = planUnite(fakeMatch, results);
  assert(!!plan, 'unite plan: created for a leaker + perfect players');
  assert(plan.helpers.map((p) => p.playerId).join(',') === 'h1,h2', `unite plan: humans first (${plan.helpers.map((p) => p.playerId).join(',')})`);
  assert(plan.roundsMax === 2 && plan.round === 1 && plan.perRound === 2, `unite plan: ${plan.round}/${plan.roundsMax} rounds of ${plan.perRound}`);
  const wave2 = nextUnitePlan(plan, {
    perPlayer: { h1: { leaked: [{ enemyKey: 'e1', sourcePlayerId: 'leak', mods: null, lpr: 1, counted: true }] } }, unspawned: [],
  });
  assert(!!wave2 && wave2.round === 2, 'unite plan: a second wave follows remaining enemies');
  assert(wave2.helpers.map((p) => p.playerId).join(',') === 'ai1,ai2', `unite plan: next pair ${wave2.helpers.map((p) => p.playerId).join(',')}`);
  assert(wave2.usedHelpers.map((p) => p.playerId).join(',') === 'h1,h2' && wave2.leaked.length === 1, 'unite plan: history and carried leaks');
  assert(nextUnitePlan(wave2, { perPlayer: {}, unspawned: [] }) === null, 'unite plan: no next wave without remaining enemies');
  assert(uniteSurvivors(wave2, { perPlayer: { ai1: { leaked: [{ sourcePlayerId: 'leak', counted: true }] } } }).get('leak') === 1, 'unite plan: survivors are billed by source');
  assert(plannedUniteSurvivors(plan).get('leak') === 1, 'unite plan: a wave that cannot run charges its leaks');
  // admin console settings: rounds 6, 3 helpers per wave; helpers 99 = everyone until the perfect players run out
  const many = [P('a1', 0, false, 1), P('a2', 1, false, 1), P('a3', 2, false, 1), P('a4', 3, false, 1), P('a5', 4, false, 1), P('leak2', 5, false, 1)];
  const manyResults = new Map(many.map((p) => [p.playerId, p.playerId === 'leak2'
    ? { leaked: [{ enemyKey: 'e1', sourcePlayerId: 'leak2', lpr: 1, mods: null }], perfect: false }
    : { leaked: [], perfect: true }]));
  const adminMatch = { ...fakeMatch, alivePlayers: () => many, uniteSettings: { rounds: 6, helpers: 3 } };
  const adminPlan = planUnite(adminMatch, manyResults);
  assert(adminPlan.helpers.length === 3 && adminPlan.roundsMax === 2, `admin unite: 3 helpers, ${adminPlan.roundsMax} waves`);
  const allMatch = { ...fakeMatch, alivePlayers: () => many, uniteSettings: { rounds: 6, helpers: 99 } };
  const allPlan = planUnite(allMatch, manyResults);
  assert(allPlan.helpers.length === 5 && allPlan.roundsMax === 1, `admin unite: everyone in ${allPlan.helpers.length} helpers, ${allPlan.roundsMax} wave`);
  // the glue: a finished wave with survivors starts the next pair, otherwise the match settles once
  const { MatchUnite } = await import('../server/match/match/unitePhase.js');
  const glue = Object.create(MatchUnite.prototype);
  const calls = [];
  glue.phase = 'UNITE';
  glue.unitePlan = plan;
  glue.startUnite = (p) => calls.push(`wave${p.round}`);
  glue.settle = () => calls.push('settle');
  glue._afterUniteWave(plan, { perPlayer: { h1: { leaked: [{ enemyKey: 'e1', sourcePlayerId: 'leak', mods: null, lpr: 1, counted: true }] } }, unspawned: [] });
  assert(calls.at(-1) === 'wave2', `unite glue: survivors start the next wave (${calls.join(',')})`);
  glue.unitePlan = wave2;
  glue._afterUniteWave(wave2, { perPlayer: {}, unspawned: [] });
  assert(calls.at(-1) === 'settle', `unite glue: no survivors settles the round (${calls.join(',')})`);
  // the HUD capsule and the phase banner both name the current wave (1/2, 2/2 …)
  const { PhaseCapsule } = await import('../public/js/ui/hud.js');
  const textsOf = (n) => {
    const out = [];
    const walk = (x) => {
      if (x == null || x === false) return;
      if (Array.isArray(x)) { x.forEach(walk); return; }
      if (typeof x === 'string' || typeof x === 'number') { out.push(String(x)); return; }
      if (x.props) walk(x.props.children);
    };
    walk(n);
    return out;
  };
  const capsule = textsOf(PhaseCapsule({ pub: { phase: 'UNITE', unite: { round: 2, roundsMax: 2 } }, hud: { resolved: 1, total: 3 }, miss: null })).join('');
  assert(capsule.includes('联防') && capsule.includes('2/2'), `unite capsule shows the wave (${capsule})`);
  const { phaseBanner } = await import('../public/js/ui/gameLogic/phases.js');
  const banner = phaseBanner('UNITE', { phase: 'UNITE', players: [{ playerId: 'a', name: 'A' }], unite: { round: 2, roundsMax: 2, helpers: ['a'] } });
  assert(String(banner.sub).includes('2/2'), `unite banner shows the wave (${banner.sub})`);

  // finish: leave everything
  for (const c of clients) c.close();
} catch (e) {
  failed++;
  console.log('[smoke] ERROR', e && (e.stack || e.message));
} finally {
  await srv.close();
  console.log(failed ? `\nSMOKE FAILED (${failed})` : '\nSMOKE PASSED');
  process.exit(failed ? 1 : 0);
}

