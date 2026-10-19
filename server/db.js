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
-- cone winding done by outside parties
CREATE TABLE IF NOT EXISTS winding (
  id INTEGER PRIMARY KEY AUTOINCREMENT, date TEXT NOT NULL, party TEXT NOT NULL,
  count TEXT NOT NULL, weight_kg REAL NOT NULL, note TEXT DEFAULT '');
`);

if (!db.prepare('SELECT COUNT(*) n FROM units').get().n) {
  const u = db.prepare('INSERT INTO units VALUES (?,?,?,?)');
  [['A', 'A Unit', 1, 1], ['S', 'S Unit', 2, 1], ['D', 'D Unit', 3, 1], ['K', 'K Unit', 4, 0], ['MALINI', 'Malini', 5, 0]]
    .forEach(r => u.run(...r));
  const c = db.prepare('INSERT INTO counts VALUES (?,?)');
  ['36S', '41S', '45S', '54S', '56S', '60S', '62S'].forEach((x, i) => c.run(x, i));
  const p = db.prepare('INSERT INTO parties VALUES (?)');
  ['Chinnasamy', 'J P Tex', 'Ellaimari Amman', 'Ponkali Amman', 'Suganthi', 'S K Tex'].forEach(x => p.run(x));
}
