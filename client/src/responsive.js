// On phones and tablets the CSS turns every table row into a block (card). Each cell needs to know its
// column heading, so this copies the (possibly two-level) heading text onto the cells as data-label.
const clean = th => {
  const sel = th.querySelector('select');
  if (sel) return sel.selectedOptions[0]?.text.replace(/^Select .*/, 'Add…') || '';
  const c = th.cloneNode(true);
  c.querySelectorAll('.sub, button, select').forEach(n => n.remove());
  return c.textContent.replace(/\s+/g, ' ').trim();
};

function labelTable(t) {
  const head = t.tHead;
  const labels = []; // column index -> heading text
  const taken = [];
  if (head) {
    [...head.rows].forEach((tr, r) => {
      let col = 0;
      [...tr.cells].forEach(th => {
        while (taken[r]?.[col]) col++;
        const text = clean(th);
        for (let i = 0; i < th.colSpan; i++) {
          for (let j = 0; j < th.rowSpan; j++) { (taken[r + j] ||= [])[col + i] = true; }
          labels[col + i] = [labels[col + i], text].filter(Boolean).join(' · ');
        }
        col += th.colSpan;
      });
    });
    t.classList.toggle('hc', !!head.querySelector('select, button'));
  }
  [...t.tBodies, t.tFoot].filter(Boolean).forEach(sec => [...sec.rows].forEach(tr => {
    let col = 0;
    [...tr.cells].forEach((td, i) => {
      const l = i === 0 && !(t.dataset.labelfirst && sec !== t.tFoot) ? '' : labels[col] || '';
      if (td.dataset.label !== l) td.dataset.label = l;
      col += td.colSpan;
    });
  }));
}

export function startResponsiveTables() {
  let queued = false;
  const run = () => { queued = false; document.querySelectorAll('table').forEach(labelTable); };
  const schedule = () => { if (!queued) { queued = true; requestAnimationFrame(run); } };
  new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true });
  document.addEventListener('change', schedule, true);
  schedule();
}
