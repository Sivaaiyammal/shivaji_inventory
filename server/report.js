import { db, CONES_PER_BAG } from './db.js';

export function baleStock(date) {
  const rows = db.prepare(`
    SELECT unit, quality,
      SUM(CASE WHEN type='IN' THEN bales ELSE -bales END) bales,
      SUM(CASE WHEN type='IN' THEN weight_kg ELSE -weight_kg END) weight_kg
    FROM bale_moves WHERE date <= ? GROUP BY unit, quality`).all(date);
  const units = db.prepare('SELECT code FROM units WHERE active=1 ORDER BY sort').all().map(u => u.code);
  return units.map(u => {
    const g = q => rows.find(r => r.unit === u && r.quality === q) || { bales: 0, weight_kg: 0 };
    return { unit: u, q1: g(1), q2: g(2), bales: g(1).bales + g(2).bales, weight_kg: g(1).weight_kg + g(2).weight_kg };
  });
}

export function mixing(date) {
  return db.prepare(`SELECT unit, quality, SUM(bales) bales, SUM(weight_kg) weight_kg
    FROM bale_moves WHERE date=? AND type='MIX' GROUP BY unit, quality`).all(date);
}

// Grid of count x unit; per cell bags + loose cones, loose cones converted to bags like the paper sheet.
export function singleCone(date) {
  const units = db.prepare('SELECT code,name FROM units WHERE active=1 ORDER BY sort').all();
  const counts = db.prepare('SELECT code FROM counts WHERE active=1 ORDER BY sort').all().map(c => c.code);
  const cells = db.prepare('SELECT * FROM single_cone WHERE date=?').all(date);
  const rows = counts.map(count => {
    const perUnit = {};
    let total = 0, loose = 0;
    for (const u of units) {
      const c = cells.find(x => x.unit === u.code && x.count === count) || { bags: 0, loose_cones: 0 };
      const conv = Math.floor(c.loose_cones / CONES_PER_BAG);
      perUnit[u.code] = { bags: c.bags, loose: c.loose_cones, total: c.bags + conv };
      total += c.bags + conv;
      loose += c.loose_cones % CONES_PER_BAG;
    }
    return { count, perUnit, total, looseLeft: loose };
  });
  const unitTotals = {};
  for (const u of units) unitTotals[u.code] = rows.reduce((s, r) => s + r.perUnit[u.code].total, 0);
  return { units, rows, unitTotals, grand: rows.reduce((s, r) => s + r.total, 0), conesPerBag: CONES_PER_BAG };
}

export function winding(date) {
  const rows = db.prepare('SELECT * FROM winding WHERE date=? ORDER BY party, count').all(date);
  const byParty = {};
  for (const r of rows) byParty[r.party] = (byParty[r.party] || 0) + r.weight_kg;
  return { rows, byParty, total: rows.reduce((s, r) => s + r.weight_kg, 0) };
}

export const daily = date => ({
  date, bales: baleStock(date), mixing: mixing(date), singleCone: singleCone(date), winding: winding(date),
});
