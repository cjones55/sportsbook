'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

// Load .env if present (no dependency needed).
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch { /* no .env */ }

const { db, tx, getSetting, setSetting, intSetting, DEFAULT_SETTINGS } = require('./src/db');
const auth = require('./src/auth');
const odds = require('./src/odds');
const bets = require('./src/bets');
const { UserError } = bets;

const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

// ---------- helpers ----------

function send(res, status, data, headers = {}) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > 100_000) { reject(new UserError('Request too large', 413)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new UserError('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const cents = v => {
  const n = Math.round(Number(v) * 100);
  if (!Number.isFinite(n)) throw new UserError('Enter a valid amount.');
  return n;
};

function publicUser(u) {
  return {
    id: u.id, username: u.username, displayName: u.display_name, role: u.role, status: u.status,
    balanceCents: u.balance_cents, maxBetCents: u.max_bet_cents, notes: u.role === 'admin' ? undefined : u.notes,
    createdAt: u.created_at, lastLoginAt: u.last_login_at,
  };
}
function adminUserView(u) { return { ...publicUser(u), notes: u.notes }; }

function bookInfo() {
  return {
    name: getSetting('book_name'),
    bettingOpen: getSetting('betting_open') === '1',
    signupEnabled: getSetting('signup_enabled') === '1',
    minBetCents: intSetting('min_bet_cents'),
    maxBetCents: intSetting('max_bet_cents'),
    maxPayoutCents: intSetting('max_payout_cents'),
    maxParlayLegs: intSetting('max_parlay_legs'),
    demoOdds: !odds.isLive(),
  };
}

// ---------- routes ----------

const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = [];
  const re = new RegExp('^' + pattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, handler, auth: opts.auth ?? 'user' });
}

// Public
route('GET', '/api/book', { auth: 'none' }, () => bookInfo());

route('POST', '/api/login', { auth: 'none' }, async (req, res, { body }) => {
  const username = String(body.username || '').trim();
  const key = `${req.socket.remoteAddress}|${username.toLowerCase()}`;
  if (auth.loginBlocked(key)) throw new UserError('Too many attempts. Try again in 15 minutes.', 429);
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!u || !auth.verifyPassword(String(body.password || ''), u.pass_hash)) {
    auth.recordFailure(key);
    throw new UserError('Wrong username or password.', 401);
  }
  if (u.status !== 'active') throw new UserError('This account is suspended. Contact your bookie.', 403);
  auth.clearFailures(key);
  const s = auth.createSession(u.id);
  res.setHeader('Set-Cookie', auth.sessionCookie(req, s.token, s.expires));
  return { user: publicUser(u) };
});

route('POST', '/api/signup', { auth: 'none' }, async (req, res, { body }) => {
  if (getSetting('signup_enabled') !== '1') throw new UserError('Sign up is closed. Ask your bookie for an account.', 403);
  const code = getSetting('signup_code');
  if (code && String(body.code || '').trim() !== code) throw new UserError('That invite code is not right.', 403);
  const username = String(body.username || '').trim();
  if (!auth.validUsername(username)) throw new UserError('Username must be 3 to 32 letters, numbers, dots, dashes or underscores.');
  if (!auth.validPassword(body.password)) throw new UserError('Password must be at least 6 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new UserError('That username is taken.', 409);
  const start = intSetting('signup_starting_credit_cents');
  const u = tx(() => {
    const { lastInsertRowid: id } = db.prepare('INSERT INTO users(username, display_name, pass_hash) VALUES(?, ?, ?)')
      .run(username, String(body.displayName || username).slice(0, 60), auth.hashPassword(body.password));
    if (start > 0) bets.applyTransaction(Number(id), start, 'deposit', { note: 'Starting credit' });
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  });
  const s = auth.createSession(u.id);
  res.setHeader('Set-Cookie', auth.sessionCookie(req, s.token, s.expires));
  return { user: publicUser(u) };
});

route('POST', '/api/logout', { auth: 'none' }, (req, res, { user }) => {
  if (user) auth.destroySession(user.session_token);
  res.setHeader('Set-Cookie', auth.sessionCookie(req, '', 0));
  return { ok: true };
});

// Signed-in users
route('GET', '/api/me', ({}, _res, { user }) => ({ user: publicUser(user), book: bookInfo() }));

route('POST', '/api/me/password', (req, res, { user, body }) => {
  if (!auth.verifyPassword(String(body.current || ''), user.pass_hash)) throw new UserError('Current password is wrong.', 400);
  if (!auth.validPassword(body.next)) throw new UserError('New password must be at least 6 characters.');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(body.next), user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, user.session_token);
  return { ok: true };
});

route('GET', '/api/sports', async () => ({ sports: await odds.boardSports() }));

route('GET', '/api/odds/:sport', async (req, res, { params }) => {
  const r = await odds.getEvents(params.sport);
  const events = r.events.filter(e => Date.parse(e.commence_time) > Date.now())
    .sort((a, b) => a.commence_time.localeCompare(b.commence_time));
  return { fetchedAt: r.fetchedAt, source: r.source, events };
});

route('POST', '/api/bets', async (req, res, { user, body }) => {
  if (user.role !== 'client') throw new UserError('Admin accounts cannot place bets. Log in as a client.', 403);
  const bet = await bets.placeBet(user, body);
  const balance = db.prepare('SELECT balance_cents FROM users WHERE id = ?').get(user.id).balance_cents;
  return { bet, balanceCents: balance };
});

route('GET', '/api/bets', (req, res, { user, query }) => ({
  bets: bets.listBets({ userId: user.id, status: query.get('status') || undefined, limit: 200 }),
}));

route('GET', '/api/transactions', (req, res, { user }) => ({
  transactions: db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 200').all(user.id),
}));

// ---------- admin ----------

route('GET', '/api/admin/summary', { auth: 'admin' }, () => ({
  summary: bets.summary(), odds: odds.status(), book: bookInfo(),
}));

route('GET', '/api/admin/exposure', { auth: 'admin' }, () => ({ exposure: bets.exposure() }));

route('GET', '/api/admin/users', { auth: 'admin' }, () => ({
  users: db.prepare(`SELECT u.*,
      (SELECT COUNT(*) FROM bets b WHERE b.user_id = u.id AND b.status = 'pending') open_bets,
      (SELECT COALESCE(SUM(stake_cents),0) FROM bets b WHERE b.user_id = u.id AND b.status = 'pending') open_stake,
      (SELECT COALESCE(SUM(stake_cents - payout_cents),0) FROM bets b WHERE b.user_id = u.id AND b.status != 'pending') book_profit
    FROM users u ORDER BY u.role, u.username COLLATE NOCASE`).all()
    .map(u => ({ ...adminUserView(u), openBets: u.open_bets, openStakeCents: u.open_stake, bookProfitCents: u.book_profit })),
}));

route('POST', '/api/admin/users', { auth: 'admin' }, (req, res, { user, body }) => {
  const username = String(body.username || '').trim();
  if (!auth.validUsername(username)) throw new UserError('Username must be 3 to 32 letters, numbers, dots, dashes or underscores.');
  if (!auth.validPassword(body.password)) throw new UserError('Password must be at least 6 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) throw new UserError('That username is taken.', 409);
  const role = body.role === 'admin' ? 'admin' : 'client';
  const credit = body.credit ? cents(body.credit) : 0;
  const created = tx(() => {
    const { lastInsertRowid: id } = db.prepare('INSERT INTO users(username, display_name, pass_hash, role, max_bet_cents, notes) VALUES(?, ?, ?, ?, ?, ?)')
      .run(username, String(body.displayName || username).slice(0, 60), auth.hashPassword(body.password), role,
        body.maxBet ? cents(body.maxBet) : null, body.notes ? String(body.notes).slice(0, 500) : null);
    if (credit > 0) bets.applyTransaction(Number(id), credit, 'deposit', { note: 'Starting credit', by: user.id });
    return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  });
  return { user: adminUserView(created) };
});

route('GET', '/api/admin/users/:id', { auth: 'admin' }, (req, res, { params }) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!u) throw new UserError('User not found', 404);
  return {
    user: adminUserView(u),
    bets: bets.listBets({ userId: u.id, limit: 100 }),
    transactions: db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT 100').all(u.id),
  };
});

route('PATCH', '/api/admin/users/:id', { auth: 'admin' }, (req, res, { user, params, body }) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!u) throw new UserError('User not found', 404);
  if ('displayName' in body) db.prepare('UPDATE users SET display_name = ? WHERE id = ?').run(String(body.displayName).slice(0, 60), u.id);
  if ('notes' in body) db.prepare('UPDATE users SET notes = ? WHERE id = ?').run(String(body.notes || '').slice(0, 500) || null, u.id);
  if ('maxBet' in body) db.prepare('UPDATE users SET max_bet_cents = ? WHERE id = ?').run(body.maxBet === '' || body.maxBet == null ? null : cents(body.maxBet), u.id);
  if ('status' in body) {
    if (!['active', 'suspended'].includes(body.status)) throw new UserError('Invalid status');
    if (u.id === user.id) throw new UserError('You cannot suspend yourself.');
    db.prepare('UPDATE users SET status = ? WHERE id = ?').run(body.status, u.id);
    if (body.status === 'suspended') auth.destroyUserSessions(u.id);
  }
  if (body.password) {
    if (!auth.validPassword(body.password)) throw new UserError('Password must be at least 6 characters.');
    db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(auth.hashPassword(body.password), u.id);
    if (u.id !== user.id) auth.destroyUserSessions(u.id);
  }
  return { user: adminUserView(db.prepare('SELECT * FROM users WHERE id = ?').get(u.id)) };
});

route('POST', '/api/admin/users/:id/credit', { auth: 'admin' }, (req, res, { user, params, body }) => {
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(params.id);
  if (!u) throw new UserError('User not found', 404);
  const amount = cents(body.amount);
  if (amount === 0) throw new UserError('Amount cannot be zero.');
  const type = ['deposit', 'withdrawal', 'adjustment'].includes(body.type) ? body.type : (amount > 0 ? 'deposit' : 'withdrawal');
  const signed = type === 'withdrawal' ? -Math.abs(amount) : type === 'deposit' ? Math.abs(amount) : amount;
  const after = bets.applyTransaction(u.id, signed, type, { note: body.note ? String(body.note).slice(0, 200) : null, by: user.id });
  return { balanceCents: after };
});

route('GET', '/api/admin/bets', { auth: 'admin' }, (req, res, { query }) => ({
  bets: bets.listBets({
    status: query.get('status') || undefined,
    userId: query.get('user') ? Number(query.get('user')) : undefined,
    limit: Math.min(500, Number(query.get('limit')) || 200),
  }),
}));

route('POST', '/api/admin/bets/:id/settle', { auth: 'admin' }, (req, res, { params, body }) => ({
  bet: bets.settleBet(Number(params.id), body.status),
}));

route('POST', '/api/admin/legs/:id/settle', { auth: 'admin' }, (req, res, { params, body }) => ({
  bet: bets.settleLeg(Number(params.id), body.status, { note: body.note || 'Set by admin' }),
}));

route('POST', '/api/admin/grade', { auth: 'admin' }, async () => bets.autoGrade({ force: true }));

route('GET', '/api/admin/transactions', { auth: 'admin' }, (req, res, { query }) => ({
  transactions: db.prepare(`SELECT t.*, u.username FROM transactions t JOIN users u ON u.id = t.user_id
    ORDER BY t.id DESC LIMIT ?`).all(Math.min(1000, Number(query.get('limit')) || 300)),
}));

const EDITABLE = ['book_name', 'betting_open', 'signup_enabled', 'signup_code', 'signup_starting_credit_cents',
  'min_bet_cents', 'max_bet_cents', 'max_payout_cents', 'max_parlay_legs', 'odds_api_key', 'odds_ttl_minutes',
  'odds_quota_floor', 'bookmakers', 'enabled_sports', 'auto_grade'];

route('GET', '/api/admin/settings', { auth: 'admin' }, async () => {
  const settings = {};
  for (const k of EDITABLE) settings[k] = getSetting(k);
  const key = settings.odds_api_key;
  settings.odds_api_key = key ? `${key.slice(0, 4)}…${key.slice(-4)}` : '';
  const all = await odds.allSports();
  const enabled = getSetting('enabled_sports');
  const enabledList = enabled ? enabled.split(',') : null;
  return {
    settings, odds: odds.status(), envKey: !!process.env.ODDS_API_KEY,
    sports: all.map(s => ({ ...s, enabled: enabledList ? enabledList.includes(s.key) : odds.DEFAULT_GROUPS.includes(s.group) })),
  };
});

route('PATCH', '/api/admin/settings', { auth: 'admin' }, (req, res, { body }) => {
  for (const [k, v] of Object.entries(body)) {
    if (!EDITABLE.includes(k)) continue;
    if (k === 'odds_api_key' && typeof v === 'string' && v.includes('…')) continue; // masked value echoed back
    if (k.endsWith('_cents') || ['max_parlay_legs', 'odds_ttl_minutes', 'odds_quota_floor'].includes(k)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0) throw new UserError(`Invalid value for ${k}`);
      setSetting(k, String(Math.round(n)));
    } else {
      setSetting(k, v == null ? '' : String(v).trim());
    }
    if (k === 'odds_api_key' || k === 'bookmakers') { db.exec('DELETE FROM odds_cache'); odds._resetSportsCache(); }
  }
  return { ok: true };
});

route('POST', '/api/admin/odds/refresh', { auth: 'admin' }, async (req, res, { body }) => {
  const sports = body.sport ? [{ key: body.sport }] : await odds.boardSports();
  let events = 0;
  for (const s of sports) events += (await odds.getEvents(s.key, { force: true })).events.length;
  return { sports: sports.length, events, odds: odds.status() };
});

// ---------- server ----------

async function handleApi(req, res, url) {
  const route = routes.find(r => r.method === req.method && r.re.test(url.pathname));
  if (!route) return send(res, 404, { error: 'Not found' });
  // Mutating requests must come from our own page (custom header can't be sent cross-site without CORS).
  if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'sportsbook') return send(res, 403, { error: 'Forbidden' });
  const user = auth.userFromRequest(req);
  if (route.auth !== 'none' && !user) return send(res, 401, { error: 'Please log in.' });
  if (route.auth === 'admin' && user.role !== 'admin') return send(res, 403, { error: 'Admins only.' });
  const m = url.pathname.match(route.re);
  const params = Object.fromEntries(route.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
  try {
    const body = ['POST', 'PATCH', 'PUT'].includes(req.method) ? await readBody(req) : {};
    const out = await route.handler(req, res, { user, params, body, query: url.searchParams });
    send(res, 200, out ?? { ok: true });
  } catch (err) {
    if (err instanceof UserError) return send(res, err.status, { error: err.message, ...(err.extra || {}) });
    console.error(err);
    send(res, 500, { error: 'Something went wrong.' });
  }
}

function serveStatic(req, res, url) {
  let p = path.normalize(decodeURIComponent(url.pathname)).replace(/^([/\\])+/, '');
  let file = path.join(PUBLIC, p);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(PUBLIC, 'index.html');
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=300',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'same-origin',
    'X-Frame-Options': 'DENY',
  });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/healthz') { res.end('ok'); return; }
  if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
  serveStatic(req, res, url);
});

auth.ensureAdmin();
db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(Date.now());

// Grade finished games every 15 minutes.
const gradeTimer = setInterval(() => {
  bets.autoGrade().then(r => { if (r.graded) console.log(`auto-graded ${r.graded} selections`); })
    .catch(err => console.error('auto-grade failed:', err.message));
}, 15 * 60e3);
gradeTimer.unref();

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  server.listen(port, () => console.log(`${getSetting('book_name')} running on http://localhost:${port} (${odds.isLive() ? 'live odds' : 'demo odds'})`));
}

module.exports = { server };
