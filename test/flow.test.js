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
