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

  // This week: lost the $100 single, won the $50 parlay. Credit adjustments don't count.
  const week = (await joe('GET', '/api/me')).body.week;
  assert.equal(week.netCents, pw.body.bet.payout_cents - 5000 - 10000);
  assert.equal(week.settledBets, 2);
  assert.equal((await admin('GET', '/api/me')).body.week, null);

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

test('props from the feed (demo) are graded by the bookie', async () => {
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'adminpass' });
  const joe = client();
  await joe('POST', '/api/login', { username: 'joe', password: 'secret1' });
  const joeRow = db.prepare("SELECT * FROM users WHERE username = 'joe'").get();
  bets.applyTransaction(joeRow.id, 50000, 'deposit');

  const nba = (await joe('GET', '/api/odds/basketball_nba')).body.events;
  assert.ok(nba[0].hasProps);
  assert.ok(!(await joe('GET', '/api/odds/tennis_atp')).body.events.some(e => e.hasProps));
  const ev = nba[0];
  const p = (await joe('GET', `/api/props/basketball_nba/${ev.id}`)).body;
  assert.equal(p.source, 'demo');
  const mk = p.markets.find(m => m.key === 'player_points');
  assert.ok(mk && mk.outcomes.length >= 4);
  const o = mk.outcomes[0];
  const leg = { eventId: ev.id, sportKey: ev.sport_key, market: mk.key, selection: o.name, point: o.point, price: o.price, description: o.description };

  // Unknown game: no props, nothing fetched.
  assert.deepEqual((await joe('GET', '/api/props/basketball_nba/nope')).body.markets, []);

  // Stale price comes back with the new one; wrong player is removed.
  const stale = await joe('POST', '/api/bets', { type: 'single', stake: 10, legs: [{ ...leg, price: o.price + 40 }] });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.changed[0].price, o.price);
  const gone = await joe('POST', '/api/bets', { type: 'single', stake: 10, legs: [{ ...leg, description: 'Nobody' }] });
  assert.equal(gone.status, 409);
  assert.ok(gone.body.changed[0].removed);

  // Props can't go in teasers, and a parlay still takes one pick per game.
  const other = nba[1];
  const teaser = await joe('POST', '/api/bets', { type: 'teaser', teaserPoints: 6, stake: 10, legs: [leg, pick(other, 'spreads')] });
  assert.equal(teaser.status, 400);
  // Same-game parlays: with the setting off, one pick per game.
  await admin('PATCH', '/api/admin/settings', { same_game_parlays: '0' });
  const sameGame = await joe('POST', '/api/bets', { type: 'parlay', stake: 10, legs: [leg, pick(ev, 'h2h')] });
  assert.equal(sameGame.status, 400);
  assert.match(sameGame.body.error, /one selection per game/);
  await admin('PATCH', '/api/admin/settings', { same_game_parlays: '1' });

  const placed = await joe('POST', '/api/bets', { type: 'single', stake: 20, legs: [leg] });
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  const b = placed.body.bet;
  assert.equal(b.legs[0].description, o.description);
  assert.equal(b.legs[0].prop_name, 'Points');
  assert.equal(b.potential_payout_cents, Math.floor(2000 * bets.americanToDecimal(o.price)));

  // The scores feed can't grade it, so it waits for the bookie.
  db.prepare('UPDATE bet_legs SET commence_time = ? WHERE bet_id = ?').run(new Date(Date.now() - 5 * 3600e3).toISOString(), b.id);
  await bets.autoGrade({ force: true });
  assert.equal(bets.getBet(b.id).status, 'pending');
  const toGrade = (await admin('GET', '/api/admin/bets?status=props')).body.bets;
  assert.deepEqual(toGrade.map(x => x.id), [b.id]);
  const before = balance(joeRow.id);
  await admin('POST', `/api/admin/legs/${b.legs[0].id}/settle`, { status: 'won' });
  assert.equal(balance(joeRow.id), before + b.potential_payout_cents);
  assert.equal((await admin('GET', '/api/admin/bets?status=props')).body.bets.length, 0);
});

test('the bookie can write, grade and undo their own props', async () => {
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'adminpass' });
  const joe = client();
  await joe('POST', '/api/login', { username: 'joe', password: 'secret1' });
  const joeRow = db.prepare("SELECT * FROM users WHERE username = 'joe'").get();
  const ev = future('americanfootball_nfl')[0];

  assert.equal((await admin('POST', '/api/admin/props', { sportKey: ev.sport_key, eventId: ev.id, question: 'Overtime?', options: [{ name: 'Yes', price: '50' }] })).status, 400);
  assert.equal((await admin('POST', '/api/admin/props', { sportKey: ev.sport_key, eventId: 'nope', question: 'Overtime?', options: [{ name: 'Yes', price: '+400' }] })).status, 400);
  const onGame = await admin('POST', '/api/admin/props', { sportKey: ev.sport_key, eventId: ev.id, question: 'Will the game go to overtime?', options: [{ name: 'Yes', price: '+400' }, { name: 'No', price: '-600' }] });
  assert.equal(onGame.status, 200, JSON.stringify(onGame.body));
  const special = await admin('POST', '/api/admin/props', {
    eventName: 'NFL Awards', question: 'MVP', closesAt: new Date(Date.now() + 86400e3).toISOString(),
    options: [{ name: 'Patrick Mahomes', price: '+300' }, { name: 'Josh Allen', price: '+450' }, { name: 'Lamar Jackson', price: '+500' }],
  });
  assert.equal(special.status, 200, JSON.stringify(special.body));
  const sp = special.body.prop;
  assert.equal(sp.eventId, `special_${sp.id}`);

  // Clients see the game's prop and the Specials tab.
  assert.ok((await joe('GET', '/api/sports')).body.sports.some(s => s.key === 'specials'));
  assert.deepEqual((await joe('GET', '/api/odds/specials')).body.specials.map(x => x.id), [sp.id]);
  const gp = (await joe('GET', `/api/props/${ev.sport_key}/${ev.id}`)).body;
  assert.equal(gp.custom[0].question, 'Will the game go to overtime?');

  const custom = (prop, name, price) => ({ eventId: prop.eventId, sportKey: prop.sportKey, market: 'custom', propId: prop.id, selection: name, point: null, price });
  const b1 = (await joe('POST', '/api/bets', { type: 'single', stake: 10, legs: [custom(sp, 'Josh Allen', 450)] })).body.bet;
  const b2 = (await joe('POST', '/api/bets', { type: 'single', stake: 10, legs: [custom(sp, 'Lamar Jackson', 500)] })).body.bet;
  assert.equal(b1.potential_payout_cents, 5500);
  assert.equal(b1.legs[0].prop_name, 'MVP');
  assert.equal((await joe('POST', '/api/bets', { type: 'single', stake: 10, legs: [custom(sp, 'Josh Allen', 300)] })).status, 409);

  // Can't delete a prop with bets; closing stops new bets.
  assert.equal((await admin('DELETE', `/api/admin/props/${sp.id}`)).status, 400);
  await admin('PATCH', `/api/admin/props/${sp.id}`, { status: 'closed' });
  assert.equal((await joe('POST', '/api/bets', { type: 'single', stake: 10, legs: [custom(sp, 'Josh Allen', 450)] })).status, 409);

  const before = balance(joeRow.id);
  const g = await admin('POST', `/api/admin/props/${sp.id}/settle`, { winner: 'Josh Allen' });
  assert.equal(g.body.graded, 2);
  assert.equal(bets.getBet(b1.id).status, 'won');
  assert.equal(bets.getBet(b2.id).status, 'lost');
  assert.equal(balance(joeRow.id), before + 5500);
  const list = (await admin('GET', '/api/admin/props')).body.props;
  assert.equal(list.find(x => x.id === sp.id).result, 'Josh Allen');
  assert.equal(list.find(x => x.id === sp.id).bets, 2);

  // Undo puts the credit back as it was.
  await admin('POST', `/api/admin/props/${sp.id}/settle`, { winner: 'pending' });
  assert.equal(bets.getBet(b1.id).status, 'pending');
  assert.equal(balance(joeRow.id), before);
  await admin('POST', `/api/admin/props/${sp.id}/settle`, { winner: 'void' });
  assert.equal(balance(joeRow.id), before + 2000);

  // A prop with no bets can be deleted.
  assert.equal((await admin('DELETE', `/api/admin/props/${onGame.body.prop.id}`)).status, 200);
});

test('first TD props, and props in parlays wait for the bookie', async () => {
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'adminpass' });
  const joe = client();
  await joe('POST', '/api/login', { username: 'joe', password: 'secret1' });
  const joeRow = db.prepare("SELECT * FROM users WHERE username = 'joe'").get();
  bets.applyTransaction(joeRow.id, 50000, 'deposit');

  // First TD scorer for the NFL and college football.
  const nfl = (await joe('GET', '/api/odds/americanfootball_nfl')).body.events;
  const ncaaf = (await joe('GET', '/api/odds/americanfootball_ncaaf')).body.events;
  assert.ok(nfl.length >= 2 && ncaaf.length >= 1);
  assert.ok(ncaaf[0].hasProps);
  const firstTd = async ev => (await joe('GET', `/api/props/${ev.sport_key}/${ev.id}`)).body.markets.find(m => m.key === 'player_1st_td');
  const ftd = await firstTd(nfl[0]);
  assert.ok(ftd && ftd.title === 'First TD' && ftd.outcomes.length >= 4);
  assert.ok(ftd.outcomes.every(o => o.name === 'Yes' && o.price >= 500 && o.point === null));
  assert.ok(await firstTd(ncaaf[0]));
  // 2+ TDs: the touchdowns market at 1.5, Over only.
  const two = (await joe('GET', `/api/props/${nfl[0].sport_key}/${nfl[0].id}`)).body.markets.find(m => m.key === 'player_tds_over');
  assert.ok(two && two.title === '2+ TDs' && two.outcomes.length >= 4);
  assert.ok(two.outcomes.every(o => o.name === 'Over' && o.point === 1.5 && o.price >= 300));
  const t2 = two.outcomes[0];
  const twoBet = await joe('POST', '/api/bets', { type: 'single', stake: 5, legs: [{ eventId: nfl[0].id, sportKey: nfl[0].sport_key, market: 'player_tds_over', selection: 'Over', point: 1.5, price: t2.price, description: t2.description }] });
  assert.equal(twoBet.status, 200, JSON.stringify(twoBet.body));
  assert.equal(twoBet.body.bet.legs[0].prop_name, '2+ TDs');
  const o = ftd.outcomes[0];
  const tdLeg = { eventId: nfl[0].id, sportKey: nfl[0].sport_key, market: 'player_1st_td', selection: 'Yes', point: null, price: o.price, description: o.description };

  // Parlay: first TD on one game, moneyline on another.
  const ml = pick(nfl[1], 'h2h');
  const placed = await joe('POST', '/api/bets', { type: 'parlay', stake: 10, legs: [tdLeg, ml] });
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  const b = placed.body.bet;
  assert.equal(b.type, 'parlay');
  assert.equal(b.potential_payout_cents, Math.floor(1000 * bets.americanToDecimal(o.price) * bets.americanToDecimal(ml.price)));
  const tdRow = b.legs.find(l => l.market === 'player_1st_td');
  const mlRow = b.legs.find(l => l.market === 'h2h');
  assert.equal(tdRow.prop_name, 'First TD');

  // Auto-grading settles the game leg as a win; the parlay waits on the prop.
  db.prepare('UPDATE bet_legs SET commence_time = ? WHERE bet_id = ?').run(new Date(Date.now() - 5 * 3600e3).toISOString(), b.id);
  bets.settleLeg(mlRow.id, 'won', { by: 'auto' });
  assert.equal(bets.getBet(b.id).status, 'pending');
  await bets.autoGrade({ force: true });
  assert.equal(bets.getBet(b.id).legs.find(l => l.id === tdRow.id).status, 'pending');
  assert.ok((await admin('GET', '/api/admin/bets?status=props')).body.bets.some(x => x.id === b.id));

  const before = balance(joeRow.id);
  await admin('POST', `/api/admin/legs/${tdRow.id}/settle`, { status: 'won' });
  const done = bets.getBet(b.id);
  assert.equal(done.status, 'won');
  assert.equal(balance(joeRow.id), before + b.potential_payout_cents);
  assert.ok(!(await admin('GET', '/api/admin/bets?status=props')).body.bets.some(x => x.id === b.id));

  // A lost game leg loses the parlay without waiting for the prop.
  const tdLeg2 = { ...tdLeg, description: ftd.outcomes[1].description, price: ftd.outcomes[1].price };
  const b2 = (await joe('POST', '/api/bets', { type: 'parlay', stake: 10, legs: [tdLeg2, pick(nfl[1], 'h2h')] })).body.bet;
  bets.settleLeg(b2.legs.find(l => l.market === 'h2h').id, 'lost', { by: 'auto' });
  assert.equal(bets.getBet(b2.id).status, 'lost');
});

test('same-game parlays: props and lines from one game, but not both sides', async () => {
  const joe = client();
  await joe('POST', '/api/login', { username: 'joe', password: 'secret1' });
  const joeRow = db.prepare("SELECT * FROM users WHERE username = 'joe'").get();
  bets.applyTransaction(joeRow.id, 50000, 'deposit');
  assert.equal((await joe('GET', '/api/me')).body.book.sameGameParlays, true);
  const ev = (await joe('GET', '/api/odds/americanfootball_nfl')).body.events[2];
  const mk = (await joe('GET', `/api/props/${ev.sport_key}/${ev.id}`)).body.markets;
  const legOf = (key, i = 0) => { const o = mk.find(m => m.key === key).outcomes[i]; return { eventId: ev.id, sportKey: ev.sport_key, market: key, selection: o.name, point: o.point, price: o.price, description: o.description }; };
  const td = legOf('player_1st_td');
  const yds = legOf('player_pass_yds');
  const ok = await joe('POST', '/api/bets', { type: 'parlay', stake: 5, legs: [td, yds, pick(ev, 'h2h'), pick(ev, 'totals')] });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.bet.legs.length, 4);
  // Over and Under on the same player's yards.
  const under = { ...yds, ...(() => { const o = mk.find(m => m.key === 'player_pass_yds').outcomes.find(x => x.description === yds.description && x.name !== yds.selection); return { selection: o.name, price: o.price, point: o.point }; })() };
  const both = await joe('POST', '/api/bets', { type: 'parlay', stake: 5, legs: [yds, under] });
  assert.equal(both.status, 400);
  assert.match(both.body.error, /one side/);
  // Two first TD scorers in one game can't both happen.
  const twoTd = await joe('POST', '/api/bets', { type: 'parlay', stake: 5, legs: [td, legOf('player_1st_td', 1)] });
  assert.equal(twoTd.status, 400);
  assert.match(twoTd.body.error, /first touchdown/);
  // Moneyline plus spread on the same game.
  const mlSpread = await joe('POST', '/api/bets', { type: 'parlay', stake: 5, legs: [pick(ev, 'h2h'), pick(ev, 'spreads')] });
  assert.equal(mlSpread.status, 400);
  assert.match(mlSpread.body.error, /moneyline and a spread/);
  // Teasers stay one per game.
  const teaser = await joe('POST', '/api/bets', { type: 'teaser', teaserPoints: 6, stake: 5, legs: [pick(ev, 'spreads'), pick(ev, 'totals')] });
  assert.equal(teaser.status, 400);
});

test('alternate spreads and totals: priced per game, auto-graded, parlay rules', async () => {
  const joe = client();
  await joe('POST', '/api/login', { username: 'joe', password: 'secret1' });
  const joeRow = db.prepare("SELECT * FROM users WHERE username = 'joe'").get();
  bets.applyTransaction(joeRow.id, 50000, 'deposit');
  const nba = (await joe('GET', '/api/odds/basketball_nba')).body.events;
  const ncaab = (await joe('GET', '/api/odds/basketball_ncaab')).body.events;
  assert.ok(ncaab[0].hasProps);
  const altOf = async ev => (await joe('GET', `/api/props/${ev.sport_key}/${ev.id}`)).body.markets;
  assert.ok((await altOf(ncaab[0])).some(m => m.key === 'alternate_spreads'));
  const ev = nba[3];
  const mk = await altOf(ev);
  const as = mk.find(m => m.key === 'alternate_spreads');
  const at = mk.find(m => m.key === 'alternate_totals');
  assert.ok(as.outcomes.length >= 10 && at.outcomes.length >= 10);
  // Taking more points costs more.
  const home = as.outcomes.filter(o => o.name === ev.home_team).sort((a, b) => a.point - b.point);
  assert.ok(bets.americanToDecimal(home[0].price) > bets.americanToDecimal(home[home.length - 1].price));
  const legOf = (key, o) => ({ eventId: ev.id, sportKey: ev.sport_key, market: key, selection: o.name, point: o.point, price: o.price, description: null });
  const spreadLeg = legOf('alternate_spreads', home[0]);
  const over = at.outcomes.find(o => o.name === 'Over');
  const totalLeg = legOf('alternate_totals', over);

  // Not with the main spread, a moneyline, or in a teaser.
  assert.match((await joe('POST', '/api/bets', { type: 'parlay', stake: 5, legs: [spreadLeg, pick(ev, 'spreads')] })).body.error, /one side/);
  assert.match((await joe('POST', '/api/bets', { type: 'parlay', stake: 5, legs: [spreadLeg, pick(ev, 'h2h')] })).body.error, /moneyline and a spread/);
  assert.equal((await joe('POST', '/api/bets', { type: 'teaser', teaserPoints: 6, stake: 5, legs: [spreadLeg, pick(nba[4], 'spreads')] })).status, 400);

  const placed = await joe('POST', '/api/bets', { type: 'parlay', stake: 10, legs: [spreadLeg, totalLeg] });
  assert.equal(placed.status, 200, JSON.stringify(placed.body));
  const b = placed.body.bet;
  assert.equal(b.legs[0].prop_name, 'Alt Spreads');
  // Alt lines aren't props: nothing for the bookie to grade by hand.
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'adminpass' });
  assert.ok(!(await admin('GET', '/api/admin/bets?status=props')).body.bets.some(x => x.id === b.id));

  // Graded from the final score.
  const leg = b.legs.find(l => l.market === 'alternate_spreads');
  const tl = b.legs.find(l => l.market === 'alternate_totals');
  const score = { home_team: ev.home_team, away_team: ev.away_team, home_score: 110, away_score: 100 };
  assert.equal(bets.gradeLeg({ ...leg, point: -9.5 }, score).status, 'won');
  assert.equal(bets.gradeLeg({ ...leg, point: -10.5 }, score).status, 'lost');
  assert.equal(bets.gradeLeg({ ...tl, selection: 'Over', point: 205.5 }, score).status, 'won');
  db.prepare('UPDATE bet_legs SET commence_time = ? WHERE bet_id = ?').run(new Date(Date.now() - 5 * 3600e3).toISOString(), b.id);
  await bets.autoGrade({ force: true });
  const after = bets.getBet(b.id);
  assert.ok(after.legs.every(l => l.status !== 'pending'), JSON.stringify(after.legs.map(l => l.status)));
  assert.notEqual(after.status, 'pending');
});

test('weeks start Monday midnight in the book time zone', () => {
  const ws = d => bets.weekStart(new Date(d), 'America/New_York').toISOString();
  assert.equal(ws('2026-11-19T16:00:00Z'), '2026-11-16T05:00:00.000Z'); // Thursday
  assert.equal(ws('2026-11-16T05:00:00Z'), '2026-11-16T05:00:00.000Z'); // Monday 12:00 AM
  assert.equal(ws('2026-11-16T04:59:59Z'), '2026-11-09T05:00:00.000Z'); // Sunday 11:59 PM
  assert.equal(ws('2026-11-02T04:30:00Z'), '2026-10-26T04:00:00.000Z'); // across the DST change
});

test('weekly net includes blackjack hands when the game exists', () => {
  db.exec(`CREATE TABLE IF NOT EXISTS blackjack_hands (id INTEGER PRIMARY KEY, user_id INTEGER, status TEXT, bet_cents INTEGER, total_bet_cents INTEGER, payout_cents INTEGER, state TEXT, settled_at TEXT)`);
  const joe = db.prepare("SELECT id FROM users WHERE username = 'joe'").get().id;
  const before = bets.weeklyNet(joe).netCents;
  const add = (status, bet, paid, when) => db.prepare("INSERT INTO blackjack_hands(user_id, status, bet_cents, total_bet_cents, payout_cents, state, settled_at) VALUES(?, ?, ?, ?, ?, '{}', datetime('now', ?))").run(joe, status, bet, bet, paid, when);
  add('done', 2000, 4000, '+0 seconds'); // won $20
  add('done', 1000, 0, '+0 seconds'); // lost $10
  add('playing', 500, 0, '+0 seconds'); // still in play
  add('done', 3000, 0, '-30 days'); // an earlier week
  try {
    assert.equal(bets.weeklyNet(joe).netCents, before + 1000);
  } finally {
    db.prepare('DELETE FROM blackjack_hands WHERE user_id = ?').run(joe); // leave the table clean for the blackjack tests
  }
});

test('blackjack: hands are dealt, played and paid from credit, and the bookie sees them', async () => {
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'adminpass' });
  const { body: { user } } = await admin('POST', '/api/admin/users', { username: 'bjplayer', password: 'secret1', credit: '1000' });
  const p = client();
  await p('POST', '/api/login', { username: 'bjplayer', password: 'secret1' });
  const bal = () => db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(user.id).balance_cents;

  assert.equal((await admin('POST', '/api/blackjack/deal', { bet: 10 })).status, 403);
  assert.equal((await p('POST', '/api/blackjack/deal', { bet: 0.5 })).status, 400);
  assert.equal((await p('POST', '/api/blackjack/deal', { bet: 500 })).status, 400);
  assert.equal((await p('POST', '/api/blackjack/action', { action: 'hit' })).status, 409);

  // Rig a hand: set the shoe so we know what comes next (cards are popped from the end).
  const rig = async (player, dealer, shoe) => {
    const r = await p('POST', '/api/blackjack/deal', { bet: 10 });
    assert.equal(r.status, 200);
    const row = db.prepare("SELECT * FROM blackjack_hands WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(user.id);
    if (row.status !== 'playing') return rig(player, dealer, shoe); // natural blackjack: deal again
    db.prepare('UPDATE blackjack_hands SET state = ? WHERE id = ?').run(JSON.stringify({ shoe: [...shoe].reverse(), dealer, hands: [{ cards: player, bet: 1000 }], active: 0, done: false }), row.id);
    return row.id;
  };

  // The hole card is hidden while playing.
  await rig(['10S', '6H'], ['9C', '8D'], ['2C']);
  let r = (await p('GET', '/api/blackjack')).body;
  assert.deepEqual(r.hand.dealer.cards, ['9C', null]);
  assert.ok(r.hand.actions.includes('double') && !r.hand.actions.includes('split'));
  // Hit to 18, stand; dealer 17 stands: win pays even money.
  let before = bal();
  r = (await p('POST', '/api/blackjack/action', { action: 'hit' })).body;
  assert.equal(r.hand.hands[0].total, 18);
  r = (await p('POST', '/api/blackjack/action', { action: 'stand' })).body;
  assert.equal(r.hand.result, 'win');
  assert.equal(r.hand.payoutCents, 2000);
  assert.equal(bal(), before + 2000);

  // Double down: second bet taken, one card, dealer busts.
  await rig(['5S', '6H'], ['6C', '10D'], ['10C', '9H']);
  before = bal();
  r = (await p('POST', '/api/blackjack/action', { action: 'double' })).body;
  assert.equal(r.hand.status, 'done');
  assert.equal(r.hand.hands[0].total, 21);
  assert.equal(r.hand.totalBetCents, 2000);
  assert.equal(r.hand.result, 'win');
  assert.equal(bal(), before - 1000 + 4000);

  // Split eights: two hands, one wins and one loses, net zero.
  await rig(['8S', '8H'], ['10C', '8D'], ['10H', '2C', 'KD']);
  before = bal();
  r = (await p('POST', '/api/blackjack/action', { action: 'split' })).body;
  assert.equal(r.hand.hands.length, 2);
  assert.equal(r.hand.hands[0].total, 18);
  r = (await p('POST', '/api/blackjack/action', { action: 'stand' })).body;
  assert.equal(r.hand.hands[1].total, 10);
  r = (await p('POST', '/api/blackjack/action', { action: 'hit' })).body;
  assert.equal(r.hand.hands[1].total, 20);
  r = (await p('POST', '/api/blackjack/action', { action: 'stand' })).body;
  assert.equal(r.hand.status, 'done');
  assert.deepEqual(r.hand.hands.map(h => h.result), ['push', 'win']);
  assert.equal(bal(), before - 1000 + 1000 + 2000);

  // Bust loses without the dealer drawing.
  await rig(['10S', '6H'], ['9C', '7D'], ['KC']);
  r = (await p('POST', '/api/blackjack/action', { action: 'hit' })).body;
  assert.equal(r.hand.result, 'bust');
  assert.equal(r.hand.dealer.cards.length, 2);

  // Only one hand at a time; an abandoned hand can be voided by the bookie for a refund.
  const open = await rig(['10S', '6H'], ['9C', '7D'], ['KC']);
  assert.equal((await p('POST', '/api/blackjack/deal', { bet: 10 })).status, 409);
  before = bal();
  assert.equal((await admin('POST', `/api/admin/blackjack/${open}/void`)).status, 200);
  assert.equal(bal(), before + 1000);

  // Random hands keep the books straight: credit moves by exactly payout minus stakes.
  for (let i = 0; i < 40; i++) {
    before = bal();
    let h = (await p('POST', '/api/blackjack/deal', { bet: 10 })).body.hand;
    while (h.status === 'playing') h = (await p('POST', '/api/blackjack/action', { action: h.hands.find(x => x.active).total < 17 ? 'hit' : 'stand' })).body.hand;
    assert.equal(bal(), before - h.totalBetCents + h.payoutCents);
  }

  // The bookie sees every hand, with stats, on the dashboard and the client's page.
  const a = (await admin('GET', '/api/admin/blackjack')).body;
  assert.ok(a.hands.length >= 45 && a.hands.every(h => h.username === 'bjplayer'));
  const done = db.prepare("SELECT COALESCE(SUM(total_bet_cents - payout_cents),0) n FROM blackjack_hands WHERE status = 'done'").get().n;
  assert.equal(a.stats.profitCents, done);
  assert.equal((await admin('GET', '/api/admin/summary')).body.blackjack.profitCents, done);
  assert.ok((await admin('GET', `/api/admin/users/${user.id}`)).body.blackjack.length > 0);
  const row = (await admin('GET', '/api/admin/users')).body.users.find(u => u.id === user.id);
  assert.equal(row.bookProfitCents, done);
  assert.equal(bal(), 100000 - done);

  // Turning it off closes the table.
  await admin('PATCH', '/api/admin/settings', { blackjack_enabled: '0' });
  assert.equal((await p('POST', '/api/blackjack/deal', { bet: 10 })).status, 400);
  await admin('PATCH', '/api/admin/settings', { blackjack_enabled: '1' });
});

test('blackjack: the bookie can take test hands off the books', async () => {
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'adminpass' });
  const { body: { user } } = await admin('POST', '/api/admin/users', { username: 'bjtest', password: 'secret1', credit: '200' });
  const p = client();
  await p('POST', '/api/login', { username: 'bjtest', password: 'secret1' });
  const bal = () => db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(user.id).balance_cents;
  const ids = [];
  for (let i = 0; i < 6; i++) {
    let h = (await p('POST', '/api/blackjack/deal', { bet: 10 })).body.hand;
    while (h.status === 'playing' && i < 5) h = (await p('POST', '/api/blackjack/action', { action: h.hands.find(x => x.active).total < 17 ? 'hit' : 'stand' })).body.hand;
    ids.push(h.id);
  }
  // Keep the first hand; remove the rest, including one still being played.
  const keep = db.prepare('SELECT * FROM blackjack_hands WHERE id = ?').get(ids[0]);
  const keptNet = keep.payout_cents - keep.total_bet_cents;
  assert.equal((await p('POST', '/api/admin/blackjack/remove', { ids: ids.slice(1) })).status, 403);
  const r = await admin('POST', '/api/admin/blackjack/remove', { ids: ids.slice(1) });
  assert.equal(r.status, 200);
  assert.equal(r.body.removed, 5);
  assert.equal(bal(), 20000 + keptNet);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM blackjack_hands WHERE user_id = ?').get(user.id).n, 1);
  const tx = db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id').all(user.id);
  assert.equal(tx.at(-1).type, 'adjustment');
  assert.equal(tx.reduce((a, t) => a + t.amount_cents, 0), bal());
  assert.equal((await admin('GET', '/api/admin/users')).body.users.find(u => u.id === user.id).bookProfitCents, -keptNet);
  assert.equal((await admin('POST', '/api/admin/blackjack/remove', { ids: [ids[1]] })).status, 404);
  // The client can deal again (the open hand is gone).
  assert.equal((await p('POST', '/api/blackjack/deal', { bet: 10 })).status, 200);
});

test('profit boosts: the bookie creates one, a client uses it once, and a win pays the boosted profit', async () => {
  const admin = client();
  await admin('POST', '/api/login', { username: 'admin', password: 'adminpass' });
  await admin('PATCH', '/api/admin/settings', { betting_open: '1' });
  const { body: { user } } = await admin('POST', '/api/admin/users', { username: 'booster', password: 'secret1', credit: '500' });
  const c = client();
  await c('POST', '/api/login', { username: 'booster', password: 'secret1' });

  assert.equal((await c('POST', '/api/admin/boosts', { title: 'x', pct: 25 })).status, 403);
  assert.equal((await admin('POST', '/api/admin/boosts', { title: 'Bad', pct: 0 })).status, 400);
  const made = await admin('POST', '/api/admin/boosts', { title: 'Straight bet boost', pct: 50, betType: 'single', maxStake: '50', usesPerClient: '1' });
  assert.equal(made.status, 200);
  const boostId = made.body.boost.id;
  const parlayOnly = (await admin('POST', '/api/admin/boosts', { title: 'Parlay boost', pct: 25, betType: 'parlay', minLegs: '3' })).body.boost.id;
  const other = await admin('POST', '/api/admin/users', { username: 'notyou', password: 'secret1' });
  const private_ = (await admin('POST', '/api/admin/boosts', { title: 'Just for notyou', pct: 100, userId: other.body.user.id })).body.boost.id;

  const listed = (await c('GET', '/api/boosts')).body.boosts.map(b => b.id);
  assert.ok(listed.includes(boostId) && listed.includes(parlayOnly));
  assert.ok(!listed.includes(private_));

  const { events } = (await c('GET', '/api/odds/basketball_nba')).body;
  const ev = events[0], o = ev.markets.h2h[0];
  const leg = { eventId: ev.id, sportKey: ev.sport_key, market: 'h2h', selection: o.name, point: null, price: o.price };
  const place = body => c('POST', '/api/bets', { type: 'single', stake: 40, legs: [leg], ...body });

  assert.equal((await place({ boostId: private_ })).status, 409);
  assert.equal((await place({ boostId: parlayOnly })).status, 400);
  assert.equal((await place({ boostId, stake: 60 })).status, 400); // over the boost's max stake
  assert.equal((await place({ boostId, freeplay: true })).status, 400);
  const ok = await place({ boostId });
  assert.equal(ok.status, 200);
  const raw = Math.floor(4000 * bets.americanToDecimal(o.price));
  const boosted = 4000 + Math.floor((raw - 4000) * 150 / 100);
  assert.equal(ok.body.bet.boost_pct, 50);
  assert.equal(ok.body.bet.potential_payout_cents, boosted);
  // Single use: the second try is refused and it drops off the client's list.
  assert.equal((await place({ boostId })).status, 400);
  assert.ok(!(await c('GET', '/api/boosts')).body.boosts.some(b => b.id === boostId));

  const won = await admin('POST', `/api/admin/legs/${ok.body.bet.legs[0].id}/settle`, { status: 'won' });
  assert.equal(won.body.bet.payout_cents, boosted);
  assert.equal(won.body.bet.boost_extra_cents, boosted - raw);
  assert.equal((await c('GET', '/api/me')).body.user.balanceCents, 50000 - 4000 + boosted);
  // A push just returns the stake.
  const push = await admin('POST', `/api/admin/legs/${ok.body.bet.legs[0].id}/settle`, { status: 'push' });
  assert.equal(push.body.bet.payout_cents, 4000);
  assert.equal(push.body.bet.boost_extra_cents, 0);
  await admin('POST', `/api/admin/legs/${ok.body.bet.legs[0].id}/settle`, { status: 'won' });

  const report = (await admin('GET', '/api/admin/boosts')).body.boosts.find(b => b.id === boostId);
  assert.equal(report.bets, 1);
  assert.equal(report.extraPaidCents, boosted - raw);
  assert.equal((await admin('DELETE', `/api/admin/boosts/${boostId}`)).status, 400);
  assert.equal((await admin('PATCH', `/api/admin/boosts/${parlayOnly}`, { status: 'paused' })).status, 200);
  assert.ok(!(await c('GET', '/api/boosts')).body.boosts.some(b => b.id === parlayOnly));
  assert.equal((await admin('DELETE', `/api/admin/boosts/${parlayOnly}`)).status, 200);
});
