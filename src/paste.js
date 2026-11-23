'use strict';
// Turns a list copied from a sportsbook site into the bookie's own props, so a whole game's
// props can be added in one paste instead of one at a time. It reads the usual shapes:
//   Christian McCaffrey <tab> 49ers <tab> -165          one price per player
//   Christian McCaffrey / -165                          name and price on separate lines
//   Player  First TD  Anytime TD  2+ TDs                a header row, then one row per player
//   Vikings +3.5 -120   /   Over 47.5 -110              spreads and totals
//   Justin Jefferson Over 85.5 -115 Under 85.5 -105     player overs and unders
// Section titles such as "Anytime Touchdown Scorer" set the bet type for the lines under them.

// Bet types the bookie can pick, and the words that name each one in a header or section title.
const TYPES = [
  { key: 'anytime_td', label: 'Anytime TD', words: /\b(any\s*time|anytime|atd|atts)\b/i },
  { key: 'first_td', label: 'First TD', words: /\b(first|1st)\b/i },
  { key: 'last_td', label: 'Last TD', words: /\blast\b/i },
  { key: 'two_td', label: '2+ TDs', words: /(\b2\s*\+|\btwo\s*(or|\+)\s*more|\b2\s*or\s*more)/i },
  { key: 'three_td', label: '3+ TDs', words: /(\b3\s*\+|\bthree\s*(or|\+)\s*more|\b3\s*or\s*more)/i },
];
const TYPE_LABEL = Object.fromEntries(TYPES.map(t => [t.key, t.label]));
// A word that makes a line read like a title or header rather than a player.
const HEADER_WORD = /\b(td|tds|touchdowns?|scorer|scorers|player|odds|yes|no)\b/i;
const POSITIONS = new Set(['QB', 'RB', 'WR', 'TE', 'K', 'FB', 'DST', 'D/ST', 'DEF', 'G', 'F', 'C', 'PG', 'SG', 'SF', 'PF', 'P', 'SP', 'RP', 'LW', 'RW', 'D']);
const NOISE = /^(show (more|less)|see (all|more)|more bets|load more|view all|sgp|same game parlay|popular|new|boost(ed)?|live|ending soon|cash ?out|bet ?slip|my bets|\d+\s*(more|markets?))$/i;

const ODDS = /(?<![\w.])([+-]\d{3,5}|even|ev|evs)(?![\w.])/gi;
const TOTAL = /(?<![\w])(over|under|o|u)\s*(\d{1,3}(?:\.\d+)?)(?![\d.])/gi;
const SPREAD = /(?<![\w.])([+-]\d{1,2}(?:\.\d+)?|pk|pick'?em|pick)(?![\w.])/i;

function clean(text) {
  return String(text || '')
    .replace(/\r/g, '')
    .replace(/[−‒–—﹣－]/g, '-') // the many kinds of minus sign
    .replace(/＋/g, '+')
    .replace(/ /g, ' ');
}

const priceOf = s => (/^(even|ev|evs)$/i.test(s) ? 100 : Math.round(Number(s)));
const fmt = p => (p > 0 ? '+' + p : String(p));
const tidy = s => s.replace(/[|()[\]•·:,;]+/g, ' ').replace(/\s+/g, ' ').trim().replace(/^[-+\s]+|[-\s]+$/g, '');

// Which bet types a header or title line names, in the order they appear.
function typesIn(line) {
  const cells = line.split(/\t| {2,}|\|/).map(s => s.trim()).filter(Boolean);
  const found = [];
  for (const cell of cells.length > 1 ? cells : [line]) {
    // "2+ TDs" also contains no "first"; check the specific ones before "anytime".
    const hits = TYPES.map(t => ({ t, i: cell.search(t.words) })).filter(h => h.i >= 0).sort((a, b) => a.i - b.i);
    for (const h of cells.length > 1 ? hits.slice(0, 1) : hits) if (!found.includes(h.t.key)) found.push(h.t.key);
  }
  return found;
}

// Read one line into { name, prices, total, spread }.
function readLine(line, teams) {
  let rest = line;
  const prices = [];
  // Over/Under first, so "o47.5" isn't read as a name.
  const totals = [];
  rest = rest.replace(TOTAL, (m, side, point, off, all) => {
    // Only a real total: "Over 47.5", "O 47.5", "o47.5", not a stray "u" inside a name.
    totals.push({ side: /^o/i.test(side) ? 'Over' : 'Under', point: Number(point), at: off });
    return ' \u0000 ';
  });
  // Prices, kept with where they were so overs and unders get the price that follows them.
  const marks = [];
  let i = 0;
  rest = rest.replace(ODDS, m => { marks.push(priceOf(m)); return ` \u0001${i++} `; });
  for (const p of marks) prices.push(p);
  // If there are totals, pair each with the next price after it.
  const parts = rest.split(/\s+/);
  const totalsOut = [];
  if (totals.length) {
    let ti = 0;
    let pending = null;
    for (const p of parts) {
      if (p === '\u0000') { pending = totals[ti++]; continue; }
      const m = /^\u0001(\d+)$/.exec(p);
      if (m && pending) { totalsOut.push({ ...pending, price: marks[Number(m[1])] }); pending = null; }
    }
  }
  let spread = null;
  if (!totals.length) {
    const m = SPREAD.exec(rest);
    if (m) { spread = /^p/i.test(m[1]) ? 0 : Number(m[1]); rest = rest.replace(SPREAD, ' '); }
  }
  rest = rest.replace(/\u0000|\u0001\d+/g, ' ');
  // Drop team names, positions and stray numbers left from the copied table.
  let cells = rest.split(/\t| {2,}|\|/).map(tidy).filter(Boolean);
  const isTeam = c => teams.some(t => t && (c.toLowerCase() === t.toLowerCase() || c.toLowerCase() === nick(t).toLowerCase()));
  const keep = cells.filter(c => !POSITIONS.has(c.toUpperCase()) && !/^[\d.%$/\s-]+$/.test(c));
  // A spread line's name is the team; a player line drops a team column next to the name.
  // In a table the player comes first; later text columns are the team, position and so on.
  cells = spread !== null || keep.length <= 1 ? keep : keep.filter(c => !isTeam(c)).slice(0, 1);
  let name = tidy(cells.join(' ').split(/\s+/).filter(w => !POSITIONS.has(w.toUpperCase()) || w.length > 2).join(' '));
  if (spread === null && !totalsOut.length && cells.length === 0) name = '';
  return { name, prices: totalsOut.length ? [] : prices, totals: totalsOut, spread };
}

const nick = t => String(t || '').trim().split(/\s+/).slice(-1)[0];

// The team a spread line is about, written the way the board writes it.
function teamFor(name, teams) {
  const n = name.toLowerCase();
  const t = teams.find(x => x && (n === x.toLowerCase() || n.includes(nick(x).toLowerCase()) || x.toLowerCase().includes(n)));
  return t ? nick(t) : name;
}

// text: what was pasted. opts.teams: [away, home]. opts.type: 'auto' or one of TYPES' keys.
// opts.columns: the bet type for each price column, when a row has several prices and the
// bookie has set them ('skip' leaves a column out, 'no' makes it the No side of the column before).
// Returns { items: [{ category, question, options: [{ name, price }] }], skipped: [lines], columns }.
function parse(text, opts = {}) {
  const teams = (opts.teams || []).filter(Boolean);
  const forced = opts.type && opts.type !== 'auto' ? opts.type : null;
  const fallback = opts.fallback || 'anytime_td';
  const lines = clean(text).split('\n').map(l => l.replace(/\s+$/, '')).filter(l => l.trim());

  let section = null; // bet type named by the last title line
  let header = null; // bet types named by a header row, one per price column
  let rec = null; // the player being read when name and prices are on separate lines
  const recs = [];
  const skipped = [];
  const flush = () => { if (rec && (rec.prices.length || rec.totals.length || rec.spread !== null)) recs.push(rec); else if (rec) skipped.push(rec.raw); rec = null; };

  for (const raw of lines) {
    const line = raw.trim();
    if (NOISE.test(line)) continue;
    const r = readLine(raw, teams);
    const hasPrice = r.prices.length || r.totals.length;
    if (!hasPrice) {
      const types = typesIn(line);
      if (types.length && (HEADER_WORD.test(line) || types.length > 1 || line.split(/\s+/).length <= 3)) {
        flush();
        if (types.length > 1) header = types; else { section = types[0]; header = null; }
        continue;
      }
      if (r.spread !== null && r.name) { flush(); rec = { ...r, raw: line, section }; continue; }
      // A spread under its team's name ("Vikings" / "+3.5" / "-110").
      if (r.spread !== null && !r.name && rec && rec.spread === null && !rec.prices.length) { rec.spread = r.spread; continue; }
      if (!r.name || /^(player|name|team|odds)$/i.test(r.name)) continue;
      flush();
      rec = { ...r, raw: line, section, header };
      continue;
    }
    if (!r.name && rec && !rec.prices.length && !rec.totals.length || (!r.name && rec && r.prices.length && !r.totals.length && rec.spread === null && !rec.totals.length)) {
      // Prices under the name they belong to.
      rec.prices.push(...r.prices);
      rec.totals.push(...r.totals);
      if (r.spread !== null && rec.spread === null) rec.spread = r.spread;
      continue;
    }
    flush();
    rec = { ...r, raw: line, section, header };
    flush();
  }
  flush();

  // How many price columns the player rows have, so the bookie can say what each one is.
  const multi = recs.filter(x => x.prices.length > 1 && x.spread === null && !x.totals.length);
  const width = multi.length ? Math.max(...multi.map(x => x.prices.length)) : 0;
  const hdr = multi.find(x => x.header) && multi.find(x => x.header).header;
  let columns = null;
  if (width) {
    const defaults = hdr ? hdr : width === 2 ? ['anytime_td', 'no'] : ['first_td', 'anytime_td', 'two_td', 'three_td'];
    columns = Array.from({ length: width }, (_, i) => (opts.columns && opts.columns[i]) || defaults[i] || 'skip');
  }

  const items = [];
  const label = key => TYPE_LABEL[key] || key;
  const typeFor = x => forced || x.section || fallback;

  for (let n = 0; n < recs.length; n++) {
    const x = recs[n];
    if (x.totals.length) {
      // Overs and unders on one line, or on lines next to each other, are one prop.
      const who = x.name || 'Game';
      const byPoint = new Map();
      for (const t of x.totals) {
        if (!byPoint.has(t.point)) byPoint.set(t.point, []);
        byPoint.get(t.point).push(t);
      }
      for (const [point, sides] of byPoint) {
        const question = x.name ? `${x.name} ${point}` : `Total ${point}`;
        const prev = items.find(it => it.question === question && it.kind === 'total');
        const opts2 = sides.map(s => ({ name: `${s.side} ${point}`, price: s.price }));
        if (prev) { for (const o of opts2) if (!prev.options.some(p => p.name === o.name)) prev.options.push(o); continue; }
        items.push({ kind: 'total', category: forced ? label(forced) : x.name ? 'Player Props' : 'Totals', question, options: opts2, who });
      }
      continue;
    }
    if (x.spread !== null) {
      if (!x.prices.length || !x.name) { skipped.push(x.raw); continue; }
      const team = teamFor(x.name, teams);
      const line = `${team} ${x.spread === 0 ? 'PK' : fmt(x.spread)}`;
      // The other side of the same line, right after it, joins it as one prop.
      const y = recs[n + 1];
      if (y && y.spread !== null && y.prices.length && y.name && Math.abs(y.spread) === Math.abs(x.spread) && (y.spread === -x.spread || x.spread === 0)) {
        const team2 = teamFor(y.name, teams);
        if (team2 !== team) {
          const line2 = `${team2} ${y.spread === 0 ? 'PK' : fmt(y.spread)}`;
          items.push({ kind: 'spread', category: forced ? label(forced) : 'Spreads', question: `${line} / ${line2}`, options: [{ name: line, price: x.prices[0] }, { name: line2, price: y.prices[0] }] });
          n++;
          continue;
        }
      }
      items.push({ kind: 'spread', category: forced ? label(forced) : 'Spreads', question: line, options: [{ name: 'Yes', price: x.prices[0] }] });
      continue;
    }
    if (!x.name || /^no\b/i.test(x.name) && /(td|touchdown|scorer)/i.test(x.name)) { skipped.push(x.raw); continue; }
    // A bet type written next to the name ("Sam Darnold Anytime TD +1200").
    const inline = x.prices.length === 1 && typesIn(x.name);
    if (inline && inline.length === 1) {
      const t = forced || inline[0];
      const words = TYPES.find(y => y.key === inline[0]).words;
      const name = tidy(x.name.replace(words, ' ').replace(/\b(td|tds|touchdowns?|scorers?|goal\s*scorer)\b/gi, ' '));
      if (name) { items.push({ kind: 'yes', category: label(t), question: `${name} ${label(t)}`, options: [{ name: 'Yes', price: x.prices[0] }] }); continue; }
    }
    if (x.prices.length === 1 || !columns) {
      const t = typeFor(x);
      items.push({ kind: 'yes', category: label(t), question: `${x.name} ${label(t)}`, options: [{ name: 'Yes', price: x.prices[0] }] });
      continue;
    }
    // Several prices on one row: one prop per column.
    let last = null;
    x.prices.forEach((price, i) => {
      const col = columns[i] || 'skip';
      if (col === 'skip') return;
      if (col === 'no') { if (last && last.options.length === 1) last.options.push({ name: 'No', price }); return; }
      last = { kind: 'yes', category: label(col), question: `${x.name} ${label(col)}`, options: [{ name: 'Yes', price }] };
      items.push(last);
    });
  }

  // Drop prices that can't be real odds, and exact repeats (the same thing pasted twice).
  const seen = new Set();
  const out = [];
  for (const it of items) {
    it.options = it.options.filter(o => Number.isFinite(o.price) && Math.abs(o.price) >= 100);
    if (!it.options.length) continue;
    const key = it.question.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ category: it.category, question: it.question.slice(0, 200), options: it.options });
  }
  return { items: out, skipped: [...new Set(skipped)].slice(0, 50), columns };
}

module.exports = { parse, TYPES };
