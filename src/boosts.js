'use strict';
// Profit boosts. The bookie creates a boost (e.g. "+25% profit on any parlay, up to $50 stake"),
// clients pick it on the bet slip, and a winning bet pays its profit raised by that percentage.
// The stake is never boosted, and a push or void just returns the stake as usual.
const { db } = require('./db');

const BET_TYPES = ['any', 'single', 'parlay'];

function userError(msg, status) {
  const { UserError } = require('./bets');
  return new UserError(msg, status);
}

// What a winning bet pays with the boost: stake back plus profit * (1 + pct/100).
function boostedPayout(stakeCents, payoutCents, pct) {
  if (!pct || payoutCents <= stakeCents) return payoutCents;
  return stakeCents + Math.floor((payoutCents - stakeCents) * (100 + pct) / 100);
}

const nowSql = () => new Date().toISOString();

function usedBy(boostId, userId) {
  return db.prepare('SELECT COUNT(*) n FROM bets WHERE boost_id = ? AND user_id = ?').get(boostId, userId).n;
}

function isLive(b) {
  return b.status === 'active' && (!b.expires_at || b.expires_at > nowSql());
}

function view(b, userId) {
  const out = {
    id: b.id, title: b.title, pct: b.pct, betType: b.bet_type, sportKey: b.sport_key || null, minLegs: b.min_legs,
    maxStakeCents: b.max_stake_cents, usesPerClient: b.uses_per_client, expiresAt: b.expires_at, status: b.status,
  };
  if (userId) out.usesLeft = Math.max(0, b.uses_per_client - usedBy(b.id, userId));
  return out;
}

// Boosts this client can still use.
function forClient(user) {
  return db.prepare('SELECT * FROM boosts WHERE (user_id IS NULL OR user_id = ?) ORDER BY pct DESC, id DESC').all(user.id)
    .filter(isLive).map(b => view(b, user.id)).filter(b => b.usesLeft > 0);
}

// Make sure a boost can go on this bet. sports is the sport of each pick.
function check(user, boostId, { type, sports, stakeCents, freeplay }) {
  const b = db.prepare('SELECT * FROM boosts WHERE id = ?').get(boostId);
  if (!b || (b.user_id && b.user_id !== user.id) || !isLive(b)) throw userError('That profit boost is no longer available.', 409);
  if (freeplay) throw userError("A profit boost can't be used on a free play bet.");
  if (type === 'teaser') throw userError("Profit boosts can't be used on teasers.");
  if (b.bet_type !== 'any' && b.bet_type !== type) throw userError(`This boost is for ${b.bet_type === 'single' ? 'straight bets' : 'parlays'} only.`);
  if (sports.length < b.min_legs) throw userError(`This boost needs a parlay of at least ${b.min_legs} picks.`);
  if (b.sport_key && sports.some(sk => sk !== b.sport_key)) throw userError('This boost is for one sport only, and a pick on this bet is from another.');
  if (b.max_stake_cents && stakeCents > b.max_stake_cents) throw userError(`The most you can bet with this boost is $${(b.max_stake_cents / 100).toFixed(2)}.`);
  if (usedBy(b.id, user.id) >= b.uses_per_client) throw userError("You've already used this boost.");
  return b;
}

// ---------- admin ----------

function adminList() {
  return db.prepare(`SELECT x.*, u.username,
      (SELECT COUNT(*) FROM bets b WHERE b.boost_id = x.id) bets,
      (SELECT COALESCE(SUM(stake_cents),0) FROM bets b WHERE b.boost_id = x.id) stake,
      (SELECT COALESCE(SUM(boost_extra_cents),0) FROM bets b WHERE b.boost_id = x.id) extra
    FROM boosts x LEFT JOIN users u ON u.id = x.user_id ORDER BY x.id DESC LIMIT 300`).all()
    .map(b => ({ ...view(b), live: isLive(b), username: b.username || null, userId: b.user_id, bets: b.bets, stakeCents: b.stake, extraPaidCents: b.extra, createdAt: b.created_at }));
}

function create(body) {
  const title = String(body.title || '').trim().slice(0, 100);
  if (!title) throw userError('Give the boost a name, like "25% boost on any parlay".');
  const pct = Math.round(Number(body.pct));
  if (!Number.isFinite(pct) || pct < 1 || pct > 500) throw userError('The boost must be between 1% and 500%.');
  const betType = BET_TYPES.includes(body.betType) ? body.betType : 'any';
  const minLegs = Math.max(1, Math.min(20, parseInt(body.minLegs, 10) || 1));
  const maxStake = body.maxStake === '' || body.maxStake == null ? null : Math.round(Number(body.maxStake) * 100);
  if (maxStake !== null && (!Number.isFinite(maxStake) || maxStake <= 0)) throw userError('Max stake must be a dollar amount, or blank for no limit.');
  const uses = Math.max(1, Math.min(1000, parseInt(body.usesPerClient, 10) || 1));
  let expires = null;
  if (body.expiresAt) {
    const d = new Date(body.expiresAt);
    if (!Number.isFinite(d.getTime()) || d.getTime() <= Date.now()) throw userError('Pick an end time in the future, or leave it blank.');
    expires = d.toISOString();
  }
  let userId = null;
  if (body.userId) {
    const u = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'client'").get(body.userId);
    if (!u) throw userError('That client was not found.');
    userId = u.id;
  }
  const sport = String(body.sportKey || '').trim() || null;
  const { lastInsertRowid } = db.prepare(`INSERT INTO boosts(title, pct, bet_type, sport_key, min_legs, max_stake_cents, uses_per_client, user_id, expires_at)
    VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(title, pct, betType, sport, betType === 'single' ? 1 : minLegs, maxStake, uses, userId, expires);
  return view(db.prepare('SELECT * FROM boosts WHERE id = ?').get(lastInsertRowid));
}

function setStatus(id, status) {
  if (!['active', 'paused'].includes(status)) throw userError('Invalid status.');
  if (!db.prepare('UPDATE boosts SET status = ? WHERE id = ?').run(status, id).changes) throw userError('Boost not found.', 404);
}

function remove(id) {
  if (db.prepare('SELECT 1 FROM bets WHERE boost_id = ?').get(id)) throw userError('This boost has bets on it. Pause it instead.');
  db.prepare('DELETE FROM boosts WHERE id = ?').run(id);
}

module.exports = { boostedPayout, forClient, check, adminList, create, setStatus, remove };
