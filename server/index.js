import express from 'express';
import ExcelJS from 'exceljs';
import path from 'node:path';
import fs from 'node:fs';
import { db } from './db.js';
import { daily } from './report.js';

const app = express();
app.use(express.json());
const today = () => new Date().toISOString().slice(0, 10);
const D = q => q.date || today();

app.get('/api/masters', (_, res) => res.json({
  units: db.prepare('SELECT code, name, sort FROM units WHERE active=1 ORDER BY sort').all(),
  counts: db.prepare('SELECT code FROM counts WHERE active=1 ORDER BY sort').all().map(c => c.code),
  parties: db.prepare('SELECT name FROM parties WHERE active=1 ORDER BY name').all().map(p => p.name),
  brands: db.prepare('SELECT name FROM brands WHERE active=1 ORDER BY name').all().map(b => b.name),
  ranges: db.prepare('SELECT name FROM ranges WHERE active=1 ORDER BY name').all().map(r => r.name),
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
  ranges: db.prepare(`SELECT name, active, 0 used FROM ranges ORDER BY name`).all(),
}));
app.post('/api/parties', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Party name required' });
  db.prepare('INSERT OR IGNORE INTO parties (name) VALUES (?)').run(name);
  res.json({ ok: true });
});

// Rename / activate / deactivate master items (Master tab)
const TABLES = { units: ['units', 'code'], counts: ['counts', 'code'], parties: ['parties', 'name'], brands: ['brands', 'name'], ranges: ['ranges', 'name'] };
app.patch('/api/masters/:kind/:key', (req, res) => {
  const [table, keyCol] = TABLES[req.params.kind] || [];
  if (!table) return res.status(404).json({ error: 'Unknown master' });
  const key = req.params.key;
  const { active, name } = req.body;
  if (active !== undefined) db.prepare(`UPDATE ${table} SET active=? WHERE ${keyCol}=?`).run(active ? 1 : 0, key);
  if (name !== undefined) {
    const v = name.trim();
    if (!v) return res.status(400).json({ error: 'Name required' });
    if (table === 'units') db.prepare('UPDATE units SET name=? WHERE code=?').run(v, key);
    else {
      // count code / party name is the key used in saved entries, so rename it everywhere
      if (v !== key && db.prepare(`SELECT 1 FROM ${table} WHERE ${keyCol}=?`).get(v)) return res.status(409).json({ error: `${v} already exists` });
      db.exec('BEGIN');
      try {
        db.prepare(`UPDATE ${table} SET ${keyCol}=? WHERE ${keyCol}=?`).run(v, key);
        if (table === 'counts') { db.prepare('UPDATE single_cone SET count=? WHERE count=?').run(v, key); db.prepare('UPDATE winding SET count=? WHERE count=?').run(v, key); }
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
app.post('/api/brands', (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Brand name required' });
  db.prepare('INSERT OR IGNORE INTO brands (name) VALUES (?)').run(name);
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
// Running bale stock up to a date: received, issued and balance per unit and quality
app.get('/api/bale-stock', (req, res) => {
  const date = D(req.query);
  const rows = db.prepare(`SELECT unit, quality,
      SUM(CASE WHEN type='IN' THEN bales ELSE 0 END) rec, SUM(CASE WHEN type='MIX' THEN bales ELSE 0 END) iss
    FROM bale_moves WHERE date <= ? GROUP BY unit, quality`).all(date);
  const units = db.prepare('SELECT code, name FROM units WHERE active=1 ORDER BY sort').all();
  res.json(units.map(u => {
    const g = q => rows.find(r => r.unit === u.code && r.quality === q) || { rec: 0, iss: 0 };
    return { unit: u.code, name: u.name, q1: { rec: g(1).rec, iss: g(1).iss }, q2: { rec: g(2).rec, iss: g(2).iss } };
  }));
});
app.post('/api/bales', (req, res) => {
  const b = req.body;
  if (!['IN', 'MIX'].includes(b.type) || ![1, 2].includes(+b.quality) || !(+b.bales > 0))
    return res.status(400).json({ error: 'type, quality (1/2) and bales > 0 required' });
  db.prepare('INSERT INTO bale_moves (date,type,unit,quality,bales,weight_kg,note) VALUES (?,?,?,?,?,?,?)')
    .run(b.date || today(), b.type, b.unit, +b.quality, +b.bales, +b.weight_kg || 0, b.note || '');
  res.json({ ok: true });
});
app.put('/api/bales/:id', (req, res) => {
  const b = req.body;
  if (!['IN', 'MIX'].includes(b.type) || ![1, 2].includes(+b.quality) || !(+b.bales > 0))
    return res.status(400).json({ error: 'type, quality (1/2) and bales > 0 required' });
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
  db.exec('BEGIN');
  try {
    cells.forEach(c => up.run(date, c.unit, c.count, +c.bags || 0, +c.loose_cones || 0, c.bags_expr || '', c.cones_expr || ''));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
  res.json({ ok: true });
});
app.get('/api/single-cone', (req, res) => res.json({
  cells: db.prepare('SELECT * FROM single_cone WHERE date=?').all(D(req.query)) }));

// Chippam / cone bags grid: cells = [{brand,count,qty}]
const KINDS = ['chippam', 'conebags'];
app.get('/api/brand-stock/:kind', (req, res) => {
  if (!KINDS.includes(req.params.kind)) return res.status(404).json({ error: 'Unknown sheet' });
  const k = req.params.kind;
  res.json({
    rows: db.prepare('SELECT label FROM sheet_rows WHERE kind=? ORDER BY sort').all(k).map(r => r.label),
    cols: db.prepare('SELECT brand FROM sheet_cols WHERE kind=? ORDER BY sort').all(k).map(c => c.brand),
    cells: db.prepare('SELECT brand, count, qty FROM brand_stock WHERE kind=? AND date=?').all(k, D(req.query)),
  });
});
// layout of a sheet: add / remove a row (count range) or a brand column
app.post('/api/brand-stock/:kind/rows', (req, res) => {
  const label = (req.body.label || '').trim();
  if (!KINDS.includes(req.params.kind) || !label) return res.status(400).json({ error: 'Row name required' });
  const next = db.prepare('SELECT COALESCE(MAX(sort),-1)+1 n FROM sheet_rows WHERE kind=?').get(req.params.kind).n;
  db.prepare('INSERT OR IGNORE INTO ranges (name) VALUES (?)').run(label);
  db.prepare('UPDATE ranges SET active=1 WHERE name=?').run(label);
  db.prepare('INSERT OR IGNORE INTO sheet_rows VALUES (?,?,?)').run(req.params.kind, label, next);
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
  db.prepare('INSERT OR IGNORE INTO sheet_cols VALUES (?,?,?)').run(req.params.kind, name, next);
  res.json({ ok: true });
});
app.delete('/api/brand-stock/:kind/cols/:brand', (req, res) => {
  db.prepare('DELETE FROM sheet_cols WHERE kind=? AND brand=?').run(req.params.kind, req.params.brand);
  res.json({ ok: true });
});
app.put('/api/brand-stock/:kind', (req, res) => {
  if (!KINDS.includes(req.params.kind)) return res.status(404).json({ error: 'Unknown sheet' });
  const { date, cells } = req.body;
  const up = db.prepare(`INSERT INTO brand_stock VALUES (?,?,?,?,?)
    ON CONFLICT(kind,date,brand,count) DO UPDATE SET qty=excluded.qty`);
  db.exec('BEGIN');
  try {
    cells.forEach(c => up.run(req.params.kind, date, c.brand, c.count, +c.qty || 0));
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
app.delete('/api/winding/:id', (req, res) => {
  db.prepare('DELETE FROM winding WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

app.get('/api/report', (req, res) => res.json(daily(D(req.query))));

app.get('/api/report.xlsx', async (req, res) => {
  const r = daily(D(req.query));
  const wb = new ExcelJS.Workbook();

  let ws = wb.addWorksheet('Bale Stock');
  ws.addRow([`Bale stock as on ${r.date}`]).font = { bold: true };
  ws.addRow(['Unit', '1st Qty bales', '1st Qty kg', '2nd Qty bales', '2nd Qty kg', 'Total bales', 'Total kg']).font = { bold: true };
  const flat = b => [b.q1.bales, b.q1.weight_kg, b.q2.bales, b.q2.weight_kg, b.bales, b.weight_kg];
  r.bales.forEach(b => ws.addRow([b.unit, ...flat(b)]));
  ws.addRow(['TOTAL', ...[0, 1, 2, 3, 4, 5].map(i => r.bales.reduce((s, b) => s + flat(b)[i], 0))]).font = { bold: true };
  ws.addRow([]);
  ws.addRow(['Mixing today']).font = { bold: true };
  ws.addRow(['Unit', 'Quality', 'Bales', 'Kg']).font = { bold: true };
  r.mixing.forEach(m => ws.addRow([m.unit, m.quality, m.bales, m.weight_kg]));

  const sc = r.singleCone;
  ws = wb.addWorksheet('Single Cone');
  ws.addRow([`Single cone stock ${r.date} (bags; ${sc.conesPerBag} loose cones = 1 bag)`]).font = { bold: true };
  ws.addRow(['Count', ...sc.units.map(u => u.name), 'Total bags', 'Loose cones left']).font = { bold: true };
  sc.rows.forEach(x => ws.addRow([x.count, ...sc.units.map(u => x.perUnit[u.code].total), x.total, x.looseLeft]));
  ws.addRow(['TOTAL', ...sc.units.map(u => sc.unitTotals[u.code]), sc.grand]).font = { bold: true };

  ws = wb.addWorksheet('Cone Winding');
  ws.addRow([`Cone winding ${r.date}`]).font = { bold: true };
  ws.addRow(['Party', 'Count', 'Weight kg', 'Note']).font = { bold: true };
  r.winding.rows.forEach(x => ws.addRow([x.party, x.count, x.weight_kg, x.note]));
  ws.addRow(['TOTAL', '', r.winding.total]).font = { bold: true };

  wb.worksheets.forEach(s => s.columns.forEach(c => { c.width = 18; }));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="stock-${r.date}.xlsx"`);
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
