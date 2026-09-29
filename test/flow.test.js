'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'sb-'));
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD = 'adminpass';
delete process.env.ODDS_API_KEY;
const { server } = require('../server');
const { db } = require('../src/db');
const bets = require('../src/bets');

let base;
test.before(() => new Promise(r => server.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); })));
test.after(() => server.close());

function client() {
  let cookie = '';
  return async (method, p, body) => {
    const res = await fetch(base + p, {
      method, body: body ? JSON.stringify(body) : undefined,
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'sportsbook', cookie },
    });
    const sc = res.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    return { status: res.status, body: await res.json() };
  };
}

test('full betting flow', async () => {
  const admin = client();
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'nope' })).status, 401);
  assert.equal((await admin('POST', '/api/login', { username: 'admin', password: 'adminpass' })).status, 200);

  const created = await admin('POST', '/api/admin/users', { username: 'joe', password: 'secret1', credit: '500' });
  assert.equal(created.status, 200);
  assert.equal(created.body.user.balanceCents, 50000);
  const joeId = created.body.user.id;

  const joe = client();
  assert.equal((await joe('GET', '/api/admin/users')).status, 401);
  await joe('POST', '/api/login', { username: 'joe', password: 'secret1' });
  assert.equal((await joe('GET', '/api/admin/users')).status, 403);

  const sports = (await joe('GET', '/api/sports')).body.sports;
  const keys = sports.map(s => s.key);
  for (const k of ['baseball_mlb', 'icehockey_nhl', 'americanfootball_nfl', 'basketball_nba', 'tennis_atp', 'basketball_ncaab', 'americanfootball_ncaaf']) assert.ok(keys.includes(k), k);

  const nfl = (await joe('GET', '/api/odds/americanfootball_nfl')).body.events;
  const nba = (await joe('GET', '/api/odds/basketball_nba')).body.events;
  assert.ok(nfl.length && nba.length);
  const e1 = nfl[0], e2 = nba[0];
  const ml = e1.markets.h2h[0];
  const leg = { eventId: e1.id, sportKey: e1.sport_key, market: 'h2h', selection: ml.name, point: null, price: ml.price };

  // Stale price is rejected with the new one.
  const stale = await joe('POST', '/api/bets', { type: 'single', stake: 10, legs: [{ ...leg, price: ml.price + 50 }] });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.changed[0].price, ml.price);

  // Over balance and under minimum.
  assert.equal((await joe('POST', '/api/bets', { type: 'single', stake: 600, legs: [leg] })).status, 400);
  assert.equal((await joe('POST', '/api/bets', { type: 'single', stake: 0.5, legs: [leg] })).status, 400);

  const single = await joe('POST', '/api/bets', { type: 'single', stake: 100, legs: [leg] });
  assert.equal(single.status, 200, JSON.stringify(single.body));
  assert.equal(single.body.balanceCents, 40000);

  const tot = e2.markets.totals[0];
  const parlayLegs = [
    { eventId: e1.id, sportKey: e1.sport_key, market: 'spreads', selection: e1.markets.spreads[1].name, point: e1.markets.spreads[1].point, price: e1.markets.spreads[1].price },
    { eventId: e2.id, sportKey: e2.sport_key, market: 'totals', selection: tot.name, point: tot.point, price: tot.price },
  ];
  const parlay = await joe('POST', '/api/bets', { type: 'parlay', stake: 50, legs: parlayLegs });
  assert.equal(parlay.status, 200, JSON.stringify(parlay.body));
  assert.equal(parlay.body.balanceCents, 35000);
  // Two picks from the same game cannot be parlayed.
  assert.equal((await joe('POST', '/api/bets', { type: 'parlay', stake: 5, legs: [leg, parlayLegs[0]] })).status, 400);

  // Admin wins the single by hand: stake * decimal is paid.
  const sb = single.body.bet;
  const won = await admin('POST', `/api/admin/legs/${sb.legs[0].id}/settle`, { status: 'won' });
  assert.equal(won.body.bet.status, 'won');
  const expected = Math.floor(10000 * bets.americanToDecimal(ml.price));
  assert.equal(won.body.bet.payout_cents, expected);
  let bal = (await joe('GET', '/api/me')).body.user.balanceCents;
  assert.equal(bal, 35000 + expected);

  // Regrade to lost takes the payout back.
  await admin('POST', `/api/admin/legs/${sb.legs[0].id}/settle`, { status: 'lost' });
  bal = (await joe('GET', '/api/me')).body.user.balanceCents;
  assert.equal(bal, 35000);

  // Parlay: one push + one win pays on the winning leg only.
  const pb = parlay.body.bet;
  await admin('POST', `/api/admin/legs/${pb.legs[0].id}/settle`, { status: 'push' });
  const pw = await admin('POST', `/api/admin/legs/${pb.legs[1].id}/settle`, { status: 'won' });
  assert.equal(pw.body.bet.status, 'won');
  assert.equal(pw.body.bet.payout_cents, Math.floor(5000 * bets.americanToDecimal(tot.price)));

  // Credit adjustments.
  const w = await admin('POST', `/api/admin/users/${joeId}/credit`, { type: 'withdrawal', amount: '20', note: 'paid out' });
  assert.equal(w.body.balanceCents, 35000 + pw.body.bet.payout_cents - 2000);

  const summary = (await admin('GET', '/api/admin/summary')).body.summary;
  assert.equal(summary.settledBets, 2);

  // Suspended users are logged out.
  await admin('PATCH', `/api/admin/users/${joeId}`, { status: 'suspended' });
  assert.equal((await joe('GET', '/api/me')).status, 401);
  await admin('PATCH', `/api/admin/users/${joeId}`, { status: 'active' });
});

test('auto-grading from scores', () => {
  const leg = (market, selection, point) => ({ market, selection, point, home_team: 'H', away_team: 'A' });
  const score = { home_team: 'H', away_team: 'A', home_score: 24, away_score: 21 };
  assert.equal(bets.gradeLeg(leg('h2h', 'H'), score).status, 'won');
  assert.equal(bets.gradeLeg(leg('h2h', 'A'), score).status, 'lost');
  assert.equal(bets.gradeLeg(leg('spreads', 'H', -3), score).status, 'push');
  assert.equal(bets.gradeLeg(leg('spreads', 'H', -3.5), score).status, 'lost');
  assert.equal(bets.gradeLeg(leg('spreads', 'A', 3.5), score).status, 'won');
  assert.equal(bets.gradeLeg(leg('totals', 'Over', 44.5), score).status, 'won');
  assert.equal(bets.gradeLeg(leg('totals', 'Under', 45), score).status, 'push');
});

test('demo games get graded after they finish', async () => {
  const joe = db.prepare("SELECT * FROM users WHERE username = 'joe'").get();
  const ev = require('../src/odds')._mockEvents('icehockey_nhl')[0];
  const o = ev.markets.h2h[0];
  const placed = await bets.placeBet(joe, { type: 'single', stake: 10, legs: [{ eventId: ev.id, sportKey: ev.sport_key, market: 'h2h', selection: o.name, point: null, price: o.price }] });
  const pending = db.prepare("SELECT COUNT(*) n FROM bet_legs WHERE status = 'pending'").get().n;
  assert.ok(pending >= 1);
  // Pretend every open game started 5 hours ago.
  db.prepare("UPDATE bet_legs SET commence_time = ? WHERE status = 'pending'").run(new Date(Date.now() - 5 * 3600e3).toISOString());
  const r = await bets.autoGrade({ force: true });
  assert.equal(r.graded, pending);
  assert.notEqual(bets.getBet(placed.id).status, 'pending');
});

// Give each leg of a bet a final score that makes it win, lose or push, then run the grader.
async function gradeAs(bet, outcomes) {
  const put = db.prepare(`INSERT OR REPLACE INTO scores(event_id, sport_key, home_team, away_team, home_score, away_score, completed, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, 1, ?)`);
  bet.legs.forEach((leg, i) => {
    const o = outcomes[i];
    const id = `test_${leg.id}`;
    let home, away;
    if (leg.market === 'totals') {
      const total = o === 'push' ? leg.point : (leg.selection === 'Over') === (o === 'won') ? leg.point + 1.5 : leg.point - 1.5;
      away = 20; home = total - 20;
    } else {
      const mine = 20 - (leg.market === 'spreads' ? leg.point : 0) + (o === 'won' ? 1.5 : o === 'lost' ? -1.5 : 0);
      if (leg.selection === leg.home_team) { home = mine; away = 20; } else { away = mine; home = 20; }
    }
    db.prepare('UPDATE bet_legs SET event_id = ?, commence_time = ? WHERE id = ?').run(id, new Date(Date.now() - 5 * 3600e3).toISOString(), leg.id);
    put.run(id, leg.sport_key, leg.home_team, leg.away_team, home, away, Date.now());
  });
  await bets.autoGrade({ force: true });
  return bets.getBet(bet.id);
}

function pick(ev, market, side = 0) {
  const o = ev.markets[market][side];
  return { eventId: ev.id, sportKey: ev.sport_key, market, selection: o.name, point: o.point, price: o.price };
}
const future = key => require('../src/odds')._mockEvents(key).filter(e => Date.parse(e.commence_time) > Date.now());
const balance = id => db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(id).balance_cents;

test('parlays are auto-graded with wins, losses and pushes', async () => {
  const joe = db.prepare("SELECT * FROM users WHERE username = 'joe'").get();
  bets.applyTransaction(joe.id, 100000, 'deposit');
  const [n1, n2] = future('americanfootball_nfl');
  const [b1] = future('basketball_nba');
  const legs = [pick(n1, 'h2h'), pick(n2, 'spreads', 1), pick(b1, 'totals')];
  const place = () => bets.placeBet(joe, { type: 'parlay', stake: 20, legs });
  const dec = legs.reduce((a, l) => a * bets.americanToDecimal(l.price), 1);

  let before = balance(joe.id);
  let b = await place();
  assert.equal(b.potential_payout_cents, Math.floor(2000 * dec));
  assert.equal(balance(joe.id), before - 2000);
  b = await gradeAs(b, ['won', 'won', 'won']);
  assert.equal(b.status, 'won');
  assert.equal(b.payout_cents, Math.floor(2000 * dec));
  assert.equal(balance(joe.id), before - 2000 + b.payout_cents);

  before = balance(joe.id);
  b = await gradeAs(await place(), ['won', 'push', 'won']);
  assert.equal(b.status, 'won');
  assert.equal(b.payout_cents, Math.floor(2000 * bets.americanToDecimal(legs[0].price) * bets.americanToDecimal(legs[2].price)));
  assert.equal(balance(joe.id), before - 2000 + b.payout_cents);

  before = balance(joe.id);
  b = await gradeAs(await place(), ['won', 'lost', 'won']);
  assert.equal(b.status, 'lost');
  assert.equal(balance(joe.id), before - 2000);

  before = balance(joe.id);
  b = await gradeAs(await place(), ['push', 'push', 'push']);
  assert.equal(b.status, 'push');
  assert.equal(balance(joe.id), before);
});

test('teasers', async () => {
  const joe = db.prepare("SELECT * FROM users WHERE username = 'joe'").get();
  const [n1, n2] = future('americanfootball_nfl');
  const [b1, b2] = future('basketball_nba');
  const [c1] = future('americanfootball_ncaaf');
  const [m1] = future('baseball_mlb');
  const legs = [pick(n1, 'spreads', 0), pick(b1, 'totals', 0), pick(c1, 'totals', 1)];
  const tease = (body) => bets.placeBet(joe, { type: 'teaser', stake: 10, teaserPoints: 6, legs, ...body });

  await assert.rejects(tease({ legs: [pick(n1, 'spreads'), pick(m1, 'spreads')] }), /football and basketball/);
  await assert.rejects(tease({ legs: [pick(n1, 'h2h'), pick(b1, 'spreads')] }), /spreads and totals/);
  await assert.rejects(tease({ legs: [pick(n1, 'spreads')] }), /at least 2/);
  await assert.rejects(tease({ teaserPoints: 5 }), /6, 6.5 or 7/);
  await assert.rejects(tease({ legs: [pick(n1, 'spreads'), pick(n1, 'totals')] }), /one selection per game/);

  const before = balance(joe.id);
  let b = await tease();
  assert.equal(b.type, 'teaser');
  assert.equal(b.teaser_points, 6);
  assert.equal(b.potential_payout_cents, Math.floor(1000 * bets.americanToDecimal(180)));
  assert.equal(balance(joe.id), before - 1000);
  // Lines move 6 points toward the bettor: spread +6, Over -6, Under +6.
  assert.equal(b.legs[0].point, legs[0].point + 6);
  assert.equal(b.legs[0].orig_point, legs[0].point);
  assert.equal(b.legs[1].point, legs[1].point - 6);
  assert.equal(b.legs[2].point, legs[2].point + 6);

  // Editing the payout table later does not change a bet already placed.
  const { setSetting, DEFAULT_SETTINGS } = require('../src/db');
  setSetting('teaser_odds', JSON.stringify({ 6: { 2: -200, 3: 100 } }));
  b = await gradeAs(b, ['won', 'won', 'won']);
  setSetting('teaser_odds', DEFAULT_SETTINGS.teaser_odds);
  assert.equal(b.status, 'won');
  assert.equal(b.payout_cents, Math.floor(1000 * bets.americanToDecimal(180)));

  // A push drops the leg: 3 legs with a push pays as a 2-leg teaser.
  b = await gradeAs(await tease(), ['won', 'push', 'won']);
  assert.equal(b.status, 'won');
  assert.equal(b.payout_cents, Math.floor(1000 * bets.americanToDecimal(-110)));

  b = await gradeAs(await tease(), ['won', 'lost', 'won']);
  assert.equal(b.status, 'lost');
  assert.equal(b.payout_cents, 0);

  // A 2-leg teaser with a push is refunded.
  const mid = balance(joe.id);
  b = await gradeAs(await tease({ teaserPoints: 7, legs: [pick(n2, 'spreads', 1), pick(b2, 'totals', 1)] }), ['won', 'push']);
  assert.equal(b.status, 'push');
  assert.equal(balance(joe.id), mid);
});

test('admin can edit teaser payouts', async () => {
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'adminpass' });
  assert.equal((await admin('PATCH', '/api/admin/settings', { teaser_odds: { 6: { 2: '50' } } })).status, 400);
  assert.equal((await admin('PATCH', '/api/admin/settings', { teaser_odds: { 6: { 2: '-115', 3: '170' }, 6.5: {}, 7: { 2: '' } } })).status, 200);
  const book = (await admin('GET', '/api/book')).body;
  assert.deepEqual(book.teaserOdds, { 6: { 2: -115, 3: 170 }, 6.5: {}, 7: {} });
});

test('free play', async () => {
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'adminpass' });
  const joe = db.prepare("SELECT * FROM users WHERE username = 'joe'").get();
  const fp = () => db.prepare('SELECT freeplay_cents FROM users WHERE id = ?').get(joe.id).freeplay_cents;

  const g = await admin('POST', `/api/admin/users/${joe.id}/credit`, { type: 'freeplay', amount: '50', note: 'promo' });
  assert.equal(g.status, 200);
  assert.equal(g.body.freeplayCents, 5000);
  assert.equal((await admin('POST', `/api/admin/users/${joe.id}/credit`, { type: 'freeplay_remove', amount: '60' })).status, 400);

  const [n1] = future('americanfootball_nfl');
  const leg = pick(n1, 'spreads', 0);
  const place = stake => bets.placeBet(joe, { type: 'single', stake, legs: [leg], freeplay: true });
  const credit = balance(joe.id);

  await assert.rejects(place(60), /Not enough free play/);
  let b = await place(20);
  assert.equal(b.freeplay, 1);
  const profit = Math.floor(2000 * bets.americanToDecimal(leg.price)) - 2000;
  assert.equal(b.potential_payout_cents, profit);
  assert.equal(fp(), 3000);
  assert.equal(balance(joe.id), credit);

  // A win pays profit only, into credit.
  b = await gradeAs(b, ['won']);
  assert.equal(b.payout_cents, profit);
  assert.equal(balance(joe.id), credit + profit);
  assert.equal(fp(), 3000);

  // A loss costs no credit.
  await gradeAs(await place(10), ['lost']);
  assert.equal(balance(joe.id), credit + profit);
  assert.equal(fp(), 2000);

  // A push gives the free play back.
  b = await gradeAs(await place(10), ['push']);
  assert.equal(b.status, 'push');
  assert.equal(fp(), 2000);
  assert.equal(balance(joe.id), credit + profit);

  // Regrading the push to a win swaps the free play back for the profit.
  await admin('POST', `/api/admin/legs/${b.legs[0].id}/settle`, { status: 'won' });
  assert.equal(fp(), 1000);
  assert.equal(balance(joe.id), credit + profit + Math.floor(1000 * bets.americanToDecimal(leg.price)) - 1000);

  const ledger = (await admin('GET', '/api/admin/transactions')).body.transactions;
  assert.ok(ledger.some(t => t.type === 'freeplay' && t.wallet === 'freeplay' && t.amount_cents === 5000));
  assert.ok(ledger.some(t => t.type === 'bet' && t.wallet === 'freeplay'));
});
