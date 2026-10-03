'use strict';
(() => {
  // ---------- helpers ----------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const app = $('#app');
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
  const money = c => usd.format((Number(c) || 0) / 100);
  const signedMoney = c => (c > 0 ? '+' : '') + money(c);
  const odds = a => (a > 0 ? '+' + a : String(a));
  const pt = p => (p == null ? '' : p > 0 ? '+' + p : String(p));
  const dec = a => (a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a));
  const decToAm = d => (d >= 2 ? '+' + Math.round((d - 1) * 100) : String(Math.round(-100 / (d - 1))));
  const when = iso => new Date(iso).toLocaleString([], { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const timeOnly = iso => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayLabel = iso => {
    const d = new Date(iso), t = new Date();
    const diff = Math.round((new Date(d.toDateString()) - new Date(t.toDateString())) / 86400e3);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    return d.toLocaleDateString([], { weekday: 'long', month: 'short', day: 'numeric' });
  };
  const sqlTime = s => (s ? when(s.replace(' ', 'T') + 'Z') : '');
  const MARKET = { h2h: 'Moneyline', spreads: 'Spread', totals: 'Total' };

  const TEASER_SPORTS = ['americanfootball_', 'basketball_'];
  const teaseOk = l => ['spreads', 'totals'].includes(l.market) && TEASER_SPORTS.some(p => String(l.sportKey || l.sport_key).startsWith(p));
  const tease = (l, pts) => ({ ...l, point: l.market === 'totals' && l.selection === 'Over' ? Number(l.point) - pts : Number(l.point) + pts });
  const betName = b => b.type === 'parlay' ? `${b.legs.length}-leg parlay` : b.type === 'teaser' ? `${b.legs.length}-leg teaser, ${b.teaser_points} pts` : 'Straight';

  const isPropLeg = l => !MARKET[l.market];
  const evName = (away, home, title) => (away && home ? `${away} @ ${home}` : title || 'Special');
  const ouShort = o => (o.name === 'Over' ? 'O' : o.name === 'Under' ? 'U' : o.name) + (o.point != null ? ' ' + o.point : '');

  function legLabel(l) {
    if (isPropLeg(l)) return [l.description, l.propName ?? l.prop_name, l.selection, l.point].filter(x => x != null && x !== '').join(' ');
    if (l.market === 'totals') return `${l.selection} ${l.point}`;
    if (l.market === 'spreads') return `${l.selection} ${pt(l.point)}`;
    return `${l.selection} ML`;
  }

  async function api(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sportsbook' },
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin',
    });
    let data = {};
    try { data = await res.json(); } catch { /* empty */ }
    if (res.status === 401 && path !== '/api/login') { state.me = null; render(); }
    if (!res.ok) { const e = new Error(data.error || `Error ${res.status}`); e.status = res.status; e.data = data; throw e; }
    return data;
  }

  let toastTimer;
  function toast(msg, err = false) {
    const t = $('#toast');
    t.textContent = msg;
    t.className = 'show' + (err ? ' err' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.className = ''; }, 3200);
  }

  function modal(html, onMount) {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal">${html}</div>`;
    const close = () => bg.remove();
    bg.addEventListener('click', e => { if (e.target === bg || e.target.closest('[data-close]')) close(); });
    document.body.appendChild(bg);
    onMount && onMount(bg.firstElementChild, close);
    return close;
  }

  function formData(form) {
    return Object.fromEntries(new FormData(form).entries());
  }

  // ---------- state ----------
  const state = {
    me: null, book: null, sports: [], sport: null, events: [], eventsInfo: null,
    slip: loadSlip(), slipMode: 'single', teaserPts: '6', slipOpen: false, placing: false,
    props: {}, propsOpen: new Set(), propTab: {}, specials: [],
  };
  function loadSlip() { try { return JSON.parse(localStorage.getItem('slip') || '[]'); } catch { return []; } }
  function saveSlip() { try { localStorage.setItem('slip', JSON.stringify(state.slip)); } catch { /* ignore */ } }

  const route = () => location.hash.replace(/^#\/?/, '');

  // ---------- shell ----------
  function shell(content) {
    const r = route();
    const isAdmin = state.me.role === 'admin';
    const links = isAdmin
      ? [['admin', 'Dashboard'], ['admin/clients', 'Clients'], ['admin/bets', 'Bets'], ['admin/props', 'Props'], ['admin/risk', 'Risk'], ['admin/ledger', 'Ledger'], ['admin/settings', 'Settings'], ['odds', 'Odds board'], ['account', 'Account']]
      : [['', 'Odds'], ['bets', 'My bets'], ['account', 'Account']];
    const active = links.map(l => l[0]).filter(k => r === k || (k && r.startsWith(k + '/'))).sort((a, b) => b.length - a.length)[0] ?? '';
    app.innerHTML = `
      <header class="top"><div class="top-inner">
        <div class="brand"><img src="/icon.svg" alt="">${esc(state.book.name)}</div>
        <nav class="nav">${links.map(([k, t]) => `<a href="#/${k}" class="${k === active ? 'on' : ''}">${t}</a>`).join('')}</nav>
        ${isAdmin ? `<div class="balance"><span>Admin</span><b>${esc(state.me.username)}</b></div>`
          : `<div class="balance"><span>Credit</span><b id="bal">${money(state.me.balanceCents)}</b></div>
            <div class="balance ${state.me.freeplayCents ? '' : 'hidden'}" id="fpBox"><span>Free play</span><b id="fpBal">${money(state.me.freeplayCents)}</b></div>`}
      </div></header>
      <main>${state.book.demoOdds && isAdmin ? `<div class="banner">Running on demo odds. Add your Odds API key in <a href="#/admin/settings">Settings</a> to switch to real lines.</div>` : ''}
      ${!state.book.bettingOpen ? `<div class="banner">Betting is paused right now.</div>` : ''}
      <div id="view">${content}</div></main>`;
    return $('#view');
  }

  function setBalance(c, fp) {
    state.me.balanceCents = c;
    const b = $('#bal');
    if (b) b.textContent = money(c);
    if (fp == null) return;
    state.me.freeplayCents = fp;
    const f = $('#fpBal');
    if (f) f.textContent = money(fp);
    const box = $('#fpBox');
    if (box) box.classList.toggle('hidden', !fp);
  }

  // ---------- auth screen ----------
  function renderAuth(mode = 'login') {
    const signup = state.book && state.book.signupEnabled;
    app.innerHTML = `
      <div class="auth">
        <div class="brand"><img src="/icon.svg" alt="">${esc(state.book ? state.book.name : 'Sportsbook')}</div>
        <div class="panel">
          ${signup ? `<div class="tabs"><button data-mode="login" class="${mode === 'login' ? 'on' : ''}">Log in</button><button data-mode="signup" class="${mode === 'signup' ? 'on' : ''}">Create account</button></div>` : ''}
          <form id="authForm" autocomplete="on">
            <label class="field"><span>Username</span><input type="text" name="username" autocomplete="username" autocapitalize="none" required></label>
            <label class="field"><span>Password</span><input type="password" name="password" autocomplete="${mode === 'login' ? 'current-password' : 'new-password'}" required></label>
            ${mode === 'signup' ? `<label class="field"><span>Invite code</span><input type="text" name="code" autocapitalize="none"></label>` : ''}
            <div class="error" id="authErr"></div>
            <button class="btn primary" type="submit">${mode === 'login' ? 'Log in' : 'Create account'}</button>
          </form>
          ${!signup ? `<p class="muted small" style="margin:14px 0 0;text-align:center">Need an account? Ask your bookie.</p>` : ''}
        </div>
      </div>`;
    $$('[data-mode]').forEach(b => b.onclick = () => renderAuth(b.dataset.mode));
    $('#authForm').onsubmit = async e => {
      e.preventDefault();
      const btn = e.target.querySelector('button[type=submit]');
      btn.disabled = true;
      try {
        await api('POST', mode === 'login' ? '/api/login' : '/api/signup', formData(e.target));
        await boot();
      } catch (err) {
        $('#authErr').textContent = err.message;
        btn.disabled = false;
      }
    };
  }

  // ---------- odds board ----------
  async function renderBoard() {
    const readOnly = state.me.role === 'admin';
    const view = shell(`<div class="layout"><div><div class="sports" id="sports"></div><div id="games"><div class="empty">Loading…</div></div></div>
      ${readOnly ? '<div></div>' : `<aside class="slip" id="slip"></aside>`}</div>
      ${readOnly ? '' : `<button class="btn primary slip-fab" id="slipFab"></button>`}`);
    if (!state.sports.length) {
      try { state.sports = (await api('GET', '/api/sports')).sports; } catch (e) { toast(e.message, true); }
    }
    if (!state.sport || !state.sports.find(s => s.key === state.sport)) state.sport = state.sports[0] && state.sports[0].key;
    drawSports();
    if (!readOnly) drawSlip();
    await loadGames();

    function drawSports() {
      $('#sports', view).innerHTML = state.sports.length
        ? state.sports.map(s => `<button class="chip ${s.key === state.sport ? 'on' : ''}" data-sport="${esc(s.key)}">${esc(s.title)}</button>`).join('')
        : '<span class="muted">No sports are open for betting right now.</span>';
      $$('[data-sport]', view).forEach(b => b.onclick = () => { state.sport = b.dataset.sport; drawSports(); loadGames(); });
    }
  }

  async function loadGames() {
    const games = $('#games');
    if (!games) return;
    if (!state.sport) { games.innerHTML = '<div class="empty">Nothing on the board yet.</div>'; return; }
    games.innerHTML = '<div class="empty">Loading odds…</div>';
    try {
      const sport = state.sport;
      const r = await api('GET', '/api/odds/' + encodeURIComponent(sport));
      if (sport !== state.sport) return;
      state.events = r.events;
      state.specials = r.specials || [];
      state.eventsInfo = r;
      drawGames();
    } catch (e) {
      games.innerHTML = `<div class="empty">${esc(e.message)}</div>`;
    }
  }

  // A pick's identity; props also carry the player/team (description) or the bookie's prop id.
  function keyOf(p) {
    if (isPropLeg(p)) return `${p.eventId}|${p.market}|${p.propId ?? p.description ?? ''}|${p.selection}|${p.point ?? ''}`;
    return `${p.eventId}|${p.market}|${p.selection}|${p.point ?? ''}`;
  }
  // Only one pick per game and market (per player for props); picking the other side replaces it.
  const groupOf = p => `${p.eventId}|${p.market}|${isPropLeg(p) ? (p.propId ?? p.description ?? '') : ''}`;

  const picks = new Map(); // key -> pick, for everything drawn on the board
  function cell(p, top) {
    p.key = keyOf(p);
    picks.set(p.key, p);
    const on = state.slip.some(s => s.key === p.key);
    return `<div class="odd ${on ? 'on' : ''}" data-pick="${esc(p.key)}">${top ? `<span class="pt">${esc(top)}</span>` : ''}<span class="pr">${odds(p.price)}</span></div>`;
  }
  const evInfo = ev => ({ eventId: ev.id, sportKey: ev.sport_key, away: ev.away_team, home: ev.home_team, commence: ev.commence_time, sportTitle: ev.sport_title });

  function oddCell(ev, market, outcome) {
    if (!outcome) return `<div class="odd na">–</div>`;
    const top = market === 'spreads' ? pt(outcome.point) : market === 'totals' ? (outcome.name === 'Over' ? 'O ' : 'U ') + outcome.point : '';
    return cell({ ...evInfo(ev), market, selection: outcome.name, point: outcome.point, price: outcome.price }, top);
  }

  function customBlock(c, info) {
    return `<div class="prop-row"><div class="prop-q">${esc(c.question)}</div>
      <div class="prop-odds wrap">${c.options.map(o => cell({ ...info, market: 'custom', propId: c.id, propName: c.question, selection: o.name, point: null, price: o.price }, o.name)).join('')}</div></div>`;
  }

  function propsPanel(ev) {
    const d = state.props[ev.id];
    if (!d) return '<div class="props"><div class="muted small">Loading props…</div></div>';
    if (d.error) return `<div class="props"><div class="muted small">${esc(d.error)}</div></div>`;
    const tabs = [...(d.custom.length ? [['custom', 'Specials']] : []), ...d.markets.map(m => [m.key, m.title])];
    if (!tabs.length) return '<div class="props"><div class="muted small">No props for this game right now.</div></div>';
    const tab = tabs.some(t => t[0] === state.propTab[ev.id]) ? state.propTab[ev.id] : tabs[0][0];
    let body = '';
    if (tab === 'custom') body = d.custom.map(c => customBlock(c, evInfo(ev))).join('');
    else {
      const m = d.markets.find(x => x.key === tab);
      const rows = new Map();
      for (const o of m.outcomes) { const k = o.description || ''; if (!rows.has(k)) rows.set(k, []); rows.get(k).push(o); }
      for (const [desc, outs] of rows) {
        body += `<div class="prop-row"><div class="team">${esc(desc || m.title)}</div><div class="prop-odds">${outs.map(o =>
          cell({ ...evInfo(ev), market: m.key, description: o.description, propName: m.title, selection: o.name, point: o.point, price: o.price }, ouShort(o))).join('')}</div></div>`;
      }
    }
    return `<div class="props"><div class="sports prop-tabs">${tabs.map(([k, t]) => `<button class="chip sm ${k === tab ? 'on' : ''}" data-ptab="${esc(ev.id)}|${esc(k)}">${esc(t)}</button>`).join('')}</div>
      ${body}${d.source ? `<p class="muted small" style="margin:6px 0 0">${esc(d.bookmaker || '')}${d.source === 'demo' ? ' (demo props)' : ''}. Props are straight bets only.</p>` : ''}</div>`;
  }

  async function toggleProps(ev) {
    if (state.propsOpen.has(ev.id)) { state.propsOpen.delete(ev.id); drawGames(); return; }
    state.propsOpen.add(ev.id);
    drawGames();
    try { state.props[ev.id] = await api('GET', `/api/props/${encodeURIComponent(ev.sport_key)}/${encodeURIComponent(ev.id)}`); }
    catch (e) { state.props[ev.id] = { error: e.message }; }
    drawGames();
  }

  function drawSpecials(games) {
    if (!state.specials.length) { games.innerHTML = '<div class="empty">No specials right now.</div>'; return; }
    games.innerHTML = state.specials.map(c => `<div class="game">
      <div class="game-head"><span>${esc(c.sportTitle || 'Special')}</span><span>Closes ${esc(when(c.commenceTime))}</span></div>
      <div class="props" style="border:0">${customBlock(c, { eventId: c.eventId, sportKey: c.sportKey, away: null, home: null, commence: c.commenceTime, sportTitle: c.sportTitle })}</div></div>`).join('');
  }

  function drawGames() {
    const games = $('#games');
    if (!games) return;
    picks.clear();
    if (state.sport === 'specials') drawSpecials(games);
    else drawEvents(games);
    if (state.me.role === 'admin') return;
    $$('[data-pick]', games).forEach(el => el.onclick = () => togglePick(el.dataset.pick));
  }

  function drawEvents(games) {
    const evs = state.events;
    if (!evs.length) { games.innerHTML = '<div class="empty">No upcoming games with odds for this sport right now.</div>'; return; }
    let html = '';
    let lastDay = '';
    for (const ev of evs) {
      const d = dayLabel(ev.commence_time);
      if (d !== lastDay) { html += `<div class="day">${esc(d)}</div>`; lastDay = d; }
      const m = ev.markets;
      const find = (mk, name) => (m[mk] || []).find(o => o.name === name);
      html += `<div class="game">
        <div class="game-head"><span>${esc(timeOnly(ev.commence_time))}</span><span>${esc(ev.bookmaker || '')}${ev.hasProps ? ` <button class="linkbtn" data-props="${esc(ev.id)}">${state.propsOpen.has(ev.id) ? 'Hide props' : 'Props'}</button>` : ''}</span></div>
        <div class="lines">
          <div></div><div class="hdr">Spread</div><div class="hdr">Money</div><div class="hdr">Total</div>
          <div class="team">${esc(ev.away_team)}</div>
          ${oddCell(ev, 'spreads', find('spreads', ev.away_team))}${oddCell(ev, 'h2h', find('h2h', ev.away_team))}${oddCell(ev, 'totals', find('totals', 'Over'))}
          <div class="team">${esc(ev.home_team)}</div>
          ${oddCell(ev, 'spreads', find('spreads', ev.home_team))}${oddCell(ev, 'h2h', find('h2h', ev.home_team))}${oddCell(ev, 'totals', find('totals', 'Under'))}
        </div>${state.propsOpen.has(ev.id) ? propsPanel(ev) : ''}</div>`;
    }
    const info = state.eventsInfo;
    if (info && info.fetchedAt) html += `<p class="muted small">Odds updated ${esc(new Date(info.fetchedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }))}${info.source === 'demo' ? ' (demo odds)' : ''}.</p>`;
    games.innerHTML = html;
    $$('[data-props]', games).forEach(b => b.onclick = () => toggleProps(evs.find(e => e.id === b.dataset.props)));
    $$('[data-ptab]', games).forEach(b => b.onclick = () => {
      const i = b.dataset.ptab.lastIndexOf('|');
      state.propTab[b.dataset.ptab.slice(0, i)] = b.dataset.ptab.slice(i + 1);
      drawGames();
    });
  }

  function togglePick(key) {
    const i = state.slip.findIndex(s => s.key === key);
    if (i >= 0) state.slip.splice(i, 1);
    else {
      const p = picks.get(key);
      if (!p) return;
      state.slip = state.slip.filter(s => groupOf(s) !== groupOf(p));
      state.slip.push({ ...p, stake: '' });
      if (state.slip.length === 1 && window.innerWidth <= 900) state.slipOpen = true;
    }
    saveSlip();
    drawGames();
    drawSlip();
  }

  function drawSlip() {
    const el = $('#slip');
    const fab = $('#slipFab');
    if (!el) return;
    const s = state.slip;
    const hasProps = s.some(isPropLeg);
    const parlayOk = s.length >= 2 && !hasProps && new Set(s.map(x => x.eventId)).size === s.length;
    const teaserRow = (state.book.teaserOdds || {})[state.teaserPts] || {};
    const teaserOk = parlayOk && s.every(teaseOk) && !!teaserRow[s.length];
    if (state.slipMode === 'parlay' && !parlayOk) state.slipMode = 'single';
    if (state.slipMode === 'teaser' && !teaserOk) state.slipMode = 'single';
    if (fab) {
      fab.innerHTML = `<span>Bet slip (${s.length})</span><span>${s.length ? 'View' : ''}</span>`;
      fab.classList.toggle('hidden', !s.length || state.slipOpen);
      fab.onclick = () => { state.slipOpen = true; drawSlip(); };
    }
    el.classList.toggle('open', state.slipOpen && s.length > 0);
    if (!s.length) {
      el.innerHTML = `<div class="panel"><h3>Bet slip</h3><p class="muted small" style="margin:0">Tap any odds to add a pick.</p></div>`;
      return;
    }
    const mode = state.slipMode;
    const fpAvail = state.me.freeplayCents > 0;
    if (!fpAvail) state.useFreeplay = false;
    const fp = state.useFreeplay;
    let totalStake = 0, totalWin = 0;
    const legsHtml = s.map((l, i) => {
      const st = parseFloat(l.stake) || 0;
      if (mode === 'single') { totalStake += st; totalWin += st * dec(l.price); }
      const sel = mode === 'teaser'
        ? `${esc(legLabel(tease(l, Number(state.teaserPts))))} <span class="muted small">from ${esc(legLabel(l).replace(l.selection + ' ', ''))}</span>`
        : `${esc(legLabel(l))} <span class="num">${odds(l.price)}</span>`;
      return `<div class="slip-leg ${l.changed ? 'changed' : ''}">
        <button class="x" data-rm="${i}" aria-label="Remove">×</button>
        <div class="sel">${sel}</div>
        <div class="ev">${esc(evName(l.away, l.home, l.sportTitle))} · ${esc(MARKET[l.market] || 'Prop')}</div>
        ${l.changed ? `<div class="small" style="color:var(--warn)">Odds changed</div>` : ''}
        ${mode === 'single' ? `<input type="number" inputmode="decimal" min="0" step="0.01" placeholder="Stake $" data-stake="${i}" value="${esc(l.stake)}">
          <div class="small muted" data-win="${i}">${st ? 'To win ' + money(Math.floor(st * (dec(l.price) - 1) * 100)) : ''}</div>` : ''}
      </div>`;
    }).join('');
    let parlayDec = mode === 'teaser' ? dec(teaserRow[s.length]) : s.reduce((a, l) => a * dec(l.price), 1);
    if (mode === 'parlay' || mode === 'teaser') {
      const st = parseFloat(state.parlayStake) || 0;
      totalStake = st; totalWin = st * parlayDec;
    }
    el.innerHTML = `<div class="panel">
      <div class="row between" style="margin-bottom:10px"><h3 style="margin:0">Bet slip</h3>
        <div class="row" style="gap:6px"><button class="btn sm" id="slipClear">Clear</button><button class="btn sm slip-close" id="slipClose">Hide</button></div></div>
      ${s.length >= 2 ? `<div class="tabs"><button data-slipmode="single" class="${mode === 'single' ? 'on' : ''}">Straight bets</button>
        <button data-slipmode="parlay" class="${mode === 'parlay' ? 'on' : ''}" ${parlayOk ? '' : `disabled title="${hasProps ? 'Props are straight bets only' : 'Only one pick per game in a parlay'}"`}>Parlay</button>
        <button data-slipmode="teaser" class="${mode === 'teaser' ? 'on' : ''}" ${teaserOk ? '' : 'disabled title="Teasers are 2 to 6 football or basketball spreads and totals, one per game"'}>Teaser</button></div>` : ''}
      ${mode === 'teaser' ? `<div class="tabs">${['6', '6.5', '7'].map(p => `<button data-teaserpts="${p}" class="${state.teaserPts === p ? 'on' : ''}">${p} pts</button>`).join('')}</div>` : ''}
      ${legsHtml}
      ${mode === 'parlay' || mode === 'teaser' ? `<div class="slip-total"><span>${s.length}-leg ${mode}</span><b class="num">${decToAm(parlayDec)}</b></div>
        <input type="number" inputmode="decimal" min="0" step="0.01" placeholder="Stake $" id="parlayStake" value="${esc(state.parlayStake || '')}">` : ''}
      ${fpAvail ? `<label class="check"><input type="checkbox" id="useFp" ${fp ? 'checked' : ''}> Bet with free play (${money(state.me.freeplayCents)}). Wins pay profit only.</label>` : ''}
      <div class="slip-total"><span class="muted">Total stake</span><b id="slipStake">${money(Math.round(totalStake * 100))}</b></div>
      <div class="slip-total"><span class="muted">Total payout</span><b id="slipWin" class="pos">${money(Math.floor(totalWin * 100) - (fp ? Math.round(totalStake * 100) : 0))}</b></div>
      <div class="error" id="slipErr"></div>
      <button class="btn primary" style="width:100%;padding:11px" id="placeBtn" ${state.placing ? 'disabled' : ''}>${state.placing ? 'Placing…' : 'Place bet' + (mode === 'single' && s.length > 1 ? 's' : '')}</button>
      <p class="muted small" style="margin:8px 0 0">Min ${money(state.book.minBetCents)} · Max ${money(state.me.maxBetCents ?? state.book.maxBetCents)} per bet</p>
    </div>`;
    $$('[data-rm]', el).forEach(b => b.onclick = () => { state.slip.splice(+b.dataset.rm, 1); saveSlip(); drawGames(); drawSlip(); });
    $$('[data-slipmode]', el).forEach(b => b.onclick = () => { state.slipMode = b.dataset.slipmode; drawSlip(); });
    const fpBox = $('#useFp', el);
    if (fpBox) fpBox.onchange = () => { state.useFreeplay = fpBox.checked; drawSlip(); };
    $$('[data-teaserpts]', el).forEach(b => b.onclick = () => { state.teaserPts = b.dataset.teaserpts; drawSlip(); });
    $('#slipClear', el).onclick = () => { state.slip = []; saveSlip(); drawGames(); drawSlip(); };
    $('#slipClose', el).onclick = () => { state.slipOpen = false; drawSlip(); };
    $$('[data-stake]', el).forEach(inp => inp.oninput = () => {
      const l = state.slip[+inp.dataset.stake];
      l.stake = inp.value;
      saveSlip();
      const st = parseFloat(inp.value) || 0;
      $(`[data-win="${inp.dataset.stake}"]`, el).textContent = st ? 'To win ' + money(Math.floor(st * (dec(l.price) - 1) * 100)) : '';
      updateTotals();
    });
    const ps = $('#parlayStake', el);
    if (ps) ps.oninput = () => { state.parlayStake = ps.value; updateTotals(); };
    $('#placeBtn', el).onclick = placeBets;

    function updateTotals() {
      let ts = 0, tw = 0;
      if (state.slipMode !== 'single') { ts = parseFloat(state.parlayStake) || 0; tw = ts * parlayDec; }
      else for (const l of state.slip) { const st = parseFloat(l.stake) || 0; ts += st; tw += st * dec(l.price); }
      $('#slipStake', el).textContent = money(Math.round(ts * 100));
      $('#slipWin', el).textContent = money(Math.floor(tw * 100) - (state.useFreeplay ? Math.round(ts * 100) : 0));
    }
  }

  function applyChanges(changed) {
    for (const c of changed || []) {
      const i = state.slip.findIndex(s => groupOf(s) === groupOf(c) && s.selection === c.selection);
      if (i < 0) continue;
      if (c.removed) { state.slip.splice(i, 1); continue; }
      Object.assign(state.slip[i], { price: c.price, point: c.point, changed: true });
      state.slip[i].key = keyOf(state.slip[i]);
    }
    saveSlip();
  }

  async function placeBets() {
    const err = $('#slipErr');
    err.textContent = '';
    const legOf = l => ({ eventId: l.eventId, sportKey: l.sportKey, market: l.market, selection: l.selection, point: l.point, price: l.price, description: l.description ?? null, propId: l.propId ?? null });
    const jobs = state.slipMode !== 'single'
      ? [{ type: state.slipMode, stake: state.parlayStake, legs: state.slip.map(legOf), keys: state.slip.map(l => l.key), teaserPoints: Number(state.teaserPts) }]
      : state.slip.map(l => ({ type: 'single', stake: l.stake, legs: [legOf(l)], keys: [l.key] }));
    if (jobs.some(j => !(parseFloat(j.stake) > 0))) { err.textContent = 'Enter a stake for every bet.'; return; }
    state.placing = true;
    drawSlip();
    let placed = 0;
    const errors = [];
    for (const j of jobs) {
      try {
        const r = await api('POST', '/api/bets', { type: j.type, stake: j.stake, legs: j.legs, teaserPoints: j.teaserPoints, freeplay: !!state.useFreeplay });
        setBalance(r.balanceCents, r.freeplayCents);
        state.slip = state.slip.filter(s => !j.keys.includes(s.key));
        placed++;
      } catch (e) {
        if (e.status === 409 && e.data.changed) applyChanges(e.data.changed);
        errors.push(e.message);
      }
    }
    state.placing = false;
    if (!state.slip.length) { state.parlayStake = ''; state.slipOpen = false; }
    saveSlip();
    drawGames();
    drawSlip();
    if (placed) toast(`${placed} bet${placed > 1 ? 's' : ''} placed.`);
    if (errors.length) { const e2 = $('#slipErr'); if (e2) e2.textContent = [...new Set(errors)].join(' '); }
  }

  // ---------- bets list (shared) ----------
  function betCard(b, { admin = false } = {}) {
    const legs = b.legs.map(l => `
      <div class="leg"><div>
        <div class="sel">${esc(legLabel(l))} ${b.type === 'teaser' ? `<span class="muted small">from ${esc(l.market === 'totals' ? l.orig_point : pt(l.orig_point))}</span>` : `<span class="num muted">${odds(l.price)}</span>`}</div>
        <div class="small muted">${l.away_team ? `${esc(l.sport_title || '')} · ${esc(l.away_team)} @ ${esc(l.home_team)}` : esc(l.sport_title || 'Special')} · ${esc(when(l.commence_time))}${isPropLeg(l) ? ' · Prop' : ''}</div>
        ${l.result_note ? `<div class="small muted">${esc(l.result_note)}</div>` : ''}
      </div>
      <div style="text-align:right">${b.type !== 'single' ? `<span class="pill ${l.status}">${l.status}</span>` : ''}
        ${admin ? `<div class="settle" style="margin-top:6px;justify-content:flex-end">${['won', 'lost', 'push', 'void'].map(s => `<button class="btn sm" data-leg="${l.id}" data-res="${s}" ${l.status === s ? 'disabled' : ''}>${s[0].toUpperCase() + s.slice(1)}</button>`).join('')}</div>` : ''}
      </div></div>`).join('');
    const result = b.status === 'pending' ? `To pay <b>${money(b.potential_payout_cents)}</b>` : `Paid <b>${money(b.payout_cents)}</b>`;
    return `<div class="bet">
      <div class="bet-head"><div><b>${esc(betName(b))}</b>${b.freeplay ? ' <span class="pill">free play</span>' : ''} <span class="muted small">#${b.id}${admin ? ` · <a href="#/admin/clients/${b.user_id}">${esc(b.username)}</a>` : ''} · ${esc(sqlTime(b.created_at))}</span></div>
        <span class="pill ${b.status}">${b.status}</span></div>
      ${legs}
      <div class="bet-foot"><span>Stake <b>${money(b.stake_cents)}</b></span><span>Odds <b>${decToAm(b.decimal_odds)}</b></span><span>${result}</span>
        ${admin && b.settled_by ? `<span>Settled by ${esc(b.settled_by)}</span>` : ''}
        ${admin && b.status === 'pending' ? `<button class="btn sm danger" data-voidbet="${b.id}">Void bet</button>` : ''}</div>
    </div>`;
  }

  function wireSettle(root, reload) {
    $$('[data-leg]', root).forEach(btn => btn.onclick = async () => {
      if (!confirm(`Mark this pick as ${btn.dataset.res.toUpperCase()}?`)) return;
      try { await api('POST', `/api/admin/legs/${btn.dataset.leg}/settle`, { status: btn.dataset.res }); toast('Updated.'); reload(); }
      catch (e) { toast(e.message, true); }
    });
    $$('[data-voidbet]', root).forEach(btn => btn.onclick = async () => {
      if (!confirm('Void this bet and refund the stake?')) return;
      try { await api('POST', `/api/admin/bets/${btn.dataset.voidbet}/settle`, { status: 'void' }); toast('Bet voided.'); reload(); }
      catch (e) { toast(e.message, true); }
    });
  }

  async function renderMyBets() {
    const tab = state.betsTab || 'open';
    const view = shell(`<h1>My bets</h1>
      <div class="tabs" style="max-width:360px"><button data-t="open" class="${tab === 'open' ? 'on' : ''}">Open</button><button data-t="settled" class="${tab === 'settled' ? 'on' : ''}">Settled</button></div>
      <div id="list"><div class="empty">Loading…</div></div>`);
    $$('[data-t]', view).forEach(b => b.onclick = () => { state.betsTab = b.dataset.t; renderMyBets(); });
    const { bets } = await api('GET', '/api/bets?status=' + tab);
    $('#list', view).innerHTML = bets.length ? bets.map(b => betCard(b)).join('') : `<div class="empty">${tab === 'open' ? 'No open bets. Head to the odds board to make a pick.' : 'No settled bets yet.'}</div>`;
  }

  async function renderAccount() {
    const isClient = state.me.role === 'client';
    const view = shell(`<h1>Account</h1>
      <div class="panel"><div class="row between"><div><b>${esc(state.me.displayName || state.me.username)}</b><div class="muted small">@${esc(state.me.username)}</div></div>
        <button class="btn" id="logout">Log out</button></div></div>
      <div class="panel"><h3>Change password</h3>
        <form id="pw" style="max-width:360px">
          <label class="field"><span>Current password</span><input type="password" name="current" autocomplete="current-password" required></label>
          <label class="field"><span>New password</span><input type="password" name="next" autocomplete="new-password" minlength="6" required></label>
          <div class="error" id="pwErr"></div><button class="btn primary">Update password</button></form></div>
      ${isClient ? `<div class="panel"><h3>Credit history</h3><div class="table-wrap" id="tx"><div class="muted">Loading…</div></div></div>` : ''}`);
    $('#logout', view).onclick = async () => { await api('POST', '/api/logout'); state.me = null; location.hash = ''; render(); };
    $('#pw', view).onsubmit = async e => {
      e.preventDefault();
      try { await api('POST', '/api/me/password', formData(e.target)); e.target.reset(); toast('Password updated.'); $('#pwErr').textContent = ''; }
      catch (err) { $('#pwErr').textContent = err.message; }
    };
    if (isClient) {
      const { transactions } = await api('GET', '/api/transactions');
      $('#tx', view).innerHTML = txTable(transactions, false);
    }
  }

  const TX_LABEL = { freeplay: 'Free play added', freeplay_remove: 'Free play removed', deposit: 'Credit added', withdrawal: 'Credit removed', adjustment: 'Adjustment', bet: 'Bet placed', payout: 'Winnings', refund: 'Refund', regrade: 'Regrade' };
  function txTable(rows, showUser) {
    if (!rows.length) return '<div class="muted">Nothing yet.</div>';
    return `<table><thead><tr><th>When</th>${showUser ? '<th>Client</th>' : ''}<th>Type</th><th class="hide-sm">Note</th><th class="r">Amount</th><th class="r">Balance after</th></tr></thead><tbody>
      ${rows.map(t => `<tr><td class="small">${esc(sqlTime(t.created_at))}</td>${showUser ? `<td><a href="#/admin/clients/${t.user_id}">${esc(t.username)}</a></td>` : ''}
        <td>${esc(TX_LABEL[t.type] || t.type)}${t.wallet === 'freeplay' && !t.type.startsWith('freeplay') ? ' <span class="pill">free play</span>' : ''}</td><td class="hide-sm small muted">${esc(t.note || '')}</td>
        <td class="r num ${t.amount_cents >= 0 ? 'pos' : 'neg'}">${signedMoney(t.amount_cents)}</td><td class="r num">${money(t.balance_after_cents)}</td></tr>`).join('')}
    </tbody></table>`;
  }

  // ---------- admin ----------
  async function renderDashboard() {
    const view = shell('<h1>Dashboard</h1><div id="d"><div class="empty">Loading…</div></div>');
    const { summary: s, odds: o } = await api('GET', '/api/admin/summary');
    const share = location.origin + '/';
    $('#d', view).innerHTML = `
      <div class="stats">
        <div class="stat"><span>Book profit (all time)</span><b class="${s.bookProfitCents >= 0 ? 'pos' : 'neg'}">${signedMoney(s.bookProfitCents)}</b><small>on ${money(s.handleCents)} settled handle</small></div>
        <div class="stat"><span>Last 7 days</span><b class="${s.weekProfitCents >= 0 ? 'pos' : 'neg'}">${signedMoney(s.weekProfitCents)}</b><small>book profit</small></div>
        <div class="stat"><span>Open bets</span><b>${s.openBets}</b><small>${money(s.openStakeCents)} staked</small></div>
        <div class="stat"><span>Max liability</span><b>${money(s.openLiabilityCents)}</b><small>if every open bet wins</small></div>
        <div class="stat"><span>Clients</span><b>${s.clients}</b><small>${money(s.clientBalanceCents)} total credit${s.clientFreeplayCents ? ` · ${money(s.clientFreeplayCents)} free play` : ''}</small></div>
        <div class="stat"><span>Today</span><b>${s.todayBets}</b><small>${money(s.todayStakeCents)} wagered</small></div>
      </div>
      ${s.needsGrading ? `<div class="banner">${s.needsGrading} open bet${s.needsGrading > 1 ? 's have' : ' has'} a game that started over 12 hours ago. <a href="#/admin/bets">Grade them</a>.</div>` : ''}
      <div class="panel"><h3>Share with your clients</h3>
        <div class="share"><input type="text" readonly value="${esc(share)}" id="shareUrl"><button class="btn" id="copy">Copy link</button></div>
        <p class="muted small" style="margin:8px 0 0">Create each client's login under <a href="#/admin/clients">Clients</a>, or turn on sign up with an invite code in <a href="#/admin/settings">Settings</a>.</p></div>
      <div class="panel"><h3>Odds feed</h3>
        <p style="margin:0">${o.live ? `Live odds from The Odds API (${esc(o.bookmakers.split(',')[0])} first).` : 'Demo odds. Add an API key in Settings for real lines.'}
        ${o.quotaRemaining ? ` <span class="muted">${esc(o.quotaRemaining)} API requests left this month.</span>` : ''}</p>
        ${o.lastError ? `<p class="neg small">${esc(o.lastError)}</p>` : ''}</div>
      <div class="panel"><div class="row between"><h3 style="margin:0">Latest bets</h3><a href="#/admin/bets">All bets</a></div><div id="latest" style="margin-top:12px"></div></div>`;
    $('#copy', view).onclick = () => { navigator.clipboard.writeText(share).then(() => toast('Link copied.')); };
    const { bets } = await api('GET', '/api/admin/bets?limit=5');
    const latest = $('#latest', view);
    latest.innerHTML = bets.length ? bets.map(b => betCard(b, { admin: true })).join('') : '<div class="muted">No bets yet.</div>';
    wireSettle(latest, renderDashboard);
  }

  async function renderClients() {
    const view = shell(`<div class="row between"><h1>Clients</h1><button class="btn primary" id="newClient">New client</button></div>
      <div class="panel"><input type="text" id="q" placeholder="Search clients"><div class="table-wrap" id="tbl" style="margin-top:10px"><div class="muted">Loading…</div></div></div>`);
    $('#newClient', view).onclick = newClientModal;
    const { users } = await api('GET', '/api/admin/users');
    const draw = () => {
      const q = $('#q', view).value.toLowerCase();
      const rows = users.filter(u => !q || u.username.toLowerCase().includes(q) || (u.displayName || '').toLowerCase().includes(q));
      $('#tbl', view).innerHTML = `<table><thead><tr><th>Client</th><th class="r">Credit</th><th class="r hide-sm">Open bets</th><th class="r hide-sm">Book P/L</th><th class="hide-sm">Last login</th></tr></thead><tbody>
        ${rows.map(u => `<tr class="click" data-u="${u.id}"><td><b>${esc(u.displayName || u.username)}</b> ${u.role === 'admin' ? '<span class="pill">admin</span>' : ''} ${u.status !== 'active' ? `<span class="pill suspended">${esc(u.status)}</span>` : ''}<div class="small muted">@${esc(u.username)}</div></td>
          <td class="r num">${u.role === 'admin' ? '–' : money(u.balanceCents)}${u.freeplayCents ? `<div class="small muted">+${money(u.freeplayCents)} free play</div>` : ''}</td>
          <td class="r num hide-sm">${u.openBets ? `${u.openBets} · ${money(u.openStakeCents)}` : '–'}</td>
          <td class="r num hide-sm ${u.bookProfitCents >= 0 ? 'pos' : 'neg'}">${u.role === 'admin' ? '–' : signedMoney(u.bookProfitCents)}</td>
          <td class="small muted hide-sm">${esc(sqlTime(u.lastLoginAt) || 'Never')}</td></tr>`).join('')}
      </tbody></table>`;
      $$('[data-u]', view).forEach(tr => tr.onclick = () => { location.hash = '#/admin/clients/' + tr.dataset.u; });
    };
    $('#q', view).oninput = draw;
    draw();
  }

  function newClientModal() {
    modal(`<div class="modal-head"><h2>New client</h2><button class="btn sm" data-close>Close</button></div>
      <form id="nc">
        <div class="grid2">
          <label class="field"><span>Username (they log in with this)</span><input type="text" name="username" autocapitalize="none" required></label>
          <label class="field"><span>Display name</span><input type="text" name="displayName"></label>
          <label class="field"><span>Password</span><input type="text" name="password" required minlength="6" autocomplete="off"></label>
          <label class="field"><span>Starting credit ($)</span><input type="number" name="credit" min="0" step="0.01" placeholder="0.00"></label>
          <label class="field"><span>Max bet ($, blank = book default)</span><input type="number" name="maxBet" min="0" step="0.01"></label>
          <label class="field"><span>Role</span><select name="role"><option value="client">Client</option><option value="admin">Admin (can manage the book)</option></select></label>
        </div>
        <label class="field"><span>Private notes</span><textarea name="notes" rows="2"></textarea></label>
        <div class="error" id="ncErr"></div><button class="btn primary">Create</button>
      </form>`, (root, close) => {
      const pw = $('[name=password]', root);
      pw.value = Math.random().toString(36).slice(2, 10);
      $('#nc', root).onsubmit = async e => {
        e.preventDefault();
        const data = formData(e.target);
        try {
          const { user } = await api('POST', '/api/admin/users', data);
          close();
          toast(`Created ${user.username}. Send them the link, username and password.`);
          location.hash = '#/admin/clients/' + user.id;
        } catch (err) { $('#ncErr', root).textContent = err.message; }
      };
    });
  }

  async function renderClient(id) {
    const view = shell('<div id="c"><div class="empty">Loading…</div></div>');
    const { user: u, bets, transactions } = await api('GET', '/api/admin/users/' + id);
    const isClient = u.role === 'client';
    $('#c', view).innerHTML = `
      <p><a href="#/admin/clients">← Clients</a></p>
      <div class="row between"><h1 style="margin:0">${esc(u.displayName || u.username)} <span class="muted small">@${esc(u.username)}</span></h1>
        ${u.status !== 'active' ? '<span class="pill suspended">suspended</span>' : ''}</div>
      <div class="stats" style="margin-top:14px">
        ${isClient ? `<div class="stat"><span>Credit</span><b>${money(u.balanceCents)}</b></div><div class="stat"><span>Free play</span><b>${money(u.freeplayCents)}</b></div>` : ''}
        <div class="stat"><span>Max bet</span><b>${u.maxBetCents != null ? money(u.maxBetCents) : 'Default'}</b></div>
        <div class="stat"><span>Last login</span><b style="font-size:1rem">${esc(sqlTime(u.lastLoginAt) || 'Never')}</b></div>
      </div>
      ${isClient ? `<div class="panel"><h3>Add or remove credit or free play</h3>
        <form id="cr" class="row">
          <select name="type" style="width:auto"><option value="deposit">Add credit</option><option value="withdrawal">Remove credit</option><option value="freeplay">Give free play</option><option value="freeplay_remove">Remove free play</option></select>
          <input type="number" name="amount" min="0.01" step="0.01" placeholder="Amount $" style="width:140px" required>
          <input type="text" name="note" placeholder="Note (optional)" class="grow" style="width:auto">
          <button class="btn primary">Apply</button></form></div>` : ''}
      <div class="panel"><h3>Account</h3>
        <form id="acct"><div class="grid2">
          <label class="field"><span>Display name</span><input type="text" name="displayName" value="${esc(u.displayName || '')}"></label>
          <label class="field"><span>Max bet ($, blank = book default)</span><input type="number" name="maxBet" min="0" step="0.01" value="${u.maxBetCents != null ? (u.maxBetCents / 100).toFixed(2) : ''}"></label>
          <label class="field"><span>New password (leave blank to keep)</span><input type="text" name="password" autocomplete="off"></label>
          <label class="field"><span>Status</span><select name="status"><option value="active" ${u.status === 'active' ? 'selected' : ''}>Active</option><option value="suspended" ${u.status === 'suspended' ? 'selected' : ''}>Suspended (cannot log in)</option></select></label>
        </div>
        <label class="field"><span>Private notes</span><textarea name="notes" rows="2">${esc(u.notes || '')}</textarea></label>
        <button class="btn primary">Save</button></form></div>
      ${isClient ? `<div class="panel"><h3>Bets</h3><div id="ub">${bets.length ? bets.map(b => betCard(b, { admin: true })).join('') : '<div class="muted">No bets yet.</div>'}</div></div>
      <div class="panel"><h3>Credit history</h3><div class="table-wrap">${txTable(transactions, false)}</div></div>` : ''}`;
    const reload = () => renderClient(id);
    const cr = $('#cr', view);
    if (cr) cr.onsubmit = async e => {
      e.preventDefault();
      try { const r = await api('POST', `/api/admin/users/${id}/credit`, formData(e.target)); toast(`Credit ${money(r.balanceCents)} · Free play ${money(r.freeplayCents)}.`); reload(); }
      catch (err) { toast(err.message, true); }
    };
    $('#acct', view).onsubmit = async e => {
      e.preventDefault();
      const d = formData(e.target);
      if (!d.password) delete d.password;
      try { await api('PATCH', `/api/admin/users/${id}`, d); toast('Saved.'); reload(); }
      catch (err) { toast(err.message, true); }
    };
    const ub = $('#ub', view);
    if (ub) wireSettle(ub, reload);
  }

  async function renderAdminBets() {
    const tab = state.adminBetsTab || 'open';
    const view = shell(`<div class="row between"><h1>Bets</h1><button class="btn" id="grade">Grade finished games</button></div>
      <div class="tabs" style="max-width:560px"><button data-t="open" class="${tab === 'open' ? 'on' : ''}">Open</button><button data-t="props" class="${tab === 'props' ? 'on' : ''}">Props to grade</button><button data-t="settled" class="${tab === 'settled' ? 'on' : ''}">Settled</button><button data-t="" class="${tab === '' ? 'on' : ''}">All</button></div>
      <p class="muted small">Games are graded automatically from final scores every 15 minutes when the feed has them. Props are never graded automatically (the feed has no player stats): grade them here with the buttons on each pick, or grade your own props in one go under <a href="#/admin/props">Props</a>. Use the buttons to fix any result; credit is corrected automatically.</p>
      <div id="list"><div class="empty">Loading…</div></div>`);
    $$('[data-t]', view).forEach(b => b.onclick = () => { state.adminBetsTab = b.dataset.t; renderAdminBets(); });
    $('#grade', view).onclick = async () => {
      try {
        const r = await api('POST', '/api/admin/grade');
        toast(r.graded ? `Graded ${r.graded} pick${r.graded > 1 ? 's' : ''}.` : 'No finished games to grade yet.');
        if (r.errors && r.errors.length) toast(r.errors[0], true);
        renderAdminBets();
      } catch (e) { toast(e.message, true); }
    };
    const { bets } = await api('GET', '/api/admin/bets?status=' + tab);
    const list = $('#list', view);
    list.innerHTML = bets.length ? bets.map(b => betCard(b, { admin: true })).join('') : '<div class="empty">No bets here.</div>';
    wireSettle(list, renderAdminBets);
  }

  async function renderAdminProps() {
    const view = shell(`<div class="row between"><h1>Props</h1><button class="btn primary" id="newProp">New prop</button></div>
      <p class="muted small">Write your own props, on a game or as a stand-alone special (awards, futures, anything). Clients see them under the game's Props, or under Specials. When it's decided, pick the winner and every bet on it is graded. Props from the odds feed are graded under <a href="#/admin/bets">Bets</a>.</p>
      <div id="list"><div class="empty">Loading…</div></div>`);
    $('#newProp', view).onclick = () => newPropModal(renderAdminProps);
    const { props } = await api('GET', '/api/admin/props');
    const list = $('#list', view);
    if (!props.length) { list.innerHTML = '<div class="empty">No props yet.</div>'; return; }
    list.innerHTML = props.map(p => {
      const closed = p.status !== 'open' || Date.parse(p.commenceTime) <= Date.now();
      const status = p.status === 'settled' ? 'settled' : closed ? 'closed' : 'open';
      return `<div class="bet">
        <div class="bet-head"><div><b>${esc(p.question)}</b><div class="small muted">${esc(evName(p.awayTeam, p.homeTeam, p.sportTitle))} · ${p.sportKey === 'specials' ? 'closes' : 'starts'} ${esc(when(p.commenceTime))}</div></div>
          <span class="pill ${status === 'settled' ? 'won' : status === 'open' ? 'pending' : ''}">${status}</span></div>
        <div class="row" style="gap:8px;flex-wrap:wrap;margin:8px 0">${p.options.map(o => `<span class="pill" style="text-transform:none">${esc(o.name)} ${odds(o.price)}${p.result === o.name ? ' ✓' : ''}</span>`).join('')}</div>
        <div class="bet-foot"><span>${p.bets} bet${p.bets === 1 ? '' : 's'} · ${money(p.stakeCents)} staked</span>
          ${p.status === 'settled' ? `<span>Result <b>${esc(p.result)}</b></span><button class="btn sm" data-regrade="${p.id}">Undo grading</button>` : `
            ${p.status === 'open' ? `<button class="btn sm" data-pstatus="${p.id}|closed">Stop taking bets</button>` : `<button class="btn sm" data-pstatus="${p.id}|open">Reopen</button>`}
            ${p.bets ? `<span class="settle">${p.options.map(o => `<button class="btn sm" data-pwin="${p.id}" data-opt="${esc(o.name)}">${esc(o.name)} won</button>`).join('')}<button class="btn sm danger" data-pwin="${p.id}" data-opt="void">Void</button></span>`
              : `<button class="btn sm danger" data-pdel="${p.id}">Delete</button>`}`}
        </div></div>`;
    }).join('');
    const act = async (fn, msg) => { try { const r = await fn(); toast(typeof msg === 'function' ? msg(r) : msg); renderAdminProps(); } catch (e) { toast(e.message, true); } };
    $$('[data-pstatus]', list).forEach(b => b.onclick = () => {
      const [id, status] = b.dataset.pstatus.split('|');
      act(() => api('PATCH', `/api/admin/props/${id}`, { status }), status === 'open' ? 'Prop reopened.' : 'Prop closed to new bets.');
    });
    $$('[data-pwin]', list).forEach(b => b.onclick = () => {
      const opt = b.dataset.opt;
      if (!confirm(opt === 'void' ? 'Void every bet on this prop and refund the stakes?' : `Grade "${opt}" as the winner? Every other option loses.`)) return;
      act(() => api('POST', `/api/admin/props/${b.dataset.pwin}/settle`, { winner: opt }), r => `Graded ${r.graded} bet${r.graded === 1 ? '' : 's'}.`);
    });
    $$('[data-regrade]', list).forEach(b => b.onclick = () => {
      if (!confirm('Put every bet on this prop back to pending? Credit paid out is taken back until you grade it again.')) return;
      act(() => api('POST', `/api/admin/props/${b.dataset.regrade}/settle`, { winner: 'pending' }), 'Grading undone.');
    });
    $$('[data-pdel]', list).forEach(b => b.onclick = () => {
      if (!confirm('Delete this prop?')) return;
      act(() => api('DELETE', `/api/admin/props/${b.dataset.pdel}`), 'Prop deleted.');
    });
  }

  function newPropModal(done) {
    const optRow = (name = '', price = '') => `<div class="row opt" style="gap:8px;margin-bottom:8px"><input type="text" class="grow" style="width:auto" placeholder="Option, e.g. Yes" value="${esc(name)}" data-oname>
      <input type="text" inputmode="numeric" style="width:110px" placeholder="Odds, e.g. +250" value="${esc(price)}" data-oprice></div>`;
    const local = d => new Date(d.getTime() - d.getTimezoneOffset() * 60e3).toISOString().slice(0, 16);
    modal(`<div class="modal-head"><h2>New prop</h2><button class="btn sm" data-close>Close</button></div>
      <form id="np">
        <div class="tabs"><button type="button" data-kind="game" class="on">On a game</button><button type="button" data-kind="special">Stand-alone special</button></div>
        <div id="kGame" class="grid2">
          <label class="field"><span>Sport</span><select id="pSport"></select></label>
          <label class="field"><span>Game</span><select id="pGame"><option value="">Loading…</option></select></label>
        </div>
        <div id="kSpecial" class="grid2 hidden">
          <label class="field"><span>Event (shown to clients)</span><input type="text" id="pEvent" placeholder="e.g. NFL Awards"></label>
          <label class="field"><span>Betting closes</span><input type="datetime-local" id="pCloses" value="${local(new Date(Date.now() + 7 * 86400e3))}"></label>
        </div>
        <label class="field"><span>Prop</span><input type="text" id="pQ" placeholder="e.g. Will the game go to overtime?" required></label>
        <div class="small muted" style="margin-bottom:6px">Options and their odds (American, like -150 or +300). Leave a row blank to skip it.</div>
        <div id="opts">${optRow('Yes')}${optRow('No')}</div>
        <button type="button" class="btn sm" id="addOpt" style="margin-bottom:12px">Add option</button>
        <div class="error" id="npErr"></div><button class="btn primary">Create prop</button>
      </form>`, async (root, close) => {
      let kind = 'game';
      $$('[data-kind]', root).forEach(b => b.onclick = () => {
        kind = b.dataset.kind;
        $$('[data-kind]', root).forEach(x => x.classList.toggle('on', x === b));
        $('#kGame', root).classList.toggle('hidden', kind !== 'game');
        $('#kSpecial', root).classList.toggle('hidden', kind !== 'special');
      });
      $('#addOpt', root).onclick = () => $('#opts', root).insertAdjacentHTML('beforeend', optRow());
      const sportSel = $('#pSport', root), gameSel = $('#pGame', root);
      const loadGamesFor = async () => {
        gameSel.innerHTML = '<option value="">Loading…</option>';
        try {
          const { events } = await api('GET', '/api/odds/' + encodeURIComponent(sportSel.value));
          gameSel.innerHTML = events.length ? events.map(e => `<option value="${esc(e.id)}">${esc(e.away_team)} @ ${esc(e.home_team)} · ${esc(when(e.commence_time))}</option>`).join('') : '<option value="">No upcoming games</option>';
        } catch (e) { gameSel.innerHTML = `<option value="">${esc(e.message)}</option>`; }
      };
      try {
        const { sports } = await api('GET', '/api/sports');
        sportSel.innerHTML = sports.filter(x => x.key !== 'specials').map(x => `<option value="${esc(x.key)}">${esc(x.title)}</option>`).join('');
        sportSel.onchange = loadGamesFor;
        if (sportSel.value) loadGamesFor(); else gameSel.innerHTML = '<option value="">No sports open</option>';
      } catch (e) { toast(e.message, true); }
      $('#np', root).onsubmit = async e => {
        e.preventDefault();
        const body = {
          question: $('#pQ', root).value,
          options: $$('.opt', root).map(r => ({ name: $('[data-oname]', r).value.trim(), price: $('[data-oprice]', r).value.trim() })).filter(o => o.name || o.price),
        };
        if (kind === 'game') {
          if (!gameSel.value) { $('#npErr', root).textContent = 'Pick a game.'; return; }
          Object.assign(body, { sportKey: sportSel.value, eventId: gameSel.value });
        } else {
          const c = $('#pCloses', root).value;
          Object.assign(body, { eventName: $('#pEvent', root).value, closesAt: c ? new Date(c).toISOString() : '' });
        }
        try { await api('POST', '/api/admin/props', body); close(); toast('Prop created.'); state.sports = []; done(); }
        catch (err) { $('#npErr', root).textContent = err.message; }
      };
    });
  }

  async function renderRisk() {
    const view = shell('<h1>Risk</h1><p class="muted small">Open action by game and side. Straight-bet payout is what you pay if that side wins; parlays and teasers are counted in stake only.</p><div class="panel"><div class="table-wrap" id="r">Loading…</div></div>');
    const { exposure } = await api('GET', '/api/admin/exposure');
    if (!exposure.length) { $('#r', view).innerHTML = '<div class="muted">No open action.</div>'; return; }
    $('#r', view).innerHTML = `<table><thead><tr><th>Game</th><th>Pick</th><th class="r">Bets</th><th class="r">Staked</th><th class="r">Straight payout</th></tr></thead><tbody>
      ${exposure.map(x => `<tr><td><b>${esc(evName(x.away_team, x.home_team, x.sport_title))}</b><div class="small muted">${esc(x.sport_title || '')} · ${esc(when(x.commence_time))}</div></td>
        <td>${esc(legLabel(x))}<div class="small muted">${esc(MARKET[x.market] || 'Prop')}</div></td><td class="r num">${x.bets}</td>
        <td class="r num">${money(x.stake_cents)}</td><td class="r num">${money(x.single_payout_cents)}</td></tr>`).join('')}
    </tbody></table>`;
  }

  async function renderLedger() {
    const view = shell('<h1>Ledger</h1><div class="panel"><div class="table-wrap" id="l">Loading…</div></div>');
    const { transactions } = await api('GET', '/api/admin/transactions');
    $('#l', view).innerHTML = txTable(transactions, true);
  }

  async function renderSettings() {
    const view = shell('<h1>Settings</h1><div id="s"><div class="empty">Loading…</div></div>');
    const { settings: s, odds: o, sports, envKey } = await api('GET', '/api/admin/settings');
    const d = c => ((Number(c) || 0) / 100).toFixed(2);
    let teaser = {};
    try { teaser = JSON.parse(s.teaser_odds) || {}; } catch { /* keep blank */ }
    const groups = {};
    for (const sp of sports) (groups[sp.group] = groups[sp.group] || []).push(sp);
    $('#s', view).innerHTML = `
      <form id="st">
      <div class="panel"><h3>Book</h3>
        <label class="field"><span>Book name</span><input type="text" name="book_name" value="${esc(s.book_name)}"></label>
        <label class="check"><input type="checkbox" name="betting_open" ${s.betting_open === '1' ? 'checked' : ''}> Betting is open</label>
        <label class="check"><input type="checkbox" name="auto_grade" ${s.auto_grade === '1' ? 'checked' : ''}> Grade bets automatically from final scores</label>
      </div>
      <div class="panel"><h3>Limits</h3><div class="grid2">
        <label class="field"><span>Minimum bet ($)</span><input type="number" step="0.01" min="0" data-cents="min_bet_cents" value="${d(s.min_bet_cents)}"></label>
        <label class="field"><span>Maximum bet ($)</span><input type="number" step="0.01" min="0" data-cents="max_bet_cents" value="${d(s.max_bet_cents)}"></label>
        <label class="field"><span>Maximum payout per bet ($)</span><input type="number" step="0.01" min="0" data-cents="max_payout_cents" value="${d(s.max_payout_cents)}"></label>
        <label class="field"><span>Maximum parlay legs</span><input type="number" min="2" max="15" name="max_parlay_legs" value="${esc(s.max_parlay_legs)}"></label>
      </div></div>
      <div class="panel"><h3>Teaser payouts</h3>
        <p class="small muted" style="margin-top:0">Football and basketball spreads and totals only. Enter American odds for each number of legs; a blank box turns that size off. A pushed leg drops out and the teaser pays at the next size down; a 2-leg teaser with a push is refunded.</p>
        <div class="table-wrap"><table><thead><tr><th>Legs</th>${['6', '6.5', '7'].map(p => `<th>${p} pts</th>`).join('')}</tr></thead><tbody>
        ${['2', '3', '4', '5', '6'].map(n => `<tr><td>${n}</td>${['6', '6.5', '7'].map(p => `<td><input type="text" inputmode="numeric" style="width:80px" data-teaser="${p}|${n}" value="${esc(teaser[p] && teaser[p][n] != null ? odds(teaser[p][n]) : '')}"></td>`).join('')}</tr>`).join('')}
        </tbody></table></div>
      </div>
      <div class="panel"><h3>Client sign up</h3>
        <label class="check"><input type="checkbox" name="signup_enabled" ${s.signup_enabled === '1' ? 'checked' : ''}> Let people create their own account from the link</label>
        <div class="grid2">
          <label class="field"><span>Invite code (required to sign up; blank = anyone with the link)</span><input type="text" name="signup_code" value="${esc(s.signup_code)}"></label>
          <label class="field"><span>Starting credit for new sign ups ($)</span><input type="number" step="0.01" min="0" data-cents="signup_starting_credit_cents" value="${d(s.signup_starting_credit_cents)}"></label>
        </div></div>
      <div class="panel"><h3>Odds feed</h3>
        <p class="small muted" style="margin-top:0">Real lines come from <a href="https://the-odds-api.com" target="_blank" rel="noopener">The Odds API</a>, which carries DraftKings, FanDuel, BetMGM and more. Its free plan gives 500 requests a month; each sport refresh uses about 3.</p>
        <p style="margin-top:0">Status: <b>${o.live ? 'Live' : 'Demo odds'}</b>${o.quotaRemaining ? ` · ${esc(o.quotaRemaining)} requests left this month` : ''}${o.lastError ? `<br><span class="neg small">${esc(o.lastError)}</span>` : ''}</p>
        <label class="field"><span>API key ${envKey && !s.odds_api_key ? '(set in the server environment)' : ''}</span><input type="text" name="odds_api_key" value="${esc(s.odds_api_key)}" placeholder="Paste your key from the-odds-api.com" autocomplete="off"></label>
        <div class="grid2">
          <label class="field"><span>Refresh odds every (minutes)</span><input type="number" min="1" name="odds_ttl_minutes" value="${esc(s.odds_ttl_minutes)}"></label>
          <label class="field"><span>Stop refreshing when fewer requests than this remain</span><input type="number" min="0" name="odds_quota_floor" value="${esc(s.odds_quota_floor)}"></label>
        </div>
        <label class="field"><span>Sportsbooks to copy lines from, in order of preference</span><input type="text" name="bookmakers" value="${esc(s.bookmakers)}"></label>
        <label class="check"><input type="checkbox" name="props_enabled" ${s.props_enabled === '1' ? 'checked' : ''}> Offer player and game props from the feed (NFL, NBA, MLB, NHL)</label>
        <label class="field"><span>Refresh a game's props every (minutes)</span><input type="number" min="1" name="props_ttl_minutes" value="${esc(s.props_ttl_minutes)}"></label>
        <p class="small muted" style="margin-top:0">Props load only when someone opens a game's props, and each load uses about 6 requests (one per prop market). The free plan's 500 a month runs out quickly; the $30 plan (20,000 a month) is plenty for a small book. Your own props under <a href="#/admin/props">Props</a> use no requests.</p>
        <button type="button" class="btn" id="refresh">Refresh odds now</button>
      </div>
      <div class="panel"><h3>Sports on the board</h3>
        <p class="small muted" style="margin-top:0">Only sports that are in season show up for clients.${o.live ? '' : ' With a live key you will see every league the feed offers here.'}</p>
        <div class="sport-groups">${Object.entries(groups).sort().map(([g, list]) => `<h4>${esc(g)}</h4>${list.map(sp => `<label class="check"><input type="checkbox" data-sportkey="${esc(sp.key)}" ${sp.enabled ? 'checked' : ''}> ${esc(sp.title)}${sp.active ? '' : ' <span class="muted small">(off season)</span>'}</label>`).join('')}`).join('')}</div>
      </div>
      <button class="btn primary" style="padding:11px 22px">Save settings</button>
      </form>`;
    const form = $('#st', view);
    $('#refresh', view).onclick = async e => {
      e.target.disabled = true;
      try { const r = await api('POST', '/api/admin/odds/refresh', {}); toast(`Loaded ${r.events} games across ${r.sports} sports.`); state.sports = []; }
      catch (err) { toast(err.message, true); }
      e.target.disabled = false;
    };
    form.onsubmit = async e => {
      e.preventDefault();
      const body = {};
      for (const el of $$('input[name], select[name]', form)) body[el.name] = el.type === 'checkbox' ? (el.checked ? '1' : '0') : el.value;
      for (const el of $$('[data-cents]', form)) body[el.dataset.cents] = Math.round((parseFloat(el.value) || 0) * 100);
      const t = {};
      for (const el of $$('[data-teaser]', form)) {
        const [p, n] = el.dataset.teaser.split('|');
        (t[p] = t[p] || {})[n] = el.value.trim().replace(/^\+/, '');
      }
      body.teaser_odds = t;
      body.enabled_sports = $$('[data-sportkey]', form).filter(x => x.checked).map(x => x.dataset.sportkey).join(',');
      try {
        await api('PATCH', '/api/admin/settings', body);
        toast('Settings saved.');
        state.sports = [];
        const me = await api('GET', '/api/me');
        state.book = me.book;
        renderSettings();
      } catch (err) { toast(err.message, true); }
    };
  }

  // ---------- router ----------
  async function render() {
    if (!state.me) return renderAuth();
    const r = route();
    const admin = state.me.role === 'admin';
    try {
      if (admin) {
        if (r === '' || r === 'admin') return await renderDashboard();
        if (r === 'admin/clients') return await renderClients();
        if (r.startsWith('admin/clients/')) return await renderClient(r.split('/')[2]);
        if (r === 'admin/bets') return await renderAdminBets();
        if (r === 'admin/props') return await renderAdminProps();
        if (r === 'admin/risk') return await renderRisk();
        if (r === 'admin/ledger') return await renderLedger();
        if (r === 'admin/settings') return await renderSettings();
        if (r === 'odds') return await renderBoard();
        if (r === 'account') return await renderAccount();
        location.hash = '#/admin';
        return;
      }
      if (r === 'bets') return await renderMyBets();
      if (r === 'account') return await renderAccount();
      return await renderBoard();
    } catch (e) {
      if (e.status !== 401) toast(e.message, true);
    }
  }

  async function boot() {
    try {
      const r = await api('GET', '/api/me');
      state.me = r.user;
      state.book = r.book;
      document.title = r.book.name;
    } catch {
      state.me = null;
      try { state.book = await api('GET', '/api/book'); document.title = state.book.name; } catch { /* offline */ }
    }
    render();
  }

  window.addEventListener('hashchange', render);
  // Keep the balance fresh (bets get graded in the background).
  setInterval(async () => {
    if (!state.me || state.me.role !== 'client' || document.hidden) return;
    try { const r = await api('GET', '/api/me'); setBalance(r.user.balanceCents, r.user.freeplayCents); } catch { /* ignore */ }
  }, 60e3);
  boot();
})();
