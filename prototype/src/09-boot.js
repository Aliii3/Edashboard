/* ==========================================================================
   LAYER 7 · APP SHELL: router, render loop, delegated events and startup.
   ========================================================================== */
function parseRoute() {
  const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean), head = parts[0] || 'overview';
  if (head === 'orders' && parts[1]) return { page: 'order360', id: decodeURIComponent(parts[1]) };
  if (head === 'customers' && parts[1]) return { page: 'crm', id: decodeURIComponent(parts[1]) };
  if (head === 'customers') return { page: 'crm', id: null };
  if (head === 'drivers' && parts[1]) return { page: 'driver', id: decodeURIComponent(parts[1]) };
  return { page: NAV.some(n => n[0] === head) ? head : 'overview', id: null };
}
const VIEWS = { overview, orders: ordersView, order360, crm: crmView, inventory: inventoryView, shipping: shippingView, driver: () => driverProfile(ui.route.id), finance: financeView, campaigns: campaignsView, settings: settingsView, roadmap: roadmapView };
let _renderQueued = false;
function render() {
  ui.route = parseRoute();
  const navPage = ui.route.page === 'driver' ? 'shipping' : ui.route.page;
  document.getElementById('workspaceName').textContent = S().company;
  document.getElementById('nav').innerHTML = NAV.map(([p, name]) => `<a href="#/${p}" title="${name}" aria-label="${name}" class="${navPage === p ? 'active' : ''}" ${navPage === p ? 'aria-current="page"' : ''}>${icon(p)}<span class="nav-title">${name}</span></a>`).join('');
  const a = document.activeElement, focusId = a && a.id && a.id.startsWith('s-') ? a.id : null, caret = focusId ? a.selectionStart : 0;
  const main = document.getElementById('main'), openEx = [...main.querySelectorAll('details[open]')].length;
  main.innerHTML = VIEWS[ui.route.page]() + `<div class="footerhint">Interactive prototype · Fictional data · ${esc(StorageAdapter.label())} · No live integrations, messages or payments.</div>`;
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch { /* not a text input */ } } }
  void openEx;
}
function queueRender() { if (_renderQueued) return; _renderQueued = true; requestAnimationFrame(() => { _renderQueued = false; render(); }); }
function bindEvents() {
  window.addEventListener('hashchange', () => { closeModal(); render(); window.scrollTo(0, 0); });
  document.addEventListener('click', e => {
    const close = e.target.closest('[data-close]'); if (close) return closeModal();
    const rm = e.target.closest('[data-dl-rm]'); if (rm) { orderDraft.splice(Number(rm.dataset.dlRm), 1); return renderDraftLines(); }
    if (e.target.closest('[data-dl-add]')) { orderDraft.push({ sku: Repo.all('skus')[0].id, qty: 1, discount: 0 }); return renderDraftLines(); }
    const t = e.target.closest('[data-a]'); if (!t) { if (!e.target.closest('.command-dock')) document.getElementById('searchResults').hidden = true; return; }
    if (t.getAttribute('aria-disabled') === 'true') return toast(t.dataset.why || 'Not available.', 'bad');
    const v = t.dataset.v ? JSON.parse(t.dataset.v) : undefined; A[t.dataset.a]?.(v);
  });
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset.f && !t.dataset.live) { setPath(t.dataset.f, t.value); if (t.dataset.t && ui.tbl[t.dataset.t]) ui.tbl[t.dataset.t].p = 0; return render(); }
    if (t.dataset.sel !== undefined) { const id = Number(t.dataset.sel); t.checked ? ui.selected.add(id) : ui.selected.delete(id); return render(); }
    if (t.dataset.selall) { JSON.parse(t.dataset.selall).forEach(id => t.checked ? ui.selected.add(id) : ui.selected.delete(id)); return render(); }
    if (t.dataset.pagesize) { const st = ui.tbl[t.dataset.pagesize]; st.size = Number(t.value); st.p = 0; return render(); }
    if (t.dataset.avail) return run(() => Commands.setAvailability(t.dataset.avail, t.value), 'Availability updated.');
    if (t.dataset.source) return run(() => Commands.saveSettings({ sources: { ...S().sources, [t.dataset.source]: t.value } }), t.value === 'API (planned)' ? 'Preference saved. No API is connected.' : 'Preference saved.');
    if (t.dataset.roadmap) { Repo.tx(() => { Repo.data.roadmap[t.dataset.roadmap] = t.checked; Repo.touch(); }); return; }
    if (t.dataset.assignMode) return syncAssign();
    if (t.dataset.dl) { orderDraft[Number(t.dataset.i)][t.dataset.dl] = t.value; return renderDraftLines(); }
    if (t.id === 'csvFile') return handleCsv(t.files[0]);
    if (t.closest('#dialog') && modalLive) modalLive(e);
  });
  let liveT = null;
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset.live) { setPath(t.dataset.f, t.value); clearTimeout(liveT); liveT = setTimeout(() => { if (t.dataset.t && ui.tbl[t.dataset.t]) ui.tbl[t.dataset.t].p = 0; render(); }, 180); return; }
    if (t.name === 'customerPick') { document.getElementById('custList').innerHTML = customerOptionsFor(t.value.includes(' · ') ? '' : t.value); return; }
    if (t.dataset.dlTotal) return renderDraftLines();
    if (t.closest('#dialog') && modalLive && (t.dataset.alloc || t.dataset.deliver || t.dataset.amount)) modalLive(t.dataset.amount ? { target: t } : e);
  });
  document.addEventListener('submit', e => {
    const f = e.target; if (!f.dataset.form) return; e.preventDefault();
    const vals = Object.fromEntries(new FormData(f));
    if (f.dataset.form === 'saveWorkspace') { vals.pageSize = Number(vals.pageSize); ui.tbl = {}; run(() => Commands.saveSettings(vals), 'Workspace saved.'); }
    if (f.dataset.form === 'saveRules') { for (const k of ['tolerance', 'overdueHours', 'driverFee', 'returnFeeDriver']) vals[k] = Number(vals[k]); run(() => Commands.saveSettings(vals), 'Rules saved. Figures recalculated.'); }
  });
  document.addEventListener('mousemove', chartHover); document.addEventListener('touchstart', e => { const t = e.touches[0]; chartHover({ target: e.target, clientX: t.clientX }); }, { passive: true });
  document.getElementById('dialog').addEventListener('click', e => { if (e.target.id === 'dialog') closeModal(); });
  const dock = document.getElementById('dock'), input = dock.elements.query, box = document.getElementById('searchResults');
  const show = () => { const list = globalSearch(input.value); box.hidden = input.value.trim().length < 2; box.innerHTML = list.map(r => `<a href="${r.href}"><strong>${esc(r.title)}</strong><small>${esc(r.sub)}</small></a>`).join('') || `<p class="empty">No matches for “${esc(input.value)}”.</p>`; };
  input.addEventListener('input', show); input.addEventListener('focus', show);
  box.addEventListener('click', e => { if (e.target.closest('a')) { box.hidden = true; input.value = ''; } });
  dock.addEventListener('submit', e => { e.preventDefault(); const first = globalSearch(input.value)[0]; if (first) { location.hash = first.href; box.hidden = true; input.value = ''; } });
  document.addEventListener('keydown', e => { if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); } if (e.key === 'Escape') box.hidden = true; });
}
async function handleCsv(file) {
  const el = document.getElementById('importPreview'); pendingImport = null; el.innerHTML = ''; if (!file) return;
  try {
    if (file.size > 5e6) throw new Rule('The file is larger than 5 MB.');
    const res = prepareImport(await file.text()); pendingImport = res;
    const rowsOk = res.total - res.errors.length;
    el.innerHTML = `${note(`<strong>${res.groups.length} valid order${res.groups.length === 1 ? '' : 's'}</strong> from ${rowsOk} of ${res.total} rows. ${res.errors.length ? `<strong>${res.errors.length} row${res.errors.length > 1 ? 's' : ''} will be skipped.</strong>` : 'No errors.'}`, res.errors.length ? 'warning' : '')}
      ${res.groups.length ? simpleTable(['External ref', 'Date', 'Customer', 'Lines', 'Payment'], res.groups.slice(0, 8).map(g => `<tr><td>${esc(g.ref)}</td><td>${esc(g.date)}</td><td>${esc(g.name || g.phone)}${Repo.by('customers', 'phone', g.phone)[0] ? ' <small>existing</small>' : ' <small>new</small>'}</td><td>${g.lines.map(l => `${l.qty} × ${esc(l.sku)}`).join(', ')}</td><td>${esc(g.paymentMethod)}</td></tr>`)) : ''}
      ${res.errors.length ? `<h3 class="mt">Rows with problems</h3>${simpleTable(['Row', 'Ref', 'Problem'], res.errors.slice(0, 20).map(x => `<tr><td>${x.row}</td><td>${esc(x.ref)}</td><td class="wrap">${esc(x.msg)}</td></tr>`))}` : ''}`;
  } catch (err) { el.innerHTML = `<p class="form-error">${esc(err instanceof Rule ? err.message : 'That file could not be read.')}</p>`; }
}
async function boot() {
  await StorageAdapter.init();
  let saved = null; try { saved = migrate(await StorageAdapter.load()); } catch { saved = null; }
  if (saved) Repo.load(saved); else { buildSeedWorkspace(); StorageAdapter.saveNow(Repo.data); }
  Repo.listeners.push(() => { StorageAdapter.saveSoon(Repo.data); queueRender(); });
  bindEvents(); render();
}
if (typeof document !== 'undefined') boot();
