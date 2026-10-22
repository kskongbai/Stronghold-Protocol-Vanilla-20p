// Capacity rules shared by the server and browser: fixed card-pool groups for larger co-op rooms.
// A 1–4 player match keeps the original single shared pool; more than four players always split into groups.
import { BASE_SEATS, MAX_SEATS, MAX_DRAFT_CARDS } from './constants.js';

export const MIN_COOP_DRAFT_CARDS = MAX_DRAFT_CARDS;
export const GROUPED_POOL_MIN_PLAYERS = 5;
/** 联防 waves: at most two by default, i.e. at most four distinct helpers (owner's decision). */
export const MAX_UNITE_ROUNDS = 2;
export const MAX_UNITE_HELPERS = MAX_UNITE_ROUNDS * 2;

/** Each fixed co-op group has its own six-card page, independent of room or living-player count. */
export function coopDraftCardCount() { return MIN_COOP_DRAFT_CARDS; }

// Seat-ordered groups: the owner's table for 5–10 players (5 → 3+2, 6 → 3+3, 7 → 4+3, 8 → 4+4, 9 → 3+3+3,
// 10 → 5+5); 11–20 keep the reference fork's layouts until the owner gives their own. Return a copy so callers
// cannot alter later matches.
const POOL_GROUP_LAYOUTS = {
  5: [3, 2],
  6: [3, 3],
  7: [4, 3],
  8: [4, 4],
  9: [3, 3, 3],
  10: [5, 5],
  11: [4, 4, 3],
  12: [4, 4, 4],
  13: [5, 4, 4],
  14: [4, 4, 3, 3],
  15: [4, 4, 4, 3],
  16: [4, 4, 4, 4],
  17: [5, 4, 4, 4],
  18: [4, 4, 4, 3, 3],
  19: [4, 4, 4, 4, 3],
  20: [4, 4, 4, 4, 4],
};

/** One shared pool for up to four; five or more use fixed groups from the table above. */
export function poolGroupSizes(players) {
  if (!Number.isInteger(players) || players < 1 || players > MAX_SEATS) throw new RangeError('invalid player count');
  if (players < GROUPED_POOL_MIN_PLAYERS) return [players];
  return POOL_GROUP_LAYOUTS[players].slice();
}

/** A two/three/four-player group keeps the complete original pool; only a five-player group expands. */
export const poolCopyScale = (groupSize) => Math.max(1, groupSize / BASE_SEATS);

/** The opening pool-group count sets the Unite limit; later departures never lower it. */
export const uniteRoundLimit = (poolGroupCount) => Number.isInteger(poolGroupCount)
  ? Math.max(1, Math.min(MAX_UNITE_ROUNDS, poolGroupCount)) : 1;

/** Keep the original <=4 player unlock requirement; larger teams need proportionally more layers. */
export const coopHiddenLayerThreshold = (baseline, players) => Math.ceil(baseline * Math.max(1, players / BASE_SEATS));
