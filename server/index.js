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
  units: db.prepare('SELECT * FROM units ORDER BY sort').all(),
  counts: db.prepare('SELECT code FROM counts ORDER BY sort').all().map(c => c.code),
  parties: db.prepare('SELECT name FROM parties ORDER BY name').all().map(p => p.name),
}));
app.post('/api/parties', (req, res) => {
  db.prepare('INSERT OR IGNORE INTO parties VALUES (?)').run(req.body.name.trim());
  res.json({ ok: true });
});

// Bale ledger (receipts + mixing issues)
app.get('/api/bales', (req, res) => res.json(
  db.prepare('SELECT * FROM bale_moves WHERE date=? ORDER BY id DESC').all(D(req.query))));
app.post('/api/bales', (req, res) => {
  const b = req.body;
  if (!['IN', 'MIX'].includes(b.type) || ![1, 2].includes(+b.quality) || !(+b.bales > 0))
    return res.status(400).json({ error: 'type, quality (1/2) and bales > 0 required' });
  db.prepare('INSERT INTO bale_moves (date,type,unit,quality,bales,weight_kg,note) VALUES (?,?,?,?,?,?,?)')
    .run(b.date || today(), b.type, b.unit, +b.quality, +b.bales, +b.weight_kg || 0, b.note || '');
  res.json({ ok: true });
});
app.delete('/api/bales/:id', (req, res) => {
  db.prepare('DELETE FROM bale_moves WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// Single cone grid: cells = [{unit,count,bags,loose_cones}]
app.put('/api/single-cone', (req, res) => {
  const { date, cells } = req.body;
  const up = db.prepare(`INSERT INTO single_cone VALUES (?,?,?,?,?)
    ON CONFLICT(date,unit,count) DO UPDATE SET bags=excluded.bags, loose_cones=excluded.loose_cones`);
  db.exec('BEGIN');
  try {
    cells.forEach(c => up.run(date, c.unit, c.count, +c.bags || 0, +c.loose_cones || 0));
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return res.status(500).json({ error: e.message }); }
  res.json({ ok: true });
});
app.get('/api/single-cone', (req, res) => res.json({
  cells: db.prepare('SELECT * FROM single_cone WHERE date=?').all(D(req.query)) }));

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
const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Shivaji Inventory on http://localhost:${port}`));
