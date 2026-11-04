import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';

fs.mkdirSync('data', { recursive: true });
export const db = new DatabaseSync('data/inventory.db');

// Cones per bag: sheet 4 shows 320 loose cones counted as 8 bags (and 40 -> 1).
export const CONES_PER_BAG = 40;

db.exec(`
CREATE TABLE IF NOT EXISTS units   (code TEXT PRIMARY KEY, name TEXT, sort INTEGER, has_bales INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS counts  (code TEXT PRIMARY KEY, sort INTEGER);
CREATE TABLE IF NOT EXISTS parties (name TEXT PRIMARY KEY);
-- bale ledger: IN = bales received, MIX = bales issued to mixing
CREATE TABLE IF NOT EXISTS bale_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, type TEXT NOT NULL CHECK(type IN ('IN','MIX')),
  unit TEXT NOT NULL, quality INTEGER NOT NULL CHECK(quality IN (1,2)),
  bales INTEGER NOT NULL, weight_kg REAL DEFAULT 0, note TEXT DEFAULT '');
-- daily single cone stock snapshot, one row per date/unit/count (mirrors paper sheet 4)
CREATE TABLE IF NOT EXISTS single_cone (
  date TEXT NOT NULL, unit TEXT NOT NULL, count TEXT NOT NULL,
  bags INTEGER DEFAULT 0, loose_cones INTEGER DEFAULT 0, PRIMARY KEY(date, unit, count));
-- count x brand stock sheets (kind = chippam | conebags)
CREATE TABLE IF NOT EXISTS brand_stock (
  kind TEXT NOT NULL, date TEXT NOT NULL, brand TEXT NOT NULL, count TEXT NOT NULL,
  qty INTEGER DEFAULT 0, PRIMARY KEY(kind, date, brand, count));
-- each sheet has its own row labels (count ranges) and brand columns
CREATE TABLE IF NOT EXISTS sheet_rows (kind TEXT NOT NULL, label TEXT NOT NULL, sort INTEGER NOT NULL, PRIMARY KEY(kind, label));
CREATE TABLE IF NOT EXISTS sheet_cols (kind TEXT NOT NULL, brand TEXT NOT NULL, sort INTEGER NOT NULL, PRIMARY KEY(kind, brand));
-- count ranges (e.g. 3/56 - 3/62): row choices for the Chippam / Cone Bags sheets
CREATE TABLE IF NOT EXISTS ranges  (name TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS brands (name TEXT PRIMARY KEY, active INTEGER NOT NULL DEFAULT 1);
-- cone winding done by outside parties
CREATE TABLE IF NOT EXISTS winding (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, party TEXT NOT NULL,
  count TEXT NOT NULL, weight_kg REAL NOT NULL, note TEXT DEFAULT '');
`);

// soft-delete flag for master data (Master tab: Deactivate / Activate)
for (const t of ['units', 'counts', 'parties'])
  if (!db.prepare(`PRAGMA table_info(${t})`).all().some(c => c.name === 'active'))
    db.exec(`ALTER TABLE ${t} ADD COLUMN active INTEGER NOT NULL DEFAULT 1`);

if (!db.prepare('SELECT COUNT(*) n FROM units').get().n) {
  const u = db.prepare('INSERT INTO units (code,name,sort,has_bales) VALUES (?,?,?,?)');
  [['A', 'A Unit', 1, 1], ['S', 'S Unit', 2, 1], ['D', 'D Unit', 3, 1], ['K', 'K Unit', 4, 0], ['MALINI', 'Malini', 5, 0]]
    .forEach(r => u.run(...r));
  const c = db.prepare('INSERT INTO counts (code,sort) VALUES (?,?)');
  ['36S', '41S', '45S', '54S', '56S', '60S', '62S'].forEach((x, i) => c.run(x, i));
  const p = db.prepare('INSERT INTO parties (name) VALUES (?)');
  ['Chinnasamy', 'J P Tex', 'Ellaimari Amman', 'Ponkali Amman', 'Suganthi', 'S K Tex'].forEach(x => p.run(x));
}

// First run: lay out the Chippam / Cone Bags sheets like the paper closing-stock sheet
const SHEETS = {
  chippam: { rows: ['3/56 - 3/62', '3/54 - 3/61', '3/45 - 3/56', '2/41 - 2/43', '2/36 - 2/40'], cols: ['Madurai', 'Plain'] },
  conebags: { rows: ['2/60 - 2/63', '2/41 - 2/43', '3/56 - 3/62', '3/45 - 3/56', '3/54', '2/50'], cols: ['Madurai', 'Plain', 'Secondz'] },
};
for (const [kind, s] of Object.entries(SHEETS)) {
  if (db.prepare('SELECT COUNT(*) n FROM sheet_rows WHERE kind=?').get(kind).n) continue;
  s.rows.forEach((l, i) => db.prepare('INSERT INTO sheet_rows VALUES (?,?,?)').run(kind, l, i));
  s.cols.forEach((b, i) => {
    db.prepare('INSERT OR IGNORE INTO brands (name) VALUES (?)').run(b);
    db.prepare('INSERT INTO sheet_cols VALUES (?,?,?)').run(kind, b, i);
  });
}

// one-time: offer the rows already on the sheets as count ranges in Master
if (!db.prepare('SELECT COUNT(*) n FROM ranges').get().n)
  db.exec('INSERT OR IGNORE INTO ranges (name) SELECT DISTINCT label FROM sheet_rows');
