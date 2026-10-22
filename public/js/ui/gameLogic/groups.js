// ui/gameLogic/groups.js — fixed shared-pool groups (20-player capacity): A–E labels, colours and roster sections.
// m.public.poolGroups is every fixed group of the match (assigned by occupied seat order at the start:
// 1–4 players one pool; 5+ split as 3+2, 3+3, 4+3, 4+4, 3+3+3, 5+5 … shared/playerCapacity.js). Only the roster
// and draft screens read it here; the server owns the pools themselves.

import { sortedPlayers } from './shared.js';
import { poolGroupSizes, GROUPED_POOL_MIN_PLAYERS } from '../../../../shared/playerCapacity.js';

/** Group labels in group-id order (no group beyond E exists: MAX_SEATS 20 / 4 per group = 5). */
export const POOL_GROUP_LABELS = Object.freeze(['A', 'B', 'C', 'D', 'E']);
/** Badge / section colours, one per group (A–E). */
export const POOL_GROUP_COLORS = Object.freeze(['#4ed8af', '#f2c14e', '#e85a1a', '#7aa2f7', '#c77dff']);

/**
 * The room's planned card-pool groups before the match starts: the occupied seats in seat order, split by the same
 * table the server uses at the start (shared/playerCapacity.js). A live preview — the final groups are fixed when
 * the match starts. 1–4 players stay one pool and get no A–E badges.
 * @param {(null | { seat: number, playerId: string, name?: string, isBot?: boolean })[]} seats normalized seats
 * @returns {{ grouped: boolean, count: number, sizes: number[], groups: {id:number,label:string,color:string,players:any[]}[],
 *   bySeat: Map<number, {id:number,label:string,color:string}> }}
 */
export function previewPoolGroups(seats) {
  const list = (Array.isArray(seats) ? seats : []).filter((s) => s && typeof s === 'object');
  const count = list.length;
  const grouped = count >= GROUPED_POOL_MIN_PLAYERS;
  const sizes = count ? (grouped ? poolGroupSizes(count) : [count]) : [];
  const groups = [];
  let at = 0;
  for (let i = 0; i < sizes.length; i++) {
    const players = list.slice(at, at + sizes[i]);
    at += sizes[i];
    groups.push({ id: i + 1, label: POOL_GROUP_LABELS[i] || String(i + 1), color: POOL_GROUP_COLORS[i % POOL_GROUP_COLORS.length], players });
  }
  const bySeat = new Map();
  if (grouped) {
    for (const g of groups) for (const s of g.players) if (Number.isInteger(s.seat)) bySeat.set(s.seat, { id: g.id, label: g.label, color: g.color });
  }
  return { grouped, count, sizes, groups, bySeat };
}

/** The match's fixed pool groups, in id order (empty for a solo match / an older server). */
export function poolGroups(pub) {
  const list = Array.isArray(pub?.poolGroups) ? pub.poolGroups : [];
  return list
    .filter((g) => g && Number.isInteger(g.id) && Array.isArray(g.playerIds))
    .sort((a, b) => a.id - b.id)
    .map((g, i) => ({
      id: g.id,
      label: POOL_GROUP_LABELS[i] || String(g.id),
      color: POOL_GROUP_COLORS[i % POOL_GROUP_COLORS.length],
      playerIds: g.playerIds.filter((x) => typeof x === 'string'),
      scale: Number(g.scale) || 1,
    }));
}

/** The fixed pool group a player belongs to ({ id, label, color, … }), or null (solo / older server / spectator). */
export function poolGroupOf(pub, playerId) {
  if (typeof playerId !== 'string') return null;
  return poolGroups(pub).find((g) => g.playerIds.includes(playerId)) || null;
}

/**
 * The roster as fixed-pool sections: [{ group, players }] in group order. Without groups (solo, up to four players,
 * an older server) one section with `group: null` and every player in seat order.
 */
export function poolGroupSections(pub) {
  const players = sortedPlayers(pub);
  const byId = new Map(players.map((p) => [p.playerId, p]));
  const groups = poolGroups(pub);
  if (!groups.length) return [{ group: null, players }];
  return groups.map((g) => ({
    group: g,
    players: g.playerIds.map((id) => byId.get(id)).filter(Boolean),
  }));
}

/** True when the match drafts and pools in more than one fixed group (the A–E UI shows then). */
export function groupedMatch(pub) {
  return poolGroups(pub).length > 1;
}
