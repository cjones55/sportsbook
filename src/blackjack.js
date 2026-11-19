'use strict';
// Blackjack against the house, played with the client's credit.
// Rules: 6 decks shuffled fresh for every hand, dealer stands on soft 17 and peeks for blackjack,
// blackjack pays 3 to 2, double on any first two cards (also after a split), split pairs up to
// 4 hands, split aces get one card each. No insurance or surrender.
const crypto = require('node:crypto');
const { db, tx, intSetting, getSetting } = require('./db');

db.exec(`
CREATE TABLE IF NOT EXISTS blackjack_hands (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'playing',
  bet_cents INTEGER NOT NULL,
  total_bet_cents INTEGER NOT NULL,
  payout_cents INTEGER NOT NULL DEFAULT 0,
  result TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_bj_user ON blackjack_hands(user_id, id);
CREATE INDEX IF NOT EXISTS idx_bj_status ON blackjack_hands(status);
`);

const { UserError: GameError } = require('./bets');

const RANKS = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUITS = ['S', 'H', 'D', 'C'];
const DECKS = 6;
const MAX_HANDS = 4;

function newShoe() {
  const shoe = [];
  for (let d = 0; d < DECKS; d++) for (const s of SUITS) for (const r of RANKS) shoe.push(r + s);
  for (let i = shoe.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [shoe[i], shoe[j]] = [shoe[j], shoe[i]];
  }
  return shoe;
}

const rank = c => c.slice(0, -1);
const cardValue = c => { const r = rank(c); return r === 'A' ? 11 : ['J', 'Q', 'K'].includes(r) ? 10 : Number(r); };

function total(cards) {
  let t = 0, aces = 0;
  for (const c of cards) { t += cardValue(c); if (rank(c) === 'A') aces++; }
  while (t > 21 && aces) { t -= 10; aces--; }
  return { total: t, soft: aces > 0 };
}
const isBlackjack = (cards, split) => !split && cards.length === 2 && total(cards).total === 21;

function enabled() { return getSetting('blackjack_enabled') === '1'; }
function limits() {
  const min = intSetting('blackjack_min_cents');
  const max = intSetting('blackjack_max_cents');
  return { minCents: min, maxCents: max };
}

// What a client may do with the hand being played right now.
function actions(s, balance) {
  if (s.done) return [];
  const h = s.hands[s.active];
  const out = ['hit', 'stand'];
  if (h.cards.length === 2 && !h.splitAces && balance >= h.bet) out.push('double');
  if (h.cards.length === 2 && cardValue(h.cards[0]) === cardValue(h.cards[1]) && s.hands.length < MAX_HANDS
    && !(h.splitAces) && balance >= h.bet) out.push('split');
  return out;
}

// What the client sees: the dealer's hole card stays hidden until the hand is over.
function view(row, balance) {
  const s = JSON.parse(row.state);
  const dealer = s.done ? s.dealer : [s.dealer[0], null];
  return {
    id: row.id, status: row.status, betCents: row.bet_cents, totalBetCents: row.total_bet_cents,
    payoutCents: row.payout_cents, result: row.result, createdAt: row.created_at, settledAt: row.settled_at,
    dealer: { cards: dealer, total: s.done ? total(s.dealer).total : cardValue(s.dealer[0]) },
    hands: s.hands.map((h, i) => ({
      cards: h.cards, total: total(h.cards).total, soft: total(h.cards).soft, bet: h.bet, doubled: !!h.doubled,
      result: h.result || null, payout: h.payout ?? null, active: !s.done && i === s.active,
    })),
    actions: row.status === 'playing' && balance != null ? actions(s, balance) : [],
  };
}
// The bookie sees everything, including the hole card of a hand still being played.
function adminView(row) {
  const v = view({ ...row, state: JSON.stringify({ ...JSON.parse(row.state), done: true }) });
  return { ...v, userId: row.user_id, username: row.username, inProgress: row.status === 'playing' };
}

function debit(userId, cents, handId, note) {
  const u = db.prepare('SELECT balance_cents, status FROM users WHERE id = ?').get(userId);
  if (u.status !== 'active') throw new GameError('Account is suspended.', 403);
  if (u.balance_cents < cents) throw new GameError('Not enough credit.');
  const after = u.balance_cents - cents;
  db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(after, userId);
  db.prepare(`INSERT INTO transactions(user_id, type, amount_cents, balance_after_cents, note) VALUES(?, 'blackjack', ?, ?, ?)`)
    .run(userId, -cents, after, `Blackjack #${handId}${note ? ' ' + note : ''}`);
}
function credit(userId, cents, type, note) {
  if (!cents) return;
  const u = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(userId);
  const after = u.balance_cents + cents;
  db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(after, userId);
  db.prepare('INSERT INTO transactions(user_id, type, amount_cents, balance_after_cents, note) VALUES(?, ?, ?, ?, ?)')
    .run(userId, type, cents, after, note);
}

// Move on to the next unfinished hand, or play out the dealer and pay when all are done.
function advance(s) {
  while (s.active < s.hands.length && s.hands[s.active].done) s.active++;
  if (s.active < s.hands.length) {
    const h = s.hands[s.active];
    // A hand made by a split gets its second card when its turn comes.
    if (h.cards.length === 1) {
      h.cards.push(s.shoe.pop());
      if (h.splitAces || total(h.cards).total === 21) h.done = true;
      return advance(s);
    }
    return;
  }
  finish(s);
}

function finish(s, { dealerBlackjack = false } = {}) {
  s.done = true;
  const live = s.hands.some(h => total(h.cards).total <= 21 && !isBlackjack(h.cards, s.hands.length > 1));
  if (live && !dealerBlackjack) {
    while (total(s.dealer).total < 17) s.dealer.push(s.shoe.pop());
  }
  const d = total(s.dealer).total;
  const split = s.hands.length > 1;
  for (const h of s.hands) {
    const p = total(h.cards).total;
    if (dealerBlackjack) { h.result = isBlackjack(h.cards, split) ? 'push' : 'lose'; h.payout = h.result === 'push' ? h.bet : 0; continue; }
    if (p > 21) { h.result = 'bust'; h.payout = 0; continue; }
    if (isBlackjack(h.cards, split)) { h.result = 'blackjack'; h.payout = h.bet + Math.floor(h.bet * 3 / 2); continue; }
    if (d > 21 || p > d) { h.result = 'win'; h.payout = h.bet * 2; continue; }
    if (p === d) { h.result = 'push'; h.payout = h.bet; continue; }
    h.result = 'lose'; h.payout = 0;
  }
}

function summaryResult(s) {
  const results = s.hands.map(h => h.result);
  if (results.length === 1) return results[0];
  const net = s.hands.reduce((a, h) => a + h.payout - h.bet, 0);
  return net > 0 ? 'win' : net < 0 ? 'lose' : 'push';
}

function save(row, s, userId) {
  if (s.done) {
    const totalBet = s.hands.reduce((a, h) => a + h.bet, 0);
    const payout = s.hands.reduce((a, h) => a + h.payout, 0);
    const result = summaryResult(s);
    db.prepare(`UPDATE blackjack_hands SET status = 'done', total_bet_cents = ?, payout_cents = ?, result = ?, state = ?, settled_at = datetime('now') WHERE id = ?`)
      .run(totalBet, payout, result, JSON.stringify(s), row.id);
    credit(userId, payout, 'blackjack_win', `Blackjack #${row.id} ${result}`);
  } else {
    db.prepare('UPDATE blackjack_hands SET total_bet_cents = ?, state = ? WHERE id = ?')
      .run(s.hands.reduce((a, h) => a + h.bet, 0), JSON.stringify(s), row.id);
  }
  return db.prepare('SELECT * FROM blackjack_hands WHERE id = ?').get(row.id);
}

function balanceOf(userId) { return db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(userId).balance_cents; }

function activeHand(userId) {
  return db.prepare("SELECT * FROM blackjack_hands WHERE user_id = ? AND status = 'playing' ORDER BY id DESC LIMIT 1").get(userId);
}

function deal(user, amount) {
  if (!enabled()) throw new GameError('Blackjack is closed right now.');
  const bet = Math.round(Number(amount) * 100);
  if (!Number.isFinite(bet) || bet <= 0) throw new GameError('Enter a valid bet.');
  const { minCents, maxCents } = limits(user);
  if (bet < minCents) throw new GameError(`Minimum blackjack bet is $${(minCents / 100).toFixed(2)}.`);
  if (maxCents && bet > maxCents) throw new GameError(`Maximum blackjack bet is $${(maxCents / 100).toFixed(2)}.`);
  return tx(() => {
    if (activeHand(user.id)) throw new GameError('Finish the hand you are playing first.', 409);
    const shoe = newShoe();
    const s = { shoe, dealer: [], hands: [{ cards: [], bet }], active: 0, done: false };
    s.hands[0].cards.push(shoe.pop()); s.dealer.push(shoe.pop()); s.hands[0].cards.push(shoe.pop()); s.dealer.push(shoe.pop());
    const { lastInsertRowid } = db.prepare('INSERT INTO blackjack_hands(user_id, bet_cents, total_bet_cents, state) VALUES(?, ?, ?, ?)')
      .run(user.id, bet, bet, JSON.stringify(s));
    const row = db.prepare('SELECT * FROM blackjack_hands WHERE id = ?').get(lastInsertRowid);
    debit(user.id, bet, row.id);
    // Dealer peeks when showing an ace or a ten; a player blackjack is paid right away.
    if (cardValue(s.dealer[0]) >= 10 && isBlackjack(s.dealer)) finish(s, { dealerBlackjack: true });
    else if (isBlackjack(s.hands[0].cards)) finish(s);
    return view(save(row, s, user.id), balanceOf(user.id));
  });
}

function act(user, action) {
  return tx(() => {
    const row = activeHand(user.id);
    if (!row) throw new GameError('No hand in play. Place a bet to deal.', 409);
    const s = JSON.parse(row.state);
    const h = s.hands[s.active];
    if (!actions(s, balanceOf(user.id)).includes(action)) {
      if (actions(s, Infinity).includes(action)) throw new GameError(`Not enough credit to ${action}. It takes another $${(h.bet / 100).toFixed(2)}.`);
      throw new GameError(`You can't ${action} now.`);
    }
    if (action === 'hit') {
      h.cards.push(s.shoe.pop());
      if (total(h.cards).total >= 21) h.done = true;
    } else if (action === 'stand') {
      h.done = true;
    } else if (action === 'double') {
      debit(user.id, h.bet, row.id, 'double');
      h.bet *= 2; h.doubled = true;
      h.cards.push(s.shoe.pop());
      h.done = true;
    } else if (action === 'split') {
      debit(user.id, h.bet, row.id, 'split');
      const aces = rank(h.cards[0]) === 'A';
      const second = { cards: [h.cards.pop()], bet: h.bet, splitAces: aces };
      h.splitAces = aces;
      s.hands.splice(s.active + 1, 0, second);
      h.cards.push(s.shoe.pop());
      if (aces || total(h.cards).total === 21) h.done = true;
    }
    advance(s);
    return view(save(row, s, user.id), balanceOf(user.id));
  });
}

function current(user) {
  const row = activeHand(user.id);
  return row ? view(row, balanceOf(user.id)) : null;
}

function history(userId, limit = 20) {
  return db.prepare("SELECT * FROM blackjack_hands WHERE user_id = ? AND status != 'playing' ORDER BY id DESC LIMIT ?")
    .all(userId, limit).map(r => view(r));
}

function listAdmin({ userId, limit = 200 } = {}) {
  const rows = db.prepare(`SELECT h.*, u.username FROM blackjack_hands h JOIN users u ON u.id = h.user_id
    ${userId ? 'WHERE h.user_id = ?' : ''} ORDER BY h.id DESC LIMIT ?`).all(...(userId ? [userId, limit] : [limit]));
  return rows.map(adminView);
}

// Totals for the dashboard. House profit is what clients bet minus what they were paid back.
function stats() {
  const q = sql => db.prepare(sql).get();
  const all = q("SELECT COUNT(*) n, COALESCE(SUM(total_bet_cents),0) bet, COALESCE(SUM(payout_cents),0) paid FROM blackjack_hands WHERE status = 'done'");
  const week = q("SELECT COALESCE(SUM(total_bet_cents),0) bet, COALESCE(SUM(payout_cents),0) paid FROM blackjack_hands WHERE status = 'done' AND settled_at >= datetime('now','-7 days')");
  const today = q("SELECT COUNT(*) n, COALESCE(SUM(total_bet_cents),0) bet FROM blackjack_hands WHERE created_at >= datetime('now','start of day')");
  const playing = q("SELECT COUNT(*) n, COALESCE(SUM(total_bet_cents),0) bet FROM blackjack_hands WHERE status = 'playing'");
  return {
    hands: all.n, wageredCents: all.bet, profitCents: all.bet - all.paid, weekProfitCents: week.bet - week.paid,
    todayHands: today.n, todayWageredCents: today.bet, playing: playing.n, playingCents: playing.bet,
  };
}

// A hand the client walked away from can be voided by the bookie: every stake on it is refunded.
function voidHand(id) {
  return tx(() => {
    const row = db.prepare('SELECT * FROM blackjack_hands WHERE id = ?').get(id);
    if (!row) throw new GameError('Hand not found.', 404);
    if (row.status !== 'playing') throw new GameError('Only a hand still being played can be voided.');
    db.prepare("UPDATE blackjack_hands SET status = 'void', result = 'void', payout_cents = total_bet_cents, settled_at = datetime('now') WHERE id = ?").run(id);
    credit(row.user_id, row.total_bet_cents, 'refund', `Blackjack #${id} voided`);
    return { ok: true };
  });
}

// Take hands off the books entirely (test hands, mistakes): the hands are deleted, so they leave
// blackjack history, stats and P/L, and the client's credit goes back to what it would be had they
// never been played. The ledger keeps its lines plus one adjustment that reverses them, so it still adds up.
function removeHands(ids, { by = null } = {}) {
  ids = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0))];
  if (!ids.length) throw new GameError('Pick the hands to remove.');
  return tx(() => {
    const rows = db.prepare(`SELECT * FROM blackjack_hands WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    if (rows.length !== ids.length) throw new GameError('Some of those hands no longer exist.', 404);
    const perUser = new Map();
    for (const h of rows) {
      // What the hand moved the client's credit by: payout back minus stakes taken (a hand still
      // being played has taken its stakes and paid nothing yet).
      const net = (h.status === 'playing' ? 0 : h.payout_cents) - h.total_bet_cents;
      const u = perUser.get(h.user_id) || { net: 0, ids: [] };
      u.net += net; u.ids.push(h.id);
      perUser.set(h.user_id, u);
      db.prepare('DELETE FROM blackjack_hands WHERE id = ?').run(h.id);
    }
    let creditBack = 0;
    for (const [userId, u] of perUser) {
      const note = `Removed blackjack hand${u.ids.length > 1 ? 's' : ''} #${u.ids.sort((a, b) => a - b).join(', #')}`;
      if (u.net !== 0) {
        const cur = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(userId).balance_cents;
        const after = cur - u.net;
        db.prepare('UPDATE users SET balance_cents = ? WHERE id = ?').run(after, userId);
        db.prepare("INSERT INTO transactions(user_id, type, amount_cents, balance_after_cents, note, created_by) VALUES(?, 'adjustment', ?, ?, ?, ?)")
          .run(userId, -u.net, after, note, by);
      }
      creditBack -= u.net;
    }
    return { removed: rows.length, creditChangeCents: creditBack };
  });
}

module.exports = { removeHands, GameError, deal, act, current, history, listAdmin, stats, voidHand, enabled, limits, total, _newShoe: newShoe };
