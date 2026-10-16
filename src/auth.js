'use strict';

const crypto = require('crypto');
const db = require('./db');

const SECRET = process.env.SESSION_SECRET;
const SESSION_DAYS = Number(process.env.SESSION_DAYS || 30);
const COOKIE = 'alog';

function hashPin(pin, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return { salt, hash };
}

function validPin(pin) {
  return /^\d{4,8}$/.test(String(pin));
}

// Returns the aircraft whose PIN matches, or null. Checks every aircraft so
// timing doesn't reveal how many there are or which one matched.
function findAircraftByPin(pin) {
  let match = null;
  for (const a of db.prepare('SELECT * FROM aircraft').all()) {
    const { hash } = hashPin(pin, a.pin_salt);
    if (crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(a.pin_hash, 'hex'))) match = a;
  }
  return match;
}

function pinInUse(pin, exceptId = null) {
  const a = findAircraftByPin(pin);
  return a && a.id !== exceptId;
}

function sign(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(token) {
  if (!token || !token.includes('.')) return null;
  const [body, mac] = token.split('.');
  const expected = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  if (mac.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expected))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function setSession(res, aircraft, secure) {
  // pv ties the session to the current PIN hash: changing a PIN signs everyone out.
  const token = sign({ aid: aircraft.id, pv: aircraft.pin_hash.slice(0, 12), exp: Date.now() + SESSION_DAYS * 864e5 });
  res.setHeader('Set-Cookie',
    `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_DAYS * 86400}${secure ? '; Secure' : ''}`);
}

function clearSession(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

function requireAircraft(req, res, next) {
  const p = verify(readCookie(req, COOKIE));
  const a = p && db.prepare('SELECT * FROM aircraft WHERE id = ?').get(p.aid);
  if (!a || a.pin_hash.slice(0, 12) !== p.pv) return res.status(401).json({ error: 'Enter the PIN to continue.' });
  req.aircraft = a;
  next();
}

// Simple in-memory limiter for PIN attempts: per IP, sliding window.
const attempts = new Map();
const MAX_TRIES = 8;
const WINDOW_MS = 15 * 60 * 1000;

function loginAllowed(ip) {
  const now = Date.now();
  const list = (attempts.get(ip) || []).filter((t) => now - t < WINDOW_MS);
  attempts.set(ip, list);
  return list.length < MAX_TRIES;
}
function recordFailure(ip) {
  const list = attempts.get(ip) || [];
  list.push(Date.now());
  attempts.set(ip, list);
}
function clearFailures(ip) {
  attempts.delete(ip);
}

module.exports = {
  hashPin, validPin, findAircraftByPin, pinInUse,
  setSession, clearSession, requireAircraft,
  loginAllowed, recordFailure, clearFailures,
};
