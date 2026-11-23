'use strict';
// One-off: Vikings vs 49ers (Sunday Night Football, Nov 22 2026) as bookie specials, so the game
// stays bettable after its listed 8:20 PM ET start. Added once, on the first start after deploy;
// the bookie grades them in Admin > Props like any other special. Safe to delete after the game.
const { db, tx, getSetting, setSetting } = require('./db');

const FLAG = 'seeded_snf_min_sf_2026_11_22';
const CLOSES = '2026-11-23T04:30:00.000Z'; // 11:30 PM ET
const TITLE = 'Vikings vs 49ers';

// [player, anytime TD, first TD]
const PLAYERS = [
  ['Christian McCaffrey', -155, 425], ['Justin Jefferson', 135, 800], ['George Kittle', 175, 1000],
  ['Aaron Jones', 190, 950], ['Mike Evans', 210, 1100], ['T.J. Hockenson', 220, 1300],
  ['Jordan Mason', 255, 1200], ['Kaelon Black', 330, 1700], ['Deebo Samuel', 330, 1500],
  ['Keenan Allen', 340, 1700], ['49ers D/ST', 475, 2200], ['Brock Purdy', 475, 2200],
  ['Jauan Jennings', 475, 2500], ['Vikings D/ST', 600, 2800],
];

function props() {
  return [
    ['Moneyline', [['Vikings', 138], ['49ers', -164]]],
    ['Spread', [['Vikings +3', 100], ['49ers -3', -120]]],
    ['Alt spread 4.5', [['Vikings +4.5', -116], ['49ers -4.5', -103]]],
    ['Alt spread: Vikings +3.5', [['Vikings +3.5', -120]]],
    ['First TD scorer', PLAYERS.map(([n, , f]) => [n, f])],
    ...PLAYERS.map(([n, a]) => [`${n} anytime TD`, [['Yes', a]]]),
  ];
}

function seed(now = Date.now()) {
  if (getSetting(FLAG) === '1' || now >= Date.parse(CLOSES)) return 0;
  const ins = db.prepare(`INSERT INTO custom_props(event_id, sport_key, sport_title, home_team, away_team, commence_time, question, options)
    VALUES(NULL, 'specials', ?, NULL, NULL, ?, ?, ?)`);
  const fix = db.prepare('UPDATE custom_props SET event_id = ? WHERE id = ?');
  const list = props();
  tx(() => {
    for (const [q, opts] of list) {
      const { lastInsertRowid } = ins.run(TITLE, CLOSES, q, JSON.stringify(opts.map(([name, price]) => ({ name, price }))));
      fix.run(`special_${lastInsertRowid}`, lastInsertRowid);
    }
    setSetting(FLAG, '1');
  });
  return list.length;
}

module.exports = { seed };
