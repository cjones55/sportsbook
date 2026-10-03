'use strict';
const { db, tx, intSetting, getSetting, teaserOdds } = require('./db');
const odds = require('./odds');
const props = require('./props');

class UserError extends Error {
  constructor(message, status = 400, extra) { super(message); this.status = status; this.extra = extra; }
}

function americanToDecimal(a) {
  a = Number(a);
  return a > 0 ? 1 + a / 100 : 1 + 100 / Math.abs(a);
}
function decimalToAmerican(d) {
  return d >= 2 ? Math.round((d - 1) * 100) : Math.round(-100 / (d - 1));
}

// ---------- wallet ----------

// wallet is 'credit' (real balance) or 'freeplay' (bonus balance the admin hands out).
function applyTransaction(userId, amountCents, type, { betId = null, note = null, by = null, wallet = 'credit' } = {}) {
  const col = wallet === 'freeplay' ? 'freeplay_cents' : 'balance_cents';
  return tx(() => {
    const u = db.prepare(`SELECT ${col} bal FROM users WHERE id = ?`).get(userId);
    if (!u) throw new UserError('User not found', 404);
    const after = u.bal + amountCents;
    db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(after, userId);
    db.prepare(`INSERT INTO transactions(user_id, type, amount_cents, balance_after_cents, bet_id, note, created_by, wallet)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, type, amountCents, after, betId, note, by, wallet);
    return after;
  });
}

// ---------- placing bets ----------

const TEASER_SPORTS = ['americanfootball_', 'basketball_'];
const TEASER_POINTS = [6, 6.5, 7];

// Move a line in the bettor's favor by the teaser points.
function teasePoint(market, selection, point, pts) {
  if (market === 'totals') return selection === 'Over' ? Number(point) - pts : Number(point) + pts;
  return Number(point) + pts;
}

function findOutcome(event, market, selection, point) {
  const outs = event.markets[market];
  if (!outs) return null;
  return outs.find(o => o.name === selection && (market === 'h2h' || Number(o.point) === Number(point))) || null;
}

async function placeBet(user, body) {
  if (getSetting('betting_open') !== '1') throw new UserError('Betting is currently closed.');
  const type = ['parlay', 'teaser'].includes(body.type) ? body.type : 'single';
  const legsIn = Array.isArray(body.legs) ? body.legs : [];
  const stake = Math.round(Number(body.stake) * 100);
  const freeplay = body.freeplay === true || body.freeplay === '1' || body.freeplay === 1;
  if (!Number.isFinite(stake) || stake <= 0) throw new UserError('Enter a valid stake.');
  if (type === 'single' && legsIn.length !== 1) throw new UserError('A straight bet has exactly one selection.');
  if (type === 'parlay') {
    if (legsIn.length < 2) throw new UserError('A parlay needs at least 2 selections.');
    if (legsIn.length > intSetting('max_parlay_legs')) throw new UserError(`Parlays are limited to ${intSetting('max_parlay_legs')} selections.`);
    const ids = new Set(legsIn.map(l => l.eventId));
    if (ids.size !== legsIn.length) throw new UserError('A parlay can only include one selection per game.');
  }
  if (type !== 'single' && legsIn.some(l => props.isProp(l.market))) throw new UserError('Props are straight bets only. Take them out to make a parlay or teaser.');
  let teaserPts = null, teaserRow = null;
  if (type === 'teaser') {
    teaserPts = Number(body.teaserPoints);
    teaserRow = teaserOdds()[teaserPts];
    if (!TEASER_POINTS.includes(teaserPts) || !teaserRow) throw new UserError('Pick a 6, 6.5 or 7 point teaser.');
    const maxLegs = Math.max(...Object.keys(teaserRow).map(Number));
    if (legsIn.length < 2) throw new UserError('A teaser needs at least 2 selections.');
    if (legsIn.length > maxLegs || !teaserRow[legsIn.length]) throw new UserError(`Teasers are limited to ${maxLegs} selections.`);
    if (new Set(legsIn.map(l => l.eventId)).size !== legsIn.length) throw new UserError('A teaser can only include one selection per game.');
    for (const l of legsIn) {
      if (!['spreads', 'totals'].includes(l.market)) throw new UserError('Teasers are spreads and totals only.');
      if (!TEASER_SPORTS.some(p => String(l.sportKey).startsWith(p))) throw new UserError('Teasers are football and basketball only.');
    }
  }

  const minBet = intSetting('min_bet_cents');
  const maxBet = user.max_bet_cents ?? intSetting('max_bet_cents');
  if (stake < minBet) throw new UserError(`Minimum bet is $${(minBet / 100).toFixed(2)}.`);
  if (maxBet && stake > maxBet) throw new UserError(`Maximum bet is $${(maxBet / 100).toFixed(2)}.`);

  // Validate every leg against current odds.
  const legs = [];
  const changed = [];
  const bySport = {};
  for (const l of legsIn) {
    if (props.isProp(l.market)) {
      const r = await props.resolveLeg(l);
      if (r.gone) throw new UserError(r.gone, 409);
      if (r.removed) { changed.push({ ...l, removed: true }); continue; }
      if (r.changed) { changed.push({ ...l, ...r.changed }); continue; }
      legs.push({ ...r.leg, origPoint: null });
      continue;
    }
    if (!['h2h', 'spreads', 'totals'].includes(l.market)) throw new UserError('Unknown market.');
    bySport[l.sportKey] = bySport[l.sportKey] || (await odds.getEvents(l.sportKey)).events;
    const event = bySport[l.sportKey].find(e => e.id === l.eventId);
    if (!event) throw new UserError('One of your games is no longer available.', 409);
    if (Date.parse(event.commence_time) <= Date.now()) throw new UserError(`${event.away_team} @ ${event.home_team} has already started.`, 409);
    const out = findOutcome(event, l.market, l.selection, l.point);
    if (!out) { changed.push({ ...l, removed: true }); continue; }
    // A teaser pays from the table, so only the line matters, not the price.
    if (type !== 'teaser' && Number(out.price) !== Number(l.price)) { changed.push({ ...l, price: out.price, point: out.point }); continue; }
    const point = type === 'teaser' ? teasePoint(l.market, out.name, out.point, teaserPts) : out.point;
    legs.push({ event, market: l.market, selection: out.name, point, origPoint: out.point, price: out.price });
  }
  if (changed.length) throw new UserError('Odds have changed. Review your bet slip and try again.', 409, { changed });

  const dec = type === 'teaser'
    ? americanToDecimal(teaserRow[legs.length])
    : legs.reduce((acc, l) => acc * americanToDecimal(l.price), 1);
  // A free play win pays the profit only; the stake is not returned.
  const payout = Math.floor(stake * dec) - (freeplay ? stake : 0);
  const maxPayout = intSetting('max_payout_cents');
  if (maxPayout && payout > maxPayout) throw new UserError(`Maximum payout is $${(maxPayout / 100).toFixed(2)}. Lower your stake.`);

  return tx(() => {
    const fresh = db.prepare('SELECT balance_cents, freeplay_cents, status FROM users WHERE id = ?').get(user.id);
    if (fresh.status !== 'active') throw new UserError('Account is suspended.', 403);
    if (freeplay && fresh.freeplay_cents < stake) throw new UserError('Not enough free play for this bet.');
    if (!freeplay && fresh.balance_cents < stake) throw new UserError('Not enough credit for this bet.');
    const { lastInsertRowid: betId } = db.prepare(`INSERT INTO bets(user_id, type, stake_cents, decimal_odds, potential_payout_cents, teaser_points, teaser_odds, freeplay)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?)`).run(user.id, type, stake, dec, payout, teaserPts, teaserRow && JSON.stringify(teaserRow), freeplay ? 1 : 0);
    const ins = db.prepare(`INSERT INTO bet_legs(bet_id, event_id, sport_key, sport_title, home_team, away_team, commence_time, market, selection, point, orig_point, price,
        description, prop_name, prop_id)
      VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const l of legs) {
      ins.run(betId, l.event.id, l.event.sport_key, l.event.sport_title, l.event.home_team, l.event.away_team,
        l.event.commence_time, l.market, l.selection, l.point, type === 'teaser' ? l.origPoint : null, l.price,
        l.description ?? null, l.propName ?? null, l.propId ?? null);
    }
    applyTransaction(user.id, -stake, 'bet', { betId: Number(betId), note: `Bet #${betId}`, wallet: freeplay ? 'freeplay' : 'credit' });
    return getBet(Number(betId));
  });
}

// ---------- reading ----------

function getBet(id) {
  const bet = db.prepare('SELECT b.*, u.username FROM bets b JOIN users u ON u.id = b.user_id WHERE b.id = ?').get(id);
  if (!bet) return null;
  bet.legs = db.prepare('SELECT * FROM bet_legs WHERE bet_id = ? ORDER BY id').all(id);
  return bet;
}

function listBets({ userId, status, limit = 200, offset = 0 } = {}) {
  const where = [];
  const args = [];
  if (userId) { where.push('b.user_id = ?'); args.push(userId); }
  if (status === 'open') where.push("b.status = 'pending'");
  else if (status === 'settled') where.push("b.status != 'pending'");
  else if (status === 'props') where.push("b.status = 'pending' AND EXISTS (SELECT 1 FROM bet_legs pl WHERE pl.bet_id = b.id AND pl.market NOT IN ('h2h','spreads','totals'))");
  else if (status) { where.push('b.status = ?'); args.push(status); }
  const sql = `SELECT b.*, u.username FROM bets b JOIN users u ON u.id = b.user_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY b.id DESC LIMIT ? OFFSET ?`;
  const bets = db.prepare(sql).all(...args, limit, offset);
  if (!bets.length) return bets;
  const legs = db.prepare(`SELECT * FROM bet_legs WHERE bet_id IN (${bets.map(() => '?').join(',')}) ORDER BY id`)
    .all(...bets.map(b => b.id));
  for (const b of bets) b.legs = legs.filter(l => l.bet_id === b.id);
  return bets;
}

// ---------- settlement ----------

const FINAL = ['won', 'lost', 'push', 'void'];

// Work out a bet's status and payout from its legs.
function evaluate(bet, legs) {
  if (bet.type === 'single') {
    const s = legs[0].status;
    if (s === 'pending') return { status: 'pending', payout: 0 };
    if (s === 'won') return { status: 'won', payout: Math.floor(bet.stake_cents * americanToDecimal(legs[0].price)) };
    if (s === 'lost') return { status: 'lost', payout: 0 };
    return { status: s, payout: bet.stake_cents };
  }
  if (legs.some(l => l.status === 'lost')) return { status: 'lost', payout: 0 };
  if (legs.some(l => l.status === 'pending')) return { status: 'pending', payout: 0 };
  if (legs.every(l => l.status === 'void')) return { status: 'void', payout: bet.stake_cents };
  const winners = legs.filter(l => l.status === 'won');
  if (bet.type === 'teaser') {
    // Pushed or voided legs drop out and the teaser pays at the smaller size.
    // Fewer than 2 winners left means the whole teaser is a push.
    const table = JSON.parse(bet.teaser_odds || '{}');
    if (winners.length < 2 || !table[winners.length]) return { status: 'push', payout: bet.stake_cents };
    return { status: 'won', payout: Math.floor(bet.stake_cents * americanToDecimal(table[winners.length])) };
  }
  if (!winners.length) return { status: 'push', payout: bet.stake_cents };
  const dec = winners.reduce((acc, l) => acc * americanToDecimal(l.price), 1);
  return { status: 'won', payout: Math.floor(bet.stake_cents * dec) };
}

// What a bet pays in credit (payout) and hands back as free play (back).
// Free play bets: a win pays profit only, a push or void returns the free play.
function outcome(bet, legs) {
  const r = evaluate(bet, legs);
  if (!bet.freeplay) return { ...r, back: 0 };
  if (r.status === 'won') return { status: 'won', payout: Math.max(0, r.payout - bet.stake_cents), back: 0 };
  if (r.status === 'push' || r.status === 'void') return { status: r.status, payout: 0, back: bet.stake_cents };
  return { status: r.status, payout: 0, back: 0 };
}

// Recompute a bet after a leg changed, and move credit by the difference from
// whatever was paid before (so re-grading a settled bet corrects the balance).
function refreshBet(betId, settledBy) {
  return tx(() => {
    const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(betId);
    const legs = db.prepare('SELECT * FROM bet_legs WHERE bet_id = ?').all(betId);
    const { status, payout, back } = outcome(bet, legs);
    if (status === bet.status && payout === bet.payout_cents && back === bet.freeplay_back_cents) return;
    const delta = payout - bet.payout_cents;
    const backDelta = back - bet.freeplay_back_cents;
    db.prepare(`UPDATE bets SET status = ?, payout_cents = ?, freeplay_back_cents = ?, settled_at = CASE WHEN ? = 'pending' THEN NULL ELSE datetime('now') END,
      settled_by = ? WHERE id = ?`).run(status, payout, back, status, status === 'pending' ? null : settledBy, betId);
    const type = bet.status === 'pending' ? (status === 'won' ? 'payout' : 'refund') : 'regrade';
    if (delta !== 0) applyTransaction(bet.user_id, delta, type, { betId, note: `Bet #${betId} ${status}` });
    if (backDelta !== 0) applyTransaction(bet.user_id, backDelta, type, { betId, note: `Bet #${betId} ${status}`, wallet: 'freeplay' });
  });
}

function settleLeg(legId, status, { by = 'admin', note = null } = {}) {
  if (!FINAL.includes(status) && status !== 'pending') throw new UserError('Invalid result.');
  const leg = db.prepare('SELECT * FROM bet_legs WHERE id = ?').get(legId);
  if (!leg) throw new UserError('Selection not found.', 404);
  tx(() => {
    db.prepare('UPDATE bet_legs SET status = ?, result_note = ? WHERE id = ?').run(status, note, legId);
    refreshBet(leg.bet_id, by);
  });
  return getBet(leg.bet_id);
}

// Settle a whole bet in one step (all legs to the same result, e.g. void a bet).
function settleBet(betId, status, { by = 'admin' } = {}) {
  if (!FINAL.includes(status) && status !== 'pending') throw new UserError('Invalid result.');
  const bet = db.prepare('SELECT * FROM bets WHERE id = ?').get(betId);
  if (!bet) throw new UserError('Bet not found.', 404);
  tx(() => {
    db.prepare('UPDATE bet_legs SET status = ?, result_note = ? WHERE bet_id = ?').run(status, `Set by ${by}`, betId);
    refreshBet(betId, by);
  });
  return getBet(betId);
}

function gradeLeg(leg, score) {
  const mine = leg.selection === score.home_team ? score.home_score : leg.selection === score.away_team ? score.away_score : null;
  const theirs = leg.selection === score.home_team ? score.away_score : score.home_score;
  const note = `Final: ${score.away_team} ${score.away_score}, ${score.home_team} ${score.home_score}`;
  if (leg.market === 'totals') {
    const total = score.home_score + score.away_score;
    if (total === leg.point) return { status: 'push', note };
    const over = total > leg.point;
    return { status: (leg.selection === 'Over') === over ? 'won' : 'lost', note };
  }
  if (mine === null) return null;
  const adj = mine + (leg.market === 'spreads' ? Number(leg.point) : 0);
  if (adj === theirs) return { status: 'push', note };
  return { status: adj > theirs ? 'won' : 'lost', note };
}

// Pull final scores for sports with open bets and grade everything that finished.
async function autoGrade({ force = false } = {}) {
  if (!force && getSetting('auto_grade') !== '1') return { graded: 0, errors: [] };
  // Props are left for the bookie: the scores feed has no player stats.
  const pending = db.prepare(`SELECT * FROM bet_legs WHERE status = 'pending' AND market IN ('h2h','spreads','totals') AND commence_time < ?`)
    .all(new Date(Date.now() - 2 * 3600e3).toISOString());
  if (!pending.length) return { graded: 0, errors: [] };
  const errors = [];
  const needScores = [...new Set(pending.filter(l => !l.event_id.startsWith('demo_')).map(l => l.sport_key))];
  const have = new Set(db.prepare('SELECT event_id FROM scores WHERE completed = 1').all().map(r => r.event_id));
  for (const sport of needScores) {
    if (pending.filter(l => l.sport_key === sport).every(l => have.has(l.event_id))) continue;
    try { await odds.fetchScores(sport); } catch (err) { errors.push(`${sport}: ${err.message}`); }
  }
  odds.mockScoresFor(pending);
  let graded = 0;
  const getScore = db.prepare('SELECT * FROM scores WHERE event_id = ? AND completed = 1');
  for (const leg of pending) {
    const score = getScore.get(leg.event_id);
    if (!score) continue;
    const g = gradeLeg(leg, score);
    if (!g) continue;
    settleLeg(leg.id, g.status, { by: 'auto', note: g.note });
    graded++;
  }
  return { graded, errors };
}

// ---------- reporting ----------

function summary() {
  const q = (sql, ...a) => db.prepare(sql).get(...a);
  const clients = q("SELECT COUNT(*) n, COALESCE(SUM(balance_cents),0) bal, COALESCE(SUM(freeplay_cents),0) fp FROM users WHERE role = 'client'");
  const open = q("SELECT COUNT(*) n, COALESCE(SUM(stake_cents),0) stake, COALESCE(SUM(potential_payout_cents),0) liability FROM bets WHERE status = 'pending'");
  // Free play stakes are not real money, so they don't count toward the book's take.
  const settled = q(`SELECT COUNT(*) n, COALESCE(SUM(stake_cents),0) stake, COALESCE(SUM(CASE WHEN freeplay = 1 THEN 0 ELSE stake_cents END),0) real,
    COALESCE(SUM(payout_cents),0) paid FROM bets WHERE status != 'pending'`);
  const today = q("SELECT COUNT(*) n, COALESCE(SUM(stake_cents),0) stake FROM bets WHERE created_at >= datetime('now','start of day')");
  const week = q(`SELECT COALESCE(SUM(CASE WHEN freeplay = 1 THEN 0 ELSE stake_cents END),0) stake, COALESCE(SUM(payout_cents),0) paid FROM bets
    WHERE status != 'pending' AND settled_at >= datetime('now','-7 days')`);
  const stale = q(`SELECT COUNT(DISTINCT bet_id) n FROM bet_legs WHERE status = 'pending' AND commence_time < ?`,
    new Date(Date.now() - 12 * 3600e3).toISOString());
  return {
    clients: clients.n, clientBalanceCents: clients.bal, clientFreeplayCents: clients.fp,
    openBets: open.n, openStakeCents: open.stake, openLiabilityCents: open.liability,
    settledBets: settled.n, handleCents: settled.stake, bookProfitCents: settled.real - settled.paid,
    todayBets: today.n, todayStakeCents: today.stake,
    weekProfitCents: week.stake - week.paid,
    needsGrading: stale.n,
  };
}

// Open liability per game, so the bookie can see where the risk is.
function exposure() {
  return db.prepare(`
    SELECT l.event_id, l.sport_title, l.home_team, l.away_team, l.commence_time, l.market, l.selection, l.point, l.description, l.prop_name,
      COUNT(*) bets, SUM(b.stake_cents) stake_cents,
      SUM(CASE WHEN b.type = 'single' THEN b.potential_payout_cents ELSE 0 END) single_payout_cents
    FROM bet_legs l JOIN bets b ON b.id = l.bet_id
    WHERE b.status = 'pending' AND l.status = 'pending'
    GROUP BY l.event_id, l.market, l.description, l.prop_id, l.selection, l.point
    ORDER BY l.commence_time, l.event_id`).all();
}

// Grade every pick on one of the bookie's own props at once: the winning option wins, the rest lose.
// winner 'void' refunds them all; 'pending' reopens grading.
function settleCustomProp(propId, winner) {
  const prop = db.prepare('SELECT * FROM custom_props WHERE id = ?').get(propId);
  if (!prop) throw new UserError('Prop not found.', 404);
  const options = JSON.parse(prop.options).map(o => o.name);
  if (!['void', 'pending'].includes(winner) && !options.includes(winner)) throw new UserError('Pick the option that won.');
  let graded = 0;
  tx(() => {
    for (const leg of db.prepare('SELECT * FROM bet_legs WHERE prop_id = ?').all(propId)) {
      const status = winner === 'void' || winner === 'pending' ? winner : leg.selection === winner ? 'won' : 'lost';
      if (leg.status === status) continue;
      settleLeg(leg.id, status, { by: 'admin', note: winner === 'pending' ? null : `Result: ${winner === 'void' ? 'void' : winner}` });
      graded++;
    }
    db.prepare('UPDATE custom_props SET status = ?, result = ? WHERE id = ?')
      .run(winner === 'pending' ? 'closed' : 'settled', winner === 'pending' ? null : winner, propId);
  });
  return { graded };
}

module.exports = {
  settleCustomProp,
  UserError, americanToDecimal, decimalToAmerican, applyTransaction, placeBet, getBet, listBets,
  settleLeg, settleBet, autoGrade, gradeLeg, evaluate, summary, exposure, teasePoint,
};
