'use strict';

// Admin commands. Run inside the container, for example:
//   docker compose exec app mx-admin list
//   docker compose exec app mx-admin add N7375Y 4821 --model PA-30 --engines 2 --ad-79-12-08
//   docker compose exec app mx-admin add N12345 5150 --model C172 --engines 1 --no-vor
//   docker compose exec app mx-admin set N7375Y --vor off
//   docker compose exec app mx-admin set-pin N7375Y 9930
//   docker compose exec app mx-admin remove N12345

const db = require('./db');
const { hashPin, validPin, pinInUse } = require('./auth');

const USAGE = `Commands:
  list
  add <tail> <pin> [--model <model>] [--engines 1|2] [--ad-79-12-08] [--no-vor]
  set <tail> [--model <model>] [--engines 1|2] [--ad-79-12-08 on|off] [--vor on|off]
  set-pin <tail> <new-pin>
  remove <tail>

Defaults for a new aircraft: 1 engine, VOR log on, AD 79-12-08 log off.
PINs are 4 to 8 digits, and each aircraft needs its own.`;

function fail(msg) { console.error(msg); process.exit(1); }

// Running as root would leave database files the app can't write to.
if (process.getuid && process.getuid() === 0) {
  fail('Run admin commands with mx-admin, for example: docker compose exec app mx-admin list');
}

// Split positional arguments from --flags. A flag takes the next word as its
// value unless that word is another flag or the flag is a bare switch.
const SWITCHES = new Set(['no-vor']);
function parse(argv) {
  const pos = [], flags = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (!t.startsWith('--')) { pos.push(t); continue; }
    const k = t.slice(2);
    const next = argv[i + 1];
    if (SWITCHES.has(k) || next == null || next.startsWith('--')) flags[k] = true;
    else { flags[k] = next; i++; }
  }
  return { pos, flags };
}

function onOff(v, name) {
  if (v === true || v === 'on' || v === 'true' || v === 'yes') return 1;
  if (v === 'off' || v === 'false' || v === 'no') return 0;
  fail(`--${name} takes on or off.`);
}
function engines(v) {
  const n = Number(v);
  if (![1, 2].includes(n)) fail('--engines must be 1 or 2.');
  return n;
}

const { pos, flags } = parse(process.argv.slice(2));
const [cmd, tailArg, pin] = pos;
const tail = tailArg && tailArg.toUpperCase();
const get = (t) => db.prepare('SELECT * FROM aircraft WHERE tail = ?').get(t);

function describe(a) {
  const logs = ['oil', a.track_ad_79_12_08 && 'AD 79-12-08', a.track_vor && 'VOR'].filter(Boolean).join(', ');
  return `${a.tail.padEnd(8)} ${(a.model || '').padEnd(10)} ${a.engines === 2 ? 'twin  ' : 'single'}  logs: ${logs}`;
}

switch (cmd) {
  case 'list': {
    const rows = db.prepare('SELECT * FROM aircraft ORDER BY tail').all();
    if (!rows.length) console.log('No aircraft yet.\n\n' + USAGE);
    rows.forEach((a) => console.log(describe(a)));
    break;
  }

  case 'add': {
    if (!tail || !pin) fail('Usage: add <tail> <pin> [--model <model>] [--engines 1|2] [--ad-79-12-08] [--no-vor]');
    if (!validPin(pin)) fail('PIN must be 4 to 8 digits.');
    if (get(tail)) fail(`${tail} already exists. Use set or set-pin to change it.`);
    if (pinInUse(pin)) fail('That PIN is already used by another aircraft. Each aircraft needs its own PIN.');
    const { salt, hash } = hashPin(pin);
    db.prepare(`INSERT INTO aircraft (tail, model, engines, track_ad_79_12_08, track_vor, pin_salt, pin_hash)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      tail,
      typeof flags.model === 'string' ? flags.model : null,
      flags.engines ? engines(flags.engines) : 1,
      flags['ad-79-12-08'] ? onOff(flags['ad-79-12-08'], 'ad-79-12-08') : 0,
      flags['no-vor'] ? 0 : 1,
      salt, hash,
    );
    console.log('Added ' + describe(get(tail)));
    break;
  }

  case 'set': {
    if (!tail) fail('Usage: set <tail> [--model <model>] [--engines 1|2] [--ad-79-12-08 on|off] [--vor on|off]');
    const a = get(tail);
    if (!a) fail(`No aircraft ${tail}.`);
    const changes = {};
    if (flags.model !== undefined) changes.model = flags.model === true ? null : flags.model;
    if (flags.engines !== undefined) {
      changes.engines = engines(flags.engines);
      if (changes.engines === 1) {
        const n = db.prepare('SELECT COUNT(*) AS n FROM oil_entries WHERE aircraft_id = ? AND (e2_reading IS NOT NULL OR e2_added IS NOT NULL)').get(a.id).n;
        if (n) fail(`${tail} has ${n} oil entries with right-engine data. Export the oil log before making it a single.`);
      }
    }
    if (flags['ad-79-12-08'] !== undefined) changes.track_ad_79_12_08 = onOff(flags['ad-79-12-08'], 'ad-79-12-08');
    if (flags.vor !== undefined) changes.track_vor = onOff(flags.vor, 'vor');
    if (flags['no-vor']) changes.track_vor = 0;
    const keys = Object.keys(changes);
    if (!keys.length) fail('Nothing to change. ' + USAGE.split('\n')[3].trim());
    db.prepare(`UPDATE aircraft SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => changes[k]), a.id);
    console.log('Updated ' + describe(get(tail)));
    console.log('Turning a log off hides it; entries already logged are kept.');
    break;
  }

  case 'set-pin': {
    if (!tail || !pin) fail('Usage: set-pin <tail> <new-pin>');
    const a = get(tail);
    if (!a) fail(`No aircraft ${tail}.`);
    if (!validPin(pin)) fail('PIN must be 4 to 8 digits.');
    if (pinInUse(pin, a.id)) fail('That PIN is already used by another aircraft.');
    const { salt, hash } = hashPin(pin);
    db.prepare('UPDATE aircraft SET pin_salt = ?, pin_hash = ? WHERE id = ?').run(salt, hash, a.id);
    console.log(`PIN changed for ${tail}. Everyone signed in to it will need the new PIN.`);
    break;
  }

  case 'remove': {
    if (!tail) fail('Usage: remove <tail>');
    const a = get(tail);
    if (!a) fail(`No aircraft ${tail}.`);
    const n = ['oil_entries', 'ad_checks', 'vor_checks']
      .reduce((s, t) => s + db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE aircraft_id = ?`).get(a.id).n, 0);
    if (n > 0) fail(`${tail} has ${n} log entries. Aircraft with records can't be removed; use set to turn logs off instead.`);
    db.prepare('DELETE FROM aircraft WHERE id = ?').run(a.id);
    console.log(`Removed ${tail}.`);
    break;
  }

  default:
    console.log(USAGE);
}
