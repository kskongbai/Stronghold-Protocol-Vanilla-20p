// The admin console page. It only talks to the core /admin/api routes; the plugin page itself is just the switch.
(() => {
  'use strict';
  const $ = (s, r = document) => r.querySelector(s);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  };
  const origin = location.origin;
  const LS = { server: 'sp.admin.server', name: 'sp.admin.name', browser: 'sp.admin.browser', key: 'sp.admin.key' };
  const browserId = (() => {
    let v = localStorage.getItem(LS.browser);
    if (!v) { v = (crypto.randomUUID ? crypto.randomUUID() : `b-${Date.now()}-${Math.random().toString(16).slice(2)}`); localStorage.setItem(LS.browser, v); }
    return v;
  })();
  let key = sessionStorage.getItem(LS.key) || '';
  let me = null;
  let state = null;
  let timer = null;
  let busy = false;

  const msg = (text, err = false) => {
    const dash = $('#dash');
    const n = dash && !dash.hidden ? $('#msg') : $('#loginMsg');
    if (!n) return;
    n.textContent = text || '';
    n.className = `msg${err ? ' err' : ''}`;
  };
  const headers = (withName = true) => ({
    'Content-Type': 'application/json',
    'X-SP-Admin': key,
    ...(withName ? { 'X-SP-Admin-Browser': browserId, 'X-SP-Admin-Name': me?.name || '' } : {}),
  });
  const api = async (path, opts = {}) => {
    const res = await fetch(path, { ...opts, headers: { ...headers(), ...(opts.headers || {}) } });
    let body = null;
    try { body = await res.json(); } catch { body = null; }
    if (!res.ok) {
      const code = body?.error || `HTTP_${res.status}`;
      const e = new Error(code); e.code = code; throw e;
    }
    return body;
  };

  const savedName = () => localStorage.getItem(LS.name) || '';
  const savedServer = () => localStorage.getItem(LS.server) || '';
  const initLabels = () => {
    $('#serverLabel').textContent = origin;
    $('#serverLabel2').textContent = origin;
    const remember = savedServer() === origin && savedName() ? `${origin} · ${savedName()}` : (savedServer() ? `之前是 ${savedServer()}` : '还没有');
    $('#remembered').textContent = remember;
    $('#name').value = savedServer() === origin ? savedName() : '';
    $('#key').value = key;
  };

  const login = async () => {
    if (busy) return;
    const name = $('#name').value.trim() || 'Admin';
    const k = $('#key').value.trim();
    if (!k) { msg('请填写 CMD 里的密钥', true); return; }
    busy = true; $('#loginBtn').disabled = true;
    try {
      const r = await fetch('/admin/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: k, name, browser: browserId }),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok) {
        if (body?.error === 'BAD_KEY') msg('密钥不对，请核对 CMD 里的 Admin key。', true);
        else if (body?.error === 'TOO_MANY') msg('尝试太频繁，等一分钟再试。', true);
        else msg(`进入失败：${body?.error || r.status}`, true);
        return;
      }
      key = k;
      me = { name };
      sessionStorage.setItem(LS.key, key);
      localStorage.setItem(LS.server, origin);
      localStorage.setItem(LS.name, name);
      $('#login').hidden = true;
      $('#dash').hidden = false;
      $('#who').textContent = name;
      state = body.state;
      render();
      startPolling();
    } catch (e) {
      msg(`进入失败：${e.code || e.message}`, true);
    } finally {
      busy = false;
      $('#loginBtn').disabled = false;
    }
  };

  const logout = () => {
    key = ''; me = null; state = null;
    sessionStorage.removeItem(LS.key);
    stopPolling();
    $('#dash').hidden = true;
    $('#login').hidden = false;
    initLabels();
    msg('');
  };

  const startPolling = () => {
    stopPolling();
    timer = setInterval(() => { void refresh(true); }, 1500);
  };
  // A background tab throttles the 3 s timer; when the owner comes back the board must not stay on the old snapshot.
  document.addEventListener('visibilitychange', () => { if (!document.hidden && me && key) void refresh(true); });
  window.addEventListener('focus', () => { if (me && key) void refresh(true); });
  const stopPolling = () => { if (timer) clearInterval(timer); timer = null; };

  let pendingRender = false;
  // Never rebuild the room controls while the user is typing or a native select is open: the 3 s refresh used to close
  // the dropdown and reset the inputs. The state still updates; the view renders once the control loses focus.
  const isEditing = () => {
    const a = document.activeElement;
    return !!(a && a.closest && a.closest('#rooms') && /^(INPUT|SELECT|TEXTAREA)$/.test(a.tagName));
  };
  const renderSoon = () => {
    if (isEditing()) pendingRender = true;
    else render();
  };

  const refresh = async (quiet = false) => {
    if (!me || !key) return;
    try {
      const r = await api('/admin/api/state');
      state = r.state;
      renderSoon();
      if (!quiet) msg(`已刷新 ${new Date().toLocaleTimeString()}`);
    } catch (e) {
      if (e.code === 'UNAUTHORIZED') { logout(); msg('登录已失效，请重新输入密钥。', true); }
      else if (!quiet) msg(`刷新失败：${e.code || e.message}`, true);
    }
  };

  const option = (value, label) => {
    const o = el('option', null, label || value);
    o.value = value;
    return o;
  };

  const postAction = async (body, okText, button = null) => {
    if (busy) return;
    const label = button?.textContent;
    busy = true;
    if (button) { button.disabled = true; button.textContent = '发送中…'; }
    try {
      const r = await api('/admin/api/action', { method: 'POST', body: JSON.stringify(body) });
      state = r.state;
      pendingRender = false;
      render();
      msg(okText ? `${okText} ✓` : '已执行 ✓');
    } catch (e) {
      msg(`执行失败：${e.code || e.message}`, true);
    } finally {
      busy = false;
      if (button) { button.disabled = false; button.textContent = label; }
    }
  };

  const playerCard = (room, p, catalog) => {
    const card = el('article', 'player');
    card.dataset.room = room.code;
    card.dataset.player = p.id;
    const bondName = (id) => (catalog.bonds || []).find((b) => b.id === id)?.name || id;
    const bondText = Object.entries(p.layers || {}).map(([id, n]) => `${bondName(id)} ${n}`).join(' ');
    card.append(el('h3', null, `${p.name || '博士'}${p.left ? ' · 已离开' : ''}${p.connected === false ? ' · 离线' : ''}`));
    card.append(el('div', 'stats', `P${Number(p.seat) + 1} · 资金 ${p.funds} · LP ${p.lp} · 部署 ${p.deployCount}/${p.deployCap} · 商店 Lv${p.shopLevel} · 盟约 ${bondText || '无'}`));

    const funds = el('div', 'ctl');
    const fundsInput = el('input'); fundsInput.type = 'number'; fundsInput.value = '0'; fundsInput.min = '0'; fundsInput.dataset.field = 'funds';
    const add = el('button', 'mini', '加金币'); add.dataset.act = 'funds-add';
    const set = el('button', 'mini', '设为'); set.dataset.act = 'funds-set';
    funds.append(fundsInput, add, set);
    card.append(funds);

    // 发干员: pick a bond first (盟约内干员), then search by name/id; the native select only shows the matches.
    const chess = el('div', 'ctl');
    const bondFilter = el('select'); bondFilter.dataset.filter = 'bond'; bondFilter.style.width = '110px';
    bondFilter.append(option('', '全部盟约'));
    for (const b of catalog.bonds || []) bondFilter.append(option(b.id, b.name || b.id));
    const chessSearch = el('input'); chessSearch.placeholder = '搜索干员 / ID / 拼音'; chessSearch.style.width = '150px'; chessSearch.dataset.search = 'chess';
    const chessSel = el('select'); chessSel.dataset.field = 'chess'; chessSel.style.width = '190px';
    const fillChess = () => {
      const q = chessSearch.value.trim().toLowerCase();
      const bond = bondFilter.value;
      chessSel.textContent = '';
      for (const c of catalog.chess || []) {
        if (bond && !(c.bonds || []).includes(bond)) continue;
        const label = `${c.name || c.id} (${c.tier ?? '?'}★)`;
        if (q && !`${label} ${c.id} ${c.py || ''} ${c.initials || ''}`.toLowerCase().includes(q)) continue;
        chessSel.append(option(c.id, label));
      }
      if (!chessSel.options.length) chessSel.append(option('', '没有匹配的干员'));
    };
    bondFilter.onchange = fillChess;
    chessSearch.oninput = fillChess;
    fillChess();
    const giveChess = el('button', 'mini', '发人员'); giveChess.dataset.act = 'chess';
    const giveAll = el('button', 'mini', '发全部'); giveAll.dataset.act = 'chess-all';
    chess.append(bondFilter, chessSearch, chessSel, giveChess, giveAll);
    card.append(chess);

    const item = el('div', 'ctl');
    const itemSearch = el('input'); itemSearch.placeholder = '搜索装备 / 拼音'; itemSearch.style.width = '140px'; itemSearch.dataset.search = 'item';
    const itemSel = el('select'); itemSel.dataset.field = 'item'; itemSel.style.width = '190px';
    const fillItems = () => {
      const q = itemSearch.value.trim().toLowerCase();
      itemSel.textContent = '';
      for (const it of catalog.items || []) {
        const label = it.name || it.id;
        if (q && !`${label} ${it.id} ${it.py || ''} ${it.initials || ''}`.toLowerCase().includes(q)) continue;
        itemSel.append(option(it.id, label));
      }
      if (!itemSel.options.length) itemSel.append(option('', '没有匹配的装备'));
    };
    itemSearch.oninput = fillItems;
    fillItems();
    const giveItem = el('button', 'mini', '发装备'); giveItem.dataset.act = 'item';
    item.append(itemSearch, itemSel, giveItem);
    card.append(item);

    const bond = el('div', 'ctl');
    const bondSel = el('select'); bondSel.dataset.field = 'bond'; bondSel.style.width = '160px';
    for (const b of catalog.bonds || []) bondSel.append(option(b.id, b.name || b.id));
    const layers = el('input'); layers.type = 'number'; layers.min = '0'; layers.max = '999'; layers.value = '0'; layers.dataset.field = 'layers';
    const setBond = el('button', 'mini', '设层数'); setBond.dataset.act = 'bond';
    bond.append(bondSel, layers, setBond);
    card.append(bond);

    const nums = el('div', 'ctl');
    const cap = el('input'); cap.type = 'number'; cap.min = '1'; cap.max = '99'; cap.value = String(p.deployCap || 8); cap.dataset.field = 'cap';
    const setCap = el('button', 'mini', '部署上限'); setCap.dataset.act = 'deployCap';
    const capMax = el('button', 'mini', '部署99');
    capMax.title = '部署上限设为 99（与联防的「扩人」不是同一个）'; capMax.dataset.act = 'deployCap99';
    nums.append(cap, setCap, capMax);
    card.append(nums);

    const lp = el('div', 'ctl');
    const lpInput = el('input'); lpInput.type = 'number'; lpInput.min = '0'; lpInput.value = String(p.lp ?? 0); lpInput.dataset.field = 'lp';
    const setLp = el('button', 'mini', '设 LP'); setLp.dataset.act = 'lp';
    lp.append(lpInput, setLp);
    card.append(lp);

    if (p.bonds?.length) card.append(el('div', 'layers', `已激活盟约：${p.bonds.map(bondName).join(', ')}`));
    return card;
  };

  const render = () => {
    const root = $('#rooms');
    // Keep whatever the owner typed / picked across a refresh and after an action (new cards get the defaults).
    const savedFields = new Map();
    for (const n of root.querySelectorAll('[data-field],[data-filter],[data-search]')) {
      const card = n.closest('.player');
      if (!card) continue;
      const kind = n.dataset.field ? 'field' : n.dataset.filter ? 'filter' : 'search';
      const key = n.dataset.field || n.dataset.filter || n.dataset.search;
      savedFields.set(`${kind}|${card.dataset.room}|${card.dataset.player}|${key}`, n.value);
    }
    for (const card of root.querySelectorAll('[data-plugin-id]')) {
      const room = card.closest('.room'); const cb = card.querySelector('input');
      if (room && cb) savedFields.set(`plugin|${room.dataset.room}|${card.dataset.pluginId}`, cb.checked);
    }
    root.textContent = '';
    if (!state) return;
    const catalog = state.catalog || { chess: [], bonds: [], items: [] };
    if (!state.rooms?.length) { root.append(el('div', 'empty', '目前没有房间。')); return; }
    for (const room of state.rooms) {
      const sec = el('section', 'room');
      sec.dataset.room = room.code;
      const head = el('div', 'head');
      const left = el('div');
      const b = el('b', null, room.code);
      const tag = el('span', 'tag', `${room.mode} · ${room.inMatch ? `对局中 ${room.phase || ''}` : '等待中'}${room.hosted ? ' · 由插件宿主托管（不可实时改）' : ''}`);
      left.append(b, tag);
      const right = el('div', 'row');
      const rounds = el('input'); rounds.type = 'number'; rounds.min = '2'; rounds.max = '99'; rounds.value = String(room.unite?.rounds ?? 2);
      const helpers = el('input'); helpers.type = 'number'; helpers.min = '1'; helpers.max = '99'; helpers.value = String(room.unite?.helpers ?? 2);
      rounds.style.width = '70px'; helpers.style.width = '70px';
      const applyUnite = el('button', 'mini', '应用联防');
      applyUnite.onclick = () => postAction({ room: room.code, action: 'unite', rounds: Number(rounds.value), helpers: Number(helpers.value) }, `联防 ${room.code} 已更新`);
      const allHelpers = el('button', 'mini', '扩人无上限');
      allHelpers.title = '每轮人数设为 99：所有完美作战玩家依次上场，直到人员耗尽';
      allHelpers.onclick = () => postAction({ room: room.code, action: 'unite', rounds: Number(rounds.value), helpers: 99 }, '联防已扩人到全部人员');
      right.append(el('span', 'muted small', '联防轮数（连发）'), rounds, el('span', 'muted small', '每轮人数'), helpers, applyUnite, allHelpers);
      head.append(left, right);
      sec.append(head);
      const choices = state.pluginChoices || [];
      if (!room.inMatch) {
        const prow = el('div', 'plugin-pick');
        prow.append(el('div', 'plugin-pick__title', '房间插件 · 等待中可调整'));
        const grid = el('div', 'plugin-grid');
        for (const c of choices) {
          const card = el('label', 'plugin-card');
          card.dataset.pluginId = c.id;
          const cb = el('input'); cb.type = 'checkbox'; cb.value = c.id; cb.checked = (room.plugins || []).includes(c.id);
          const body = el('span', 'plugin-card__body');
          body.append(el('span', 'plugin-card__name', c.name || c.id));
          body.append(el('span', 'plugin-card__meta', `v${c.version || '?'} · ${c.classLabel || c.class}`));
          if (c.desc) body.append(el('span', 'plugin-card__desc', c.desc));
          card.append(cb, body);
          if (cb.checked) card.classList.add('is-on');
          cb.onchange = () => card.classList.toggle('is-on', cb.checked);
          grid.append(card);
        }
        prow.append(grid);
        const applyPlugins = el('button', 'mini plugin-apply', '应用插件');
        applyPlugins.onclick = () => postAction({ room: room.code, action: 'plugins', plugins: [...prow.querySelectorAll('[data-plugin-id]:checked')].map((n) => n.dataset.pluginId) }, `插件 ${room.code} 已更新`);
        prow.append(applyPlugins);
        sec.append(prow);
      } else if (room.plugins?.length) {
        sec.append(el('div', 'muted small', `当前插件：${(room.plugins || []).join(', ')}（开局后不能改）`));
      }

      const players = el('div', 'players');
      if (!room.players?.length) {
        const humanSeats = (room.seats || []).filter((s) => s && !s.isBot && !s.left);
        const names = humanSeats.map((s) => `${s.name || '玩家'}${s.connected === false ? '（断线）' : ''}`).join('、');
        players.append(el('div', 'empty', room.inMatch
          ? `对局中真人座位：${names || '无'}${room.hosted ? '（插件宿主托管，实时修改不可用）' : ''}`
          : (names ? `已就座：${names}` : '等待开局。')));
      }
      for (const p of room.players || []) players.append(playerCard(room, p, room.catalog?.chess?.length ? room.catalog : catalog));
      sec.append(players);
      root.append(sec);
    }
    // Restore the filter/search first (they rebuild the operator select), then the picked values.
    for (const n of root.querySelectorAll('[data-search]')) {
      const card = n.closest('.player');
      if (!card) continue;
      const v = savedFields.get(`search|${card.dataset.room}|${card.dataset.player}|${n.dataset.search}`);
      if (v == null) continue;
      n.value = v;
      n.dispatchEvent(new Event('input'));
    }
    for (const n of root.querySelectorAll('[data-filter]')) {
      const card = n.closest('.player');
      if (!card) continue;
      const v = savedFields.get(`filter|${card.dataset.room}|${card.dataset.player}|${n.dataset.filter}`);
      if (v == null) continue;
      n.value = v;
      n.dispatchEvent(new Event('change'));
    }
    for (const n of root.querySelectorAll('[data-field]')) {
      const card = n.closest('.player');
      if (!card) continue;
      const v = savedFields.get(`field|${card.dataset.room}|${card.dataset.player}|${n.dataset.field}`);
      if (v == null) continue;
      if (n.tagName === 'SELECT' && ![...n.options].some((o) => o.value === v)) continue;
      n.value = v;
    }
    for (const card of root.querySelectorAll('[data-plugin-id]')) {
      const room = card.closest('.room'); const cb = card.querySelector('input');
      if (!room || !cb) continue;
      const v = savedFields.get(`plugin|${room.dataset.room}|${card.dataset.pluginId}`);
      if (v == null) continue;
      cb.checked = v;
      card.classList.toggle('is-on', v);
    }
  };

  // One delegated listener reads the controls of the clicked player card.
  $('#rooms')?.addEventListener('click', (ev) => {
    const btn = ev.target.closest('button[data-act]');
    if (!btn) return;
    const card = btn.closest('.player');
    if (!card) return;
    const room = card.dataset.room;
    const player = card.dataset.player;
    const act = btn.dataset.act;
    const base = { room, player, action: '' };
    const field = (name) => card.querySelector(`[data-field="${name}"]`)?.value ?? '';
    const target = (state?.rooms || []).find((r) => r.code === room)?.players?.find((p) => p.id === player);
    const targetName = target?.name || player || '该玩家';
    const confirmSend = (what) => window.confirm(`是否将「${what}」发送给「${targetName}」？`);
    if (act === 'funds-add' || act === 'funds-set') {
      base.action = 'funds'; base.mode = act === 'funds-add' ? 'add' : 'set'; base.amount = Number(field('funds'));
      void postAction(base, act === 'funds-add' ? '已加金币' : '资金已设置');
    } else if (act === 'chess') {
      const what = card.querySelector('[data-field="chess"]')?.selectedOptions?.[0]?.textContent || field('chess') || '该干员';
      if (!confirmSend(what)) return;
      base.action = 'chess'; base.id = field('chess'); base.count = 1;
      void postAction(base, '已发人员', btn);
    } else if (act === 'chess-all') {
      if (!confirmSend('全部干员')) return;
      base.action = 'grantAllOperators';
      void postAction(base, '已发全部人员', btn);
    } else if (act === 'item') {
      const what = card.querySelector('[data-field="item"]')?.selectedOptions?.[0]?.textContent || field('item') || '该装备';
      if (!confirmSend(what)) return;
      base.action = 'item'; base.id = field('item'); base.count = 1;
      void postAction(base, '已发装备', btn);
    } else if (act === 'bond') {
      base.action = 'bond'; base.id = field('bond'); base.layers = Number(field('layers'));
      void postAction(base, '盟约层数已设置');
    } else if (act === 'deployCap') {
      base.action = 'deployCap'; base.value = Number(field('cap'));
      void postAction(base, '部署上限已设置');
    } else if (act === 'deployCap99') {
      base.action = 'deployCap'; base.value = 99;
      void postAction(base, '已扩人（99）');
    } else if (act === 'lp') {
      base.action = 'lp'; base.value = Number(field('lp'));
      void postAction(base, 'LP 已设置');
    }
  });

  // Deferred refresh render: focus left the controls, apply the state fetched meanwhile.
  document.addEventListener('focusout', () => {
    setTimeout(() => {
      if (pendingRender && !isEditing()) { pendingRender = false; render(); }
    }, 150);
  });

  $('#loginBtn').addEventListener('click', login);
  $('#key').addEventListener('keydown', (e) => { if (e.key === 'Enter') login(); });
  $('#refresh').addEventListener('click', () => refresh(false));
  $('#logout').addEventListener('click', logout);

  initLabels();
  if (key && savedServer() === origin) {
    $('#dash').hidden = false;
    $('#login').hidden = true;
    me = { name: savedName() || 'Admin' };
    $('#who').textContent = me.name;
    refresh(true).then(() => startPolling()).catch(() => { $('#dash').hidden = true; $('#login').hidden = false; });
  }
})();
