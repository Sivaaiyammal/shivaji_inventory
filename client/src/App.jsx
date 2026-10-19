import React, { useCallback, useEffect, useState } from 'react';

const api = async (url, opts) => {
  const r = await fetch(url, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
};
const iso = () => new Date().toISOString().slice(0, 10);
const num = v => (v === '' || v == null ? 0 : +v);
const fmt = n => (Math.round(n * 100) / 100).toLocaleString('en-IN');

export default function App() {
  const [tab, setTab] = useState('bales');
  const [date, setDate] = useState(iso());
  const [masters, setMasters] = useState(null);
  useEffect(() => { api('/api/masters').then(setMasters); }, []);
  const tabs = [['bales', 'Bale Stock'], ['single', 'Single Cone'], ['winding', 'Cone Winding'], ['report', 'Report / Print']];
  return (
    <>
      <header>
        <h1>Shivaji Inventory</h1>
        <nav>{tabs.map(([k, l]) => <button key={k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}</nav>
        <span className="spacer" />
        <label>Date <input type="date" value={date} onChange={e => setDate(e.target.value)} /></label>
      </header>
      <main>
        {!masters ? 'Loading…' : tab === 'bales' ? <Bales date={date} masters={masters} />
          : tab === 'single' ? <Single date={date} masters={masters} />
          : tab === 'winding' ? <Winding date={date} masters={masters} setMasters={setMasters} />
          : <Report date={date} />}
      </main>
    </>
  );
}

function Bales({ date, masters }) {
  const baleUnits = masters.units.filter(u => u.has_bales);
  const blank = { type: 'IN', unit: baleUnits[0].code, quality: 1, bales: '', weight_kg: '', note: '' };
  const [f, setF] = useState(blank);
  const [moves, setMoves] = useState([]);
  const [stock, setStock] = useState([]);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api(`/api/bales?date=${date}`).then(setMoves);
    api(`/api/report?date=${date}`).then(r => setStock(r.bales));
  }, [date]);
  useEffect(load, [load]);
  const save = async e => {
    e.preventDefault(); setErr('');
    try { await api('/api/bales', { method: 'POST', body: { ...f, date } }); setF({ ...f, bales: '', weight_kg: '', note: '' }); load(); }
    catch (x) { setErr(x.message); }
  };
  const del = async id => { await api(`/api/bales/${id}`, { method: 'DELETE' }); load(); };
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <div className="card">
        <h2>Bale received / issued to mixing</h2>
        <form className="form" onSubmit={save}>
          <label>Entry
            <select value={f.type} onChange={set('type')}><option value="IN">Received (load)</option><option value="MIX">Issued to mixing</option></select></label>
          <label>Unit
            <select value={f.unit} onChange={set('unit')}>{baleUnits.map(u => <option key={u.code} value={u.code}>{u.name}</option>)}</select></label>
          <label>Quality
            <select value={f.quality} onChange={set('quality')}><option value={1}>1st</option><option value={2}>2nd</option></select></label>
          <label>Bales<input type="number" min="1" value={f.bales} onChange={set('bales')} required /></label>
          <label>Weight (kg)<input type="number" step="0.01" value={f.weight_kg} onChange={set('weight_kg')} /></label>
          <label>Note<input value={f.note} onChange={set('note')} /></label>
          <button className="btn primary">Add</button>
        </form>
        {err && <div className="err">{err}</div>}
      </div>

      <div className="card">
        <h2>Bale stock as on {date}</h2>
        <BaleTable stock={stock} />
      </div>

      <div className="card">
        <h2>Entries on {date}</h2>
        <table>
          <thead><tr><th>Entry</th><th>Unit</th><th>Quality</th><th>Bales</th><th>Kg</th><th>Note</th><th /></tr></thead>
          <tbody>
            {moves.map(m => (
              <tr key={m.id}><td>{m.type === 'IN' ? 'Received' : 'Mixing'}</td><td>{m.unit}</td><td>{m.quality === 1 ? '1st' : '2nd'}</td>
                <td>{m.bales}</td><td>{fmt(m.weight_kg)}</td><td style={{ textAlign: 'left' }}>{m.note}</td>
                <td><button className="x" onClick={() => del(m.id)}>✕</button></td></tr>
            ))}
            {!moves.length && <tr><td colSpan="7" className="mute">No entries for this date</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function BaleTable({ stock }) {
  const sum = f => stock.reduce((s, b) => s + f(b), 0);
  return (
    <table>
      <thead><tr><th rowSpan="2">Unit</th><th colSpan="2">1st quality</th><th colSpan="2">2nd quality</th><th colSpan="2">Total</th></tr>
        <tr><th>Bales</th><th>Kg</th><th>Bales</th><th>Kg</th><th>Bales</th><th>Kg</th></tr></thead>
      <tbody>{stock.map(b => (
        <tr key={b.unit}><td>{b.unit} Unit</td><td>{b.q1.bales}</td><td>{fmt(b.q1.weight_kg)}</td><td>{b.q2.bales}</td><td>{fmt(b.q2.weight_kg)}</td><td>{b.bales}</td><td>{fmt(b.weight_kg)}</td></tr>
      ))}</tbody>
      <tfoot><tr><td>TOTAL</td><td>{sum(b => b.q1.bales)}</td><td>{fmt(sum(b => b.q1.weight_kg))}</td><td>{sum(b => b.q2.bales)}</td>
        <td>{fmt(sum(b => b.q2.weight_kg))}</td><td>{sum(b => b.bales)}</td><td>{fmt(sum(b => b.weight_kg))}</td></tr></tfoot>
    </table>
  );
}

function Single({ date, masters }) {
  const [cells, setCells] = useState({}); // "unit|count" -> {bags, loose_cones}
  const [msg, setMsg] = useState('');
  const key = (u, c) => `${u}|${c}`;
  useEffect(() => {
    api(`/api/single-cone?date=${date}`).then(({ cells }) => {
      const m = {};
      cells.forEach(c => { m[key(c.unit, c.count)] = { bags: c.bags || '', loose_cones: c.loose_cones || '' }; });
      setCells(m); setMsg('');
    });
  }, [date]);
  const upd = (u, c, field, v) => setCells({ ...cells, [key(u, c)]: { ...cells[key(u, c)], [field]: v } });
  const per = 40;
  const cellTotal = (u, c) => { const x = cells[key(u, c)] || {}; return num(x.bags) + Math.floor(num(x.loose_cones) / per); };
  const save = async () => {
    const list = [];
    masters.units.forEach(u => masters.counts.forEach(c => {
      const x = cells[key(u.code, c)];
      if (x) list.push({ unit: u.code, count: c, bags: num(x.bags), loose_cones: num(x.loose_cones) });
    }));
    await api('/api/single-cone', { method: 'PUT', body: { date, cells: list } });
    setMsg('Saved');
  };
  return (
    <div className="card">
      <h2>Single cone stock — {date}</h2>
      <p className="mute">Enter bags and loose cones per unit. {per} loose cones = 1 bag (counted in totals automatically).</p>
      <table>
        <thead><tr><th>Count</th>{masters.units.map(u => <th key={u.code}>{u.name}<br /><span className="mute">bags / loose</span></th>)}<th>Total bags</th></tr></thead>
        <tbody>
          {masters.counts.map(c => (
            <tr key={c}><td>{c}</td>
              {masters.units.map(u => (
                <td key={u.code}>
                  <input type="number" min="0" placeholder="bags" value={cells[key(u.code, c)]?.bags ?? ''} onChange={e => upd(u.code, c, 'bags', e.target.value)} style={{ width: 62 }} />{' '}
                  <input type="number" min="0" placeholder="cones" value={cells[key(u.code, c)]?.loose_cones ?? ''} onChange={e => upd(u.code, c, 'loose_cones', e.target.value)} style={{ width: 62 }} />
                </td>
              ))}
              <td><b>{masters.units.reduce((s, u) => s + cellTotal(u.code, c), 0)}</b></td></tr>
          ))}
        </tbody>
        <tfoot><tr><td>TOTAL</td>{masters.units.map(u => <td key={u.code}>{masters.counts.reduce((s, c) => s + cellTotal(u.code, c), 0)}</td>)}
          <td>{masters.units.reduce((s, u) => s + masters.counts.reduce((t, c) => t + cellTotal(u.code, c), 0), 0)}</td></tr></tfoot>
      </table>
      <p><button className="btn primary" onClick={save}>Save</button> <span className="mute">{msg}</span></p>
    </div>
  );
}

function Winding({ date, masters, setMasters }) {
  const [rows, setRows] = useState([]);
  const [f, setF] = useState({ party: masters.parties[0] || '', count: masters.counts[0], weight_kg: '', note: '' });
  const [newParty, setNewParty] = useState('');
  const [err, setErr] = useState('');
  const load = useCallback(() => api(`/api/report?date=${date}`).then(r => setRows(r.winding.rows)), [date]);
  useEffect(() => { load(); }, [load]);
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const add = async e => {
    e.preventDefault(); setErr('');
    try { await api('/api/winding', { method: 'POST', body: { ...f, date } }); setF({ ...f, weight_kg: '', note: '' }); load(); }
    catch (x) { setErr(x.message); }
  };
  const addParty = async () => {
    if (!newParty.trim()) return;
    await api('/api/parties', { method: 'POST', body: { name: newParty } });
    setMasters(await api('/api/masters')); setF({ ...f, party: newParty.trim() }); setNewParty('');
  };
  const del = async id => { await api(`/api/winding/${id}`, { method: 'DELETE' }); load(); };
  const total = rows.reduce((s, r) => s + r.weight_kg, 0);
  return (
    <>
      <div className="card">
        <h2>Cone winding entry</h2>
        <form className="form" onSubmit={add}>
          <label>Party<select value={f.party} onChange={set('party')}>{masters.parties.map(p => <option key={p}>{p}</option>)}</select></label>
          <label>Count<select value={f.count} onChange={set('count')}>{masters.counts.map(c => <option key={c}>{c}</option>)}</select></label>
          <label>Weight (kg)<input type="number" step="0.001" value={f.weight_kg} onChange={set('weight_kg')} required /></label>
          <label>Note<input value={f.note} onChange={set('note')} /></label>
          <button className="btn primary">Add</button>
        </form>
        {err && <div className="err">{err}</div>}
        <p className="form" style={{ marginTop: 14 }}>
          <label>New party<input value={newParty} onChange={e => setNewParty(e.target.value)} /></label>
          <button type="button" className="btn" onClick={addParty}>Add party</button>
        </p>
      </div>
      <div className="card">
        <h2>Cone winding — {date}</h2>
        <table>
          <thead><tr><th>Party</th><th>Count</th><th>Weight (kg)</th><th>Note</th><th /></tr></thead>
          <tbody>{rows.map(r => (
            <tr key={r.id}><td>{r.party}</td><td>{r.count}</td><td>{fmt(r.weight_kg)}</td><td style={{ textAlign: 'left' }}>{r.note}</td>
              <td><button className="x" onClick={() => del(r.id)}>✕</button></td></tr>
          ))}</tbody>
          <tfoot><tr><td>TOTAL</td><td /><td>{fmt(total)}</td><td /><td /></tr></tfoot>
        </table>
      </div>
    </>
  );
}

function Report({ date }) {
  const [r, setR] = useState(null);
  useEffect(() => { api(`/api/report?date=${date}`).then(setR); }, [date]);
  if (!r) return 'Loading…';
  const sc = r.singleCone;
  return (
    <>
      <div className="noprint" style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className="btn primary" onClick={() => window.print()}>Print</button>
        <a className="btn" href={`/api/report.xlsx?date=${date}`}>Download Excel</a>
      </div>
      <div className="print-title">Shivaji Inventory — Daily Report {date}</div>
      <div className="card"><h2>Bale stock</h2><BaleTable stock={r.bales} />
        {r.mixing.length > 0 && <p className="mute">Mixing today: {r.mixing.map(m => `${m.unit} ${m.quality === 1 ? '1st' : '2nd'}: ${m.bales} bales`).join(' · ')}</p>}
      </div>
      <div className="card"><h2>Single cone stock (bags)</h2>
        <table>
          <thead><tr><th>Count</th>{sc.units.map(u => <th key={u.code}>{u.name}</th>)}<th>Total</th><th>Loose cones left</th></tr></thead>
          <tbody>{sc.rows.map(x => (
            <tr key={x.count}><td>{x.count}</td>{sc.units.map(u => <td key={u.code}>{x.perUnit[u.code].total || '–'}</td>)}<td><b>{x.total}</b></td><td>{x.looseLeft || '–'}</td></tr>
          ))}</tbody>
          <tfoot><tr><td>TOTAL</td>{sc.units.map(u => <td key={u.code}>{sc.unitTotals[u.code]}</td>)}<td>{sc.grand}</td><td /></tr></tfoot>
        </table>
      </div>
      <div className="card"><h2>Cone winding</h2>
        <table>
          <thead><tr><th>Party</th><th>Count</th><th>Weight (kg)</th></tr></thead>
          <tbody>{r.winding.rows.map(x => <tr key={x.id}><td>{x.party}</td><td>{x.count}</td><td>{fmt(x.weight_kg)}</td></tr>)}</tbody>
          <tfoot><tr><td>TOTAL</td><td /><td>{fmt(r.winding.total)}</td></tr></tfoot>
        </table>
      </div>
    </>
  );
}
