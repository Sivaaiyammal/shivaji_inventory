import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const api = async (url, opts) => {
  const r = await fetch(url, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
};
const iso = () => new Date().toISOString().slice(0, 10);
const num = v => (v === '' || v == null ? 0 : +v);
// count range label, e.g. "3/56 - 3/62"; a single count when "to" is left empty
const rangeName = (from, to) => [from, to].map(x => (x || '').trim()).filter(Boolean).join(' - ');
const fmt = n => (Math.round(n * 100) / 100).toLocaleString('en-IN');

export default function App() {
  const [tab, setTab] = useState('bales');
  const [date, setDate] = useState(iso());
  const [masters, setMasters] = useState(null);
  useEffect(() => { api('/api/masters').then(setMasters); }, []);
  const tabs = [['bales', 'Bale Stock'], ['single', 'Single Cone'], ['winding', 'Cone Winding'], ['chippam', 'Chippam'], ['conebags', 'Cone Bags'], ['report', 'Report / Print'], ['master', 'Master']];
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
          : tab === 'single' ? <Single date={date} masters={masters} setMasters={setMasters} />
          : tab === 'winding' ? <Winding date={date} masters={masters} setMasters={setMasters} />
          : tab === 'chippam' ? <BrandGrid kind="chippam" title="Chippam" date={date} />
          : tab === 'conebags' ? <BrandGrid kind="conebags" title="Cone bags" date={date} />
          : tab === 'master' ? <Master setMasters={setMasters} />
          : <Report date={date} />}
      </main>
    </>
  );
}

function Bales({ date, masters }) {
  const baleUnits = masters.units;
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
  const edit = async (m, patch) => {
    setErr('');
    try { await api(`/api/bales/${m.id}`, { method: 'PUT', body: { ...m, ...patch } }); }
    catch (x) { setErr(x.message); }
    load();
  };
  // stock is received minus mixing, so editing a stock cell saves the difference as a correcting entry
  const adjust = async (unit, quality, current, v) => {
    const diff = num(v) - current;
    if (!diff) return;
    setErr('');
    try { await api('/api/bales', { method: 'POST', body: { type: diff > 0 ? 'IN' : 'MIX', unit, quality, bales: Math.abs(diff), note: 'Stock adjustment', date } }); }
    catch (x) { setErr(x.message); }
    load();
  };
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
          <button className="btn primary">Add</button>
        </form>
        {err && <div className="err">{err}</div>}
      </div>

      <div className="card">
        <h2>Bale stock as on {date}</h2>
        <BaleTable stock={stock} adjust={adjust} />
      </div>

      <div className="card">
        <h2>Entries on {date}</h2>
        <table>
          <thead><tr><th>Entry</th><th>Unit</th><th>Quality</th><th>Bales</th><th>Note</th><th /></tr></thead>
          <tbody>
            {moves.map(m => (
              <tr key={m.id}>
                <td><select value={m.type} onChange={e => edit(m, { type: e.target.value })}><option value="IN">Received</option><option value="MIX">Issued</option></select></td>
                <td><select value={m.unit} onChange={e => edit(m, { unit: e.target.value })}>{baleUnits.map(u => <option key={u.code} value={u.code}>{u.name}</option>)}</select></td>
                <td><select value={m.quality} onChange={e => edit(m, { quality: +e.target.value })}><option value={1}>1st</option><option value={2}>2nd</option></select></td>
                <td><input type="number" min="1" key={m.bales} defaultValue={m.bales} onBlur={e => +e.target.value !== m.bales && edit(m, { bales: e.target.value })} /></td>
                <td style={{ textAlign: 'left' }}>{m.note}</td>
                <td><button className="x" onClick={() => del(m.id)}>✕</button></td></tr>
            ))}
            {!moves.length && <tr><td colSpan="6" className="mute">No entries for this date</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

function BaleTable({ stock, adjust }) {
  const sum = f => stock.reduce((s, b) => s + f(b), 0);
  // editable on the Bale Stock tab (adjust given), plain numbers on the report
  const cell = (b, q) => adjust
    ? <input type="number" min="0" key={b[q].bales} defaultValue={b[q].bales} onBlur={e => adjust(b.unit, q === "q1" ? 1 : 2, b[q].bales, e.target.value)} />
    : b[q].bales;
  return (
    <table>
      <thead><tr><th>Unit</th><th>1st quality</th><th>2nd quality</th><th>Total</th></tr>
        </thead>
      <tbody>{stock.map(b => (
        <tr key={b.unit}><td>{b.unit} Unit</td><td>{cell(b, "q1")}</td><td>{cell(b, "q2")}</td><td>{b.bales}</td></tr>
      ))}</tbody>
      <tfoot><tr><td>TOTAL</td><td>{sum(b => b.q1.bales)}</td><td>{sum(b => b.q2.bales)}</td>
        <td>{sum(b => b.bales)}</td></tr></tfoot>
    </table>
  );
}

// Evaluate a simple sum like "10+20+30-20"; only digits and + - * / ( ) . are accepted
const calc = text => {
  const t = text.trim();
  if (!t || !/^[0-9+\-*/().\s]+$/.test(t)) return null;
  try {
    const v = Function(`"use strict"; return (${t})`)();
    return Number.isFinite(v) ? Math.round(v) : null;
  } catch { return null; }
};

// Calculator icon beside an input: type a sum, press Enter to put the result in the input.
// The sum is kept (expr) and shown on hover and when the popup is reopened.
function CalcButton({ expr, value, title, onApply }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const show = () => { setText(expr || ''); setOpen(true); };
  const result = calc(text);
  const apply = () => {
    if (result === null) return;
    onApply(result, text.trim());
    setOpen(false);
  };
  return (
    <>
      <button type="button" className={'calc-btn' + (expr ? ' has' : '')} onClick={show} title={expr ? `${expr} = ${value}` : 'Calculator'}>🖩</button>
      {open && createPortal(
        <div className="calc-back" onClick={() => setOpen(false)}>
          <div className="calc-pop" onClick={e => e.stopPropagation()}>
            <div className="calc-head"><b>Calculator</b><span className="mute">{title}</span></div>
            <textarea autoFocus rows={3} value={text} placeholder="10+20+30-20" onChange={e => setText(e.target.value.replace(/\n/g, ' '))}
              onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); apply(); } else if (e.key === 'Escape') setOpen(false); }} />
            <div className={'calc-res' + (text.trim() && result === null ? ' bad' : '')}>
              {text.trim() ? (result === null ? 'Enter a valid sum, e.g. 10+20-5' : `= ${result}`) : 'Type a sum like 10+20+30-20, then press Enter'}
            </div>
            <div className="calc-acts">
              <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn primary" disabled={result === null} onClick={apply}>Add to input</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

function Single({ date, masters, setMasters }) {
  const [cells, setCells] = useState({}); // "unit|count" -> {bags, loose_cones}
  const [msg, setMsg] = useState('');
  // hide a unit (column) or count (row) everywhere; it can be brought back with Activate in Master
  const removeItem = async (kind, key, label) => {
    if (!window.confirm(`Remove ${label}? It is hidden from all tabs and can be restored from Master (Activate).`)) return;
    try { await api(`/api/masters/${kind}/${encodeURIComponent(key)}`, { method: 'PATCH', body: { active: false } }); setMasters(await api('/api/masters')); }
    catch (x) { setMsg(x.message); }
  };
  const addStructure = async (label, url, field) => {
    const v = (window.prompt(label) || '').trim();
    if (!v) return;
    try { await api(url, { method: 'POST', body: { [field]: v } }); setMasters(await api('/api/masters')); }
    catch (x) { setMsg(x.message); }
  };
  // + Column / + Row: list the units / counts created in Master that are not on the sheet (hidden), plus a way to create a new one
  const [menu, setMenu] = useState(null); // {type: 'units' | 'counts', items: [{key, label}]}
  const openMenu = async type => {
    if (menu?.type === type) return setMenu(null);
    const all = await api('/api/masters/all');
    setMenu({ type, items: all[type].filter(x => !x.active).map(x => ({ key: x.code, label: type === 'units' ? x.name : x.code })) });
  };
  const activate = async (type, k) => {
    setMenu(null);
    try { await api(`/api/masters/${type}/${encodeURIComponent(k)}`, { method: 'PATCH', body: { active: true } }); setMasters(await api('/api/masters')); }
    catch (x) { setMsg(x.message); }
  };
  const picker = (type, noun, url, field, example) => menu?.type === type && (
    <div className={'menu' + (type === 'counts' ? ' up' : '')}>
      {menu.items.map(x => <button key={x.key} onClick={() => activate(type, x.key)}>{x.label}</button>)}
      {!menu.items.length && <span className="mute">No hidden {noun}s</span>}
      <button className="new" onClick={() => { setMenu(null); addStructure(`New ${noun} name (e.g. ${example}):`, url, field); }}>+ New {noun}…</button>
    </div>
  );
  const key = (u, c) => `${u}|${c}`;
  useEffect(() => {
    api(`/api/single-cone?date=${date}`).then(({ cells }) => {
      const m = {};
      cells.forEach(c => { m[key(c.unit, c.count)] = { bags: c.bags || '', loose_cones: c.loose_cones || '', bags_expr: c.bags_expr || '', cones_expr: c.cones_expr || '' }; });
      setCells(m); setMsg('');
    });
  }, [date]);
  // typing straight into an input drops the sum that was saved for it (exprField)
  const upd = (u, c, field, v, exprField) => setCells({ ...cells, [key(u, c)]: { ...cells[key(u, c)], [field]: v, ...(exprField && { [exprField]: '' }) } });
  // calculator result: set the input and remember the sum
  const setCalc = (u, c, field, v, exprField, text) => setCells({ ...cells, [key(u, c)]: { ...cells[key(u, c)], [field]: String(v), [exprField]: text } });
  const per = 40;
  // sum a set of cells: bags and loose cones are totalled separately; `all` = bags + loose cones converted at 40 per bag
  const sumCells = pairs => {
    let bags = 0, cones = 0;
    pairs.forEach(([u, c]) => { const x = cells[key(u, c)] || {}; bags += num(x.bags); cones += num(x.loose_cones); });
    return { bags, cones, all: bags + Math.floor(cones / per), left: cones % per };
  };
  // bags (40 loose cones = 1 bag) with the cones left over shown as loose cones
  const Overall = ({ t }) => <><b>{t.all}</b>{t.left > 0 && <span className="loose"> ({t.left} Loose Cone)</span>}</>;
  const Pair = ({ t }) => <span className="pair"><b>{t.bags}</b><b>{t.cones}</b></span>;
  const save = async () => {
    const list = [];
    masters.units.forEach(u => masters.counts.forEach(c => {
      const x = cells[key(u.code, c)];
      if (x) list.push({ unit: u.code, count: c, bags: num(x.bags), loose_cones: num(x.loose_cones), bags_expr: x.bags_expr || '', cones_expr: x.cones_expr || '' });
    }));
    await api('/api/single-cone', { method: 'PUT', body: { date, cells: list } });
    setMsg('Saved');
  };
  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Single cone stock — {date}</h2>
        <div className="menu-wrap">
          <button type="button" className="btn" onClick={() => openMenu('units')}>+ Column</button>
          {picker('units', 'unit', '/api/units', 'name', 'X Unit')}
        </div>
      </div>
      <p className="mute">Enter bags and loose cones per unit. {per} loose cones = 1 bag (counted in totals automatically).</p>
      <div className="grid-wrap"><table className="grid">
        <thead><tr><th>Count</th>{masters.units.map(u => <th key={u.code}>{u.name} <button className="x" title="Remove column" onClick={() => removeItem('units', u.code, u.name)}>✕</button><span className="pair sub"><span>bags</span><span>loose</span></span></th>)}<th className="tot">Total<span className="pair sub"><span>bags</span><span>loose</span></span></th></tr></thead>
        <tbody>
          {masters.counts.map(c => (
            <tr key={c}><td>{c} <button className="x" title="Remove row" onClick={() => removeItem('counts', c, c)}>✕</button></td>
              {masters.units.map(u => (
                <td key={u.code}>
                  <input type="number" min="0" placeholder="bags" value={cells[key(u.code, c)]?.bags ?? ''} onChange={e => upd(u.code, c, 'bags', e.target.value, 'bags_expr')} style={{ width: 62 }} />
                  <CalcButton title={u.name + " · " + c + " · bags"} expr={cells[key(u.code, c)]?.bags_expr} value={cells[key(u.code, c)]?.bags} onApply={(v, t) => setCalc(u.code, c, 'bags', v, 'bags_expr', t)} />{' '}
                  <input type="number" min="0" placeholder="cones" value={cells[key(u.code, c)]?.loose_cones ?? ''} onChange={e => upd(u.code, c, 'loose_cones', e.target.value, 'cones_expr')} style={{ width: 62 }} />
                  <CalcButton title={u.name + " · " + c + " · loose cones"} expr={cells[key(u.code, c)]?.cones_expr} value={cells[key(u.code, c)]?.loose_cones} onApply={(v, t) => setCalc(u.code, c, 'loose_cones', v, 'cones_expr', t)} />
                </td>
              ))}
              <td className="tot">{(() => { const t = sumCells(masters.units.map(u => [u.code, c])); return <><Pair t={t} /><div className="eq">= <Overall t={t} /></div></>; })()}</td></tr>
          ))}
        </tbody>
        <tfoot><tr><td>TOTAL</td>{masters.units.map(u => <td key={u.code}><Pair t={sumCells(masters.counts.map(c => [u.code, c]))} /></td>)}
          <td className="tot"><Pair t={sumCells(masters.units.flatMap(u => masters.counts.map(c => [u.code, c])))} /></td></tr>
          <tr className="overall"><td>OVERALL <span className="mute">(bags + cones/{per})</span></td>{masters.units.map(u => <td key={u.code}><Overall t={sumCells(masters.counts.map(c => [u.code, c]))} /></td>)}
            <td className="tot"><Overall t={sumCells(masters.units.flatMap(u => masters.counts.map(c => [u.code, c])))} /></td></tr>
        </tfoot>
      </table></div>
      <div className="menu-wrap" style={{ display: 'inline-block', marginTop: 10 }}>
        <button type="button" className="btn" onClick={() => openMenu('counts')}>+ Row</button>
        {picker('counts', 'count', '/api/counts', 'code', '30S')}
      </div>
      <p><button className="btn primary" onClick={save}>Save</button> <span className="mute">{msg}</span></p>
    </div>
  );
}

function Master({ setMasters }) {
  const [sec, setSec] = useState('units');
  const [all, setAll] = useState({ units: [], counts: [], parties: [], brands: [], ranges: [] });
  const [f, setF] = useState({ code: '', name: '' });
  const [err, setErr] = useState('');
  const enc = encodeURIComponent;
  const load = useCallback(() => api('/api/masters/all').then(setAll), []);
  useEffect(() => { load(); }, [load]);
  // run a change, then refresh this list and the masters used by the other tabs
  const run = async (url, method, body) => {
    setErr('');
    try { await api(url, { method, body }); await load(); setMasters(await api('/api/masters')); return true; }
    catch (x) { setErr(x.message); return false; }
  };
  const SECTIONS = {
    units: { title: 'Units', hint: 'Each unit is a column in Single Cone and a row in Bale Stock.', list: all.units, id: u => u.code, label: () => '', show: u => u.name },
    counts: { title: 'Counts', hint: 'Each count is a row in Single Cone and an option in Cone Winding.', list: all.counts, id: c => c.code, label: () => '' },
    parties: { title: 'Companies / parties', hint: 'Parties used in Cone Winding.', list: all.parties, id: p => p.name, label: () => '' },
    brands: { title: 'Brands', hint: 'Brand names, used as columns in Chippam and Cone Bags.', list: all.brands, id: b => b.name, label: () => '' },
    ranges: { title: 'Count ranges', hint: 'Count ranges such as 3/56 - 3/62, used as rows in Chippam and Cone Bags.', list: all.ranges, id: r => r.name, label: () => '' },
  };
  const S = SECTIONS[sec];
  const shown = it => (S.show ? S.show(it) : S.id(it));
  const switchSec = k => { setSec(k); setF({ code: '', name: '' }); setErr(''); };
  const add = async e => {
    e.preventDefault();
    const [url, body] = sec === 'units' ? ['/api/units', { code: f.code, name: f.name }]
      : sec === 'counts' ? ['/api/counts', { code: f.name }]
      : sec === 'ranges' ? ['/api/ranges', { name: rangeName(f.code, f.name) }] : [`/api/${sec}`, { name: f.name }];
    if (await run(url, 'POST', body)) setF({ code: '', name: '' });
  };
  const rename = it => {
    const v = (window.prompt('Rename', sec === 'units' ? it.name : S.id(it)) || '').trim();
    if (v) run(`/api/masters/${sec}/${enc(S.id(it))}`, 'PATCH', { name: v });
  };
  const toggle = it => run(`/api/masters/${sec}/${enc(S.id(it))}`, 'PATCH', { active: !it.active });
  const del = it => window.confirm(`Delete ${shown(it)}?`) && run(`/api/${sec}/${enc(S.id(it))}`, 'DELETE');
  return (
    <>
      <div className="subtabs">
        {Object.entries(SECTIONS).map(([k, v]) => <button key={k} className={sec === k ? 'on' : ''} onClick={() => switchSec(k)}>{v.title}</button>)}
      </div>
      <h2 className="page-title">{S.title}</h2>
      <p className="mute">{S.hint} Deactivate anything no longer in use; only unused items can be deleted.</p>
      {err && <div className="err">{err}</div>}
      <div className="card">
        <form className="form" onSubmit={add}>
                    {sec === 'ranges' ? (
            <>
              <label>From count<input value={f.code} onChange={e => setF({ ...f, code: e.target.value })} placeholder="e.g. 3/56" style={{ width: 110 }} required /></label>
              <label>To count<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="e.g. 3/62" style={{ width: 110 }} /></label>
            </>
          ) : (
            <label>{'New ' + { units: 'unit', counts: 'count', parties: 'party', brands: 'brand' }[sec]}
              <input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder={sec === 'units' ? 'e.g. X Unit' : sec === 'counts' ? 'e.g. 30S' : 'Name'} required /></label>
          )}
          <button className="btn primary">Add {{ units: 'unit', counts: 'count', parties: 'party', brands: 'brand', ranges: 'range' }[sec]}</button>
        </form>
      </div>
      <div className="card list">
        {S.list.map(it => (
          <div key={S.id(it)} className={'row' + (it.active ? '' : ' off')}>
            <span className="name"><b>{shown(it)}</b> <span className="mute">{S.label(it)}</span></span>
            <span className={'badge' + (it.active ? '' : ' off')}>{it.active ? 'Active' : 'Inactive'}</span>
            <span className="acts">
              <button className="btn sm" onClick={() => rename(it)}>Rename</button>
              <button className="btn sm" onClick={() => toggle(it)}>{it.active ? 'Deactivate' : 'Activate'}</button>
              <button className="btn sm" disabled={!!it.used} title={it.used ? 'Has saved entries, deactivate instead' : ''} onClick={() => del(it)}>Delete</button>
            </span>
          </div>
        ))}
        {!S.list.length && <div className="mute">Nothing here yet</div>}
      </div>
    </>
  );
}

// Count (rows) x brand (columns) closing-stock sheet, used by the Chippam and Cone Bags tabs.
// Each sheet keeps its own rows and brand columns.
function BrandGrid({ kind, title, date }) {
  const [rows, setRows] = useState([]);
  const [cols, setCols] = useState([]);
  const [cells, setCells] = useState({}); // "brand|row" -> qty
  const [msg, setMsg] = useState('');
  const [menu, setMenu] = useState(null); // {type:'cols'|'rows', items}: Master choices not yet on this sheet
  const key = (b, r) => `${b}|${r}`;
  const enc = encodeURIComponent;
  const load = useCallback(() => {
    api(`/api/brand-stock/${kind}?date=${date}`).then(d => {
      const m = {};
      d.cells.forEach(c => { m[key(c.brand, c.count)] = c.qty || ''; });
      setRows(d.rows); setCols(d.cols); setCells(m); setMsg('');
    });
  }, [kind, date]);
  useEffect(() => { load(); }, [load]);
  const openMenu = async type => {
    if (menu?.type === type) return setMenu(null);
    const m = await api('/api/masters');
    setMenu({ type, items: type === 'cols' ? m.brands.filter(b => !cols.includes(b)) : m.ranges.filter(x => !rows.includes(x)) });
  };
  const addItem = async (type, name) => {
    setMenu(null);
    try { await api(`/api/brand-stock/${kind}/${type}`, { method: 'POST', body: type === 'cols' ? { name } : { label: name } }); load(); }
    catch (x) { setMsg(x.message); }
  };
  const remove = async (type, name) => {
    if (!window.confirm(`Remove ${name} from this sheet?`)) return;
    try { await api(`/api/brand-stock/${kind}/${type}/${enc(name)}`, { method: 'DELETE' }); load(); }
    catch (x) { setMsg(x.message); }
  };
  const picker = (type, noun) => menu?.type === type && (
    <div className={'menu' + (type === 'rows' ? ' up' : '')}>
      {menu.items.map(x => <button key={x} onClick={() => addItem(type, x)}>{x}</button>)}
      {!menu.items.length && <span className="mute">All added</span>}
      <button className="new" onClick={() => {
        let v;
        if (type === 'rows') {
          const from = (window.prompt('From count (e.g. 3/56):') || '').trim();
          v = from && rangeName(from, window.prompt('To count (e.g. 3/62, leave empty for a single count):'));
        } else v = (window.prompt(`New ${noun}:`) || '').trim();
        if (v) addItem(type, v); else setMenu(null);
      }}>+ New {noun}…</button>
    </div>
  );
  const total = (brands, labels) => brands.reduce((s, b) => s + labels.reduce((t, r) => t + num(cells[key(b, r)]), 0), 0);
  const save = async () => {
    const list = [];
    cols.forEach(b => rows.forEach(r => {
      if (cells[key(b, r)] !== undefined) list.push({ brand: b, count: r, qty: num(cells[key(b, r)]) });
    }));
    await api(`/api/brand-stock/${kind}`, { method: 'PUT', body: { date, cells: list } });
    setMsg('Saved');
  };
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>{title} — {date}</h2>
        <div className="menu-wrap">
          <button type="button" className="btn" onClick={() => openMenu('cols')}>+ Column</button>
          {picker('cols', 'brand')}
        </div>
      </div>
      <p className="mute">Enter the quantity for each count and brand. Pick brands and count ranges from Master with + Column and + Row.</p>
      <div className="grid-wrap">
        <table className="grid">
          <thead><tr><th>Count range</th>
            {cols.map(b => <th key={b}>{b} <button className="x" title="Remove column" onClick={() => remove('cols', b)}>✕</button></th>)}
            <th className="tot">Total</th></tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r}><td>{r} <button className="x" title="Remove row" onClick={() => remove('rows', r)}>✕</button></td>
                {cols.map(b => (
                  <td key={b}><input type="number" min="0" value={cells[key(b, r)] ?? ''} onChange={e => setCells({ ...cells, [key(b, r)]: e.target.value })} style={{ width: 80 }} /></td>
                ))}
                <td className="tot"><b>{total(cols, [r])}</b></td></tr>
            ))}
          </tbody>
          <tfoot><tr><td>TOTAL</td>{cols.map(b => <td key={b}><b>{total([b], rows)}</b></td>)}
            <td className="tot"><b>{total(cols, rows)}</b></td></tr></tfoot>
        </table>
      </div>
      <div className="menu-wrap" style={{ display: 'inline-block', marginTop: 10 }}>
        <button type="button" className="btn" onClick={() => openMenu('rows')}>+ Row</button>
        {picker('rows', 'count range')}
      </div>
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
