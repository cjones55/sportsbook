'use strict';
// Odds source: The Odds API (https://the-odds-api.com), which aggregates DraftKings,
// FanDuel, BetMGM and others. Without an API key the book runs on generated demo odds.
const { db, getSetting, setSetting, intSetting } = require('./db');

const API = 'https://api.the-odds-api.com/v4';
const MARKETS = ['h2h', 'spreads', 'totals'];
const DEFAULT_GROUPS = ['American Football', 'Baseball', 'Basketball', 'Ice Hockey', 'Tennis', 'Lacrosse'];

function apiKey() {
  return (getSetting('odds_api_key') || process.env.ODDS_API_KEY || '').trim();
}
function isLive() { return !!apiKey(); }

async function apiGet(pathname, params) {
  const url = new URL(API + pathname);
  url.searchParams.set('apiKey', apiKey());
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
  const remaining = res.headers.get('x-requests-remaining');
  const used = res.headers.get('x-requests-used');
  if (remaining !== null) setSetting('odds_quota_remaining', remaining);
  if (used !== null) setSetting('odds_quota_used', used);
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`Odds API ${res.status}: ${body.slice(0, 200)}`);
    err.status = res.status;
    setSetting('odds_last_error', `${new Date().toISOString()} ${err.message}`);
    throw err;
  }
  setSetting('odds_last_error', '');
  return res.json();
}

function quotaTooLow() {
  const rem = getSetting('odds_quota_remaining');
  return rem !== null && rem !== '' && Number(rem) < intSetting('odds_quota_floor');
}

// ---------- sports list ----------

let sportsMem = null; // { at, list }

async function allSports() {
  if (!isLive()) return MOCK_SPORTS.map(s => ({ key: s.key, group: s.group, title: s.title, active: true }));
  if (sportsMem && Date.now() - sportsMem.at < 6 * 3600e3) return sportsMem.list;
  try {
    const list = (await apiGet('/sports')) // free call, costs no quota
      .filter(s => !s.has_outrights)
      .map(s => ({ key: s.key, group: s.group, title: s.title, active: s.active }));
    sportsMem = { at: Date.now(), list };
    return list;
  } catch (err) {
    console.error('sports list failed:', err.message);
    return sportsMem ? sportsMem.list : [];
  }
}

function enabledSportKeys() {
  const raw = getSetting('enabled_sports');
  return raw ? raw.split(',').filter(Boolean) : null; // null = default groups
}

// Sports shown to clients: enabled and currently in season.
async function boardSports() {
  const list = await allSports();
  const enabled = enabledSportKeys();
  return list.filter(s => s.active && (enabled ? enabled.includes(s.key) : DEFAULT_GROUPS.includes(s.group)));
}

// ---------- odds ----------

const inflight = new Map();

function readCache(sportKey) {
  const row = db.prepare('SELECT * FROM odds_cache WHERE sport_key = ?').get(sportKey);
  return row ? { fetchedAt: row.fetched_at, source: row.source, events: JSON.parse(row.data) } : null;
}

async function getEvents(sportKey, { force = false } = {}) {
  if (!isLive()) return { fetchedAt: Date.now(), source: 'demo', events: mockEvents(sportKey) };
  const cached = readCache(sportKey);
  const ttl = Math.max(1, intSetting('odds_ttl_minutes')) * 60e3;
  const fresh = cached && cached.source === 'live' && Date.now() - cached.fetchedAt < ttl;
  if (fresh && !force) return cached;
  if (quotaTooLow() && !force) return cached || { fetchedAt: 0, source: 'live', events: [] };
  if (inflight.has(sportKey)) return inflight.get(sportKey);
  const p = (async () => {
    try {
      const raw = await apiGet(`/sports/${encodeURIComponent(sportKey)}/odds`, {
        bookmakers: getSetting('bookmakers'),
        markets: MARKETS.join(','),
        oddsFormat: 'american',
        dateFormat: 'iso',
      });
      const events = raw.map(normalizeEvent).filter(Boolean);
      db.prepare(`INSERT INTO odds_cache(sport_key, fetched_at, source, data) VALUES(?, ?, 'live', ?)
        ON CONFLICT(sport_key) DO UPDATE SET fetched_at = excluded.fetched_at, source = excluded.source, data = excluded.data`)
        .run(sportKey, Date.now(), JSON.stringify(events));
      return { fetchedAt: Date.now(), source: 'live', events };
    } catch (err) {
      console.error(`odds fetch ${sportKey} failed:`, err.message);
      return cached || { fetchedAt: 0, source: 'live', events: [], error: err.message };
    } finally {
      inflight.delete(sportKey);
    }
  })();
  inflight.set(sportKey, p);
  return p;
}

function normalizeEvent(e) {
  const prefs = String(getSetting('bookmakers')).split(',').map(s => s.trim());
  const books = [...(e.bookmakers || [])].sort((a, b) => rank(a.key) - rank(b.key));
  function rank(k) { const i = prefs.indexOf(k); return i === -1 ? 99 : i; }
  const markets = {};
  let bookTitle = null;
  for (const m of MARKETS) {
    for (const b of books) {
      const mk = (b.markets || []).find(x => x.key === m);
      if (mk && mk.outcomes && mk.outcomes.length) {
        markets[m] = mk.outcomes.map(o => ({ name: o.name, price: Math.round(o.price), point: o.point ?? null }));
        bookTitle = bookTitle || b.title;
        break;
      }
    }
  }
  if (!Object.keys(markets).length) return null;
  return {
    id: e.id, sport_key: e.sport_key, sport_title: e.sport_title, commence_time: e.commence_time,
    home_team: e.home_team, away_team: e.away_team, bookmaker: bookTitle, markets,
  };
}

// ---------- scores ----------

async function fetchScores(sportKey) {
  if (!isLive()) return 0;
  if (quotaTooLow()) return 0;
  const raw = await apiGet(`/sports/${encodeURIComponent(sportKey)}/scores`, { daysFrom: '3', dateFormat: 'iso' });
  let n = 0;
  for (const e of raw) {
    if (!e.completed || !e.scores) continue;
    const home = e.scores.find(s => s.name === e.home_team);
    const away = e.scores.find(s => s.name === e.away_team);
    if (!home || !away) continue;
    saveScore(e.id, sportKey, e.home_team, e.away_team, Number(home.score), Number(away.score));
    n++;
  }
  return n;
}

function saveScore(eventId, sportKey, home, away, hs, as) {
  db.prepare(`INSERT INTO scores(event_id, sport_key, home_team, away_team, home_score, away_score, completed, updated_at)
    VALUES(?, ?, ?, ?, ?, ?, 1, ?)
    ON CONFLICT(event_id) DO UPDATE SET home_score = excluded.home_score, away_score = excluded.away_score,
      completed = 1, updated_at = excluded.updated_at`)
    .run(eventId, sportKey, home, away, hs, as, Date.now());
}

// Demo mode: invent a final score for demo games that started more than 3 hours ago.
function mockScoresFor(legs) {
  for (const l of legs) {
    if (!l.event_id.startsWith('demo_')) continue;
    if (Date.parse(l.commence_time) > Date.now() - 3 * 3600e3) continue;
    const def = MOCK_SPORTS.find(s => s.key === l.sport_key);
    const r = rng(l.event_id + ':score');
    const base = def ? def.total / 2 : 3;
    let hs = Math.max(0, Math.round(base + (r() - 0.45) * base * 0.9));
    let as = Math.max(0, Math.round(base + (r() - 0.5) * base * 0.9));
    if (def && def.group === 'Tennis') { hs = r() < 0.5 ? 2 : Math.floor(r() * 2); as = hs === 2 ? Math.floor(r() * 2) : 2; }
    else if (hs === as) hs++;
    saveScore(l.event_id, l.sport_key, l.home_team, l.away_team, hs, as);
  }
}

// ---------- demo data ----------

const MOCK_SPORTS = [
  { key: 'americanfootball_nfl', group: 'American Football', title: 'NFL', total: 45, spread: true,
    teams: ['Kansas City Chiefs', 'Buffalo Bills', 'Philadelphia Eagles', 'Dallas Cowboys', 'San Francisco 49ers', 'Detroit Lions', 'Baltimore Ravens', 'Green Bay Packers', 'Miami Dolphins', 'Cincinnati Bengals', 'New York Giants', 'Chicago Bears'] },
  { key: 'americanfootball_ncaaf', group: 'American Football', title: 'NCAAF', total: 52, spread: true,
    teams: ['Alabama Crimson Tide', 'Georgia Bulldogs', 'Ohio State Buckeyes', 'Michigan Wolverines', 'Texas Longhorns', 'LSU Tigers', 'Oregon Ducks', 'Notre Dame Fighting Irish', 'Penn State Nittany Lions', 'Clemson Tigers'] },
  { key: 'baseball_mlb', group: 'Baseball', title: 'MLB', total: 8.5, spread: true, runline: true,
    teams: ['New York Yankees', 'Los Angeles Dodgers', 'Atlanta Braves', 'Houston Astros', 'Boston Red Sox', 'Chicago Cubs', 'Philadelphia Phillies', 'San Diego Padres', 'Seattle Mariners', 'St. Louis Cardinals'] },
  { key: 'baseball_ncaa', group: 'Baseball', title: 'NCAA Baseball', total: 11.5, spread: true, runline: true,
    teams: ['LSU Tigers', 'Florida Gators', 'Wake Forest Demon Deacons', 'Arkansas Razorbacks', 'Tennessee Volunteers', 'Vanderbilt Commodores'] },
  { key: 'basketball_nba', group: 'Basketball', title: 'NBA', total: 226.5, spread: true,
    teams: ['Boston Celtics', 'Denver Nuggets', 'Milwaukee Bucks', 'Los Angeles Lakers', 'Golden State Warriors', 'Phoenix Suns', 'Miami Heat', 'New York Knicks', 'Dallas Mavericks', 'Oklahoma City Thunder'] },
  { key: 'basketball_ncaab', group: 'Basketball', title: 'NCAAB', total: 145.5, spread: true,
    teams: ['Duke Blue Devils', 'Kansas Jayhawks', 'Kentucky Wildcats', 'North Carolina Tar Heels', 'UConn Huskies', 'Gonzaga Bulldogs', 'Houston Cougars', 'Purdue Boilermakers'] },
  { key: 'basketball_wncaab', group: 'Basketball', title: "NCAAW Basketball", total: 138.5, spread: true,
    teams: ['South Carolina Gamecocks', 'Iowa Hawkeyes', 'UConn Huskies', 'LSU Tigers', 'Stanford Cardinal', 'Texas Longhorns'] },
  { key: 'icehockey_nhl', group: 'Ice Hockey', title: 'NHL', total: 6, spread: true, puckline: true,
    teams: ['Florida Panthers', 'Edmonton Oilers', 'New York Rangers', 'Dallas Stars', 'Colorado Avalanche', 'Boston Bruins', 'Vegas Golden Knights', 'Toronto Maple Leafs', 'Carolina Hurricanes', 'Vancouver Canucks'] },
  { key: 'tennis_atp', group: 'Tennis', title: 'ATP', total: 3, spread: false,
    teams: ['Jannik Sinner', 'Carlos Alcaraz', 'Novak Djokovic', 'Alexander Zverev', 'Daniil Medvedev', 'Taylor Fritz', 'Casper Ruud', 'Ben Shelton'] },
  { key: 'tennis_wta', group: 'Tennis', title: 'WTA', total: 3, spread: false,
    teams: ['Aryna Sabalenka', 'Iga Swiatek', 'Coco Gauff', 'Elena Rybakina', 'Jessica Pegula', 'Qinwen Zheng', 'Jasmine Paolini', 'Madison Keys'] },
];

function rng(seed) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
  return () => {
    h += 0x6D2B79F5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function probToAmerican(p, vig = 0.025) {
  p = Math.min(0.95, Math.max(0.05, p + vig));
  const a = p >= 0.5 ? -Math.round((p / (1 - p)) * 100) : Math.round(((1 - p) / p) * 100);
  return Math.round(a / 5) * 5;
}

function mockEvents(sportKey) {
  const def = MOCK_SPORTS.find(s => s.key === sportKey);
  if (!def) return [];
  const out = [];
  const today = Math.floor(Date.now() / 86400e3);
  for (let d = 0; d < 5; d++) {
    const day = today + d;
    const r = rng(`${sportKey}:${day}`);
    const teams = [...def.teams].sort(() => r() - 0.5);
    const games = Math.min(3, Math.floor(teams.length / 2));
    for (let g = 0; g < games; g++) {
      const hourUtc = 17 + g * 3 + Math.floor(r() * 2); // afternoon/evening US
      const start = new Date((day * 86400 + hourUtc * 3600) * 1000);
      if (start.getTime() < Date.now() + 10 * 60e3) continue;
      const home = teams[g * 2], away = teams[g * 2 + 1];
      const pHome = 0.3 + r() * 0.45;
      const markets = { h2h: [{ name: home, price: probToAmerican(pHome), point: null }, { name: away, price: probToAmerican(1 - pHome), point: null }] };
      if (def.spread) {
        let pt;
        if (def.runline || def.puckline) pt = 1.5;
        else pt = Math.max(0.5, Math.round(Math.abs(pHome - 0.5) * def.total * 0.25 * 2) / 2 + 0.5);
        const fav = pHome >= 0.5 ? home : away;
        markets.spreads = [
          { name: home, price: def.runline || def.puckline ? (fav === home ? 140 : -160) : -110, point: fav === home ? -pt : pt },
          { name: away, price: def.runline || def.puckline ? (fav === away ? 140 : -160) : -110, point: fav === away ? -pt : pt },
        ];
      }
      if (def.group !== 'Tennis') {
        const tp = Math.round((def.total + (r() - 0.5) * def.total * 0.1) * 2) / 2;
        markets.totals = [{ name: 'Over', price: -110, point: tp }, { name: 'Under', price: -110, point: tp }];
      }
      out.push({
        id: `demo_${sportKey}_${day}_${g}`, sport_key: sportKey, sport_title: def.title,
        commence_time: start.toISOString(), home_team: home, away_team: away, bookmaker: 'Demo odds', markets,
      });
    }
  }
  return out;
}

function status() {
  return {
    live: isLive(),
    keySource: getSetting('odds_api_key') ? 'admin settings' : (process.env.ODDS_API_KEY ? 'environment' : null),
    quotaRemaining: getSetting('odds_quota_remaining'),
    quotaUsed: getSetting('odds_quota_used'),
    lastError: getSetting('odds_last_error') || null,
    ttlMinutes: intSetting('odds_ttl_minutes'),
    bookmakers: getSetting('bookmakers'),
  };
}

module.exports = {
  allSports, boardSports, getEvents, fetchScores, mockScoresFor, isLive, status, DEFAULT_GROUPS,
  _resetSportsCache: () => { sportsMem = null; }, _mockEvents: mockEvents,
};
