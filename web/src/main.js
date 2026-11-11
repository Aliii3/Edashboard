import { Commands, Session, request, loadSnapshot, startSync, stopSync } from './api.js';
import './styles.css';
import { enterScreen, refreshScreen, scrollTop, startSmoothScroll } from './motion.js';
import { isAr, startI18n, translateTree } from './i18n.js';
import { Repo, esc } from '@commerce-os/domain';
import { S } from '@commerce-os/domain';
import { LOGO, NAV, card, chartHover, icon, iconBtn, initials, pad, setPath, ui } from './ui-kit.js';
import { order360, ordersView, overview } from './views-core.js';
import { crmView, driverProfile, inventoryView, shippingView } from './views-ops.js';
import { campaignsView, financeView, roadmapView, settingsView } from './views-biz.js';
import { A, closeModal, customerOptionsFor, field, globalSearch, handleCsv, modalLive, orderDraft, renderDraftLines, run, syncAssign, toast } from './actions.js';
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
let _renderQueued = false, _screenKey = '';
function render() {
  if (!Session.user || !Repo.data) return;
  ui.route = parseRoute();
  if (!allowed(ui.route)) { const h = home(); if (location.hash !== h) { location.hash = h; return; } ui.route = parseRoute(); }
  const navPage = ui.route.page === 'driver' ? 'shipping' : ui.route.page;
  document.getElementById('workspaceName').textContent = S().company;
  document.getElementById('nav').innerHTML = Session.isDriver ? `<a href="${home()}" class="active" aria-current="page">${icon('shipping')}<span class="nav-title">My deliveries</span></a>` : NAV.filter(([p]) => Session.canSee(p)).map(([p, name]) => `<a href="#/${p}" title="${name}" aria-label="${name}" class="${navPage === p ? 'active' : ''}" ${navPage === p ? 'aria-current="page"' : ''}>${icon(p)}<span class="nav-title">${name}</span></a>`).join('');
  translateTree(document.getElementById('nav'));   // measure the highlight against the translated labels
  placeNavPill(document.getElementById('nav'));
  const a = document.activeElement, focusId = a && a.id && a.id.startsWith('s-') ? a.id : null, caret = focusId ? a.selectionStart : 0;
  const main = document.getElementById('main'), openEx = [...main.querySelectorAll('details[open]')].length;
  main.innerHTML = VIEWS[ui.route.page]() + `<div class="footerhint"><span>${esc(Session.user.name)}</span> · <span>${esc(Session.user.role)}</span> · <span>${Session.online ? 'Connected' : 'Reconnecting…'}</span> · <span>No live integrations, messages or payments.</span></div>`;
  /* A new screen or tab flows in. A re-render of the same screen (after a sync or a filter) doesn't. */
  const key = `${location.hash}|${ui.inv?.tab}|${ui.ship?.tab}|${ui.fin?.tab}|${ui.set?.tab}|${ui.ov?.preset}`;
  if (key !== _screenKey) { _screenKey = key; enterScreen(main); } else refreshScreen(main);
  if (focusId) { const el = document.getElementById(focusId); if (el) { el.focus(); try { el.setSelectionRange(caret, caret); } catch { /* not a text input */ } } }
  void openEx;
}
/* The tab highlight slides to the new tab. The edge moving toward it leads and the other
   edge catches up, so the highlight stretches and settles. */
let _pill = null;
const EASE_OUT = 'cubic-bezier(.215,.61,.355,1)', EASE_IN_OUT = 'cubic-bezier(.645,.045,.355,1)';
function placeNavPill(nav) {
  const a = nav.querySelector('a.active'); if (!a) { _pill = null; return; }
  /* On narrow screens the bar scrolls sideways: keep the current tab in view. Positions are measured
     against the visible box, which is what absolute positioning inside a scrolling bar uses. */
  if (nav.scrollWidth > nav.clientWidth) { const want = a.offsetLeft - (nav.clientWidth - a.offsetWidth) / 2; if (Math.abs(nav.scrollLeft - want) > 4) nav.scrollLeft = want; }
  const l = a.offsetLeft, r = nav.clientWidth - (a.offsetLeft + a.offsetWidth);
  let pill = nav.querySelector('.nav-pill');
  const fresh = !pill; if (fresh) { pill = document.createElement('span'); pill.className = 'nav-pill'; pill.setAttribute('aria-hidden', 'true'); nav.prepend(pill); }
  nav.classList.add('has-pill');
  const set = (x, y) => { pill.style.setProperty('--l', x + 'px'); pill.style.setProperty('--r', y + 'px'); };
  const from = _pill; _pill = { l, r };
  if (!from || (from.l === l && from.r === r)) { pill.style.transition = 'none'; set(l, r); return; }
  if (fresh) { pill.style.transition = 'none'; set(from.l, from.r); void pill.offsetWidth; }
  const right = l > from.l;
  pill.style.transition = '';
  pill.style.setProperty('--dl', right ? '.55s' : '.36s'); pill.style.setProperty('--el', right ? EASE_IN_OUT : EASE_OUT);
  pill.style.setProperty('--dr', right ? '.36s' : '.55s'); pill.style.setProperty('--er', right ? EASE_OUT : EASE_IN_OUT);
  set(l, r);
}
function queueRender() { if (_renderQueued) return; _renderQueued = true; requestAnimationFrame(() => { _renderQueued = false; render(); }); }
function bindEvents() {
  window.addEventListener('hashchange', () => { closeModal(); render(); scrollTop(); });
  window.addEventListener('resize', () => { const nav = document.getElementById('nav'); if (nav && !nav.closest('[hidden]')) { _pill = null; placeNavPill(nav); } });
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
    if (t.dataset.roadmap) return run(() => Commands.setRoadmap(t.dataset.roadmap, t.checked));
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
function loginView() {
  document.getElementById('header').hidden = true; document.getElementById('dock').hidden = true; document.getElementById('rail').hidden = true;
  document.getElementById('main').innerHTML = `<div class="login"><div class="login-lang">${langToggle()}</div><form id="loginForm" class="card"><div class="pad"><span class="logo-mark" aria-hidden="true">${LOGO(44)}</span><h1>Sign in to Commerce OS</h1><label class="field mt">Email<input name="email" type="email" required autocomplete="username"></label><label class="field mt">Password<input name="password" type="password" required autocomplete="current-password"></label><p id="loginError" class="form-error" role="alert"></p><button class="primary mt" style="width:100%">Sign in</button></div></form></div>`;
  document.getElementById('loginForm').addEventListener('submit', async e => {
    e.preventDefault(); const f = Object.fromEntries(new FormData(e.target));
    try { const r = await request('/api/auth/login', { method: 'POST', body: f }); Session.user = r.user; await enter(); }
    catch (err) { document.getElementById('loginError').textContent = err.message; }
  });
}
/* Switches between English and Arabic. The label is the other language, written in that language. */
const langToggle = () => `<button type="button" class="iconbtn lang-toggle" data-a="toggleLang" data-no-i18n aria-label="${isAr() ? 'English' : 'العربية'}" title="${isAr() ? 'English' : 'العربية'}">${isAr() ? 'EN' : 'ع'}</button>`;
/* Side bar and header buttons: shortcuts to the things people do most, shown only when the role can do them. */
function renderChrome() {
  document.getElementById('logoMark').innerHTML = LOGO(32);
  const rail = document.getElementById('rail'), link = (page, ic, label) => Session.canSee(page) ? `<a class="iconbtn" href="#/${page}" aria-label="${label}" title="${label}">${icon(ic)}</a>` : '';
  rail.hidden = Session.isDriver;
  rail.innerHTML = Session.isDriver ? '' : [iconBtn('search', 'focusSearch', undefined, 'Search (⌘K)'), iconBtn('plus', 'newOrder', undefined, 'New order'), iconBtn('upload', 'importModal', undefined, 'Import orders from CSV'), iconBtn('download', 'exportOrders', undefined, 'Export orders as CSV'), '<span class="rail-gap"></span>', link('orders', 'orders', 'Orders'), link('shipping', 'truck', 'Shipping'), link('finance', 'finance', 'Finance'), '<span class="rail-gap"></span>', link('roadmap', 'roadmap', 'Roadmap'), link('settings', 'settings', 'Settings')].join('');
  document.getElementById('topActions').innerHTML = (Session.isDriver ? '' : iconBtn('search', 'focusSearch', undefined, 'Search (⌘K)')) + iconBtn('refresh', 'syncNow', undefined, 'Get the latest changes') + langToggle();
}
async function enter() {
  Session.onProgress = (i, n) => { const el = document.getElementById('main'); if (el && !Repo.data) el.innerHTML = `<p class="empty">Loading workspace… ${Math.round(i / n * 100)}%</p>`; };
  await loadSnapshot(); startSync();
  document.getElementById('header').hidden = false; document.getElementById('dock').hidden = Session.isDriver;
  document.getElementById('accountBtn').textContent = initials(Session.user.name);
  renderChrome(); startSmoothScroll();
  if (!location.hash || !allowed(parseRoute())) location.hash = home();
  render();
}
const home = () => Session.isDriver ? `#/drivers/${Session.user.driverId}` : Session.canSee('overview') ? '#/overview' : '#/orders';
const allowed = r => Session.canSee(r.page) && (!Session.isDriver || r.id === Session.user.driverId);
async function boot() {
  startI18n();
  bindEvents();
  Session.onChange = queueRender;
  Session.onAuthLost = () => { stopSync(); Repo.data = null; closeModal(); Session.user = null; loginView(); };
  try { Session.demoTools = (await request('/api/config')).demoTools; const me = await request('/api/me'); Session.user = me.user; await enter(); }
  catch { loginView(); }
}
boot();

export { VIEWS, _renderQueued, allowed, bindEvents, boot, enter, home, loginView, parseRoute, queueRender, render };
/* Test builds only: exposes modules so browser tests can compare screens with records. */
if (import.meta.env.MODE === 'e2e') {
  Promise.all([import('@commerce-os/domain'), import('./ui-kit.js')]).then(([dom, kit]) => Object.assign(window, dom, kit, { render }));
}
