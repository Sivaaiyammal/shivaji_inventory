import express from 'express';
import ExcelJS from 'exceljs';
import path from 'node:path';
import fs from 'node:fs';
import { db, CONES_PER_BAG } from './db.js';
import { daily, winding } from './report.js';
import { mountAuth } from './auth.js';

const app = express();
app.use(express.json());
mountAuth(app); // /api/login, /api/logout, /api/me and a session check on every other /api route
const today = () => new Date().toISOString().slice(0, 10);
const D = q => q.date || today();

app.get('/api/masters', (_, res) => res.json({
  units: db.prepare('SELECT code, name, sort FROM units WHERE active=1 ORDER BY sort').all(),
  counts: db.prepare('SELECT code FROM counts WHERE active=1 ORDER BY sort').all().map(c => c.code),
  parties: db.prepare('SELECT name FROM parties WHERE active=1 ORDER BY name').all().map(p => p.name),
  brands: db.prepare('SELECT name FROM brands WHERE active=1 ORDER BY name').all().map(b => b.name),
  places: db.prepare('SELECT name, grp "group" FROM places WHERE active=1 ORDER BY name').all(),
  ranges: db.prepare('SELECT name FROM ranges WHERE active=1 ORDER BY name').all().map(r => r.name),
  qualities: db.prepare('SELECT id, name FROM qualities WHERE active=1 ORDER BY sort, id').all(),
  customers: db.prepare('SELECT name, ply FROM customers WHERE active=1 ORDER BY name').all(),
  plies: db.prepare('SELECT name FROM plies WHERE active=1 ORDER BY sort, CAST(name AS REAL)').all().map(p => p.name),
}));
// Everything incl. inactive, with an 'used' flag (saved entries exist) for the Master tab
app.get('/api/masters/all', (_, res) => res.json({
  units: db.prepare(`SELECT code, name, active,
    (EXISTS(SELECT 1 FROM bale_moves b WHERE b.unit=units.code) OR EXISTS(SELECT 1 FROM single_cone s WHERE s.unit=units.code AND (s.bags>0 OR s.loose_cones>0))) used
    FROM units ORDER BY sort`).all(),
  counts: db.prepare(`SELECT code, active,
    (EXISTS(SELECT 1 FROM winding w WHERE w.count=counts.code) OR EXISTS(SELECT 1 FROM single_cone s WHERE s.count=counts.code AND (s.bags>0 OR s.loose_cones>0))) used
    FROM counts ORDER BY sort`).all(),
  parties: db.prepare(`SELECT name, active, EXISTS(SELECT 1 FROM winding w WHERE w.party=parties.name) used FROM parties ORDER BY name`).all(),
  brands: db.prepare(`SELECT name, active, 0 used FROM brands ORDER BY name`).all(),
  places: db.prepare(`SELECT name, grp "group", active, 0 used FROM places ORDER BY name`).all(),
  ranges: db.prepare(`SELECT name, active, 0 used FROM ranges ORDER BY name`).all(),
  qualities: db.prepare(`SELECT id, name, active, (EXISTS(SELECT 1 FROM bale_moves b WHERE b.quality=qualities.id) OR EXISTS(SELECT 1 FROM opening_balances o WHERE o.quality=qualities.id)) used FROM qualities ORDER BY sort, id`).all(),
  customers: db.prepare(`SELECT name, ply, active, EXISTS(SELECT 1 FROM winding w WHERE w.kind='doubling' AND w.party=customers.name) used FROM customers ORDER BY name`).all(),
  plies: db.prepare(`SELECT name, active, EXISTS(SELECT 1 FROM winding w WHERE w.kind='doubling' AND w.note='received' AND w.count LIKE plies.name || '/%') used FROM plies ORDER BY sort, CAST(name AS REAL)`).all(),
}));
app.post('/api/parties', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Party name required' });
  db.prepare('INSERT OR IGNORE INTO parties (name) VALUES (?)').run(name);
  res.json({ ok: true });
});

// Rename / activate / deactivate master items (Master tab)
const TABLES = { units: ['units', 'code'], counts: ['counts', 'code'], parties: ['parties', 'name'], brands: ['brands', 'name'], ranges: ['ranges', 'name'], places: ['places', 'name'], qualities: ['qualities', 'id'], customers: ['customers', 'name'], plies: ['plies', 'name'] };
app.patch('/api/masters/:kind/:key', (req, res) => {
  const [table, keyCol] = TABLES[req.params.kind] || [];
  if (!table) return res.status(404).json({ error: 'Unknown master' });
  const key = req.params.key;
  const { active, name, group, ply } = req.body;
  if (ply !== undefined && table === 'customers') {
    const p = String(ply).trim();
    if (p && !db.prepare('SELECT 1 FROM plies WHERE name=?').get(p)) return res.status(400).json({ error: 'Choose a ply from the Plies list' });
    db.prepare('UPDATE customers SET ply=? WHERE name=?').run(p, key);
  }
  if (group !== undefined && table === 'places') db.prepare('UPDATE places SET grp=? WHERE name=?').run(group, key);
  if (active !== undefined) db.prepare(`UPDATE ${table} SET active=? WHERE ${keyCol}=?`).run(active ? 1 : 0, key);
  if (name !== undefined) {
    const v = name.trim();
    if (!v) return res.status(400).json({ error: 'Name required' });
    if (table === 'units') db.prepare('UPDATE units SET name=? WHERE code=?').run(v, key);
    else if (table === 'customers' || table === 'plies') {
      if (v !== key && db.prepare(`SELECT 1 FROM ${table} WHERE name=?`).get(v)) return res.status(409).json({ error: `${v} already exists` });
      if (table === 'plies' && !(+v > 0 && /^\d+$/.test(v))) return res.status(400).json({ error: 'Ply must be a whole number, e.g. 2' });
      db.exec('BEGIN');
      try {
        db.prepare(`UPDATE ${table} SET name=? WHERE name=?`).run(v, key);
        if (table === 'customers') db.prepare("UPDATE winding SET party=? WHERE party=? AND kind='doubling'").run(v, key);
        else db.prepare("UPDATE winding SET count=? || substr(count, length(?)+1) WHERE kind='doubling' AND note='received' AND count LIKE ? || '/%'").run(v, key, key);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
    }
    else if (table === 'qualities') {
      if (db.prepare('SELECT 1 FROM qualities WHERE name=? AND id<>?').get(v, key)) return res.status(409).json({ error: `${v} already exists` });
      db.prepare('UPDATE qualities SET name=? WHERE id=?').run(v, key);
    }
    else {
      // count code / party name is the key used in saved entries, so rename it everywhere
      if (v !== key && db.prepare(`SELECT 1 FROM ${table} WHERE ${keyCol}=?`).get(v)) return res.status(409).json({ error: `${v} already exists` });
      db.exec('BEGIN');
      try {
        db.prepare(`UPDATE ${table} SET ${keyCol}=? WHERE ${keyCol}=?`).run(v, key);
        if (table === 'counts') { db.prepare('UPDATE single_cone SET count=? WHERE count=?').run(v, key); db.prepare('UPDATE single_cone_places SET count=? WHERE count=?').run(v, key); db.prepare('UPDATE winding SET count=? WHERE count=?').run(v, key); }
        else db.prepare('UPDATE winding SET party=? WHERE party=?').run(v, key);
        db.exec('COMMIT');
      } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
    }
  }
  res.json({ ok: true });
});

// Grid structure: add a count (row) or a unit (column) to the single cone sheet
app.post('/api/counts', (req, res) => {
  const code = (req.body.code || '').trim();
  if (!code) return res.status(400).json({ error: 'Count name required' });
  const next = db.prepare('SELECT COALESCE(MAX(sort),-1)+1 n FROM counts').get().n;
  db.prepare('INSERT OR IGNORE INTO counts (code,sort) VALUES (?,?)').run(code, next);
  res.json({ ok: true });
});
app.post('/api/units', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Unit name required' });
  const code = (req.body.code || name.replace(/\s*unit$/i, '')).trim().toUpperCase();
  const next = db.prepare('SELECT COALESCE(MAX(sort),0)+1 n FROM units').get().n;
  db.prepare('INSERT OR IGNORE INTO units (code,name,sort,has_bales) VALUES (?,?,?,?)').run(code, name, next, 1);
  res.json({ ok: true });
});

// Master data maintenance (Master tab): delete when not in use
const inUse = (res, n, what) => n ? (res.status(409).json({ error: `Cannot delete: ${what} has ${n} saved entries` }), true) : false;
app.delete('/api/units/:code', (req, res) => {
  const c = req.params.code;
  const n = db.prepare('SELECT (SELECT COUNT(*) FROM bale_moves WHERE unit=?) + (SELECT COUNT(*) FROM single_cone WHERE unit=? AND (bags>0 OR loose_cones>0)) n').get(c, c).n;
  if (inUse(res, n, 'this unit')) return;
  db.prepare('DELETE FROM single_cone WHERE unit=?').run(c);
  db.prepare('DELETE FROM units WHERE code=?').run(c);
  res.json({ ok: true });
});
app.delete('/api/counts/:code', (req, res) => {
  const c = req.params.code;
  const n = db.prepare('SELECT (SELECT COUNT(*) FROM winding WHERE count=?) + (SELECT COUNT(*) FROM single_cone WHERE count=? AND (bags>0 OR loose_cones>0)) n').get(c, c).n;
  if (inUse(res, n, 'this count')) return;
  db.prepare('DELETE FROM single_cone WHERE count=?').run(c);
  db.prepare('DELETE FROM counts WHERE code=?').run(c);
  res.json({ ok: true });
});
app.post('/api/qualities', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Quality name required' });
  if (db.prepare('SELECT 1 FROM qualities WHERE name=?').get(name)) return res.status(409).json({ error: name + ' already exists' });
  const next = db.prepare('SELECT COALESCE(MAX(sort),0)+1 n FROM qualities').get().n;
  db.prepare('INSERT INTO qualities (name,sort) VALUES (?,?)').run(name, next);
  res.json({ ok: true });
});
app.delete('/api/qualities/:id', (req, res) => {
  const id = +req.params.id;
  const n = db.prepare('SELECT (SELECT COUNT(*) FROM bale_moves WHERE quality=?) + (SELECT COUNT(*) FROM opening_balances WHERE quality=?) n').get(id, id).n;
  if (inUse(res, n, 'this quality')) return;
  db.prepare('DELETE FROM qualities WHERE id=?').run(id);
  res.json({ ok: true });
});
app.post('/api/customers', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Customer name required' });
  if (db.prepare('SELECT 1 FROM customers WHERE name=?').get(name)) return res.status(409).json({ error: name + ' already exists' });
  const ply = String(req.body.ply ?? '').trim();
  if (ply && !db.prepare('SELECT 1 FROM plies WHERE name=?').get(ply)) return res.status(400).json({ error: 'Choose a ply from the Plies list' });
  db.prepare('INSERT INTO customers (name,ply) VALUES (?,?)').run(name, ply);
  res.json({ ok: true });
});
app.delete('/api/customers/:name', (req, res) => {
  const n = db.prepare("SELECT COUNT(*) n FROM winding WHERE kind='doubling' AND party=?").get(req.params.name).n;
  if (inUse(res, n, 'this customer')) return;
  db.prepare('DELETE FROM customers WHERE name=?').run(req.params.name);
  res.json({ ok: true });
});
app.post('/api/plies', (req, res) => {
  const name = String(req.body.name ?? '').trim();
  if (!/^\d+$/.test(name) || !(+name > 0)) return res.status(400).json({ error: 'Ply must be a whole number, e.g. 2' });
  const v = String(+name);
  if (db.prepare('SELECT 1 FROM plies WHERE name=?').get(v)) return res.status(409).json({ error: v + ' ply already exists' });
  db.prepare('INSERT INTO plies (name,sort) VALUES (?,?)').run(v, +v);
  res.json({ ok: true });
});
app.delete('/api/plies/:name', (req, res) => {
  const n = db.prepare("SELECT COUNT(*) n FROM winding WHERE kind='doubling' AND note='received' AND count LIKE ? || '/%'").get(req.params.name).n;
  if (inUse(res, n, 'this ply')) return;
  db.prepare('DELETE FROM plies WHERE name=?').run(req.params.name);
  res.json({ ok: true });
});
app.post('/api/brands', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Brand name required' });
  db.prepare('INSERT OR IGNORE INTO brands (name) VALUES (?)').run(name);
  res.json({ ok: true });
});
app.post('/api/places', (req, res) => {
  const name = (req.body.name || '').trim(), group = (req.body.group || '').trim();
  if (!name) return res.status(400).json({ error: 'Place name required' });
  if (!db.prepare('SELECT 1 FROM units WHERE code=?').get(group)) return res.status(400).json({ error: 'Choose a group (unit)' });
  if (db.prepare('SELECT 1 FROM places WHERE name=?').get(name)) return res.status(409).json({ error: name + ' already exists' });
  db.prepare('INSERT INTO places (name,grp) VALUES (?,?)').run(name, group);
  res.json({ ok: true });
});
app.delete('/api/places/:name', (req, res) => {
  db.prepare('DELETE FROM places WHERE name=?').run(req.params.name);
  res.json({ ok: true });
});
app.post('/api/ranges', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Count range required' });
  db.prepare('INSERT OR IGNORE INTO ranges (name) VALUES (?)').run(name);
  res.json({ ok: true });
});
app.delete('/api/ranges/:name', (req, res) => {
  db.prepare('DELETE FROM ranges WHERE name=?').run(req.params.name);
  res.json({ ok: true });
});
app.delete('/api/brands/:name', (req, res) => {
  db.prepare('DELETE FROM brands WHERE name=?').run(req.params.name);
  res.json({ ok: true });
});
app.delete('/api/parties/:name', (req, res) => {
  const n = db.prepare('SELECT COUNT(*) n FROM winding WHERE party=?').get(req.params.name).n;
  if (inUse(res, n, 'this party')) return;
  db.prepare('DELETE FROM parties WHERE name=?').run(req.params.name);
  res.json({ ok: true });
});

// Bale ledger (receipts + mixing issues)
app.get('/api/bales', (req, res) => res.json(
  db.prepare('SELECT * FROM bale_moves WHERE date=? ORDER BY id DESC').all(D(req.query))));
// Opening balances (Master tab)
app.get('/api/opening', (_, res) => res.json(db.prepare('SELECT * FROM opening_balances ORDER BY date DESC, id DESC').all()));
const qualityOk = q => !!db.prepare('SELECT 1 FROM qualities WHERE id=?').get(+q);
const openingOk = b => /^\d{4}-\d{2}-\d{2}$/.test(b.date || '') && qualityOk(b.quality) && Number.isInteger(+b.bales) && +b.bales >= 0
  && db.prepare('SELECT 1 FROM units WHERE code=?').get(b.unit);
app.post('/api/opening', (req, res) => {
  const b = req.body;
  if (!openingOk(b)) return res.status(400).json({ error: 'Unit, date, quality (from Master) and bales (0 or more, whole number) required' });
  db.prepare('INSERT INTO opening_balances (date,unit,quality,bales) VALUES (?,?,?,?)').run(b.date, b.unit, +b.quality, +b.bales);
  res.json({ ok: true });
});
app.put('/api/opening/:id', (req, res) => {
  const b = req.body;
  if (!openingOk(b)) return res.status(400).json({ error: 'Unit, date, quality (from Master) and bales (0 or more, whole number) required' });
  db.prepare('UPDATE opening_balances SET date=?, unit=?, quality=?, bales=? WHERE id=?').run(b.date, b.unit, +b.quality, +b.bales, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/opening/:id', (req, res) => {
  db.prepare('DELETE FROM opening_balances WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Daily bale stock per unit and quality. Opening is carried forward: it is the opening balance set in Master
// plus everything received and issued BEFORE the selected date, i.e. the previous day's closing stock.
// Received and issued are that day's entries; closing stock = opening + received - issued.
function baleDaily(date) {
  const before = db.prepare(`SELECT unit, quality, SUM(CASE WHEN type='IN' THEN bales ELSE -bales END) net
    FROM bale_moves WHERE date < ? GROUP BY unit, quality`).all(date);
  const day = db.prepare(`SELECT unit, quality,
      SUM(CASE WHEN type='IN' THEN bales ELSE 0 END) rec, SUM(CASE WHEN type='MIX' THEN bales ELSE 0 END) iss
    FROM bale_moves WHERE date = ? GROUP BY unit, quality`).all(date);
  const opening = db.prepare('SELECT unit, quality, SUM(bales) bales FROM opening_balances WHERE date <= ? GROUP BY unit, quality').all(date);
  const units = db.prepare('SELECT code, name FROM units WHERE active=1 ORDER BY sort').all();
  const pick = (list, u, q, k) => list.find(r => r.unit === u && r.quality === q)?.[k] || 0;
  const qs = db.prepare('SELECT id, name, active FROM qualities ORDER BY sort, id').all();
  const rows = units.map(u => {
    const f = q => ({
      open: pick(opening, u.code, q, 'bales') + pick(before, u.code, q, 'net'),
      rec: pick(day, u.code, q, 'rec'),
      iss: pick(day, u.code, q, 'iss'),
    });
    return { unit: u.code, name: u.name, q: Object.fromEntries(qs.map(x => [x.id, f(x.id)])) };
  });
  // columns: active qualities, plus an inactive one while it still has stock or movement
  const qualities = qs.filter(x => x.active || rows.some(r => r.q[x.id].open || r.q[x.id].rec || r.q[x.id].iss)).map(x => ({ id: x.id, name: x.name }));
  return { qualities, rows };
}
app.get('/api/bale-stock', (req, res) => res.json(baleDaily(D(req.query))));
app.post('/api/bales', (req, res) => {
  const b = req.body;
  if (!['IN', 'MIX'].includes(b.type) || !qualityOk(b.quality) || !(+b.bales > 0))
    return res.status(400).json({ error: 'type, quality (from Master) and bales > 0 required' });
  db.prepare('INSERT INTO bale_moves (date,type,unit,quality,bales,weight_kg,note) VALUES (?,?,?,?,?,?,?)')
    .run(b.date || today(), b.type, b.unit, +b.quality, +b.bales, +b.weight_kg || 0, b.note || '');
  res.json({ ok: true });
});
app.put('/api/bales/:id', (req, res) => {
  const b = req.body;
  if (!['IN', 'MIX'].includes(b.type) || !qualityOk(b.quality) || !(+b.bales > 0))
    return res.status(400).json({ error: 'type, quality (from Master) and bales > 0 required' });
  db.prepare('UPDATE bale_moves SET type=?, unit=?, quality=?, bales=? WHERE id=?').run(b.type, b.unit, +b.quality, +b.bales, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/bales/:id', (req, res) => {
  db.prepare('DELETE FROM bale_moves WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Single cone grid: cells = [{unit,count,bags,loose_cones}]
app.put('/api/single-cone', (req, res) => {
  const { date, cells } = req.body;
  const up = db.prepare(`INSERT INTO single_cone (date,unit,count,bags,loose_cones,bags_expr,cones_expr) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(date,unit,count) DO UPDATE SET bags=excluded.bags, loose_cones=excluded.loose_cones,
      bags_expr=excluded.bags_expr, cones_expr=excluded.cones_expr`);
  const delPlaces = db.prepare('DELETE FROM single_cone_places WHERE date=? AND unit=? AND count=?');
  const addPlace = db.prepare('INSERT INTO single_cone_places (date,unit,count,place,bags,cones) VALUES (?,?,?,?,?,?)');
  db.exec('BEGIN');
  try {
    cells.forEach(c => {
      up.run(date, c.unit, c.count, +c.bags || 0, +c.loose_cones || 0, c.bags_expr || '', c.cones_expr || '');
      // c.places = { placeName: { bags, cones } }; replaces what was saved for this cell
      if (c.places) {
        delPlaces.run(date, c.unit, c.count);
        Object.entries(c.places).forEach(([place, v]) => {
          if ((+v.bags || 0) || (+v.cones || 0)) addPlace.run(date, c.unit, c.count, place, +v.bags || 0, +v.cones || 0);
        });
      }
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
  res.json({ ok: true });
});
app.get('/api/single-cone', (req, res) => res.json({
  cells: db.prepare('SELECT * FROM single_cone WHERE date=?').all(D(req.query)),
  places: db.prepare('SELECT unit, count, place, bags, cones FROM single_cone_places WHERE date=?').all(D(req.query)) }));

// Chippam / cone bags grid: cells = [{brand,count,qty}]
const KINDS = ['chippam', 'conebags'];
app.get('/api/brand-stock/:kind', (req, res) => {
  if (!KINDS.includes(req.params.kind)) return res.status(404).json({ error: 'Unknown sheet' });
  const k = req.params.kind;
  // every active unit always has at least one row on the sheet (more can be added with the + beside the unit)
  db.prepare('SELECT code FROM units WHERE active=1 ORDER BY sort').all().forEach(u => {
    if (db.prepare('SELECT 1 FROM sheet_rows WHERE kind=? AND unit=?').get(k, u.code)) return;
    const next = db.prepare('SELECT COALESCE(MAX(sort),-1)+1 n FROM sheet_rows WHERE kind=?').get(k).n;
    db.prepare('INSERT OR IGNORE INTO sheet_rows (kind,label,sort,unit) VALUES (?,?,?,?)').run(k, `~new~default-${u.code}`, next, u.code);
  });
  res.json({
    rows: db.prepare('SELECT label FROM sheet_rows WHERE kind=? ORDER BY sort').all(k).map(r => r.label),
    actuals: Object.fromEntries(db.prepare('SELECT label, actual FROM sheet_rows WHERE kind=?').all(k).map(r => [r.label, r.actual || ''])),
    cols: db.prepare('SELECT brand FROM sheet_cols WHERE kind=? ORDER BY sort').all(k).map(c => c.brand),
    units: Object.fromEntries(db.prepare('SELECT label, unit FROM sheet_rows WHERE kind=?').all(k).map(r => [r.label, r.unit || ''])),
    cells: db.prepare('SELECT brand, count, qty FROM brand_stock WHERE kind=? AND date=?').all(k, D(req.query)),
    places: db.prepare('SELECT brand, count, place, qty FROM brand_stock_places WHERE kind=? AND date=?').all(k, D(req.query)),
  });
});
// layout of a sheet: add / remove a row (count range) or a brand column
app.post('/api/brand-stock/:kind/rows', (req, res) => {
  const label = (req.body.label || '').trim();
  if (!KINDS.includes(req.params.kind) || !label) return res.status(400).json({ error: 'Row name required' });
  const next = db.prepare('SELECT COALESCE(MAX(sort),-1)+1 n FROM sheet_rows WHERE kind=?').get(req.params.kind).n;
  // a blank row added with the Add button (label ~new~...) is not a count range yet
  if (!label.startsWith('~new~')) {
    db.prepare('INSERT OR IGNORE INTO ranges (name) VALUES (?)').run(label);
    db.prepare('UPDATE ranges SET active=1 WHERE name=?').run(label);
  }
  db.prepare('INSERT OR IGNORE INTO sheet_rows (kind,label,sort,unit) VALUES (?,?,?,?)').run(req.params.kind, label, next, String(req.body.unit || ''));
  res.json({ ok: true });
});
// change a row's marketing count: renames the row and its saved quantities
app.patch('/api/brand-stock/:kind/rows/:label', (req, res) => {
  const k = req.params.kind, old = req.params.label, label = (req.body.label || '').trim();
  if (!KINDS.includes(k) || !label) return res.status(400).json({ error: 'Count required' });
  if (label !== old && db.prepare('SELECT 1 FROM sheet_rows WHERE kind=? AND label=?').get(k, label))
    return res.status(409).json({ error: label + ' is already on this sheet' });
  db.exec('BEGIN');
  try {
    db.prepare('UPDATE sheet_rows SET label=? WHERE kind=? AND label=?').run(label, k, old);
    db.prepare('UPDATE brand_stock SET count=? WHERE kind=? AND count=?').run(label, k, old);
    db.prepare('UPDATE brand_stock_places SET count=? WHERE kind=? AND count=?').run(label, k, old);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
  res.json({ ok: true });
});
app.delete('/api/brand-stock/:kind/rows/:label', (req, res) => {
  db.prepare('DELETE FROM sheet_rows WHERE kind=? AND label=?').run(req.params.kind, req.params.label);
  res.json({ ok: true });
});
app.post('/api/brand-stock/:kind/cols', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!KINDS.includes(req.params.kind) || !name) return res.status(400).json({ error: 'Brand name required' });
  const next = db.prepare('SELECT COALESCE(MAX(sort),-1)+1 n FROM sheet_cols WHERE kind=?').get(req.params.kind).n;
  db.prepare('INSERT OR IGNORE INTO brands (name) VALUES (?)').run(name);
  db.prepare('UPDATE brands SET active=1 WHERE name=?').run(name);
  db.prepare('INSERT OR IGNORE INTO sheet_cols (kind,brand,sort) VALUES (?,?,?)').run(req.params.kind, name, next);
  res.json({ ok: true });
});
app.delete('/api/brand-stock/:kind/cols/:brand', (req, res) => {
  db.prepare('DELETE FROM sheet_cols WHERE kind=? AND brand=?').run(req.params.kind, req.params.brand);
  res.json({ ok: true });
});
app.put('/api/brand-stock/:kind', (req, res) => {
  if (!KINDS.includes(req.params.kind)) return res.status(404).json({ error: 'Unknown sheet' });
  const { date, cells, actuals, units } = req.body;
  const up = db.prepare(`INSERT INTO brand_stock VALUES (?,?,?,?,?)
    ON CONFLICT(kind,date,brand,count) DO UPDATE SET qty=excluded.qty`);
  db.exec('BEGIN');
  try {
    const delPl = db.prepare('DELETE FROM brand_stock_places WHERE kind=? AND date=? AND brand=? AND count=?');
    const addPl = db.prepare('INSERT INTO brand_stock_places (kind,date,brand,count,place,qty) VALUES (?,?,?,?,?,?)');
    cells.forEach(c => {
      up.run(req.params.kind, date, c.brand, c.count, +c.qty || 0);
      // c.places = { placeName: qty }; replaces what was saved for this cell
      if (c.places) {
        delPl.run(req.params.kind, date, c.brand, c.count);
        Object.entries(c.places).forEach(([place, q]) => { if (+q) addPl.run(req.params.kind, date, c.brand, c.count, place, +q); });
      }
    });
    Object.entries(units || {}).forEach(([label, u]) => db.prepare('UPDATE sheet_rows SET unit=? WHERE kind=? AND label=?').run(String(u), req.params.kind, label));
    Object.entries(actuals || {}).forEach(([label, v]) => db.prepare('UPDATE sheet_rows SET actual=? WHERE kind=? AND label=?').run(String(v).trim(), req.params.kind, label));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
  res.json({ ok: true });
});

// Cone winding
app.post('/api/winding', (req, res) => {
  const w = req.body;
  if (!w.party || !w.count || !(+w.weight_kg > 0)) return res.status(400).json({ error: 'party, count, weight required' });
  db.prepare('INSERT INTO winding (date,party,count,weight_kg,note) VALUES (?,?,?,?,?)')
    .run(w.date || today(), w.party, w.count, +w.weight_kg, w.note || '');
  res.json({ ok: true });
});
// one company's lines for a day (count + bags). Replaces that company's bag entries for the date; older kg entries are left alone.
app.put('/api/winding/day', (req, res) => {
  const { date, party, lines } = req.body || {};
  const kind = req.body?.kind === 'winding' ? 'winding' : 'doubling';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !party || !Array.isArray(lines)) return res.status(400).json({ error: 'date, party and lines required' });
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM winding WHERE date=? AND party=? AND kind=? AND weight_kg=0').run(date, party, kind);
    const seen = new Set();
    const ins = db.prepare("INSERT INTO winding (date,party,count,weight_kg,bags,note,kind) VALUES (?,?,?,0,?,?,?)");
    for (const l of lines) {
      const count = String(l.count || '').trim();
      if (!count || seen.has(count)) continue;
      seen.add(count);
      const given = +l.bags, got = +l.inBags, ply = Number.isInteger(+l.ply) && +l.ply > 0 ? +l.ply : 2;
      // Doubling: given = the count handed over, received = the doubled count (e.g. 2/56S) that comes back
      if (kind === 'doubling') {
        if (given > 0) ins.run(date, party, count, given, 'given', kind);
        if (got > 0) ins.run(date, party, ply + '/' + count, got, 'received', kind);
      } else if (given > 0) ins.run(date, party, count, given, '', kind);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
  res.json({ ok: true });
});
app.delete('/api/winding/:id', (req, res) => {
  db.prepare('DELETE FROM winding WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/report', (req, res) => res.json(daily(D(req.query))));

app.get('/api/report.xlsx', async (req, res) => {
  const date = D(req.query);
  const wb = new ExcelJS.Workbook();
  const bold = r => { r.font = { bold: true }; return r; };
  const head = (ws, title, cols) => { bold(ws.addRow([title])); bold(ws.addRow(cols)); };
  const units = db.prepare('SELECT code, name FROM units WHERE active=1 ORDER BY sort').all();
  const unitName = c => units.find(u => u.code === c)?.name || c;

  // Bale stock: opening / received / issued / stock for each quality
  let ws = wb.addWorksheet('Bale Stock');
  const bale = baleDaily(date);
  const q = x => [x.open, x.rec, x.iss, x.open + x.rec - x.iss];
  const line = r => [...bale.qualities.flatMap(x => q(r.q[x.id])), bale.qualities.reduce((t, x) => t + q(r.q[x.id])[3], 0)];
  head(ws, `Bale stock as on ${date}`, ['Unit', ...bale.qualities.flatMap(x => [`${x.name} Opening`, `${x.name} Received`, `${x.name} Issued`, `${x.name} Stock`]), 'Total Stock']);
  bale.rows.forEach(b => ws.addRow([b.name, ...line(b)]));
  const tot = bale.rows.map(line);
  bold(ws.addRow(['TOTAL', ...Array.from({ length: bale.qualities.length * 4 + 1 }, (_, k) => tot.reduce((s, r) => s + r[k], 0))]));

  // Single cone: one line per unit / count / place
  ws = wb.addWorksheet('Single Cone');
  head(ws, `Single cone stock ${date} (${CONES_PER_BAG} loose cones = 1 bag)`, ['Unit', 'Count', 'Place', 'Bags', 'Loose cones', 'Total bags']);
  const cells = db.prepare('SELECT * FROM single_cone WHERE date=?').all(date);
  const plc = db.prepare('SELECT unit, count, place, bags, cones FROM single_cone_places WHERE date=?').all(date);
  let sb = 0, sc = 0;
  const counts = db.prepare('SELECT code FROM counts WHERE active=1 ORDER BY sort').all().map(c => c.code);
  for (const u of units) for (const c of counts) {
    const p = plc.filter(r => r.unit === u.code && r.count === c && (r.bags || r.cones));
    const lines = p.length ? p.map(r => [r.place, r.bags, r.cones]) : cells.filter(r => r.unit === u.code && r.count === c && (r.bags || r.loose_cones)).map(r => ['', r.bags, r.loose_cones]);
    lines.forEach(([pl, b, n]) => { ws.addRow([u.name, c, pl, b, n, b + Math.floor(n / CONES_PER_BAG)]); sb += b; sc += n; });
  }
  bold(ws.addRow(['TOTAL', '', '', sb, sc, sb + Math.floor(sc / CONES_PER_BAG)]));
  if (sc % CONES_PER_BAG) ws.addRow([`Loose cones left after converting: ${sc % CONES_PER_BAG}`]);

  // Chippam and Cone Bags: unit, actual count, marketing count, brand, quantity
  for (const [kind, name] of [['chippam', 'Chippam'], ['conebags', 'Cone Bags']]) {
    ws = wb.addWorksheet(name);
    head(ws, `${name} ${date}`, ['Unit', 'Actual count', 'Marking', 'Brand', 'Qty']);
    const meta = Object.fromEntries(db.prepare('SELECT label, actual, unit FROM sheet_rows WHERE kind=?').all(kind).map(r => [r.label, r]));
    let total = 0;
    db.prepare('SELECT brand, count, qty FROM brand_stock WHERE kind=? AND date=? AND qty<>0').all(kind, date)
      .filter(r => meta[r.count] && !r.count.startsWith('~new~'))
      .sort((a, b) => unitName(meta[a.count].unit).localeCompare(unitName(meta[b.count].unit)))
      .forEach(r => { ws.addRow([unitName(meta[r.count].unit), meta[r.count].actual || '', r.count, r.brand, r.qty]); total += r.qty; });
    bold(ws.addRow(['TOTAL', '', '', '', total]));
  }

  ws = wb.addWorksheet('Cone Winding');
  head(ws, `Cone winding ${date}`, ['Party', 'Count', 'Weight kg', 'Note']);
  const w = winding(date);
  w.rows.forEach(x => ws.addRow([x.party, x.count, x.weight_kg, x.note]));
  bold(ws.addRow(['TOTAL', '', w.total]));

  ws = wb.addWorksheet('Doubling');
  head(ws, `Doubling ${date}`, ['Company', 'Count given', 'Bags given', 'Count received', 'Bags received']);
  const dbl = winding(date, 'doubling');
  const grouped = {};
  for (const x of dbl.rows) {
    const rec = x.note === 'received';
    const base = rec && x.count.includes('/') ? x.count.split('/').slice(1).join('/') : x.count;
    const g = (grouped[x.party + '|' + base] ||= { party: x.party, count: base, given: 0, recCount: '', rec: 0 });
    if (rec) { g.recCount = x.count; g.rec += x.bags; } else g.given += x.bags;
  }
  const list = Object.values(grouped);
  list.forEach(g => ws.addRow([g.party, g.count, g.given, g.recCount, g.rec]));
  bold(ws.addRow(['TOTAL', '', list.reduce((t, g) => t + g.given, 0), '', list.reduce((t, g) => t + g.rec, 0)]));

  // ?sheet=bale|single|chippam|conebags|winding keeps just that sheet
  const names = { bale: 'Bale Stock', single: 'Single Cone', chippam: 'Chippam', conebags: 'Cone Bags', winding: 'Cone Winding', doubling: 'Doubling' };
  const only = names[req.query.sheet];
  // the combined file leaves out Cone Winding and Doubling, like the combined report
  if (only) wb.worksheets.filter(w => w.name !== only).forEach(w => wb.removeWorksheet(w.id));
  else wb.worksheets.filter(w => w.name === 'Cone Winding' || w.name === 'Doubling').forEach(w => wb.removeWorksheet(w.id));
  wb.worksheets.forEach(s => s.columns.forEach(c => { c.width = 16; }));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${only ? only.replace(/ /g, '-').toLowerCase() : 'stock'}-${date}.xlsx"`);
  await wb.xlsx.write(res);
  res.end();
});

const dist = path.resolve('client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.use((_, res) => res.sendFile(path.join(dist, 'index.html')));
}
const port = process.env.PORT || 3006;
app.listen(port, () => console.log(`Shivaji Inventory on http://localhost:${port}`));
