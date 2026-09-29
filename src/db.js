'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(process.env.DB_FILE || path.join(DATA_DIR, 'sportsbook.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  display_name TEXT,
  pass_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'client',
  status TEXT NOT NULL DEFAULT 'active',
  balance_cents INTEGER NOT NULL DEFAULT 0,
  max_bet_cents INTEGER,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_login_at TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS transactions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  amount_cents INTEGER NOT NULL,
  balance_after_cents INTEGER NOT NULL,
  bet_id INTEGER,
  note TEXT,
  created_by INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, id);
CREATE TABLE IF NOT EXISTS bets (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  type TEXT NOT NULL,
  stake_cents INTEGER NOT NULL,
  decimal_odds REAL NOT NULL,
  potential_payout_cents INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  payout_cents INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  settled_at TEXT,
  settled_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id, id);
CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status);
CREATE TABLE IF NOT EXISTS bet_legs (
  id INTEGER PRIMARY KEY,
  bet_id INTEGER NOT NULL REFERENCES bets(id) ON DELETE CASCADE,
  event_id TEXT NOT NULL,
  sport_key TEXT NOT NULL,
  sport_title TEXT,
  home_team TEXT,
  away_team TEXT,
  commence_time TEXT,
  market TEXT NOT NULL,
  selection TEXT NOT NULL,
  point REAL,
  price INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  result_note TEXT
);
CREATE INDEX IF NOT EXISTS idx_legs_bet ON bet_legs(bet_id);
CREATE INDEX IF NOT EXISTS idx_legs_event ON bet_legs(event_id, status);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS odds_cache (
  sport_key TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  source TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS scores (
  event_id TEXT PRIMARY KEY,
  sport_key TEXT NOT NULL,
  home_team TEXT,
  away_team TEXT,
  home_score REAL,
  away_score REAL,
  completed INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
`);

// Columns added after the first release; older databases get them on start.
function addColumn(table, column, type) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
}
addColumn('bets', 'teaser_points', 'REAL');
addColumn('bets', 'teaser_odds', 'TEXT');
addColumn('bet_legs', 'orig_point', 'REAL');

// Run fn inside a transaction; nested calls join the outer one.
let depth = 0;
function tx(fn) {
  if (depth > 0) return fn();
  depth++;
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    depth--;
  }
}

const DEFAULT_SETTINGS = {
  book_name: process.env.BOOK_NAME || 'The Book',
  betting_open: '1',
  signup_enabled: '0',
  signup_code: '',
  signup_starting_credit_cents: '0',
  min_bet_cents: '100',
  max_bet_cents: '50000',
  max_payout_cents: '500000',
  max_parlay_legs: '10',
  odds_api_key: '',
  odds_ttl_minutes: '30',
  odds_quota_floor: '25',
  bookmakers: 'draftkings,fanduel,betmgm,williamhill_us,betrivers',
  enabled_sports: '',
  auto_grade: '1',
  // American odds a teaser pays, by teaser size and number of winning legs.
  teaser_odds: JSON.stringify({
    6: { 2: -110, 3: 180, 4: 300, 5: 450, 6: 600 },
    6.5: { 2: -120, 3: 160, 4: 250, 5: 400, 6: 500 },
    7: { 2: -130, 3: 140, 4: 200, 5: 325, 6: 450 },
  }),
};

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (row && row.value !== null) return row.value;
  return DEFAULT_SETTINGS[key] ?? null;
}
function setSetting(key, value) {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, value == null ? null : String(value));
}
function intSetting(key) {
  return parseInt(getSetting(key), 10) || 0;
}

function teaserOdds() {
  try { return JSON.parse(getSetting('teaser_odds')); } catch { return JSON.parse(DEFAULT_SETTINGS.teaser_odds); }
}

module.exports = { db, tx, getSetting, setSetting, intSetting, teaserOdds, DEFAULT_SETTINGS, DATA_DIR };
