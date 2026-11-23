'use strict';
// One-off: Bengals at Commanders (Monday Night Football, Nov 23 2026) as bookie specials, priced from
// the bookie's own screenshots. Added once, on the first start after deploy; bets close at kickoff
// (8:15 PM ET) and the bookie grades them in Admin > Props like any other special. Safe to delete after.
const { db, tx, getSetting, setSetting } = require('./db');

const FLAG = 'seeded_mnf_cin_was_2026_11_23';
const CLOSES = '2026-11-24T01:15:00.000Z'; // 8:15 PM ET kickoff
const TITLE = 'Bengals at Commanders';

// [player, anytime TD, first TD, 2+ TDs]
const PLAYERS = [
  ["Ja'Marr Chase", -160, 550, 350], ['Chase Brown', -125, 600, 500], ['Tee Higgins', -110, 700, 550],
  ['Mike Gesicki', 180, 1100, 1400], ['Stefon Diggs', 185, 1400, 1500], ['Jacory Croskey-Merritt', 185, 1300, 1400],
  ['Rachaad White', 220, 1600, 2000], ['Jayden Daniels', 240, 1900, 2200], ['Chigoziem Okonkwo', 260, 2000, 2200],
  ['Samaje Perine', 260, 1700, 2200], ['Antonio Williams', 285, 2200, 2800], ['Treylon Burks', 310, 2200, 3000],
  ['Dohnte Meyers', 370, 2200, 4000], ['Austin Ekeler', 380, 2500, 3500], ['Joe Burrow', 425, 1900, 4500],
  ['Drew Sample', 550, 3500, 6500], ['Bengals D/ST', 550, 3500, 5500], ['Commanders D/ST', 650, 3000, 7000],
  ['Jack Endries', 850, 5500, 10000],
];

// [player, yards, price]
const REC_YARDS = [
  ["Ja'Marr Chase", 102, -111], ['Tee Higgins', 80, -102], ['Stefon Diggs', 55, -112], ['Antonio Williams', 40, -105],
  ['Chigoziem Okonkwo', 42, -115], ['Treylon Burks', 31, -115], ['Mike Gesicki', 30, 105], ['Chase Brown', 30, 103],
  ['Dohnte Meyers', 22, -109], ['Van Jefferson', 6, -115], ['Ben Sinnott', 1, 105], ['Drew Sample', 6, -122],
];

const FIRST_CIN = [
  ["Ja'Marr Chase", 295], ['Chase Brown', 350], ['Tee Higgins', 380], ['Mike Gesicki', 650], ['Samaje Perine', 1100],
  ['Dohnte Meyers', 1300], ['Joe Burrow', 1700], ['Drew Sample', 2000], ['Bengals D/ST', 2500], ['Jack Endries', 3000],
  ['Colbie Young', 5000], ['Mitchell Tinsley', 5000],
];
const FIRST_WAS = [
  ['Jacory Croskey-Merritt', 500], ['Stefon Diggs', 550], ['Rachaad White', 650], ['Jayden Daniels', 700],
  ['Chigoziem Okonkwo', 800], ['Antonio Williams', 850], ['Treylon Burks', 900], ['Austin Ekeler', 1100],
  ['Commanders D/ST', 1900],
];

function props() {
  return [
    ['Moneyline', [['Bengals', -300], ['Commanders', 244]]],
    ['Spread', [['Bengals -6', -120], ['Commanders +6', 100]]],
    ['Total points 54.5', [['Over 54.5', -113], ['Under 54.5', -106]]],
    ['Alt spread 2.5', [['Bengals -2.5', -235], ['Commanders +2.5', 171]]],
    ['Alt total 53.5', [['Over 53.5', -130], ['Under 53.5', -102]]],
    ['First TD scorer', PLAYERS.map(([n, , f]) => [n, f])],
    ['First Bengals TD scorer', FIRST_CIN],
    ['First Commanders TD scorer', FIRST_WAS],
    ...PLAYERS.map(([n, a]) => [`${n} anytime TD`, [['Yes', a]]]),
    ...PLAYERS.map(([n, , , two]) => [`${n} 2+ TDs`, [['Yes', two]]]),
    ...REC_YARDS.map(([n, y, p]) => [`${n} ${y}+ receiving yards`, [['Yes', p]]]),
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

module.exports = { seed, props };
