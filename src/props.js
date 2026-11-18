'use strict';
// Props: player and game props from The Odds API (fetched one game at a time, only when
// someone opens that game, so the bookie's request quota isn't spent on games nobody looks at),
// generated demo props when there's no API key, and props the bookie writes by hand.
// The scores feed has no player stats, so every prop is graded by the bookie.
const { db, getSetting, intSetting } = require('./db');
const odds = require('./odds');

const MAIN_MARKETS = ['h2h', 'spreads', 'totals'];
// Alternate lines come from the same per-game feed as props, but grade from the final score
// like the main spread and total.
const ALT_MARKETS = ['alternate_spreads', 'alternate_totals'];
const BASE_MARKET = { alternate_spreads: 'spreads', alternate_totals: 'totals' };
const baseMarket = market => BASE_MARKET[market] || market;
const isAlt = market => ALT_MARKETS.includes(market);
const isProp = market => !MAIN_MARKETS.includes(market) && !isAlt(market);
// Anything priced from the per-game feed (props and alternate lines) rather than the main board.
const isFeedMarket = market => !MAIN_MARKETS.includes(market);

// Markets asked for per league. Each market the feed returns costs one request.
const PROP_MARKETS = {
  americanfootball_nfl: [...ALT_MARKETS, 'player_pass_yds', 'player_pass_tds', 'player_rush_yds', 'player_reception_yds', 'player_receptions', 'player_anytime_td', 'player_1st_td', 'team_totals'],
  americanfootball_ncaaf: [...ALT_MARKETS, 'player_pass_yds', 'player_rush_yds', 'player_reception_yds', 'player_anytime_td', 'player_1st_td', 'team_totals'],
  basketball_nba: [...ALT_MARKETS, 'player_points', 'player_rebounds', 'player_assists', 'player_threes', 'player_points_rebounds_assists', 'team_totals'],
  basketball_ncaab: [...ALT_MARKETS],
  basketball_wncaab: [...ALT_MARKETS],
  baseball_mlb: ['batter_hits', 'batter_home_runs', 'batter_total_bases', 'batter_rbis', 'pitcher_strikeouts', 'team_totals'],
  icehockey_nhl: ['player_points', 'player_goals', 'player_assists', 'player_shots_on_goal', 'player_goal_scorer_anytime', 'team_totals'],
};

const TITLES = {
  alternate_spreads: 'Alt Spreads', alternate_totals: 'Alt Totals',
  team_totals: 'Team Total',
  player_pass_yds: 'Passing Yards', player_pass_tds: 'Passing TDs', player_rush_yds: 'Rushing Yards',
  player_reception_yds: 'Receiving Yards', player_receptions: 'Receptions', player_anytime_td: 'Anytime TD',
  player_1st_td: 'First TD',
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
  // A copy fetched before the market list changed (e.g. First TD was added) is refetched right away.
  const asked = PROP_MARKETS[sportKey].join(',');
  if (cached && cached.asked === asked && Date.now() - cached.fetchedAt < ttl) return cached;
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
      const data = { ...normalize(raw), asked: PROP_MARKETS[sportKey].join(',') };
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
    ['RB', 'player_1st_td'], ['WR', 'player_1st_td'], ['TE', 'player_1st_td'],
  ],
  americanfootball_ncaaf: [
    ['QB', 'player_pass_yds', 235.5, 50], ['RB', 'player_rush_yds', 74.5, 25], ['WR', 'player_reception_yds', 58.5, 20],
    ['RB', 'player_anytime_td'], ['WR', 'player_anytime_td'], ['RB', 'player_1st_td'], ['WR', 'player_1st_td'],
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
  if ((PROP_MARKETS[event.sport_key] || []).includes('alternate_spreads')) demoAltLines(event, add);
  if (total) for (const team of [event.away_team, event.home_team]) ou('team_totals', team, Math.round(total) / 2);
  for (const [pos, key, line, swing] of DEMO[event.sport_key] || []) {
    for (const team of [event.away_team, event.home_team]) {
      const description = `${nick(team)} ${pos}`;
      // First TD is a long shot (+500 to +1200); anytime TD is around +100 to +400.
      if (key === 'player_1st_td') add(key, { name: 'Yes', description, price: 500 + Math.round(r() * 14) * 50, point: null });
      else if (line === undefined) add(key, { name: 'Yes', description, price: 100 + Math.round(r() * 30) * 10, point: null });
      else ou(key, description, swing ? Math.floor(line + (r() - 0.5) * swing) + 0.5 : line);
    }
  }
  // Keep every prop line on a half point so there are no pushes in the demo (alt lines follow the main line).
  for (const [k, list] of Object.entries(byKey)) if (!isAlt(k)) for (const o of list) if (o.point != null && Number.isInteger(o.point)) o.point += 0.5;
  return (PROP_MARKETS[event.sport_key] || []).filter(k => byKey[k]).map(key => ({ key, title: TITLES[key] || key, outcomes: byKey[key] }));
}

// Alternate spreads and totals around the main line, priced about 2.5% of win chance per point
// for football (1.5% for basketball, where points are cheaper), with the usual -110 vig.
function demoAltLines(event, add) {
  const football = event.sport_key.startsWith('americanfootball_');
  const perPoint = football ? 0.025 : 0.015;
  const steps = football ? [-7, -6, -4, -3, -2, -1, 1, 2, 3, 4, 6, 7] : [-10, -8, -6, -4, -2, 2, 4, 6, 8, 10];
  const price = prob => {
    const p = Math.min(0.93, Math.max(0.07, prob)) + 0.024;
    const a = p >= 0.5 ? -100 * p / (1 - p) : 100 * (1 - p) / p;
    return Math.round(a / 5) * 5;
  };
  const home = (event.markets.spreads || []).find(o => o.name === event.home_team);
  if (home) {
    for (const d of steps) {
      const hp = Number(home.point) + d;
      if (hp === 0) continue;
      add('alternate_spreads', { name: event.away_team, description: null, price: price(0.5 - perPoint * d), point: -hp });
      add('alternate_spreads', { name: event.home_team, description: null, price: price(0.5 + perPoint * d), point: hp });
    }
  }
  const over = (event.markets.totals || []).find(o => o.name === 'Over');
  if (over) {
    for (const d of steps) {
      const t = Number(over.point) + d * (football ? 1 : 2);
      add('alternate_totals', { name: 'Over', description: null, price: price(0.5 - perPoint * d), point: t });
      add('alternate_totals', { name: 'Under', description: null, price: price(0.5 + perPoint * d), point: t });
    }
  }
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
  return { leg: { event, market: l.market, selection: out.name, point: out.point, price: out.price, description: isAlt(l.market) ? null : out.description, propName: mk.title, propId: null } };
}

module.exports = { isProp, isAlt, isFeedMarket, baseMarket, ALT_MARKETS, PROP_MARKETS, feedPropsOn, forEvent, openCustom, eventsWithCustom, hasSpecials, customView, resolveLeg, _demoMarkets: demoMarkets };
