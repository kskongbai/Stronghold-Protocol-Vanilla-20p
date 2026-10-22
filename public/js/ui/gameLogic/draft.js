// ui/gameLogic/draft.js — 机变 and band-draft normalisation. Re-exported from ../gameLogic.js.
//
// Large co-op rooms (up to 20 players) draft in fixed card-pool groups: m.public.draft / m.public.sp carry `groups`,
// each with its own order, page and clock. The normalisers scope the top-level fields to the requesting player's own
// group, so screens need no separate group plumbing; `groups` stays available for the A–E group view.

import { isObj } from './shared.js';
import { PHASE } from '../../../../shared/constants.js';
import { t } from '../../../../shared/i18n.js';


// ---- 机变 / band draft normalisation ----------------------------------------------------------------------

/**
 * One draft page/stage: order, turn, picks, skips. Tolerant of index/playerId turns and object/array picks.
 * @param {any} draft
 * @param {string[]} ids fallback order
 */
function normalizeOneDraft(draft, ids) {
  const order = Array.isArray(draft?.order) && draft.order.length ? draft.order.filter((x) => typeof x === 'string') : ids;
  let turnPid = null;
  if (typeof draft?.turn === 'string') turnPid = draft.turn;
  else if (Number.isInteger(draft?.turn) && draft.turn >= 0 && draft.turn < order.length) turnPid = order[draft.turn];
  const picks = new Map();
  const src = draft?.picks;
  if (Array.isArray(src)) {
    src.forEach((v, i) => {
      if (typeof v === 'string' && order[i]) picks.set(order[i], v);
      else if (isObj(v) && typeof v.playerId === 'string' && typeof v.bandId === 'string') picks.set(v.playerId, v.bandId);
    });
  } else if (isObj(src)) {
    for (const [k, v] of Object.entries(src)) if (typeof v === 'string' && v) picks.set(k, v);
  }
  const skipsLeft = new Map();
  const sk = draft?.skipsLeft ?? draft?.skips;
  if (isObj(sk)) for (const [k, v] of Object.entries(sk)) if (Number.isFinite(v)) skipsLeft.set(k, v);
  const done = order.length > 0 && order.every((pid) => picks.has(pid));
  return { order, turnPid, picks, skipsLeft, done };
}

/**
 * Normalise m.public.draft ({order, turn, picks, skips?, groups?}) — tolerant of index/playerId turns and
 * object/array picks. With `myId` and group pages, the top-level fields are the requester's own group.
 * @param {any} draft
 * @param {any[]} [players]
 * @param {string|null} [myId]
 * @returns {{ order: string[], turnPid: string|null, picks: Map<string,string>, skipsLeft: Map<string, number>, done: boolean,
 *   turnDeadline: number, turnSeconds: number, untimed: boolean, groupId: number|null, groups: object[] }}
 */
export function normalizeDraft(draft, players = [], myId = null) {
  const ids = (Array.isArray(players) ? players : []).filter(isObj).map((p) => p.playerId);
  const groups = Array.isArray(draft?.groups)
    ? draft.groups.filter(isObj).map((g) => ({ id: g.id, playerIds: (Array.isArray(g.playerIds) ? g.playerIds : []).filter((x) => typeof x === 'string'), ...normalizeOneDraft(g, ids),
      turnDeadline: Number(g.turnDeadline) || 0, turnSeconds: Number(g.turnSeconds) || 0, untimed: !!g.untimed }))
    : [];
  const own = (myId != null && groups.find((g) => g.playerIds.includes(myId))) || null;
  // an already-normalised group is used as is (its picks/skips are Maps, its turn is `turnPid`)
  const one = own || normalizeOneDraft(draft, ids);
  return {
    order: one.order,
    turnPid: one.turnPid,
    picks: one.picks,
    skipsLeft: one.skipsLeft,
    done: one.done,
    turnDeadline: own ? own.turnDeadline : Number(draft?.turnDeadline) || 0,
    turnSeconds: own ? own.turnSeconds : Number(draft?.turnSeconds) || 0,
    untimed: own ? one.untimed : !!draft?.untimed,
    groupId: own ? own.id : null,
    groups,
  };
}

/**
 * One 机变 page: cards, picks and the current turn.
 * @param {any} sp
 * @param {string[]} ids fallback order
 */
function normalizeOneSp(sp, ids) {
  const order = Array.isArray(sp.order) && sp.order.length ? sp.order.filter((x) => typeof x === 'string') : ids;
  const cards = (Array.isArray(sp.cards) ? sp.cards : []).slice(0, 6).map((c, idx) => {
    const card = typeof c === 'string' ? { id: c } : isObj(c) ? { ...c } : {};
    return { ...card, idx, takenBy: typeof card.takenBy === 'string' ? card.takenBy : null };
  });
  const takenBy = new Map(); // idx → playerId
  const pickOf = new Map(); // playerId → idx
  const src = sp.picks;
  const add = (pid, idx) => {
    if (typeof pid !== 'string' || !Number.isInteger(idx) || idx < 0 || idx >= cards.length) return;
    takenBy.set(idx, pid);
    pickOf.set(pid, idx);
  };
  if (Array.isArray(src)) src.forEach((v, i) => { if (isObj(v)) add(v.playerId, v.idx); else if (Number.isInteger(v) && order[i]) add(order[i], v); });
  else if (isObj(src)) for (const [k, v] of Object.entries(src)) add(k, v);
  if (isObj(sp.taken)) for (const [k, v] of Object.entries(sp.taken)) add(v, Number(k));
  for (const c of cards) if (c.takenBy) add(c.takenBy, c.idx);
  for (const c of cards) c.takenBy = takenBy.get(c.idx) ?? null;
  let turnPid = null;
  if (typeof sp.turn === 'string') turnPid = sp.turn;
  else if (Number.isInteger(sp.turn) && sp.turn >= 0 && sp.turn < order.length) turnPid = order[sp.turn];
  return {
    family: typeof sp.family === 'string' ? sp.family : null,
    name: typeof sp.name === 'string' && sp.name ? sp.name : null,
    desc: typeof sp.desc === 'string' && sp.desc ? sp.desc : null,
    cards, order, turnPid, pickOf, takenBy, pickedCount: pickOf.size,
  };
}

/**
 * Normalise m.public.sp ({family, cards, turn, picks, order?, groups?}).
 * Cards: string ids or objects; picks: {playerId: cardIdx} | [{playerId, idx}] | card.takenBy.
 * With `myId` and group pages, the top-level fields are the requester's own group.
 * @param {any} sp
 * @param {any[]} [players]
 * @param {string|null} [myId]
 */
export function normalizeSp(sp, players = [], myId = null) {
  if (!isObj(sp)) return null;
  const ids = (Array.isArray(players) ? players : []).filter(isObj).map((p) => p.playerId);
  const groups = Array.isArray(sp.groups)
    ? sp.groups.filter(isObj).map((g) => ({ id: g.id, playerIds: (Array.isArray(g.playerIds) ? g.playerIds : []).filter((x) => typeof x === 'string'), ...normalizeOneSp(g, ids),
      untimed: !!g.untimed, done: !!g.done, turnDeadline: Number(g.turnDeadline) || 0, turnSeconds: Number(g.turnSeconds) || 0 }))
    : [];
  const own = (myId != null && groups.find((g) => g.playerIds.includes(myId))) || null;
  // an already-normalised group is used as is (its picks/taken are Maps, its turn is `turnPid`)
  const one = own || normalizeOneSp(sp, ids);
  return {
    family: one.family,
    name: one.name,
    desc: one.desc,
    cards: one.cards,
    order: one.order,
    turnPid: one.turnPid,
    pickOf: one.pickOf,
    takenBy: one.takenBy,
    pickedCount: one.pickedCount,
    untimed: own ? one.untimed : !!sp.untimed,
    turnDeadline: own ? own.turnDeadline : Number(sp.turnDeadline) || 0,
    turnSeconds: own ? own.turnSeconds : Number(sp.turnSeconds) || 0,
    groupId: own ? own.id : null,
    groups,
  };
}

/** Adapt only the recipient's current PREP choice; never write it into the public draft. */
export function normalizePersonalChoice(pub, priv, myId) {
  const choice = priv?.personalChoice;
  if (pub?.phase !== PHASE.PREP || !priv || priv.playerId !== myId || priv.alive === false
    || !choice || choice.round !== pub.round) return null;
  return {
    ...normalizeSp({ family: 'bounty', name: t('教鞭 · 战术特训'), desc: t('请选择一项战术特训'),
      cards: choice.cards, turn: myId, order: [myId], picks: {} }),
    id: choice.id,
  };
}
