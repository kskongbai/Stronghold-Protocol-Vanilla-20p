// server/match/match/admin.js — the live admin controls for a match that runs in a match host.
//
// The lobby's admin console talks to a normal Match through `room.match.players`; a plugin match is a MatchProxy in
// another process, so it has no player objects in the lobby. These two methods are the small, explicit bridge:
// `adminState` returns the same player snapshot the admin page renders, and `admin` applies the same bounded actions.
// They are deliberately not protocol frames: only the local admin gateway can call them through the proxy.

const int = (v, lo, hi, fallback) => {
  const n = Math.trunc(Number(v));
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
};
const text = (v, n) => (typeof v === 'string' ? v.trim().slice(0, n) : '');

export class MatchAdmin {
  /** The live player snapshot used by the admin console (same fields as the in-process admin gateway). */
  adminState() {
    const players = [];
    for (const ps of this.players?.values?.() || []) {
      if (!ps || ps.isBot) continue;
      players.push({
        id: ps.playerId, name: ps.name, seat: ps.seat, left: !!ps.left, connected: ps.connected !== false,
        funds: ps.funds ?? 0, lp: ps.lp ?? 0, deployCap: ps.deployCap ?? 0, deployCount: ps.deployCount ?? 0,
        shopLevel: ps.shop?.level ?? 0, layers: { ...(ps.layers || {}) },
        bonds: Object.entries(ps.bonds || {}).filter(([, b]) => b && b.active).map(([id]) => id),
        items: (Array.isArray(ps.items) ? ps.items : []).map((i) => (i && (i.itemId || i.id)) || null).filter(Boolean).slice(0, 30),
      });
    }
    // The room's content may add operators/bonds/items that the lobby's base catalog does not know. Send the match's
    // own catalog with the snapshot so the admin page's selects can offer them.
    const chess = [];
    for (const id of (this.gd?.visibleChess || Object.keys(this.gd?.raw?.chess || {}))) {
      const c = this.gd?.chess?.(id) || this.gd?.raw?.chess?.[id];
      if (c) chess.push({ id: c.chessId || id, name: c.name || id, py: '', initials: '' });
    }
    const bonds = [];
    for (const id of (this.gd?.bondIds || Object.keys(this.gd?.raw?.bonds || {}))) {
      const b = this.gd?.bond?.(id) || this.gd?.raw?.bonds?.[id];
      if (b) bonds.push({ id: b.bondId || id, name: b.name || id, py: '', initials: '' });
    }
    const items = [];
    for (const id of Object.keys(this.gd?.raw?.items || {})) {
      const it = this.gd?.item?.(id);
      if (it) items.push({ id: it.itemId || id, name: it.name || id, py: '', initials: '' });
    }
    return { players, catalog: { chess: chess.slice(0, 600), bonds, items: items.slice(0, 600) } };
  }

  /** Apply one admin action. `body` is the admin API body; only the player-level actions reach this method. */
  admin(body) {
    const ps = this.players?.get?.(text(body?.player, 64));
    if (!ps || ps.isBot) return { error: 'PLAYER_NOT_FOUND' };
    const action = text(body?.action, 32);
    if (action === 'funds') {
      const amount = int(body.amount, -9999, 99999, 0);
      if (body.mode === 'set') ps.funds = Math.max(0, amount);
      else ps.addFunds(amount);
      ps.dirty(); this.markPrivate(ps);
      return { ok: true, funds: ps.funds };
    }
    if (action === 'chess') {
      const id = text(body.id, 80);
      if (!id) return { error: 'BAD_TARGET' };
      const n = int(body.count, 1, 20, 1);
      let given = 0;
      for (let i = 0; i < n; i++) if (ps.acquireChess(id, { source: 'grant' })) given++;
      ps.dirty(); this.markPrivate(ps);
      return { ok: given > 0, given };
    }
    if (action === 'grantAllOperators') {
      let given = 0;
      const list = (this.gd?.visibleChess || []).slice(0, 600);
      for (const id of list) if (ps.acquireChess(id, { source: 'grant' })) given++;
      ps.dirty(); this.markPrivate(ps);
      return { ok: true, given };
    }
    if (action === 'item') {
      const id = text(body.id, 80);
      if (!id || !this.gd?.item?.(id)) return { error: 'BAD_TARGET' };
      const n = int(body.count, 1, 20, 1);
      let given = 0;
      for (let i = 0; i < n; i++) if (ps.acquireItem(id, { source: 'grant', displayed: true })) given++;
      ps.dirty(); this.markPrivate(ps);
      return { ok: given > 0, given };
    }
    if (action === 'bond') {
      const id = text(body.id, 80);
      const layers = int(body.layers, 0, 999, 0);
      if (!this.gd?.bond?.(id)) return { error: 'BAD_TARGET' };
      ps.layers[id] = layers;
      ps.recompute();
      ps.dirty(); this.markPrivate(ps);
      return { ok: true, layers: ps.layers[id] };
    }
    if (action === 'deployCap') {
      const value = int(body.value, 1, 99, ps.deployCap);
      ps.deployCapMin = Math.max(ps.deployCapMin || 0, value);
      ps.dirty(); this.markPrivate(ps);
      return { ok: true, deployCap: ps.deployCap };
    }
    if (action === 'lp') {
      const value = int(body.value, 0, 99999, ps.lp);
      ps.lp = value; ps.dirty(); this.markPrivate(ps);
      return { ok: true, lp: ps.lp };
    }
    if (action === 'teamLp') {
      this.teamLp = int(body.value, 0, 99999, this.teamLp ?? 0);
      this.markPublic();
      return { ok: true, teamLp: this.teamLp };
    }
    if (action === 'bossHp') {
      if (!this.bossPool) return { error: 'NO_BOSS' };
      this.bossPool.hp = int(body.value, 0, this.bossPool.maxHp || 99999, this.bossPool.hp);
      this.markPublic();
      return { ok: true, hp: this.bossPool.hp };
    }
    if (action === 'shopLevel') {
      const value = int(body.value, 1, this.gd?.maxShopLevel || 6, ps.shop?.level || 1);
      if (!ps.shop) return { error: 'NO_SHOP' };
      ps.shop.level = value; ps.dirty(); this.markPrivate(ps);
      return { ok: true, shopLevel: ps.shop.level };
    }
    return { error: 'BAD_ACTION' };
  }
}
