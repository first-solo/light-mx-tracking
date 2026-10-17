'use strict';

const path = require('path');
const express = require('express');

if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET.length < 32) {
  console.error('SESSION_SECRET must be set to a random string of at least 32 characters.');
  process.exit(1);
}

const db = require('./db');
const auth = require('./auth');
const { buildAdReport } = require('./report');

const PORT = Number(process.env.PORT || 3000);
const SECURE_COOKIE = process.env.COOKIE_SECURE !== 'false';

// Optional bootstrap so a fresh container comes up with one aircraft.
if (process.env.INIT_TAIL && process.env.INIT_PIN) {
  const count = db.prepare('SELECT COUNT(*) AS n FROM aircraft').get().n;
  if (count === 0) {
    if (!auth.validPin(process.env.INIT_PIN)) {
      console.error('INIT_PIN must be 4 to 8 digits.');
      process.exit(1);
    }
    const { salt, hash } = auth.hashPin(process.env.INIT_PIN);
    const engines = Number(process.env.INIT_ENGINES || 1);
    if (![1, 2].includes(engines)) { console.error('INIT_ENGINES must be 1 or 2.'); process.exit(1); }
    db.prepare(`INSERT INTO aircraft (tail, model, engines, track_ad_79_12_08, track_vor, pin_salt, pin_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(process.env.INIT_TAIL.toUpperCase(), process.env.INIT_MODEL || null, engines,
        process.env.INIT_AD_79_12_08 === 'true' ? 1 : 0, process.env.INIT_VOR === 'false' ? 0 : 1, salt, hash);
    console.log(`Created ${process.env.INIT_TAIL.toUpperCase()} from INIT_TAIL/INIT_PIN.`);
  }
}

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY);
app.use(express.json({ limit: '300kb' })); // room for a signature image
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; frame-ancestors 'none'");
  next();
});
// Browsers check back on every load (a cheap 304 when nothing changed), so an
// update's page and script always arrive together.
app.use(express.static(path.join(__dirname, '..', 'public'), {
  index: 'index.html',
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// ---------- auth ----------

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (!auth.loginAllowed(ip)) return res.status(429).json({ error: 'Too many wrong PINs. Wait 15 minutes and try again.' });
  const pin = String(req.body?.pin ?? '');
  const a = auth.validPin(pin) ? auth.findAircraftByPin(pin) : null;
  if (!a) {
    auth.recordFailure(ip);
    return res.status(401).json({ error: 'That PIN didn’t match an aircraft.' });
  }
  auth.clearFailures(ip);
  auth.setSession(res, a, SECURE_COOKIE && req.secure);
  res.json(profile(a));
});

app.post('/api/logout', (req, res) => {
  auth.clearSession(res);
  res.json({ ok: true });
});

app.get('/api/me', auth.requireAircraft, (req, res) => {
  res.json(profile(req.aircraft));
});

// What the page needs to know about the signed-in aircraft.
function profile(a) {
  const logs = ['oil'];
  if (a.track_ad_79_12_08) logs.push('ad');
  if (a.track_vor) logs.push('vor');
  return { tail: a.tail, model: a.model, engines: a.engines, logs };
}

// ---------- validation ----------

class Bad extends Error {}
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const isTime = (s) => /^([01]\d|2[0-3]):[0-5]\d$/.test(s);

function text(v, label, { required = false, max = 200 } = {}) {
  const s = v == null ? '' : String(v).trim();
  if (required && !s) throw new Bad(`Enter ${label}.`);
  if (s.length > max) throw new Bad(`${label[0].toUpperCase() + label.slice(1)} is too long (max ${max} characters).`);
  return s || null;
}
function number(v, label, { min = -Infinity, max = Infinity } = {}) {
  if (v === '' || v == null) return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Bad(`${label} must be a number between ${min} and ${max}.`);
  return n;
}
function date(v) {
  if (!isDate(String(v || ''))) throw new Bad('Enter a valid date.');
  return v;
}
function oneOf(v, label, options) {
  if (!options.includes(v)) throw new Bad(`Choose ${label}.`);
  return v;
}
// A finger-drawn signature arrives as a PNG data URL. Stored as-is; served back
// only as an image from its own route.
const PNG_PREFIX = 'data:image/png;base64,';
function signature(v) {
  if (typeof v !== 'string' || !v.startsWith(PNG_PREFIX)) throw new Bad('Sign in the signature box.');
  const bytes = Buffer.from(v.slice(PNG_PREFIX.length), 'base64');
  if (bytes.length < 100 || bytes.length > 200 * 1024 || bytes.readUInt32BE(0) !== 0x89504e47) {
    throw new Bad('The signature didn’t come through. Clear it and sign again.');
  }
  return PNG_PREFIX + bytes.toString('base64');
}

// ---------- log definitions ----------

const logs = {
  oil: {
    table: 'oil_entries',
    order: 'date DESC, tach DESC, id DESC',
    columns: ['date', 'tach', 'e1_reading', 'e1_added', 'e2_reading', 'e2_added', 'performed_by', 'note'],
    enabled: () => true,
    parse(b, a) {
      const twin = a.engines === 2;
      const n1 = twin ? 'Left' : 'Engine';
      const r = {
        date: date(b.date),
        tach: number(b.tach, 'Tach', { min: 0, max: 99999 }),
        e1_reading: number(b.e1_reading, `${n1} reading`, { min: 0, max: 20 }),
        e1_added: number(b.e1_added, `${n1} quarts added`, { min: 0, max: 20 }),
        e2_reading: twin ? number(b.e2_reading, 'Right reading', { min: 0, max: 20 }) : null,
        e2_added: twin ? number(b.e2_added, 'Right quarts added', { min: 0, max: 20 }) : null,
        performed_by: text(b.performed_by, 'who added the oil', { required: true, max: 60 }),
        note: text(b.note, 'remarks', { max: 500 }),
      };
      if ([r.e1_reading, r.e1_added, r.e2_reading, r.e2_added].every((v) => v == null)) {
        throw new Bad(twin ? 'Enter a reading or quarts added for at least one engine.' : 'Enter the reading or quarts added.');
      }
      return r;
    },
  },
  ad: {
    table: 'ad_checks',
    order: 'date DESC, time DESC, id DESC',
    columns: ['date', 'time', 'trigger', 'exposed', 'left_result', 'right_result', 'performed_by', 'note'],
    enabled: (a) => !!a.track_ad_79_12_08,
    signed: true,
    parse(b) {
      const exposed = b.exposed === 'yes' || b.exposed === 1 || b.exposed === '1' || b.exposed === true ? 1
        : b.exposed === 'no' || b.exposed === 0 || b.exposed === '0' || b.exposed === false ? 0
        : (() => { throw new Bad('Answer whether the airplane was exposed to below-freezing temperatures.'); })();
      return {
        date: date(b.date),
        time: b.time ? (isTime(b.time) ? b.time : (() => { throw new Bad('Enter the time as HH:MM.'); })()) : null,
        trigger: oneOf(b.trigger, 'whether this is for the first flight or after refueling', ['first_flight', 'after_refuel']),
        exposed,
        left_result: exposed ? oneOf(b.left_result, 'the left valve result', ['clear', 'water_drained']) : null,
        right_result: exposed ? oneOf(b.right_result, 'the right valve result', ['clear', 'water_drained']) : null,
        performed_by: text(b.performed_by, 'who is signing off', { required: true, max: 60 }),
        note: text(b.note, 'remarks', { max: 500 }),
        signature: signature(b.signature),
      };
    },
  },
  vor: {
    table: 'vor_checks',
    order: 'date DESC, id DESC',
    columns: ['date', 'method', 'place', 'vor1', 'vor2', 'performed_by', 'note'],
    enabled: (a) => !!a.track_vor,
    signed: true,
    // vor1/vor2 hold bearing errors (degrees) for VOT, ground and airborne checks,
    // and the indicated bearings from each receiver for a dual-system check.
    parse(b) {
      const method = oneOf(b.method, 'the check method', ['vot', 'ground', 'airborne', 'dual']);
      const range = method === 'dual' ? { min: 0, max: 360 } : { min: -180, max: 180 };
      const label = method === 'dual' ? 'bearing' : 'error';
      const r = {
        date: date(b.date),
        method,
        place: text(b.place, 'where the check was done', { required: true, max: 120 }),
        vor1: number(b.vor1, `VOR 1 ${label}`, range),
        vor2: number(b.vor2, `VOR 2 ${label}`, range),
        performed_by: text(b.performed_by, 'who did the check', { required: true, max: 60 }),
        note: text(b.note, 'remarks', { max: 500 }),
      };
      if (method === 'dual' && (r.vor1 == null || r.vor2 == null)) {
        throw new Bad('A dual-system check needs the indicated bearing from both receivers.');
      }
      if (r.vor1 == null && r.vor2 == null) throw new Bad('Enter the bearing error for at least one receiver.');
      r.signature = signature(b.signature);
      return r;
    },
  },
};

function logFor(req, res) {
  const def = logs[req.params.log];
  if (!def || !def.enabled(req.aircraft)) { res.status(404).json({ error: 'That log isn’t turned on for this aircraft.' }); return null; }
  return def;
}

app.get('/api/:log', auth.requireAircraft, (req, res) => {
  const def = logFor(req, res); if (!def) return;
  const rows = db.prepare(
    `SELECT id, ${def.columns.join(', ')}, created_at${def.signed ? ', signature IS NOT NULL AS signed' : ''} FROM ${def.table}
     WHERE aircraft_id = ? AND deleted_at IS NULL ORDER BY ${def.order} LIMIT 1000`
  ).all(req.aircraft.id);
  res.json(rows);
});

app.post('/api/:log', auth.requireAircraft, (req, res) => {
  const def = logFor(req, res); if (!def) return;
  let rec;
  try { rec = def.parse(req.body || {}, req.aircraft); }
  catch (e) { if (e instanceof Bad) return res.status(400).json({ error: e.message }); throw e; }
  const cols = Object.keys(rec);
  const info = db.prepare(
    `INSERT INTO ${def.table} (aircraft_id, ${cols.join(', ')}) VALUES (?, ${cols.map(() => '?').join(', ')})`
  ).run(req.aircraft.id, ...cols.map((c) => rec[c]));
  res.status(201).json({ id: info.lastInsertRowid });
});

// Entries are soft-deleted so the record of what was logged survives a mistaken tap.
app.delete('/api/:log/:id', auth.requireAircraft, (req, res) => {
  const def = logFor(req, res); if (!def) return;
  const info = db.prepare(
    `UPDATE ${def.table} SET deleted_at = datetime('now') WHERE id = ? AND aircraft_id = ? AND deleted_at IS NULL`
  ).run(Number(req.params.id), req.aircraft.id);
  if (!info.changes) return res.status(404).json({ error: 'That entry no longer exists.' });
  res.json({ ok: true });
});

app.get('/api/:log/export.csv', auth.requireAircraft, (req, res) => {
  const def = logFor(req, res); if (!def) return;
  const rows = db.prepare(
    `SELECT ${def.columns.join(', ')},${def.signed ? " CASE WHEN signature IS NULL THEN 'no' ELSE 'yes' END AS hand_signed," : ''} created_at AS logged_at_utc, deleted_at AS removed_at_utc FROM ${def.table}
     WHERE aircraft_id = ? ORDER BY date ASC, id ASC`
  ).all(req.aircraft.id);
  const head = [...def.columns, ...(def.signed ? ['hand_signed'] : []), 'logged_at_utc', 'removed_at_utc'];
  const cell = (v) => {
    if (v == null) return '';
    let s = String(v);
    if (/^[=+\-@]/.test(s) && typeof v === 'string') s = "'" + s; // keep spreadsheets from running formulas
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [head.join(','), ...rows.map((r) => head.map((h) => cell(r[h])).join(','))].join('\r\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.aircraft.tail}-${req.params.log}-log.csv"`);
  res.send(csv + '\r\n');
});

// Logbook report: every AD 79-12-08 sign-off in a date range, as a PDF.
app.get('/api/ad/report.pdf', auth.requireAircraft, (req, res) => {
  if (!req.aircraft.track_ad_79_12_08) return res.status(404).json({ error: 'That log isn’t turned on for this aircraft.' });
  const { from, to } = req.query;
  if (!isDate(String(from || '')) || !isDate(String(to || ''))) return res.status(400).json({ error: 'Choose a start and end date.' });
  if (from > to) return res.status(400).json({ error: 'The start date is after the end date.' });
  const rows = db.prepare(
    `SELECT date, time, trigger, exposed, left_result, right_result, performed_by, note, signature FROM ad_checks
     WHERE aircraft_id = ? AND deleted_at IS NULL AND date BETWEEN ? AND ?
     ORDER BY date ASC, COALESCE(time, '99:99') ASC, id ASC LIMIT 5000`
  ).all(req.aircraft.id, from, to);
  const removedCount = db.prepare(
    'SELECT COUNT(*) AS n FROM ad_checks WHERE aircraft_id = ? AND deleted_at IS NOT NULL AND date BETWEEN ? AND ?'
  ).get(req.aircraft.id, from, to).n;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${req.aircraft.tail}-AD-79-12-08-${from}-to-${to}.pdf"`);
  res.setHeader('Cache-Control', 'no-store');
  buildAdReport({ aircraft: req.aircraft, from, to, rows, removedCount }, res);
});

app.get('/api/:log/:id/signature.png', auth.requireAircraft, (req, res) => {
  const def = logFor(req, res); if (!def) return;
  const row = def.signed && db.prepare(`SELECT signature FROM ${def.table} WHERE id = ? AND aircraft_id = ?`)
    .get(Number(req.params.id), req.aircraft.id);
  if (!row || !row.signature) return res.status(404).json({ error: 'No signature for that entry.' });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Cache-Control', 'private, max-age=31536000, immutable'); // a signed entry never changes
  res.send(Buffer.from(row.signature.slice(PNG_PREFIX.length), 'base64'));
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server. Try again.' });
});

app.listen(PORT, () => console.log(`Aircraft logs listening on :${PORT}`));
