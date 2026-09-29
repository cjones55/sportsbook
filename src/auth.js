'use strict';
const crypto = require('node:crypto');
const { db, getSetting, setSetting } = require('./db');

const SESSION_DAYS = 30;
const COOKIE = 'sb_session';

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const test = crypto.scryptSync(password, salt, 64);
  const want = Buffer.from(hash, 'hex');
  return want.length === test.length && crypto.timingSafeEqual(want, test);
}

function validUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_.-]{3,32}$/.test(u);
}
function validPassword(p) {
  return typeof p === 'string' && p.length >= 6 && p.length <= 200;
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expires = Date.now() + SESSION_DAYS * 86400e3;
  db.prepare('INSERT INTO sessions(token, user_id, expires_at) VALUES(?, ?, ?)').run(token, userId, expires);
  db.prepare("UPDATE users SET last_login_at = datetime('now') WHERE id = ?").run(userId);
  return { token, expires };
}

function destroySession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

function destroyUserSessions(userId) {
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
}

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function userFromRequest(req) {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (!token) return null;
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
    WHERE s.token = ? AND s.expires_at > ?`).get(token, Date.now());
  if (!row || row.status !== 'active') return null;
  row.session_token = token;
  return row;
}

function sessionCookie(req, token, expires) {
  const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted;
  const parts = [`${COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (secure) parts.push('Secure');
  parts.push(expires ? `Expires=${new Date(expires).toUTCString()}` : 'Max-Age=0');
  return parts.join('; ');
}

// Simple in-memory brute force guard: 10 failures per 15 minutes per ip+username.
const failures = new Map();
function loginBlocked(key) {
  const f = failures.get(key);
  if (!f) return false;
  if (Date.now() - f.first > 15 * 60e3) { failures.delete(key); return false; }
  return f.count >= 10;
}
function recordFailure(key) {
  const f = failures.get(key);
  if (!f || Date.now() - f.first > 15 * 60e3) failures.set(key, { first: Date.now(), count: 1 });
  else f.count++;
}
function clearFailures(key) { failures.delete(key); }

function ensureAdmin() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const envPassword = process.env.ADMIN_PASSWORD;
  const existing = db.prepare("SELECT id, username FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get();
  if (existing) {
    // ADMIN_USERNAME / ADMIN_PASSWORD are the way to recover the admin login on a host:
    // when they change, apply them to the admin account once. Changes made in the app stick
    // until the env values change again.
    if (!envPassword) return;
    const marker = crypto.createHash('sha256').update(`${username}\n${envPassword}`).digest('hex');
    if (getSetting('admin_env_applied') === marker) return;
    const taken = db.prepare('SELECT id FROM users WHERE username = ? AND id != ?').get(username, existing.id);
    const newName = taken ? existing.username : username;
    db.prepare('UPDATE users SET username = ?, pass_hash = ?, status = ? WHERE id = ?')
      .run(newName, hashPassword(envPassword), 'active', existing.id);
    setSetting('admin_env_applied', marker);
    console.log(`Admin account "${newName}" password set from ADMIN_PASSWORD.`);
    return;
  }
  let password = envPassword;
  let generated = false;
  if (!password) { password = crypto.randomBytes(9).toString('base64url'); generated = true; }
  db.prepare("INSERT INTO users(username, display_name, pass_hash, role) VALUES(?, ?, ?, 'admin')")
    .run(username, 'Bookie', hashPassword(password));
  if (!generated) setSetting('admin_env_applied', crypto.createHash('sha256').update(`${username}\n${password}`).digest('hex'));
  console.log(`Created admin account "${username}".`);
  if (generated) console.log(`  Generated admin password: ${password}\n  (set ADMIN_PASSWORD to choose your own; change it after first login)`);
}

module.exports = {
  COOKIE, hashPassword, verifyPassword, validUsername, validPassword,
  createSession, destroySession, destroyUserSessions, userFromRequest, sessionCookie,
  loginBlocked, recordFailure, clearFailures, ensureAdmin,
};
