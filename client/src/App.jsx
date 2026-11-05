import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';

const api = async (url, opts) => {
  const r = await fetch(url, opts && { ...opts, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(opts.body) });
  const j = await r.json();
  // session expired or never logged in: send the user back to the login page
  if (r.status === 401 && !url.startsWith('/api/login') && !url.startsWith('/api/me')) window.dispatchEvent(new Event('auth-lost'));
  if (!r.ok) throw new Error(j.error || 'Request failed');
  return j;
};
const iso = () => new Date().toISOString().slice(0, 10);
const num = v => (v === '' || v == null ? 0 : +v);
const fmt = n => (Math.round(n * 100) / 100).toLocaleString('en-IN');

// Login gate: the app is only shown to a signed-in user
export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking, null = signed out
  useEffect(() => {
    api('/api/me').then(r => setUser(r.user)).catch(() => setUser(null));
    const out = () => setUser(null);
    window.addEventListener('auth-lost', out);
    return () => window.removeEventListener('auth-lost', out);
  }, []);
  if (user === undefined) return null;
  if (!user) return <Login onLogin={setUser} />;
  return <Shell user={user} onLogout={async () => { await api('/api/logout', { method: 'POST' }); setUser(null); }} />;
}

function Login({ onLogin }) {
  const [f, setF] = useState({ username: '', password: '' });
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async e => {
    e.preventDefault(); setErr(''); setBusy(true);
    try { onLogin((await api('/api/login', { method: 'POST', body: f })).user); }
    catch (x) { setErr(x.message); setBusy(false); }
  };
  return (
    <div className="login-wrap">
      <form className="card login" onSubmit={submit}>
        <h1>Shivaji Inventory</h1>
        <p className="mute">Sign in to continue</p>
        <label>Username<input autoFocus autoComplete="username" value={f.username} onChange={e => setF({ ...f, username: e.target.value })} required /></label>
        <label>Password<input type="password" autoComplete="current-password" value={f.password} onChange={e => setF({ ...f, password: e.target.value })} required /></label>
        {err && <div className="err">{err}</div>}
        <button className="btn primary" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </div>
  );
}

// The current tab lives in the URL (#/single, #/master/places) and the date in sessionStorage, so a refresh stays where you were
const TAB_KEYS = ['bales', 'single', 'winding', 'chippam', 'conebags', 'report', 'master'];
const hashParts = () => location.hash.replace(/^#\/?/, '').split('/');
const tabFromHash = () => (TAB_KEYS.includes(hashParts()[0]) ? hashParts()[0] : 'bales');
const store = {
  get: k => { try { return sessionStorage.getItem(k); } catch { return null; } },
  set: (k, v) => { try { sessionStorage.setItem(k, v); } catch { /* storage blocked: fine */ } },
};

function Shell({ user, onLogout }) {
  const [tab, setTabState] = useState(tabFromHash);
  const [date, setDateState] = useState(() => store.get('date') || iso());
  const setDate = d => { setDateState(d); store.set('date', d); };
  const setTab = k => { location.hash = '/' + k; };
  useEffect(() => {
    const onHash = () => setTabState(tabFromHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
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
        <span className="mute">{user}</span>
        <button className="btn sm" onClick={onLogout}>Log out</button>
      </header>
      <main>
        {!masters ? 'Loading…' : tab === 'bales' ? <Bales date={date} masters={masters} />
          : tab === 'single' ? <Single date={date} masters={masters} setMasters={setMasters} />
          : tab === 'winding' ? <Winding date={date} masters={masters} setMasters={setMasters} />
          : tab === 'chippam' ? <BrandGrid kind="chippam" title="Chippam" date={date} withActual />
          : tab === 'conebags' ? <BrandGrid kind="conebags" title="Cone bags" date={date} withActual />
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
    api(`/api/bale-stock?date=${date}`).then(setStock);
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

      <div className="two">
        <BaleEntries title="Received" rows={moves.filter(m => m.type === 'IN')} baleUnits={baleUnits} edit={edit} del={del} date={date} />
        <BaleEntries title="Issued" rows={moves.filter(m => m.type === 'MIX')} baleUnits={baleUnits} edit={edit} del={del} date={date} />
      </div>

      <div className="card">
        <h2>Stock as on {date} <span className="mute">(opening = previous day stock)</span></h2>
        <BaleStockTable rows={stock} />
      </div>
    </>
  );
}

// Stock = opening + received - issued, running total up to the selected date (read-only)
function BaleStockTable({ rows }) {
  const sum = f => rows.reduce((s, r) => s + f(r), 0);
  const cols = [
    ['1st quality', r => r.q1], ['2nd quality', r => r.q2],
    ['Total', r => ({ open: r.q1.open + r.q2.open, rec: r.q1.rec + r.q2.rec, iss: r.q1.iss + r.q2.iss })],
  ];
  const heads = ['Opening', 'Received', 'Issued', 'Stock'];
  // stock = opening + received - issued
  const cells = (t, v, tag) => [
    <td key={t + 'o'}>{v.open}</td>, <td key={t + 'r'}>{v.rec}</td>, <td key={t + 'i'}>{v.iss}</td>,
    <td key={t + 's'} className="stk">{tag === 'b' ? <b>{v.open + v.rec - v.iss}</b> : v.open + v.rec - v.iss}</td>,
  ];
  return (
    <table className="stock">
      <thead>
        <tr><th rowSpan="2">Unit</th>{cols.map(([t]) => <th key={t} colSpan="4" className="grp">{t}</th>)}</tr>
        <tr>{cols.map(([t]) => heads.map(h => <th key={t + h} className={h === 'Stock' ? 'stk' : ''}>{h}</th>))}</tr>
      </thead>
      <tbody>
        {rows.map(r => <tr key={r.unit}><td>{r.name}</td>{cols.map(([t, get]) => cells(t, get(r), 'b'))}</tr>)}
        {!rows.length && <tr><td colSpan="13" className="mute">No units</td></tr>}
      </tbody>
      <tfoot><tr><td>TOTAL</td>
        {cols.map(([t, get]) => cells(t, { open: sum(r => get(r).open), rec: sum(r => get(r).rec), iss: sum(r => get(r).iss) }))}
      </tr></tfoot>
    </table>
  );
}

// One ledger table on the Bale Stock tab: Received (type IN) or Issued (type MIX)
function BaleEntries({ title, rows, baleUnits, edit, del, date }) {
  const total = rows.reduce((s, m) => s + m.bales, 0);
  return (
    <div className="card">
      <h2>{title} on {date}</h2>
      <table>
        <thead><tr><th>Unit</th><th>Quality</th><th>Bales</th><th>Note</th><th /></tr></thead>
        <tbody>
          {rows.map(m => (
            <tr key={m.id}>
              <td><select value={m.unit} onChange={e => edit(m, { unit: e.target.value })}>{baleUnits.map(u => <option key={u.code} value={u.code}>{u.name}</option>)}</select></td>
              <td><select value={m.quality} onChange={e => edit(m, { quality: +e.target.value })}><option value={1}>1st</option><option value={2}>2nd</option></select></td>
              <td><input type="number" min="1" key={m.bales} defaultValue={m.bales} onBlur={e => +e.target.value !== m.bales && edit(m, { bales: e.target.value })} /></td>
              <td style={{ textAlign: 'left' }}>{m.note}</td>
              <td><button className="x" onClick={() => del(m.id)}>✕</button></td></tr>
          ))}
          {!rows.length && <tr><td colSpan="5" className="mute">No entries for this date</td></tr>}
        </tbody>
        <tfoot><tr><td>TOTAL</td><td /><td>{total}</td><td /><td /></tr></tfoot>
      </table>
    </div>
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

// Calculator icon on a cell: opens a table of the places in the row's unit with one input per field
// (Single Cone: Bags + Cones, Chippam / Cone Bags: one Qty for the brand).
// "Add to cell" gives back the totals and keeps the per-place figures.
// value / draft: { placeName: { fieldKey: number } }
function PlacesCalc({ title, places, value, fields = [['bags', 'Bags'], ['cones', 'Cones']], onApply }) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState({});
  const any = v => fields.some(([k]) => num(v?.[k]));
  const entered = Object.entries(value || {}).filter(([, v]) => any(v));
  const show = () => { setDraft(JSON.parse(JSON.stringify(value || {}))); setOpen(true); };
  const set = (p, k, v) => setDraft({ ...draft, [p]: { ...draft[p], [k]: v } });
  const sum = k => places.reduce((s, p) => s + num(draft[p]?.[k]), 0);
  const apply = () => {
    const out = {}, totals = {};
    places.forEach(p => { if (any(draft[p])) out[p] = Object.fromEntries(fields.map(([k]) => [k, num(draft[p][k])])); });
    fields.forEach(([k]) => { totals[k] = sum(k); });
    onApply(totals, out);
    setOpen(false);
  };
  return (
    <>
      <button type="button" className={'calc-btn' + (entered.length ? ' has' : '')} onClick={show}
        title={entered.length ? entered.map(([p, v]) => `${p}: ${fields.map(([k, l]) => `${num(v[k])} ${l.toLowerCase()}`).join(', ')}`).join('\n') : 'Enter figures by place'}>🖩</button>
      {open && createPortal(
        <div className="calc-back" onClick={() => setOpen(false)}>
          <div className="calc-pop" onClick={e => e.stopPropagation()}>
            <div className="calc-head"><b>Places</b><span className="mute">{title}</span></div>
            {places.length ? (
              <table className="places">
                <thead><tr><th>Places</th>{fields.map(([k, l]) => <th key={k}>{l}</th>)}</tr></thead>
                <tbody>
                  {places.map(p => (
                    <tr key={p}><td>{p}</td>
                      {fields.map(([k]) => <td key={k}><input type="number" min="0" value={draft[p]?.[k] ?? ''} onChange={e => set(p, k, e.target.value)} /></td>)}</tr>
                  ))}
                </tbody>
                <tfoot><tr><td>TOTAL</td>{fields.map(([k]) => <td key={k}>{sum(k)}</td>)}</tr></tfoot>
              </table>
            ) : <p className="mute">No places for this unit. Add places in Master → Places (rows on Chippam / Cone Bags also need a Unit chosen).</p>}
            <div className="calc-acts">
              <button type="button" className="btn" onClick={() => setOpen(false)}>Cancel</button>
              <button type="button" className="btn primary" disabled={!places.length} onClick={apply}>Add to cell</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// number box that also takes a sum such as 10+20+30+50: the result is applied on Enter / leaving the box
function CalcInput({ value, onChange, placeholder }) {
  const [text, setText] = useState(null); // null = not editing
  const [expr, setExpr] = useState(null); // the sum last typed, shown under the box while it still matches the value
  const commit = () => {
    if (text === null) return;
    const t = text.replace(/\s+/g, '');
    if (t === '') onChange('');
    else if (/^[0-9+*/().-]+$/.test(t)) {
      try { const r = Function('"use strict"; return (' + t + ')')(); if (Number.isFinite(r) && r >= 0) { const out = String(Math.round(r * 100) / 100); onChange(out); setExpr(/[-+*/()]/.test(t.replace(/^-/, '')) ? { t, out } : null); } } catch { /* keep old value */ }
    }
    setText(null);
  };
  return <span style={{ display: 'inline-flex', flexDirection: 'column', verticalAlign: 'top' }}><input type="text" inputMode="decimal" placeholder={placeholder} value={text ?? value} style={{ width: 62, textAlign: 'right' }}
    onFocus={e => { setText(String(value)); e.target.select(); }} onChange={e => setText(e.target.value)} onBlur={commit}
    onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }} />
    {expr && text === null && expr.out === String(value) && <small className="mute" title={expr.t + ' = ' + expr.out} style={{ textAlign: 'right', maxWidth: 62, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{expr.t}</small>}</span>;
}

// Single Cone: one table per unit with places (rows = counts, columns = the unit's places, bags / loose each).
// Typing here fills the unit's column in the summary table above.
function UnitPlacesTable({ unit, places: realPlaces, counts, cells, setPlace, setDirect }) {
  // a unit without places gets one plain column (null) that holds its bags / cones directly
  const places = realPlaces.length ? realPlaces : [null];
  const val = (c, p, f) => {
    const x = cells[`${unit.code}|${c}`];
    return p === null ? (x?.[f === 'bags' ? 'bags' : 'loose_cones'] ?? '') : (x?.places?.[p]?.[f] ?? '');
  };
  const put = (c, p, f, v) => p === null ? setDirect(unit.code, c, f === 'bags' ? 'bags' : 'loose_cones', v) : setPlace(unit.code, c, p, f, v);
  const sum = (cs, ps) => {
    let bags = 0, cones = 0;
    cs.forEach(c => ps.forEach(p => { bags += num(val(c, p, 'bags')); cones += num(val(c, p, 'cones')); }));
    return { bags, cones };
  };
  const Pair = ({ t }) => <span className="pair"><b>{t.bags}</b><b>{t.cones}</b></span>;
  // bags + cones converted at 40 per bag, e.g. 200 bags + 50 cones = 201 (1 Bag + 10 Loose Cone)
  const Eq = ({ t }) => { const extra = Math.floor(t.cones / 40), left = t.cones % 40; return <span className="eq" style={{ whiteSpace: 'nowrap' }}>= <b>{t.bags + extra}</b>{t.cones > 0 && <span className="loose"> ({extra} Bag + {left} Loose Cone)</span>}</span>; };
  const sub = <span className="pair sub"><span>bags</span><span>loose</span></span>;
  // only the counts picked from the dropdown (or already holding figures) are rows
  const hasData = c => places.some(p => num(val(c, p, 'bags')) || num(val(c, p, 'cones')));
  const [added, setAdded] = useState([]);
  const shown = counts.filter(c => added.includes(c) || hasData(c));
  const free = counts.filter(c => !shown.includes(c));
  return (
    <details className="card unitcard" open>
      <summary><b>{unit.name}</b>{realPlaces.length > 0 && <span className="mute"> by place</span>}</summary>
      <div className="grid-wrap">
        <table className="grid">
          <thead><tr><th>Count</th>{places.map(p => <th key={p ?? 'qty'}>{p ?? 'Stock'}{sub}</th>)}<th className="tot">{unit.name} total{sub}</th></tr></thead>
          <tbody>
            {shown.map(c => (
              <tr key={c}><td>
                <select value={c} disabled={hasData(c)} onChange={e => setAdded(added.map(x => x === c ? e.target.value : x))}>
                  {counts.map(o => <option key={o} value={o} disabled={o !== c && shown.includes(o)}>{o}</option>)}
                </select>
                {!hasData(c) && <> <button type="button" className="x" title="Remove row" onClick={() => setAdded(added.filter(x => x !== c))}>✕</button></>}</td>
                {places.map(p => (
                  <td key={p ?? 'qty'}>
                    <CalcInput placeholder="bags" value={val(c, p, 'bags')} onChange={v => put(c, p, 'bags', v)} />{' '}
                    <CalcInput placeholder="cones" value={val(c, p, 'cones')} onChange={v => put(c, p, 'cones', v)} />
                  </td>
                ))}
                <td className="tot"><Pair t={sum([c], places)} /><div><Eq t={sum([c], places)} /></div></td></tr>
            ))}
            {free.length > 0 && (
              // always one blank line: choosing a count here fills it and a new blank line appears below
              <tr><td>
                <select value="" onChange={e => e.target.value && setAdded([...added, e.target.value])}>
                  <option value="">Select count…</option>
                  {counts.map(o => <option key={o} value={o} disabled={shown.includes(o)}>{o}</option>)}
                </select>
              </td>
                {places.map(p => (
                  <td key={p ?? 'qty'}>
                    <input type="number" disabled placeholder="bags" style={{ width: 62 }} />{' '}
                    <input type="number" disabled placeholder="cones" style={{ width: 62 }} />
                  </td>
                ))}
                <td className="tot"><Pair t={{ bags: 0, cones: 0 }} /></td></tr>
            )}
          </tbody>
          <tfoot><tr><td>TOTAL</td>{places.map(p => <td key={p ?? 'qty'}><Pair t={sum(counts, [p])} /><div><Eq t={sum(counts, [p])} /></div></td>)}<td className="tot"><Pair t={sum(counts, places)} /><div><Eq t={sum(counts, places)} /></div></td></tr></tfoot>
        </table>
      </div>
    </details>
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
    api(`/api/single-cone?date=${date}`).then(({ cells, places }) => {
      const m = {};
      cells.forEach(c => { m[key(c.unit, c.count)] = { bags: c.bags || '', loose_cones: c.loose_cones || '', places: {} }; });
      places.forEach(p => {
        const k = key(p.unit, p.count);
        m[k] = { bags: '', loose_cones: '', ...m[k], places: { ...m[k]?.places, [p.place]: { bags: p.bags || '', cones: p.cones || '' } } };
      });
      setCells(m); setMsg('');
    });
  }, [date]);
  // typing straight into an input drops the per-place figures, since they would no longer add up to it
  const upd = (u, c, field, v) => setCells({ ...cells, [key(u, c)]: { ...cells[key(u, c)], [field]: v, places: {} } });
  const placesOf = unit => (masters.places || []).filter(p => p.group === unit).map(p => p.name);
  // a figure typed in a unit's place table: the unit's cell in the summary becomes the sum of its places
  const setPlace = (u, c, place, field, v) => {
    const cur = cells[key(u, c)] || {};
    const places = { ...cur.places, [place]: { ...cur.places?.[place], [field]: v } };
    const sum = f => placesOf(u).reduce((s, p) => s + num(places[p]?.[f]), 0);
    setCells({ ...cells, [key(u, c)]: { ...cur, places, bags: sum('bags') || '', loose_cones: sum('cones') || '' } });
  };
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
      if (x) list.push({ unit: u.code, count: c, bags: num(x.bags), loose_cones: num(x.loose_cones), places: x.places || {} });
    }));
    await api('/api/single-cone', { method: 'PUT', body: { date, cells: list } });
    setMsg('Saved');
  };
  return (
    <>
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <h2>Single cone stock — {date}</h2>
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
        <span className="mute">{msg}</span><button type="button" className="btn primary" onClick={save}>Save</button>
        <div className="menu-wrap">
          <button type="button" className="btn" onClick={() => openMenu('units')}>+ Unit</button>
          {picker('units', 'unit', '/api/units', 'name', 'X Unit')}
        </div>
        </div>
      </div>
      <p className="mute">Enter stock in each unit's table below: pick a count on the blank line to add a row. {per} loose cones = 1 bag.</p>
      {(() => { const t = sumCells(masters.units.flatMap(u => masters.counts.map(c => [u.code, c]))); return <p><b>All units:</b> <Pair t={t} /> <span className="mute">bags / loose</span> &nbsp; = <Overall t={t} /> <span className="mute">bags</span></p>; })()}
    </div>

    {masters.units.map(u => (
      <UnitPlacesTable key={u.code} unit={u} places={placesOf(u.code)} counts={masters.counts} cells={cells} setPlace={setPlace} setDirect={upd} />
    ))}

    <p><button className="btn primary" onClick={save}>Save</button> <span className="mute">{msg}</span></p>
    </>
  );
}

function Master({ setMasters }) {
  const [sec, setSecState] = useState(() => hashParts()[1] || 'units');
  const setSec = k => { setSecState(k); location.hash = '/master/' + k; };
  const [all, setAll] = useState({ units: [], places: [], counts: [], parties: [], brands: [], ranges: [] });
  const [f, setF] = useState({ code: '', name: '', group: '' });
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
    places: { title: 'Places', hint: 'Places, each in a group. The group is one of your units.', list: all.places, id: p => p.name, label: () => '' },
    counts: { title: 'Counts', hint: 'Each count is a row in Single Cone and an option in Cone Winding.', list: all.counts, id: c => c.code, label: () => '' },
    parties: { title: 'Companies / parties', hint: 'Parties used in Cone Winding.', list: all.parties, id: p => p.name, label: () => '' },
    brands: { title: 'Brands', hint: 'Brand names, used as columns in Chippam and Cone Bags.', list: all.brands, id: b => b.name, label: () => '' },
    opening: { title: 'Opening balances', list: [], id: () => '', label: () => '' },
    ranges: { title: 'Count ranges', hint: 'Count ranges such as 3/56 - 3/62, used as rows in Chippam and Cone Bags.', list: all.ranges, id: r => r.name, label: () => '' },
  };
  const S = SECTIONS[sec] || SECTIONS.units;
  const shown = it => (S.show ? S.show(it) : S.id(it));
  const groups = all.units.filter(u => u.active); // group dropdown options
  const unitName = code => all.units.find(u => u.code === code)?.name || code;
  const switchSec = k => { setSec(k); setF({ code: '', name: '', group: '' }); setErr(''); };
  const add = async e => {
    e.preventDefault();
    const [url, body] = sec === 'units' ? ['/api/units', { code: f.code, name: f.name }]
      : sec === 'places' ? ['/api/places', { name: f.name, group: f.group || groups[0]?.code }]
      : sec === 'counts' ? ['/api/counts', { code: f.name }]
      : sec === 'ranges' ? ['/api/ranges', { name: f.name.trim() }] : [`/api/${sec}`, { name: f.name }];
    if (await run(url, 'POST', body)) setF({ code: '', name: '', group: f.group });
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
      {sec === 'opening' ? <OpeningBalances units={groups} /> : <>
      <h2 className="page-title">{S.title}</h2>
      <p className="mute">{S.hint} Deactivate anything no longer in use; only unused items can be deleted.</p>
      {err && <div className="err">{err}</div>}
      <div className="card">
        <form className="form" onSubmit={add}>
                    {sec === 'ranges' ? (
            <>
              <label>To count<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="e.g. 3/62" style={{ width: 110 }} required /></label>
            </>
          ) : sec === 'places' ? (
            <>
              <label>Place name<input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Place" required /></label>
              <label>Group<select value={f.group || groups[0]?.code || ''} onChange={e => setF({ ...f, group: e.target.value })} required>
                {groups.map(u => <option key={u.code} value={u.code}>{u.name}</option>)}</select></label>
            </>
          ) : (
            <label>{'New ' + { units: 'unit', counts: 'count', parties: 'party', brands: 'brand' }[sec]}
              <input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder={sec === 'units' ? 'e.g. X Unit' : sec === 'counts' ? 'e.g. 30S' : 'Name'} required /></label>
          )}
          <button className="btn primary">Add {{ units: 'unit', places: 'place', counts: 'count', parties: 'party', brands: 'brand', ranges: 'range' }[sec]}</button>
        </form>
      </div>
      <div className="card list">
        {S.list.map(it => (
          <div key={S.id(it)} className={'row' + (it.active ? '' : ' off')}>
            <span className="name"><b>{shown(it)}</b> <span className="mute">{S.label(it)}</span>
              {sec === 'places' && <span className="mute"> · Group: <select value={it.group} onChange={e => run(`/api/masters/places/${enc(it.name)}`, 'PATCH', { group: e.target.value })}>
                {groups.some(u => u.code === it.group) || <option value={it.group}>{unitName(it.group)}</option>}
                {groups.map(u => <option key={u.code} value={u.code}>{u.name}</option>)}</select></span>}
            </span>
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
      </>}
    </>
  );
}

// Master > Opening balances: opening bale stock per unit, date and quality; counted in the Bale Stock table
function OpeningBalances({ units }) {
  const blank = { unit: '', date: iso(), quality: 1, bales: '' };
  const [f, setF] = useState(blank);
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');
  const load = useCallback(() => api('/api/opening').then(setRows), []);
  useEffect(() => { load(); }, [load]);
  const unitName = code => units.find(u => u.code === code)?.name || code;
  const call = async (url, method, body) => {
    setErr('');
    try { await api(url, { method, body }); await load(); return true; } catch (x) { setErr(x.message); return false; }
  };
  const add = async e => {
    e.preventDefault();
    if (await call('/api/opening', 'POST', { ...f, unit: f.unit || units[0]?.code })) setF({ ...f, bales: '' });
  };
  const edit = (o, patch) => call(`/api/opening/${o.id}`, 'PUT', { ...o, ...patch });
  const del = o => window.confirm(`Delete this opening balance (${unitName(o.unit)}, ${o.date})?`) && call(`/api/opening/${o.id}`, 'DELETE');
  const quality = <><option value={1}>1st</option><option value={2}>2nd</option></>;
  return (
    <>
      <h2 className="page-title">Opening balances</h2>
      <p className="mute">Bales already in stock before you started entering Received and Issued. Each one counts in the Bale Stock table from its date onwards.</p>
      {err && <div className="err">{err}</div>}
      <div className="card">
        <form className="form" onSubmit={add}>
          <label>Unit<select value={f.unit || units[0]?.code || ''} onChange={e => setF({ ...f, unit: e.target.value })} required>
            {units.map(u => <option key={u.code} value={u.code}>{u.name}</option>)}</select></label>
          <label>Date<input type="date" value={f.date} onChange={e => setF({ ...f, date: e.target.value })} required /></label>
          <label>Quality<select value={f.quality} onChange={e => setF({ ...f, quality: +e.target.value })}>{quality}</select></label>
          <label>Opening bales<input type="number" min="0" step="1" value={f.bales} onChange={e => setF({ ...f, bales: e.target.value })} required style={{ width: 120 }} /></label>
          <button className="btn primary">Add opening balance</button>
        </form>
      </div>
      <div className="card">
        <table>
          <thead><tr><th>Date</th><th>Unit</th><th>Quality</th><th>Opening bales</th><th /></tr></thead>
          <tbody>
            {rows.map(o => (
              <tr key={o.id}>
                <td><input type="date" value={o.date} onChange={e => e.target.value && edit(o, { date: e.target.value })} /></td>
                <td><select value={o.unit} onChange={e => edit(o, { unit: e.target.value })}>
                  {units.some(u => u.code === o.unit) || <option value={o.unit}>{unitName(o.unit)}</option>}
                  {units.map(u => <option key={u.code} value={u.code}>{u.name}</option>)}</select></td>
                <td><select value={o.quality} onChange={e => edit(o, { quality: +e.target.value })}>{quality}</select></td>
                <td><input type="number" min="0" step="1" key={o.bales} defaultValue={o.bales} onBlur={e => e.target.value !== '' && +e.target.value !== o.bales && edit(o, { bales: e.target.value })} /></td>
                <td><button className="x" title="Delete" onClick={() => del(o)}>✕</button></td></tr>
            ))}
            {!rows.length && <tr><td colSpan="5" className="mute">No opening balances yet</td></tr>}
          </tbody>
        </table>
      </div>
    </>
  );
}

// Count (rows) x brand (columns) closing-stock sheet, used by the Chippam and Cone Bags tabs.
// Each sheet keeps its own rows and brand columns.
// withActual: Chippam shows an editable Actual Count beside the Marketing count (the row label)
function BrandGrid({ kind, title, date, withActual }) {
  const [rows, setRows] = useState([]);
  const [actuals, setActuals] = useState({}); // row label -> actual count
  const [ranges, setRanges] = useState([]); // count ranges from Master, offered in the dropdowns
  const [units, setUnits] = useState({}); // row label -> unit code
  const [mast, setMast] = useState({ units: [], places: [] }); // units and places from Master
  const [cellPlaces, setCellPlaces] = useState({}); // "brand|row" -> { place: { qty } }
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
      setRows(d.rows); setActuals(d.actuals || {}); setUnits(d.units || {});
      const cp = {};
      (d.places || []).forEach(p => { const k = key(p.brand, p.count); cp[k] = { ...cp[k], [p.place]: { qty: p.qty || '' } }; });
      setCellPlaces(cp); setCols(d.cols); setCells(m); setMsg('');
    });
  }, [kind, date]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (withActual) api('/api/masters').then(m => { setRanges(m.ranges); setMast({ units: m.units, places: m.places || [] }); }); }, [withActual]);
  const placesOf = label => mast.places.filter(p => p.group === units[label]).map(p => p.name);
  // pick a different marketing count for a row: rename it on the server, then re-key what is typed but not saved yet
  const changeMarketing = async (old, label) => {
    if (!label || label === old) return;
    try { await api(`/api/brand-stock/${kind}/rows/${enc(old)}`, { method: 'PATCH', body: { label } }); }
    catch (x) { return setMsg(x.message); }
    const rekey = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.endsWith(`|${old}`) ? k.slice(0, -old.length) + label : k === old ? label : k, v]));
    setRows(rows.map(x => (x === old ? label : x)));
    setCells(rekey(cells)); setActuals(rekey(actuals)); setUnits(rekey(units)); setCellPlaces(rekey(cellPlaces));
  };
  const isNew = label => label.startsWith('~new~'); // blank row from the Add button, no marketing count chosen yet
  const options = cur => [...new Set([...ranges, cur].filter(Boolean))];
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
    if (!window.confirm(`Remove ${name.startsWith('~new~') ? 'this row' : name} from this sheet?`)) return;
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
          v = (window.prompt('To count (e.g. 3/62):') || '').trim();
        } else v = (window.prompt(`New ${noun}:`) || '').trim();
        if (v) addItem(type, v); else setMenu(null);
      }}>+ New {noun}…</button>
    </div>
  );
  const total = (brands, labels) => brands.reduce((s, b) => s + labels.reduce((t, r) => t + num(cells[key(b, r)]), 0), 0);
  const save = async () => {
    const list = [];
    cols.forEach(b => rows.forEach(r => {
      if (cells[key(b, r)] !== undefined) list.push({ brand: b, count: r, qty: num(cells[key(b, r)]), ...(cellPlaces[key(b, r)] && { places: Object.fromEntries(Object.entries(cellPlaces[key(b, r)]).map(([p, v]) => [p, num(v.qty)])) }) });
    }));
    await api(`/api/brand-stock/${kind}`, { method: 'PUT', body: { date, cells: list, ...(withActual && { actuals, units }) } });
    setMsg('Saved');
  };
  const row = (r, g, idx) => (
              <tr key={r}>
                                {withActual && <td className="unit"><b>{g?.name}</b>{g?.code && idx === 0 && <button type="button" className="plus" title={'Add another row for ' + g.name} onClick={() => addRowTo(g.code)}>+</button>}</td>}
                {withActual && <td><select value={actuals[r] ?? ''} onChange={e => setActuals({ ...actuals, [r]: e.target.value })}><option value="">Select count</option>{options(actuals[r]).map(x => <option key={x}>{x}</option>)}</select></td>}
                <td className={withActual ? "mk" : ""}>{withActual ? <select value={isNew(r) ? '' : r} onChange={e => changeMarketing(r, e.target.value)}>{isNew(r) && <option value="">Select count</option>}{options(r).filter(x => !isNew(x) && (x === r || !rows.includes(x))).map(x => <option key={x}>{x}</option>)}</select> : r} <button className="x" title="Remove row" onClick={() => remove('rows', r)}>✕</button></td>
                {cols.map(b => (
                  <td key={b}><input type="number" min="0" value={cells[key(b, r)] ?? ''} onChange={e => { setCells({ ...cells, [key(b, r)]: e.target.value }); setCellPlaces({ ...cellPlaces, [key(b, r)]: {} }); }} style={{ width: 80 }} />
                    {withActual && <PlacesCalc title={b + (isNew(r) ? '' : ' · ' + r)} places={placesOf(r)} fields={[['qty', b]]} value={cellPlaces[key(b, r)]}
                      onApply={(t, p) => { setCells({ ...cells, [key(b, r)]: t.qty ? String(t.qty) : '' }); setCellPlaces({ ...cellPlaces, [key(b, r)]: p }); }} />}</td>
                ))}
                <td className="tot"><b>{total(cols, [r])}</b></td></tr>
  );
  // Chippam / Cone Bags: every unit is listed, each with its own rows and its own Add button
  const unitGroups = () => {
    const g = mast.units.map(u => ({ code: u.code, name: u.name, rows: rows.filter(r => units[r] === u.code) }));
    const loose = rows.filter(r => !mast.units.some(u => u.code === units[r]));
    return loose.length ? [...g, { code: '', name: 'No unit', rows: loose }] : g;
  };
  const addRowTo = async unit => {
    try { await api(`/api/brand-stock/${kind}/rows`, { method: 'POST', body: { label: `~new~${Date.now()}`, unit } }); load(); }
    catch (x) { setMsg(x.message); }
  };
  // a unit with no row at all (only until the server has added its default row): just the unit and its +
  const emptyUnit = g => (
    <tr key={'empty-' + g.code}><td className="unit"><b>{g.name}</b><button type="button" className="plus" title={'Add a row for ' + g.name} onClick={() => addRowTo(g.code)}>+</button></td><td colSpan={cols.length + 4} /></tr>
  );
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
          <thead><tr>{withActual ? <><th>Unit</th><th>Actual Count</th><th className="mk">Marketing</th></> : <th>Count range</th>}
            {cols.map(b => <th key={b}>{b} <button className="x" title="Remove column" onClick={() => remove('cols', b)}>✕</button></th>)}
            <th className="tot">Total</th></tr></thead>
          <tbody>
            {withActual ? unitGroups().flatMap(g => (g.rows.length || !g.code ? g.rows.map((r, i) => row(r, g, i)) : [emptyUnit(g)])) : rows.map(r => row(r))}
          </tbody>
          <tfoot><tr><td>TOTAL</td>{withActual && <><td /><td className="mk" /></>}{cols.map(b => <td key={b}><b>{total([b], rows)}</b></td>)}
            <td className="tot"><b>{total(cols, rows)}</b></td></tr></tfoot>
        </table>
      </div>
      {withActual ? null : (
        <div className="menu-wrap" style={{ display: 'inline-block', marginTop: 10 }}>
          <button type="button" className="btn" onClick={() => openMenu('rows')}>+ Row</button>
          {picker('rows', 'count range')}
        </div>
      )}
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
