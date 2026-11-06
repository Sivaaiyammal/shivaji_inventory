import React, { useCallback, useEffect, useRef, useState } from 'react';
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
const TAB_KEYS = ['bales', 'single', 'winding', 'doubling', 'chippam', 'conebags', 'report', 'master'];
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
  const tabs = [['bales', 'Bale Stock'], ['single', 'Single Cone'], ['chippam', 'Chippam'], ['conebags', 'Cone Bags'], ['winding', 'Cone Winding'], ['doubling', 'Doubling'], ['report', 'Report / Print'], ['master', 'Master']];
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
          : tab === 'doubling' ? <Doubling date={date} masters={masters} />
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
  const qualities = masters.qualities || [];
  const blank = { type: 'IN', unit: baleUnits[0].code, quality: qualities[0]?.id ?? 1, bales: '', weight_kg: '', note: '' };
  const [f, setF] = useState(blank);
  const [moves, setMoves] = useState([]);
  const [stock, setStock] = useState({ qualities: [], rows: [] });
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [pending, setPending] = useState([]); // new entries, not saved yet
  const [edits, setEdits] = useState({}); // id -> changed fields, not saved yet
  const [removed, setRemoved] = useState([]); // ids to delete on Save
  const load = useCallback(() => {
    api(`/api/bales?date=${date}`).then(setMoves);
    api(`/api/bale-stock?date=${date}`).then(setStock);
  }, [date]);
  useEffect(load, [load]);
  useEffect(() => { setPending([]); setEdits({}); setRemoved([]); setErr(''); setMsg(''); }, [date]);
  const isNew = id => String(id).startsWith('new-');
  const dirty = pending.length > 0 || removed.length > 0 || Object.keys(edits).length > 0;
  // what the tables show: saved entries with the unsaved changes applied, then the new ones
  const view = [...moves.filter(m => !removed.includes(m.id)).map(m => ({ ...m, ...edits[m.id] })), ...pending];
  const add = e => {
    e.preventDefault(); setErr(''); setMsg('');
    if (!(+f.bales > 0)) return setErr('Enter the number of bales');
    setPending([...pending, { id: 'new-' + Date.now() + '-' + pending.length, type: f.type, unit: f.unit, quality: +f.quality, bales: +f.bales, weight_kg: 0, note: '' }]);
    setF({ ...f, bales: '' });
  };
  const del = id => { setMsg(''); if (isNew(id)) setPending(pending.filter(p => p.id !== id)); else setRemoved([...removed, id]); };
  const edit = (m, patch) => {
    setMsg('');
    const p = patch.bales !== undefined ? { ...patch, bales: +patch.bales } : patch;
    if (isNew(m.id)) setPending(pending.map(x => (x.id === m.id ? { ...x, ...p } : x)));
    else setEdits({ ...edits, [m.id]: { ...edits[m.id], ...p } });
  };
  const save = async () => {
    setErr('');
    try {
      for (const id of removed) await api(`/api/bales/${id}`, { method: 'DELETE' });
      for (const [id, patch] of Object.entries(edits)) {
        const orig = moves.find(m => String(m.id) === String(id));
        if (orig && !removed.includes(orig.id)) await api(`/api/bales/${id}`, { method: 'PUT', body: { ...orig, ...patch } });
      }
      for (const p of pending) await api('/api/bales', { method: 'POST', body: { type: p.type, unit: p.unit, quality: p.quality, bales: p.bales, weight_kg: 0, note: '', date } });
      setPending([]); setEdits({}); setRemoved([]); setMsg('Saved'); load();
    } catch (x) { setErr(x.message); }
  };
  const set = k => e => setF({ ...f, [k]: e.target.value });
  return (
    <>
      <div className="card">
        <h2>Bale received / issued to mixing</h2>
        <form className="form" onSubmit={add}>
          <label>Entry
            <select value={f.type} onChange={set('type')}><option value="IN">Received (load)</option><option value="MIX">Issued to mixing</option></select></label>
          <label>Unit
            <select value={f.unit} onChange={set('unit')}>{baleUnits.map(u => <option key={u.code} value={u.code}>{u.name}</option>)}</select></label>
          <label>Quality
            <select value={f.quality} onChange={set('quality')}>{qualities.map(q => <option key={q.id} value={q.id}>{q.name}</option>)}</select></label>
          <label>Bales<input type="number" min="1" value={f.bales} onChange={set('bales')} required /></label>
          <button className="btn primary">Add to list</button>
        </form>
        {err && <div className="err">{err}</div>}
      </div>

      <div className="two">
        <BaleEntries title="Received" rows={view.filter(m => m.type === 'IN')} baleUnits={baleUnits} qualities={qualities} stockQualities={stock.qualities || []} edit={edit} del={del} date={date} />
        <BaleEntries title="Issued" rows={view.filter(m => m.type === 'MIX')} baleUnits={baleUnits} qualities={qualities} stockQualities={stock.qualities || []} edit={edit} del={del} date={date} />
      </div>
      <p style={{ display: 'flex', gap: 12, alignItems: 'center' }}><button type="button" className="btn primary" onClick={save}>Save</button>
        <span className="mute">{dirty ? 'Unsaved changes. Click Save to keep them.' : msg}</span></p>

      <div className="card">
        <h2>Stock as on {date} <span className="mute">(opening = previous day stock)</span></h2>
        <BaleStockTable rows={stock.rows || []} qualities={stock.qualities || []} />
      </div>
    </>
  );
}

// Stock = opening + received - issued, running total up to the selected date (read-only)
function BaleStockTable({ rows, qualities }) {
  const sum = f => rows.reduce((s, r) => s + f(r), 0);
  const cols = [
    ...qualities.map(x => [x.name + ' quality', r => r.q[x.id]]),
    ['Total', r => qualities.reduce((t, x) => ({ open: t.open + r.q[x.id].open, rec: t.rec + r.q[x.id].rec, iss: t.iss + r.q[x.id].iss }), { open: 0, rec: 0, iss: 0 })],
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
        {!rows.length && <tr><td colSpan={qualities.length * 4 + 5} className="mute">No units</td></tr>}
      </tbody>
      <tfoot><tr><td>TOTAL</td>
        {cols.map(([t, get]) => cells(t, { open: sum(r => get(r).open), rec: sum(r => get(r).rec), iss: sum(r => get(r).iss) }))}
      </tr></tfoot>
    </table>
  );
}

// One ledger table on the Bale Stock tab: Received (type IN) or Issued (type MIX)
function BaleEntries({ title, rows, baleUnits, qualities, stockQualities, edit, del, date }) {
  const qname = id => [...qualities, ...stockQualities].find(q => q.id === id)?.name || `Quality ${id}`;
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
              <td><select value={m.quality} onChange={e => edit(m, { quality: +e.target.value })}>{qualities.some(q => q.id === m.quality) || <option value={m.quality}>{qname(m.quality)}</option>}{qualities.map(q => <option key={q.id} value={q.id}>{q.name}</option>)}</select></td>
              <td><input type="number" min="1" key={m.bales} defaultValue={m.bales} onBlur={e => +e.target.value !== m.bales && edit(m, { bales: e.target.value })} /></td>
              <td style={{ textAlign: 'left' }}>{String(m.id).startsWith('new-') ? <span className="badge off">unsaved</span> : m.note}</td>
              <td><button className="x" onClick={() => del(m.id)}>✕</button></td></tr>
          ))}
          {!rows.length && <tr><td colSpan="5" className="mute">No entries for this date</td></tr>}
        </tbody>
        <tfoot><tr><td>TOTAL</td><td /><td>{total}</td><td /><td /></tr></tfoot>
      </table>
    </div>
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
function CalcInput({ value, onChange, placeholder, disabled, width = 62 }) {
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
  return <span style={{ display: 'inline-flex', flexDirection: 'column', verticalAlign: 'top' }}><input type="text" inputMode="decimal" disabled={disabled} placeholder={placeholder} value={text ?? value} style={{ width, textAlign: 'right' }}
    onFocus={e => { setText(String(value)); e.target.select(); }} onChange={e => setText(e.target.value)} onBlur={commit}
    onKeyDown={e => { if (e.key === 'Enter') e.target.blur(); }} />
    {expr && text === null && expr.out === String(value) && <small className="mute" title={expr.t + ' = ' + expr.out} style={{ textAlign: 'right', maxWidth: width, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{expr.t}</small>}</span>;
}

// Single Cone entry for ONE unit and place (picked above the table): each line is a count, bags and loose cones.
// The last line is always blank; choosing a count there fills it in and a new blank line appears.
function SingleEntry({ unit, place, counts, cells, setPlace, setDirect, moveCount, clearLine }) {
  const field = f => (f === 'bags' ? 'bags' : 'loose_cones');
  const val = (c, f) => { const x = cells[`${unit.code}|${c}`]; return place === null ? (x?.[field(f)] ?? '') : (x?.places?.[place]?.[f] ?? ''); };
  const put = (c, f, v) => (place === null ? setDirect(unit.code, c, field(f), v) : setPlace(unit.code, c, place, f, v));
  const hasData = c => num(val(c, 'bags')) || num(val(c, 'cones'));
  const [added, setAdded] = useState([]);
  const shown = counts.filter(c => added.includes(c) || hasData(c));
  const tot = cs => cs.reduce((t, c) => ({ bags: t.bags + num(val(c, 'bags')), cones: t.cones + num(val(c, 'cones')) }), { bags: 0, cones: 0 });
  const all = tot(shown);
  return (
    <table className="rep entry">
      <thead><tr><th>Count</th><th>Bags</th><th>Loose cones</th><th className="tot">Total</th></tr></thead>
      <tbody>
        {shown.map(c => { const t = tot([c]); return (
          <tr key={c}>
            <td>
              <select value={c} onChange={e => { const to = e.target.value; if (hasData(c)) moveCount(unit.code, c, to, place); else setAdded(added.map(x => (x === c ? to : x))); }}>
                {counts.map(o => <option key={o} value={o} disabled={o !== c && shown.includes(o)}>{o}</option>)}
              </select>
              <> <button type="button" className="x" title="Remove this line" onClick={() => { if (hasData(c)) clearLine(unit.code, c, place); setAdded(added.filter(x => x !== c)); }}>✕</button></>
            </td>
            <td><CalcInput placeholder="bags" width={96} value={val(c, 'bags')} onChange={v => put(c, 'bags', v)} /></td>
            <td><CalcInput placeholder="cones" width={96} value={val(c, 'cones')} onChange={v => put(c, 'cones', v)} /></td>
            <td className="tot"><b>{t.bags}</b> <span className="mute">/</span> <b>{t.cones}</b><div>{coneEq(t.bags, t.cones)}</div></td>
          </tr>
        ); })}
        {shown.length < counts.length && (
          <tr>
            <td>
              <select value="" onChange={e => e.target.value && setAdded([...added, e.target.value])}>
                <option value="">Select count…</option>
                {counts.map(o => <option key={o} value={o} disabled={shown.includes(o)}>{o}</option>)}
              </select>
            </td>
            <td><input type="text" disabled placeholder="bags" style={{ width: 96 }} /></td>
            <td><input type="text" disabled placeholder="cones" style={{ width: 96 }} /></td>
            <td className="tot" />
          </tr>
        )}
      </tbody>
      <tfoot><tr><td>TOTAL</td><td><b>{all.bags}</b></td><td><b>{all.cones}</b></td><td className="tot">{coneEq(all.bags, all.cones)}</td></tr></tfoot>
    </table>
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
  // change the count of a line that already has figures: its figures move to the new count (this unit and place only)
  const moveCount = (u, from, to, p) => {
    if (from === to) return;
    const next = { ...cells };
    const sumP = (x, f) => placesOf(u).reduce((t, q) => t + num(x.places?.[q]?.[f]), 0);
    const src = cells[key(u, from)] || {};
    const dst = cells[key(u, to)] || {};
    if (p === null) {
      next[key(u, to)] = { ...dst, bags: src.bags, loose_cones: src.loose_cones, places: dst.places || {} };
      next[key(u, from)] = { ...src, bags: '', loose_cones: '', places: {} };
    } else {
      const moved = src.places?.[p] || {};
      const d = { ...dst, places: { ...dst.places, [p]: moved } };
      const o = { ...src, places: { ...src.places, [p]: { bags: '', cones: '' } } };
      d.bags = sumP(d, 'bags') || ''; d.loose_cones = sumP(d, 'cones') || '';
      o.bags = sumP(o, 'bags') || ''; o.loose_cones = sumP(o, 'cones') || '';
      next[key(u, to)] = d; next[key(u, from)] = o;
    }
    setCells(next);
  };
  // remove a line that has figures: they are cleared for this unit and place (the change is saved with Save)
  const clearLine = (u, c, p) => {
    const cur = cells[key(u, c)] || {};
    if (p === null) { setCells({ ...cells, [key(u, c)]: { ...cur, bags: '', loose_cones: '', places: {} } }); return; }
    const places = { ...cur.places, [p]: { bags: '', cones: '' } };
    const sum = f => placesOf(u).reduce((t, q) => t + num(places[q]?.[f]), 0);
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
  // entry screen: pick the unit, then the place, then enter lines (count, bags, cones)
  const [sel, setSel] = useState(() => { try { return JSON.parse(sessionStorage.getItem('singleSel')) || {}; } catch { return {}; } });
  const unit = masters.units.find(u => u.code === sel.unit) || masters.units[0];
  const ps = unit ? placesOf(unit.code) : [];
  const place = ps.length ? (ps.includes(sel.place) ? sel.place : ps[0]) : null;
  const choose = patch => {
    const n = { unit: unit?.code, place, ...patch };
    setSel(n);
    try { sessionStorage.setItem('singleSel', JSON.stringify(n)); } catch { /* ignore */ }
  };
  const placeSum = (u, p) => masters.counts.reduce((t, c) => {
    const x = cells[key(u.code, c)];
    const v = p === null ? { bags: x?.bags, cones: x?.loose_cones } : { bags: x?.places?.[p]?.bags, cones: x?.places?.[p]?.cones };
    return { bags: t.bags + num(v.bags), cones: t.cones + num(v.cones) };
  }, { bags: 0, cones: 0 });
  const lines = (u, p) => masters.counts.filter(c => { const x = cells[key(u.code, c)]; return p === null ? num(x?.bags) || num(x?.loose_cones) : num(x?.places?.[p]?.bags) || num(x?.places?.[p]?.cones); }).length;
  if (!unit) return <div className="card">No units yet. Add one in Master.</div>;
  const cur = placeSum(unit, place);
  const unitTotal = sumCells(masters.counts.map(c => [unit.code, c]));
  const everything = sumCells(masters.units.flatMap(u => masters.counts.map(c => [u.code, c])));
  return (
    <>
    <div className="card entrybar">
      <div className="bar">
        <label>Unit
          <select value={unit.code} onChange={e => choose({ unit: e.target.value, place: undefined })}>
            {masters.units.map(u => { const n = masters.counts.filter(c => { const x = cells[key(u.code, c)]; return num(x?.bags) || num(x?.loose_cones); }).length; return <option key={u.code} value={u.code}>{u.name}{n ? ` (${n} entered)` : ""}</option>; })}
          </select>
        </label>
        {ps.length > 0 && (
          <label>Place
            <select value={place} onChange={e => choose({ place: e.target.value })}>
              {ps.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        )}
      </div>
      <div className="strip">
        <b>{unit.name}{place ? ` | ${place}` : ''} | {date}</b>
        <span>{lines(unit, place)} {lines(unit, place) === 1 ? 'line' : 'lines'} entered</span>
        <span>Bags {cur.bags}</span><span>Loose cones {cur.cones}</span>
        <span className="mute">{coneEq(cur.bags, cur.cones)}</span>
      </div>
    </div>

    <div className="card">
      <h2>{unit.name}{place ? ` · ${place}` : ''} entry <span className="rep-sub">{per} loose cones = 1 bag</span></h2>
      <SingleEntry key={unit.code + '|' + place} unit={unit} place={place} counts={masters.counts} cells={cells} setPlace={setPlace} setDirect={upd} moveCount={moveCount} clearLine={clearLine} />
      <p style={{ margin: '12px 0 0', display: 'flex', gap: 12, alignItems: 'center' }}><button type="button" className="btn primary" onClick={save}>Save</button> <span className="mute">{msg}</span></p>
    </div>

    <div className="card">
      <h2>{unit.name} summary</h2>
      <table className="rep entry">
        <thead><tr><th>{ps.length ? 'Place' : 'Unit'}</th><th>Bags</th><th>Loose cones</th><th className="tot">Total</th></tr></thead>
        <tbody>
          {(ps.length ? ps : [null]).map(p => { const t = placeSum(unit, p); return (
            <tr key={p ?? 'u'} className={p === place ? 'cur' : ''} style={ps.length ? { cursor: 'pointer' } : undefined} onClick={() => ps.length && choose({ place: p })}>
              <td>{p ?? unit.name}</td><td>{t.bags}</td><td>{t.cones}</td><td className="tot">{coneEq(t.bags, t.cones)}</td>
            </tr>
          ); })}
        </tbody>
        {ps.length > 0 && <tfoot><tr><td>{unit.name} total</td><td>{unitTotal.bags}</td><td>{unitTotal.cones}</td><td className="tot">{coneEq(unitTotal.bags, unitTotal.cones)}</td></tr></tfoot>}
      </table>
      <p style={{ marginBottom: 0 }}><b>All units:</b> {everything.bags} bags, {everything.cones} loose cones &nbsp; {coneEq(everything.bags, everything.cones)}</p>
    </div>

    </>
  );
}

function Master({ setMasters }) {
  const [sec, setSecState] = useState(() => hashParts()[1] || 'units');
  const setSec = k => { setSecState(k); location.hash = '/master/' + k; };
  const [all, setAll] = useState({ units: [], places: [], counts: [], parties: [], brands: [], ranges: [], qualities: [] });
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
    qualities: { title: 'Qualities', hint: 'Bale qualities (1st, 2nd, …). Each is a column in the Bale Stock table and an option when entering bales.', list: all.qualities, id: q => q.id, label: () => '', show: q => q.name },
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
    const v = (window.prompt('Rename', sec === 'units' || sec === 'qualities' ? shown(it) : S.id(it)) || '').trim();
    if (v) run(`/api/masters/${sec}/${enc(S.id(it))}`, 'PATCH', { name: v });
  };
  const toggle = it => run(`/api/masters/${sec}/${enc(S.id(it))}`, 'PATCH', { active: !it.active });
  const del = it => window.confirm(`Delete ${shown(it)}?`) && run(`/api/${sec}/${enc(S.id(it))}`, 'DELETE');
  return (
    <>
      <div className="subtabs">
        {Object.entries(SECTIONS).map(([k, v]) => <button key={k} className={sec === k ? 'on' : ''} onClick={() => switchSec(k)}>{v.title}</button>)}
      </div>
      {sec === 'opening' ? <OpeningBalances units={groups} qualities={all.qualities.filter(q => q.active)} allQualities={all.qualities} /> : <>
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
            <label>{'New ' + { units: 'unit', counts: 'count', parties: 'party', brands: 'brand', qualities: 'quality' }[sec]}
              <input value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder={sec === 'units' ? 'e.g. X Unit' : sec === 'counts' ? 'e.g. 30S' : 'Name'} required /></label>
          )}
          <button className="btn primary">Add {{ units: 'unit', places: 'place', counts: 'count', parties: 'party', brands: 'brand', ranges: 'range', qualities: 'quality' }[sec]}</button>
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
function OpeningBalances({ units, qualities, allQualities }) {
  const blank = { unit: '', date: iso(), quality: '', bales: '' };
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
    if (await call('/api/opening', 'POST', { ...f, unit: f.unit || units[0]?.code, quality: f.quality || qualities[0]?.id })) setF({ ...f, bales: '' });
  };
  const edit = (o, patch) => call(`/api/opening/${o.id}`, 'PUT', { ...o, ...patch });
  const del = o => window.confirm(`Delete this opening balance (${unitName(o.unit)}, ${o.date})?`) && call(`/api/opening/${o.id}`, 'DELETE');
  const quality = qualities.map(q => <option key={q.id} value={q.id}>{q.name}</option>);
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
          <label>Quality<select value={f.quality || qualities[0]?.id || ''} onChange={e => setF({ ...f, quality: +e.target.value })}>{quality}</select></label>
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
                <td><select value={o.quality} onChange={e => edit(o, { quality: +e.target.value })}>{qualities.some(q => q.id === o.quality) || <option value={o.quality}>{allQualities.find(q => q.id === o.quality)?.name || o.quality}</option>}{quality}</select></td>
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
  const [loaded, setLoaded] = useState(false);
  const [menu, setMenu] = useState(null); // {type:'cols'|'rows', items}: Master choices not yet on this sheet
  const key = (b, r) => `${b}|${r}`;
  const enc = encodeURIComponent;
  // keep = true: a layout change (new blank line) reloads the sheet but must not lose what is typed and not saved yet
  const load = useCallback((keep = false) => {
    api(`/api/brand-stock/${kind}?date=${date}`).then(d => {
      const m = {};
      d.cells.forEach(c => { m[key(c.brand, c.count)] = c.qty || ''; });
      const cp = {};
      (d.places || []).forEach(p => { const k = key(p.brand, p.count); cp[k] = { ...cp[k], [p.place]: { qty: p.qty || '' } }; });
      const lab = new Set(d.rows);
      const merge = (srv, prev, ok) => (keep ? { ...srv, ...Object.fromEntries(Object.entries(prev).filter(([k]) => ok(k))) } : srv);
      const inRows = k => lab.has(k) || [...lab].some(l => k.endsWith('|' + l));
      setRows(d.rows); setUnits(d.units || {}); setCols(d.cols);
      setActuals(p => merge(d.actuals || {}, p, k => lab.has(k) && p[k]));
      setCells(p => merge(m, p, k => inRows(k) && p[k] !== undefined));
      setCellPlaces(p => merge(cp, p, inRows));
      setMsg(''); setLoaded(true);
    });
  }, [kind, date]);
  useEffect(() => { setLoaded(false); load(); }, [load]);
  useEffect(() => { if (withActual) api('/api/masters').then(m => { setRanges(m.ranges); setMast({ units: m.units, places: m.places || [] }); }); }, [withActual]);
  const placesOf = label => mast.places.filter(p => p.group === units[label]).map(p => p.name);
  // pick a different marketing count for a row: rename it on the server, then re-key what is typed but not saved yet
  const changeMarketing = async (old, label) => {
    if (!label || label === old) return;
    const tk = (l, u = units[old]) => `${u}|${place}|${l}`;
    // that count already has a line in another place of this unit: show that line here instead of renaming the blank one
    if (isNew(old) && rows.includes(label)) {
      setTouched({ ...touched, [tk(label)]: 1 });
      // the Actual Count already picked on the blank line moves to that line
      if (actuals[old]) setActuals({ ...actuals, [label]: actuals[label] || actuals[old], [old]: '' });
      return;
    }
    if (isNew(old)) setTouched({ ...touched, [tk(label)]: 1 });
    try { await api(`/api/brand-stock/${kind}/rows/${enc(old)}`, { method: 'PATCH', body: { label } }); }
    catch (x) { return setMsg(x.message); }
    const rekey = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k.endsWith(`|${old}`) ? k.slice(0, -old.length) + label : k === old ? label : k, v]));
    setRows(rows.map(x => (x === old ? label : x)));
    setCells(rekey(cells)); setActuals(rekey(actuals)); setUnits(rekey(units)); setCellPlaces(rekey(cellPlaces));
  };
  const [touched, setTouched] = useState({}); // lines picked in a place this session, kept visible while still empty
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
    try { await api(`/api/brand-stock/${kind}/${type}/${enc(name)}`, { method: 'DELETE' }); load(true); }
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
  const unitPlaces = code => mast.places.filter(p => p.group === code).map(p => p.name);
  // a figure typed for one place: the brand cell becomes the sum of the unit's places
  const setPlaceQty = (b, r, ps, p, v) => {
    const k = key(b, r);
    const cp = { ...cellPlaces[k], [p]: { qty: v } };
    const sum = ps.reduce((t, x) => t + num(cp[x]?.qty), 0);
    setCellPlaces({ ...cellPlaces, [k]: cp }); setCells({ ...cells, [k]: sum ? String(sum) : '' });
  };
  const placeTotal = (brands, labels, p) => brands.reduce((s, b) => s + labels.reduce((t, r) => t + num(cellPlaces[key(b, r)]?.[p]?.qty), 0), 0);
  // entry screen state: unit, then place (kept for the session)
  const [sel, setSel] = useState(() => { try { return JSON.parse(sessionStorage.getItem(kind + 'Sel')) || {}; } catch { return {}; } });
  const choose = patch => { const n = { ...sel, ...patch }; setSel(n); try { sessionStorage.setItem(kind + 'Sel', JSON.stringify(n)); } catch { /* ignore */ } };
  const place = (() => { const ps = unitPlaces(sel.unit && mast.units.some(u => u.code === sel.unit) ? sel.unit : mast.units[0]?.code); return ps.includes(sel.place) ? sel.place : ps[0] ?? null; })();
  // lines shown for the place picked: the blank line, lines with a quantity here, and lines just picked here
  const visible = g => g.rows.filter(r => isNew(r) || touched[`${g.code}|${place}|${r}`] || (unitPlaces(g.code).length ? placeTotal(cols, [r], place) : total(cols, [r])));
  const row = (r, g, idx) => (
              <tr key={r}>
                {withActual && <td><select value={actuals[r] ?? ''} onChange={e => { setActuals({ ...actuals, [r]: e.target.value }); setTouched({ ...touched, [`${g?.code}|${place}|${r}`]: 1 }); }}><option value="">Select count</option>{options(actuals[r]).map(x => <option key={x}>{x}</option>)}</select></td>}
                <td className={withActual ? "mk" : ""}>{withActual ? <select value={isNew(r) ? '' : r} onChange={e => changeMarketing(r, e.target.value)}>{isNew(r) && <option value="">Select count</option>}{options(r).filter(x => !isNew(x) && (x === r || !(isNew(r) ? visible(g) : rows).includes(x))).map(x => <option key={x}>{x}</option>)}</select> : r} {!(withActual && isNew(r)) && <button className="x" title="Remove row" onClick={() => remove('rows', r)}>✕</button>}</td>
                {cols.map(b => {
                  const ps = withActual ? unitPlaces(g?.code) : [];
                  if (withActual && ps.length) {
                    // a unit with places: the box for the place picked above the table
                    const k = key(b, r);
                    return <td key={b}><CalcInput placeholder="qty" disabled={isNew(r)} value={cellPlaces[k]?.[place]?.qty ?? ''} onChange={v => setPlaceQty(b, r, ps, place, v)} /></td>;
                  }
                  return (
                    <td key={b}>{withActual ? (
                      <CalcInput placeholder="qty" disabled={isNew(r)} value={cells[key(b, r)] ?? ''} onChange={v => { setCells({ ...cells, [key(b, r)]: v }); setCellPlaces({ ...cellPlaces, [key(b, r)]: {} }); }} />
                    ) : <input type="number" min="0" value={cells[key(b, r)] ?? ''} onChange={e => setCells({ ...cells, [key(b, r)]: e.target.value })} style={{ width: 80 }} />}</td>
                  );
                })}
                <td className="tot"><b>{withActual && unitPlaces(g?.code).length ? placeTotal(cols, [r], place) : total(cols, [r])}</b></td></tr>
  );
  // Chippam / Cone Bags: one table per unit; its last line is always a blank one, and choosing a marketing count there adds the next blank line
  const unitGroups = () => {
    const g = mast.units.map(u => ({ code: u.code, name: u.name, rows: rows.filter(r => units[r] === u.code) }));
    const loose = rows.filter(r => !mast.units.some(u => u.code === units[r]));
    return loose.length ? [...g, { code: '', name: 'No unit', rows: loose }] : g;
  };
  const addRowTo = async unit => {
    try { await api(`/api/brand-stock/${kind}/rows`, { method: 'POST', body: { label: `~new~${Date.now()}-${unit}`, unit } }); load(true); }
    catch (x) { setMsg(x.message); }
  };
  const tried = useRef(new Set());
  useEffect(() => {
    if (!withActual || !loaded || !mast.units.length) return;
    mast.units.forEach(u => {
      if (rows.some(r => units[r] === u.code && isNew(r))) return;
      const sig = kind + '|' + u.code + '|' + rows.join(',');
      if (tried.current.has(sig)) return;
      tried.current.add(sig);
      addRowTo(u.code);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, units, mast.units, loaded, withActual]);
  const unitTable = g => {
    const ps = unitPlaces(g.code);
    return (
    <>
    <div className="card">
      <h2>{g.name}{place ? ` · ${place}` : ''} entry</h2>
      <div className="grid-wrap">
        <table className="grid" data-labelfirst="1">
          <thead>
            <tr><th>Actual Count</th><th className="mk">Marking</th>
              {cols.map(b => <th key={b}>{b} <button className="x" title="Remove column" onClick={() => remove('cols', b)}>✕</button></th>)}
              <th className="tot">Total</th></tr>
          </thead>
          <tbody>{visible(g).map((r, i) => row(r, g, i))}</tbody>
          <tfoot><tr><td>TOTAL</td><td className="mk" />
            {cols.map(b => <td key={b}><b>{ps.length ? placeTotal([b], g.rows, place) : total([b], g.rows)}</b></td>)}
            <td className="tot"><b>{ps.length ? placeTotal(cols, g.rows, place) : total(cols, g.rows)}</b></td></tr></tfoot>
        </table>
      </div>
      <p style={{ margin: '12px 0 0', display: 'flex', gap: 12, alignItems: 'center' }}><button type="button" className="btn primary" onClick={save}>Save</button> <span className="mute">{msg}</span></p>
    </div>
    <div className="card">
      <h2>{g.name} summary</h2>
      <table className="rep" data-labelfirst="1">
        <thead><tr><th>Actual</th><th>Marking</th>{ps.map(p => <th key={p}>{p}</th>)}<th className="tot">Total</th><th /></tr></thead>
        <tbody>{g.rows.filter(r => !isNew(r)).map(r => (
          <tr key={r}><td>{actuals[r] || ''}</td><td>{r}</td>{ps.map(p => <td key={p}>{placeTotal(cols, [r], p)}</td>)}<td className="tot"><b>{total(cols, [r])}</b></td>
            <td><button type="button" className="x" title="Remove this line from the sheet" onClick={() => remove('rows', r)}>✕</button></td></tr>
        ))}</tbody>
        <tfoot><tr><td>TOTAL</td><td />{ps.map(p => <td key={p}><b>{placeTotal(cols, g.rows, p)}</b></td>)}<td className="tot"><b>{total(cols, g.rows)}</b></td><td /></tr></tfoot>
      </table>
    </div>
    </>
    );
  };
  if (withActual) {
    const groups = unitGroups();
    const g = groups.find(x => x.code === sel.unit) || groups[0];
    if (!g) return <div className="card">Loading…</div>;
    const ps = unitPlaces(g.code);
    const entered = x => x.rows.filter(r => !isNew(r) && total(cols, [r])).length;
    const cur = ps.length ? placeTotal(cols, g.rows, place) : total(cols, g.rows);
    return (
      <>
      <div className="card entrybar">
        <div className="bar">
          <label>Unit
            <select value={g.code} onChange={e => choose({ unit: e.target.value, place: undefined })}>
              {groups.map(x => <option key={x.code} value={x.code}>{x.name}{entered(x) ? ` (${entered(x)} entered)` : ''}</option>)}
            </select>
          </label>
          {ps.length > 0 && (
            <label>Place
              <select value={place} onChange={e => choose({ place: e.target.value })}>
                {ps.map(p => <option key={p} value={p}>{p}</option>)}
              </select>
            </label>
          )}
          <div className="menu-wrap">
            <button type="button" className="btn" onClick={() => openMenu('cols')}>+ Column</button>
            {picker('cols', 'brand')}
          </div>
        </div>
        <div className="strip">
          <b>{title} | {g.name}{place ? ` | ${place}` : ''} | {date}</b>
          <span>{entered(g)} {entered(g) === 1 ? 'line' : 'lines'} entered</span>
          <span>Quantity {cur}</span>
        </div>
      </div>
      {unitTable(g)}
      </>
    );
  }
  return (
    <div className="card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h2>{title} — {date}</h2>
        <div className="menu-wrap">
          <button type="button" className="btn" onClick={() => openMenu('cols')}>+ Column</button>
          {picker('cols', 'brand')}
        </div>
      </div>
      <p className="mute">Enter the quantity for each count and brand. Pick a marking count on the blank line of a unit to add a row; add brands with + Column.</p>
      {withActual ? (
        <>
          <p><b>All units:</b> <b>{total(cols, rows)}</b></p>
          {unitGroups().map(unitTable)}
        </>
      ) : (
      <div className="grid-wrap">
        <table className="grid">
          <thead><tr><th>Count range</th>
            {cols.map(b => <th key={b}>{b} <button className="x" title="Remove column" onClick={() => remove('cols', b)}>✕</button></th>)}
            <th className="tot">Total</th></tr></thead>
          <tbody>{rows.map(r => row(r))}</tbody>
          <tfoot><tr><td>TOTAL</td>{cols.map(b => <td key={b}><b>{total([b], rows)}</b></td>)}
            <td className="tot"><b>{total(cols, rows)}</b></td></tr></tfoot>
        </table>
      </div>
      )}
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
  const [msg, setMsg] = useState('');
  const [pending, setPending] = useState([]); // new entries, not saved yet
  const [removed, setRemoved] = useState([]); // saved entries to delete on Save
  const load = useCallback(() => api(`/api/report?date=${date}`).then(r => setRows(r.winding.rows)), [date]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPending([]); setRemoved([]); setErr(''); setMsg(''); }, [date]);
  const dirty = pending.length > 0 || removed.length > 0;
  const view = [...rows.filter(r => !removed.includes(r.id)), ...pending];
  const set = k => e => setF({ ...f, [k]: e.target.value });
  const add = e => {
    e.preventDefault(); setErr(''); setMsg('');
    setPending([...pending, { id: 'new-' + Date.now() + '-' + pending.length, party: f.party, count: f.count, weight_kg: +f.weight_kg, note: f.note }]);
    setF({ ...f, weight_kg: '', note: '' });
  };
  const save = async () => {
    setErr('');
    try {
      for (const id of removed) await api(`/api/winding/${id}`, { method: 'DELETE' });
      for (const p of pending) await api('/api/winding', { method: 'POST', body: { party: p.party, count: p.count, weight_kg: p.weight_kg, note: p.note, date } });
      setPending([]); setRemoved([]); setMsg('Saved'); load();
    } catch (x) { setErr(x.message); }
  };
  const addParty = async () => {
    if (!newParty.trim()) return;
    await api('/api/parties', { method: 'POST', body: { name: newParty } });
    setMasters(await api('/api/masters')); setF({ ...f, party: newParty.trim() }); setNewParty('');
  };
  const del = id => { setMsg(''); if (String(id).startsWith('new-')) setPending(pending.filter(p => p.id !== id)); else setRemoved([...removed, id]); };
  const total = view.reduce((s, r) => s + r.weight_kg, 0);
  return (
    <>
      <div className="card">
        <h2>Cone winding entry</h2>
        <form className="form" onSubmit={add}>
          <label>Party<select value={f.party} onChange={set('party')}>{masters.parties.map(p => <option key={p}>{p}</option>)}</select></label>
          <label>Count<select value={f.count} onChange={set('count')}>{masters.counts.map(c => <option key={c}>{c}</option>)}</select></label>
          <label>Weight (kg)<input type="number" step="0.001" value={f.weight_kg} onChange={set('weight_kg')} required /></label>
          <label>Note<input value={f.note} onChange={set('note')} /></label>
          <button className="btn primary">Add to list</button>
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
          <tbody>{view.map(r => (
            <tr key={r.id}><td>{r.party}</td><td>{r.count}</td><td>{fmt(r.weight_kg)}</td><td style={{ textAlign: 'left' }}>{String(r.id).startsWith('new-') ? <span className="badge off">unsaved</span> : r.note}{String(r.id).startsWith('new-') && r.note ? ' ' + r.note : ''}</td>
              <td><button className="x" onClick={() => del(r.id)}>✕</button></td></tr>
          ))}</tbody>
          <tfoot><tr><td>TOTAL</td><td /><td>{fmt(total)}</td><td /><td /></tr></tfoot>
        </table>
        <p style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '12px 0 0' }}><button type="button" className="btn primary" onClick={save}>Save</button>
          <span className="mute">{dirty ? 'Unsaved changes. Click Save to keep them.' : msg}</span></p>
      </div>
    </>
  );
}

// Doubling: yarn is given to a company (e.g. 56s) and they bring back the doubled yarn (e.g. 2/56s).
// Saved rows are one "given" row and one "received" row per count; this joins them back into lines.
const PLIES = [2, 3, 4];
function doublingLines(rows) {
  const out = {};
  rows.forEach(r => {
    const rec = r.note === 'received';
    const base = rec && r.count.includes('/') ? r.count.split('/').slice(1).join('/') : r.count;
    const k = r.party + '|' + base;
    const g = (out[k] ||= { party: r.party, count: base, bags: 0, ply: 2, inBags: 0, ids: [] });
    g.ids.push(r.id);
    if (rec) { g.inBags += r.bags || 0; g.ply = +r.count.split('/')[0] || 2; } else g.bags += r.bags || 0;
  });
  return Object.values(out);
}

function Doubling({ date, masters }) {
  const [party, setParty] = useState(() => { try { return sessionStorage.getItem('doublingParty') || ''; } catch { return ''; } });
  const [rows, setRows] = useState([]); // everything entered on this date
  const [lines, setLines] = useState([]); // this company's lines: [{count, bags, ply, inBags}]
  const [msg, setMsg] = useState('');
  const company = masters.parties.includes(party) ? party : (masters.parties[0] || '');
  const load = useCallback(() => api(`/api/report?date=${date}`).then(r => setRows(r.doubling?.rows || [])), [date]);
  useEffect(() => { load(); }, [load]);
  // lines come from what is saved for this company on this date
  useEffect(() => {
    setLines(doublingLines(rows.filter(r => r.party === company)).map(g => ({ count: g.count, bags: String(g.bags || ''), ply: g.ply, inBags: String(g.inBags || '') })));
    setMsg('');
  }, [rows, company]);
  const pick = p => { setParty(p); try { sessionStorage.setItem('doublingParty', p); } catch { /* ignore */ } };
  const counts = masters.counts;
  const used = lines.map(l => l.count);
  const setLine = (i, patch) => setLines(lines.map((l, k) => (k === i ? { ...l, ...patch } : l)));
  const save = async () => {
    try {
      await api('/api/winding/day', { method: 'PUT', body: { date, kind: 'doubling', party: company, lines: lines.map(l => ({ count: l.count, bags: num(l.bags), ply: l.ply, inBags: num(l.inBags) })) } });
      await load(); setMsg('Saved');
    } catch (x) { setMsg(x.message); }
  };
  const given = lines.reduce((s, l) => s + num(l.bags), 0);
  const got = lines.reduce((s, l) => s + num(l.inBags), 0);
  const day = doublingLines(rows);
  // a count that is no longer in Master (older entry) stays selectable so it still shows
  const opts = cur => [...counts, ...(cur && !counts.includes(cur) ? [cur] : [])].map(c => <option key={c} value={c} disabled={c !== cur && used.includes(c)}>{c}</option>);
  const removeDay = async g => { for (const id of g.ids) await api(`/api/winding/${id}`, { method: 'DELETE' }); load(); };
  return (
    <>
      <div className="card entrybar">
        <div className="bar">
          <label>Company
            <select value={company} onChange={e => pick(e.target.value)}>
              {masters.parties.map(p => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        </div>
        <div className="strip"><b>{company || 'No company'} | {date}</b><span>{lines.filter(l => num(l.bags) || num(l.inBags)).length} lines entered</span><span>Given {given} bags</span><span>Received {got} bags</span></div>
      </div>

      <div className="card">
        <h2>{company} <span className="rep-sub">given count → doubled count received</span></h2>
        <table className="rep entry">
          <thead><tr><th>Count given</th><th>Bags given</th><th>Ply</th><th>Count received</th><th>Bags received</th></tr></thead>
          <tbody>
            {lines.map((l, i) => (
              <tr key={i}>
                <td>
                  <select value={l.count} onChange={e => setLine(i, { count: e.target.value })}>{opts(l.count)}</select>
                  <> <button type="button" className="x" title="Remove this line" onClick={() => setLines(lines.filter((_, k) => k !== i))}>✕</button></>
                </td>
                <td><CalcInput placeholder="bags" width={90} value={l.bags} onChange={v => setLine(i, { bags: v })} /></td>
                <td><select value={l.ply} onChange={e => setLine(i, { ply: +e.target.value })}>{PLIES.map(n => <option key={n} value={n}>{n} ply</option>)}</select></td>
                <td><b>{l.ply}/{l.count}</b></td>
                <td><CalcInput placeholder="bags" width={90} value={l.inBags} onChange={v => setLine(i, { inBags: v })} /></td>
              </tr>
            ))}
            <tr>
              <td>
                <select value="" onChange={e => e.target.value && setLines([...lines, { count: e.target.value, bags: '', ply: 2, inBags: '' }])}>
                  <option value="">Select count…</option>{opts('')}
                </select>
              </td>
              <td><input type="text" disabled placeholder="bags" style={{ width: 90 }} /></td>
              <td /><td />
              <td><input type="text" disabled placeholder="bags" style={{ width: 90 }} /></td>
            </tr>
          </tbody>
          <tfoot><tr><td>TOTAL</td><td><b>{given}</b></td><td /><td /><td><b>{got}</b></td></tr></tfoot>
        </table>
        <p style={{ margin: '12px 0 0', display: 'flex', gap: 12, alignItems: 'center' }}><button type="button" className="btn primary" onClick={save}>Save</button> <span className="mute">{msg}</span></p>
      </div>

      <div className="card">
        <h2>Doubling — {date}</h2>
        <table className="rep">
          <thead><tr><th>Company</th><th>Count given</th><th>Bags given</th><th>Count received</th><th>Bags received</th><th /></tr></thead>
          <tbody>
            {day.map(g => <tr key={g.party + g.count}><td>{g.party}</td><td>{g.count}</td><td>{g.bags || '–'}</td><td>{g.inBags ? `${g.ply}/${g.count}` : '–'}</td><td>{g.inBags || '–'}</td><td><button type="button" className="x" title="Remove this entry" onClick={() => removeDay(g)}>✕</button></td></tr>)}
            {!day.length && <tr><td colSpan={6} className="mute" style={{ textAlign: 'left' }}>No entries for this date.</td></tr>}
          </tbody>
          <tfoot><tr><td>TOTAL</td><td /><td>{day.reduce((s, g) => s + g.bags, 0)}</td><td /><td>{day.reduce((s, g) => s + g.inBags, 0)}</td><td /></tr></tfoot>
        </table>
      </div>
    </>
  );
}
// bags + loose cones (40 per bag) as the sheet writes it, e.g. 10 bags + 60 cones = 11 (Loose cone bag = 1)
const coneEq = (bags, cones) => {
  const extra = Math.floor(cones / 40);
  return <span className="eq" style={{ whiteSpace: 'nowrap' }}>= <b>{bags + extra}</b>{cones > 0 && <span className="loose"> (Loose cone bag = {extra})</span>}</span>;
};
const dash = n => (n ? n : '–');

function Report({ date }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState('');
  const [which, setWhich] = useState(() => { try { return sessionStorage.getItem('reportWhich') || 'all'; } catch { return 'all'; } });
  const pick = k => { setWhich(k); try { sessionStorage.setItem('reportWhich', k); } catch { /* ignore */ } };
  useEffect(() => {
    setD(null); setErr('');
    Promise.all([
      api(`/api/bale-stock?date=${date}`), api(`/api/single-cone?date=${date}`),
      api(`/api/brand-stock/chippam?date=${date}`), api(`/api/brand-stock/conebags?date=${date}`),
      api(`/api/report?date=${date}`), api('/api/masters'),
    ]).then(([bales, sc, chippam, conebags, rep, m]) => setD({ bales, sc, chippam, conebags, winding: rep.winding, m }))
      .catch(x => setErr(x.message));
  }, [date]);
  if (err) return <div className="err">{err}</div>;
  if (!d) return 'Loading…';
  const { m } = d;
  const pretty = new Date(date + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'long', day: '2-digit', month: 'long', year: 'numeric' });

  // Single cone: one table per unit, only the counts that have stock
  const singleUnit = u => {
    const places = m.places.filter(p => p.group === u.code).map(p => p.name);
    const cols = places.length ? places : [null];
    const get = (c, p) => {
      if (p === null) { const x = d.sc.cells.find(r => r.unit === u.code && r.count === c); return { bags: x?.bags || 0, cones: x?.loose_cones || 0 }; }
      const x = d.sc.places.find(r => r.unit === u.code && r.count === c && r.place === p); return { bags: x?.bags || 0, cones: x?.cones || 0 };
    };
    const sum = (cs, ps) => cs.reduce((t, c) => ps.reduce((a, p) => { const g = get(c, p); return { bags: a.bags + g.bags, cones: a.cones + g.cones }; }, t), { bags: 0, cones: 0 });
    const counts = m.counts.filter(c => { const t = sum([c], cols); return t.bags || t.cones; });
    if (!counts.length) return null;
    const Pair = ({ t }) => <span className="pair"><b>{t.bags}</b><b>{t.cones}</b></span>;
    const sub = <span className="pair sub"><span>bags</span><span>loose</span></span>;
    return (
      <div key={u.code} className="rep-block">
        <h3>{u.name}</h3>
        <table className="rep">
          <thead><tr><th>Count</th>{places.length ? places.map(p => <th key={p}>{p}{sub}</th>) : null}<th className="tot">Total{sub}</th></tr></thead>
          <tbody>{counts.map(c => { const t = sum([c], cols); return (
            <tr key={c}><td>{c}</td>{places.length ? places.map(p => { const g = get(c, p); return <td key={p}>{g.bags || g.cones ? <Pair t={g} /> : '–'}</td>; }) : null}
              <td className="tot"><Pair t={t} /><div>{coneEq(t.bags, t.cones)}</div></td></tr>
          ); })}</tbody>
          <tfoot><tr><td>TOTAL</td>{places.length ? places.map(p => { const t = sum(counts, [p]); return <td key={p}><Pair t={t} /><div>{coneEq(t.bags, t.cones)}</div></td>; }) : null}
            <td className="tot">{(() => { const t = sum(counts, cols); return <><Pair t={t} /><div>{coneEq(t.bags, t.cones)}</div></>; })()}</td></tr></tfoot>
        </table>
      </div>
    );
  };
  const scUnits = m.units.map(singleUnit).filter(Boolean);
  const scAll = d.sc.cells.reduce((a, r) => ({ bags: a.bags + r.bags, cones: a.cones + r.loose_cones }), { bags: 0, cones: 0 });

  // Chippam / Cone Bags: per unit, rows (actual + marketing count) that have a quantity, brands as columns
  const brandSheet = (sheet, title) => {
    const qty = (b, r) => sheet.cells.find(c => c.brand === b && c.count === r)?.qty || 0;
    const blocks = m.units.map(u => {
      const rows = sheet.rows.filter(r => sheet.units[r] === u.code && !r.startsWith('~new~') && sheet.cols.some(b => qty(b, r)));
      if (!rows.length) return null;
      const rowTotal = r => sheet.cols.reduce((s, b) => s + qty(b, r), 0);
      return (
        <div key={u.code} className="rep-block">
          <h3>{u.name}</h3>
          <table className="rep">
            <thead><tr><th>Actual count</th><th>Marking</th>{sheet.cols.map(b => <th key={b}>{b}</th>)}<th className="tot">Total</th></tr></thead>
            <tbody>{rows.map(r => <tr key={r}><td>{sheet.actuals[r] || '–'}</td><td>{r}</td>{sheet.cols.map(b => <td key={b}>{dash(qty(b, r))}</td>)}<td className="tot"><b>{rowTotal(r)}</b></td></tr>)}</tbody>
            <tfoot><tr><td>TOTAL</td><td />{sheet.cols.map(b => <td key={b}>{rows.reduce((s, r) => s + qty(b, r), 0)}</td>)}<td className="tot">{rows.reduce((s, r) => s + rowTotal(r), 0)}</td></tr></tfoot>
          </table>
        </div>
      );
    }).filter(Boolean);
    const grand = sheet.cells.reduce((s, c) => s + (c.qty || 0), 0);
    return (
      <section className="card rep-sec">
        <h2>{title}{blocks.length > 0 && <span className="rep-sum">Total {grand}</span>}</h2>
        {blocks.length ? blocks : <p className="mute">No entries for this date.</p>}
      </section>
    );
  };

  const windTotal = d.winding.total;
  const dbl = d.doubling || { rows: [], totalBags: 0 };
  const dbLines = doublingLines(dbl.rows);
  const SHEETS = [['all', 'Combined report'], ['bale', 'Bale Stock'], ['single', 'Single Cone'], ['chippam', 'Chippam'], ['conebags', 'Cone Bags'], ['winding', 'Cone Winding'], ['doubling', 'Doubling']];
  // the combined report leaves out Cone Winding and Doubling; they have their own reports
  const show = k => which === k || (which === 'all' && k !== 'winding' && k !== 'doubling');
  const label = SHEETS.find(x => x[0] === which)[1];
  return (
    <>
      <div className="noprint" style={{ marginBottom: 16 }}>
        <div className="subtabs">{SHEETS.map(([k, l]) => <button key={k} className={which === k ? 'on' : ''} onClick={() => pick(k)}>{l}</button>)}</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn primary" onClick={() => window.print()}>Print {which === 'all' ? 'combined report' : label}</button>
          <a className="btn" href={`/api/report.xlsx?date=${date}${which === 'all' ? '' : '&sheet=' + which}`}>Download Excel</a>
        </div>
      </div>
      <div className="print-title">
        <div className="rep-title">Shivaji Inventory — {which === 'all' ? 'Daily Stock Report' : label}</div>
        <div className="rep-date">{pretty}</div>
      </div>
      {show('bale') && <section className="card rep-sec"><h2>Bale stock <span className="rep-sub">(bales)</span></h2><BaleStockTable rows={d.bales.rows || []} qualities={d.bales.qualities || []} /></section>}
      {show('single') && <section className="card rep-sec">
        <h2>Single cone stock{scUnits.length > 0 && <span className="rep-sum">All units {scAll.bags + Math.floor(scAll.cones / 40)} bags{scAll.cones % 40 ? ` + ${scAll.cones % 40} loose cones` : ''}</span>}</h2>
        {scUnits.length ? scUnits : <p className="mute">No entries for this date.</p>}
      </section>}
      {show('chippam') && brandSheet(d.chippam, 'Chippam')}
      {show('conebags') && brandSheet(d.conebags, 'Cone Bags')}
      {show('winding') && <section className="card rep-sec"><h2>Cone winding</h2>
        {d.winding.rows.length ? (
          <table className="rep">
            <thead><tr><th>Party</th><th>Count</th><th>Weight (kg)</th><th>Note</th></tr></thead>
            <tbody>{d.winding.rows.map(x => <tr key={x.id}><td>{x.party}</td><td>{x.count}</td><td>{fmt(x.weight_kg)}</td><td style={{ textAlign: 'left' }}>{x.note}</td></tr>)}</tbody>
            <tfoot><tr><td>TOTAL</td><td /><td>{fmt(windTotal)}</td><td /></tr></tfoot>
          </table>
        ) : <p className="mute">No entries for this date.</p>}
      </section>}
      {show('doubling') && <section className="card rep-sec"><h2>Doubling{dbLines.length > 0 && <span className="rep-sum">Given {dbLines.reduce((t, g) => t + g.bags, 0)} bags · Received {dbLines.reduce((t, g) => t + g.inBags, 0)} bags</span>}</h2>
        {dbLines.length ? (
          <table className="rep">
            <thead><tr><th>Company</th><th>Count given</th><th>Bags given</th><th>Count received</th><th>Bags received</th></tr></thead>
            <tbody>{dbLines.map(g => <tr key={g.party + g.count}><td>{g.party}</td><td>{g.count}</td><td>{g.bags || '–'}</td><td>{g.inBags ? g.ply + '/' + g.count : '–'}</td><td>{g.inBags || '–'}</td></tr>)}</tbody>
            <tfoot><tr><td>TOTAL</td><td /><td>{dbLines.reduce((t, g) => t + g.bags, 0)}</td><td /><td>{dbLines.reduce((t, g) => t + g.inBags, 0)}</td></tr></tfoot>
          </table>
        ) : <p className="mute">No entries for this date.</p>}
      </section>}
      <div className="rep-foot print-only">Printed from Shivaji Inventory</div>
    </>
  );
}
