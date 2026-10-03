'use strict';
// Props: player and game props from The Odds API (fetched one game at a time, only when
// someone opens that game, so the bookie's request quota isn't spent on games nobody looks at),
// generated demo props when there's no API key, and props the bookie writes by hand.
// The scores feed has no player stats, so every prop is graded by the bookie.
const { db, getSetting, intSetting } = require('./db');
const odds = require('./odds');

const MAIN_MARKETS = ['h2h', 'spreads', 'totals'];
const isProp = market => !MAIN_MARKETS.includes(market);

// Markets asked for per league. Each market the feed returns costs one request.
const PROP_MARKETS = {
  americanfootball_nfl: ['player_pass_yds', 'player_pass_tds', 'player_rush_yds', 'player_reception_yds', 'player_receptions', 'player_anytime_td', 'team_totals'],
  basketball_nba: ['player_points', 'player_rebounds', 'player_assists', 'player_threes', 'player_points_rebounds_assists', 'team_totals'],
  baseball_mlb: ['batter_hits', 'batter_home_runs', 'batter_total_bases', 'batter_rbis', 'pitcher_strikeouts', 'team_totals'],
  icehockey_nhl: ['player_points', 'player_goals', 'player_assists', 'player_shots_on_goal', 'player_goal_scorer_anytime', 'team_totals'],
};

const TITLES = {
  team_totals: 'Team Total',
  player_pass_yds: 'Passing Yards', player_pass_tds: 'Passing TDs', player_rush_yds: 'Rushing Yards',
  player_reception_yds: 'Receiving Yards', player_receptions: 'Receptions', player_anytime_td: 'Anytime TD',
  player_points: 'Points', player_rebounds: 'Rebounds', player_assists: 'Assists', player_threes: 'Threes Made',
  player_points_rebounds_assists: 'Pts + Reb + Ast',
  batter_hits: 'Hits', batter_home_runs: 'Home Runs', batter_total_bases: 'Total Bases', batter_rbis: 'RBIs',
  pitcher_strikeouts: 'Pitcher Strikeouts',
  player_goals: 'Goals', player_shots_on_goal: 'Shots on Goal', player_goal_scorer_anytime: 'Anytime Goal',
};

function feedPropsOn(sportKey) {
  return !!PROP_MARKETS[sportKey] && getSetting('props_enabled') === '1';
}

// ---------- feed props ----------

const inflight = new Map();

async function feedProps(sportKey, eventId) {
  if (!feedPropsOn(sportKey)) return null;
  // Only games that are on the board, so nobody can spend the quota on made-up ids.
  const event = (await odds.getEvents(sportKey)).events.find(e => e.id === eventId);
  if (!event) return null;
  if (!odds.isLive()) return { source: 'demo', fetchedAt: Date.now(), bookmaker: 'Demo odds', markets: demoMarkets(event) };

  const row = db.prepare('SELECT * FROM props_cache WHERE event_id = ?').get(eventId);
  const cached = row ? { source: row.source, fetchedAt: row.fetched_at, ...JSON.parse(row.data) } : null;
  const ttl = Math.max(1, intSetting('props_ttl_minutes')) * 60e3;
  if (cached && Date.now() - cached.fetchedAt < ttl) return cached;
  if (odds.quotaTooLow()) return cached;
  if (inflight.has(eventId)) return inflight.get(eventId);
  const p = (async () => {
    try {
      const raw = await odds.apiGet(`/sports/${encodeURIComponent(sportKey)}/events/${encodeURIComponent(eventId)}/odds`, {
        bookmakers: getSetting('bookmakers'),
        markets: PROP_MARKETS[sportKey].join(','),
        oddsFormat: 'american',
        dateFormat: 'iso',
      });
      const data = normalize(raw);
      db.prepare(`INSERT INTO props_cache(event_id, sport_key, fetched_at, source, data) VALUES(?, ?, ?, 'live', ?)
        ON CONFLICT(event_id) DO UPDATE SET fetched_at = excluded.fetched_at, source = excluded.source, data = excluded.data`)
        .run(eventId, sportKey, Date.now(), JSON.stringify(data));
      // Old games' props are never needed again.
      db.prepare('DELETE FROM props_cache WHERE fetched_at < ?').run(Date.now() - 3 * 86400e3);
      return { source: 'live', fetchedAt: Date.now(), ...data };
    } catch (err) {
      console.error(`props fetch ${eventId} failed:`, err.message);
      return cached;
    } finally {
      inflight.delete(eventId);
    }
  })();
  inflight.set(eventId, p);
  return p;
}

// For each market, take the first bookmaker in the preferred order that offers it.
function normalize(e) {
  const prefs = String(getSetting('bookmakers')).split(',').map(s => s.trim());
  const rank = k => { const i = prefs.indexOf(k); return i === -1 ? 99 : i; };
  const books = [...(e.bookmakers || [])].sort((a, b) => rank(a.key) - rank(b.key));
  const order = PROP_MARKETS[e.sport_key] || [];
  const markets = [];
  let bookmaker = null;
  for (const key of order) {
    for (const b of books) {
      const mk = (b.markets || []).find(x => x.key === key);
      if (!mk || !mk.outcomes || !mk.outcomes.length) continue;
      markets.push({
        key, title: TITLES[key] || key,
        outcomes: mk.outcomes.map(o => ({ name: o.name, description: o.description ?? null, price: Math.round(o.price), point: o.point ?? null })),
      });
      bookmaker = bookmaker || b.title;
      break;
    }
  }
  return { bookmaker, markets };
}

// ---------- demo props ----------

const DEMO = {
  americanfootball_nfl: [
    ['QB', 'player_pass_yds', 245.5, 40], ['QB', 'player_pass_tds', 1.5, 0], ['RB', 'player_rush_yds', 64.5, 20],
    ['WR', 'player_reception_yds', 62.5, 20], ['WR', 'player_receptions', 4.5, 1], ['RB', 'player_anytime_td'], ['WR', 'player_anytime_td'],
  ],
  basketball_nba: [
    ['G', 'player_points', 24.5, 6], ['F', 'player_points', 19.5, 5], ['F', 'player_rebounds', 8.5, 2],
    ['G', 'player_assists', 6.5, 2], ['G', 'player_threes', 2.5, 1],
  ],
  baseball_mlb: [
    ['SP', 'pitcher_strikeouts', 5.5, 1], ['1B', 'batter_hits', 0.5, 0], ['1B', 'batter_home_runs', 0.5, 0],
    ['CF', 'batter_total_bases', 1.5, 0],
  ],
  icehockey_nhl: [
    ['C', 'player_points', 0.5, 0], ['C', 'player_shots_on_goal', 2.5, 1], ['RW', 'player_goal_scorer_anytime'],
  ],
};

function demoMarkets(event) {
  const r = odds.rng(event.id + ':props');
  const nick = t => t.split(' ').slice(-1)[0];
  const byKey = {};
  const add = (key, outcome) => (byKey[key] = byKey[key] || []).push(outcome);
  const ou = (key, description, point) => {
    const lean = Math.round((r() - 0.5) * 6) * 5; // -15..+15 around -110
    add(key, { name: 'Over', description, price: -110 + lean, point });
    add(key, { name: 'Under', description, price: -110 - lean, point });
  };
  const total = Number(((event.markets.totals || [])[0] || {}).point) || 0;
  if (total) for (const team of [event.away_team, event.home_team]) ou('team_totals', team, Math.round(total) / 2);
  for (const [pos, key, line, swing] of DEMO[event.sport_key] || []) {
    for (const team of [event.away_team, event.home_team]) {
      const description = `${nick(team)} ${pos}`;
      if (line === undefined) add(key, { name: 'Yes', description, price: 100 + Math.round(r() * 30) * 10, point: null });
      else ou(key, description, swing ? Math.floor(line + (r() - 0.5) * swing) + 0.5 : line);
    }
  }
  // Keep every line on a half point so there are no pushes in the demo.
  for (const list of Object.values(byKey)) for (const o of list) if (o.point != null && Number.isInteger(o.point)) o.point += 0.5;
  return (PROP_MARKETS[event.sport_key] || []).filter(k => byKey[k]).map(key => ({ key, title: TITLES[key] || key, outcomes: byKey[key] }));
}

// ---------- the bookie's own props ----------

function customView(p) {
  return {
    id: p.id, eventId: p.event_id, sportKey: p.sport_key, sportTitle: p.sport_title, homeTeam: p.home_team, awayTeam: p.away_team,
    commenceTime: p.commence_time, question: p.question, options: JSON.parse(p.options), status: p.status, result: p.result,
    createdAt: p.created_at,
  };
}

// Open props for one game, or the stand-alone specials when eventId is null.
function openCustom(eventId) {
  const rows = eventId
    ? db.prepare("SELECT * FROM custom_props WHERE event_id = ? AND status = 'open' AND commence_time > ? ORDER BY id").all(eventId, new Date().toISOString())
    : db.prepare("SELECT * FROM custom_props WHERE sport_key = 'specials' AND status = 'open' AND commence_time > ? ORDER BY commence_time, id").all(new Date().toISOString());
  return rows.map(customView);
}

function eventsWithCustom() {
  return new Set(db.prepare("SELECT DISTINCT event_id FROM custom_props WHERE status = 'open' AND commence_time > ?")
    .all(new Date().toISOString()).map(r => r.event_id));
}

function hasSpecials() {
  return openCustom(null).length > 0;
}

// Everything a client sees when they open a game's props.
async function forEvent(sportKey, eventId) {
  const feed = await feedProps(sportKey, eventId);
  return {
    source: feed ? feed.source : null,
    fetchedAt: feed ? feed.fetchedAt : null,
    bookmaker: feed ? feed.bookmaker : null,
    markets: feed ? feed.markets : [],
    custom: openCustom(eventId),
  };
}

// Check a prop pick against current prices.
// Returns { gone: message } | { changed: {...} } | { removed: true } | { leg }.
async function resolveLeg(l) {
  if (l.market === 'custom') {
    const row = db.prepare('SELECT * FROM custom_props WHERE id = ?').get(Number(l.propId));
    if (!row || row.event_id !== l.eventId || row.status !== 'open') return { gone: 'That prop is no longer available.' };
    if (Date.parse(row.commence_time) <= Date.now()) return { gone: `${row.question} is closed.` };
    const opt = JSON.parse(row.options).find(o => o.name === l.selection);
    if (!opt) return { removed: true };
    if (Number(opt.price) !== Number(l.price)) return { changed: { price: opt.price, point: null } };
    return {
      leg: {
        event: { id: row.event_id, sport_key: row.sport_key, sport_title: row.sport_title, home_team: row.home_team, away_team: row.away_team, commence_time: row.commence_time },
        market: 'custom', selection: opt.name, point: null, price: opt.price, description: null, propName: row.question, propId: row.id,
      },
    };
  }
  const event = (await odds.getEvents(l.sportKey)).events.find(e => e.id === l.eventId);
  if (!event) return { gone: 'One of your games is no longer available.' };
  if (Date.parse(event.commence_time) <= Date.now()) return { gone: `${event.away_team} @ ${event.home_team} has already started.` };
  const feed = await feedProps(l.sportKey, l.eventId);
  const mk = feed && feed.markets.find(m => m.key === l.market);
  const out = mk && mk.outcomes.find(o => o.name === l.selection && (o.description ?? null) === (l.description ?? null)
    && (o.point == null ? l.point == null : Number(o.point) === Number(l.point)));
  if (!out) return { removed: true };
  if (Number(out.price) !== Number(l.price)) return { changed: { price: out.price, point: out.point } };
  return { leg: { event, market: l.market, selection: out.name, point: out.point, price: out.price, description: out.description, propName: mk.title, propId: null } };
}

module.exports = { isProp, PROP_MARKETS, feedPropsOn, forEvent, openCustom, eventsWithCustom, hasSpecials, customView, resolveLeg, _demoMarkets: demoMarkets };
