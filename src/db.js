'use strict';

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'logs.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Each migration runs once, in order. Append new ones; never edit old ones.
const migrations = [
  `
  CREATE TABLE aircraft (
    id         INTEGER PRIMARY KEY,
    tail       TEXT NOT NULL UNIQUE,
    model      TEXT,
    engines    INTEGER NOT NULL DEFAULT 1 CHECK (engines IN (1, 2)),
    track_ad_79_12_08 INTEGER NOT NULL DEFAULT 0,
    track_vor  INTEGER NOT NULL DEFAULT 1,
    pin_salt   TEXT NOT NULL,
    pin_hash   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE oil_entries (
    id            INTEGER PRIMARY KEY,
    aircraft_id   INTEGER NOT NULL REFERENCES aircraft(id),
    date          TEXT NOT NULL,
    tach          REAL,
    e1_reading    REAL,   -- single engine, or left engine on a twin
    e1_added      REAL,
    e2_reading    REAL,   -- right engine on a twin
    e2_added      REAL,
    performed_by  TEXT NOT NULL,
    note          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at    TEXT
  );

  CREATE TABLE ad_checks (
    id            INTEGER PRIMARY KEY,
    aircraft_id   INTEGER NOT NULL REFERENCES aircraft(id),
    date          TEXT NOT NULL,
    time          TEXT,
    trigger       TEXT NOT NULL CHECK (trigger IN ('first_flight', 'after_refuel')),
    left_result   TEXT NOT NULL CHECK (left_result IN ('clear', 'water_drained')),
    right_result  TEXT NOT NULL CHECK (right_result IN ('clear', 'water_drained')),
    performed_by  TEXT NOT NULL,
    note          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at    TEXT
  );

  CREATE TABLE vor_checks (
    id            INTEGER PRIMARY KEY,
    aircraft_id   INTEGER NOT NULL REFERENCES aircraft(id),
    date          TEXT NOT NULL,
    method        TEXT NOT NULL CHECK (method IN ('vot', 'ground', 'airborne', 'dual')),
    place         TEXT NOT NULL,
    vor1          REAL,
    vor2          REAL,
    performed_by  TEXT NOT NULL,
    note          TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    deleted_at    TEXT
  );

  CREATE INDEX oil_by_aircraft ON oil_entries(aircraft_id, date);
  CREATE INDEX ad_by_aircraft  ON ad_checks(aircraft_id, date);
  CREATE INDEX vor_by_aircraft ON vor_checks(aircraft_id, date);
  `,
];

db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
const row = db.prepare('SELECT version FROM schema_version').get();
let version = row ? row.version : 0;
if (!row) db.prepare('INSERT INTO schema_version (version) VALUES (0)').run();

for (let i = version; i < migrations.length; i++) {
  db.transaction(() => {
    db.exec(migrations[i]);
    db.prepare('UPDATE schema_version SET version = ?').run(i + 1);
  })();
}

module.exports = db;
