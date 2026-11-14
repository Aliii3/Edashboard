import { linesOf } from '@commerce-os/domain';
import { Session } from './api.js';
import { Repo, esc } from '@commerce-os/domain';
import { Guards, S, activeDelivery, carrierKey, carrierName, casesOf, collectionOutcome, customerOf, dateKey, isOverdue, money, paymentStatus } from '@commerce-os/domain';
import { order360, overview } from './views-core.js';
import { A } from './actions.js';
/* ==========================================================================
   LAYER 4 · UI KIT: formatting, router, event delegation and shared components.
   Views are pure functions of state. Interaction goes through data-a actions,
   so one document-level listener serves every row however large the tables get.
   ========================================================================== */
const m = n => money(n);
let _fd = null, _fdt = null, _ftz = null;
function _fmt() { const tz = S().timezone; if (_ftz !== tz) { _fd = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', year: 'numeric' }); _fdt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false }); _ftz = tz; } }
const fd = iso => { if (!iso) return '—'; _fmt(); return _fd.format(new Date(iso)); };
const fdt = iso => { if (!iso) return '—'; _fmt(); return _fdt.format(new Date(iso)); };
const today = () => dateKey(new Date().toISOString());
const dayShift = (key, n) => { const d = new Date(key + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const act = (name, arg) => `data-a="${name}"${arg !== undefined ? ` data-v="${esc(JSON.stringify(arg))}"` : ''}`;
/* Buttons a user's role can't use aren't shown. The server still enforces this on every request. */
const ACTION_COMMAND = { closePeriodModal: 'closePeriod', reopenPeriodModal: 'reopenPeriod', newOrder: 'createOrder', importModal: 'importOrders', confirmOrder: 'confirmOrder', advance: 'advanceOrder', cancelModal: 'cancelOrder', orderNoteModal: 'addOrderNote', attributeModal: 'attribute', bulkConfirm: 'confirmOrder', bulkAdvance: 'advanceOrder', bulkAssign: 'assign', assignModal: 'shipOrder', shipModal: 'shipOrder', bulkShip: 'shipOrder', bulkReady: 'advanceOrder', bulkPickup: 'pickup', trackingModal: 'setTracking', storeSaleModal: 'storeSale', employeeModal: 'saveEmployee', attSet: 'recordAttendance', attTime: 'recordAttendance', attNow: 'recordAttendance', attAllPresent: 'recordAttendanceDay', attRemove: 'removeAttendance', assignPicker: 'assign', prepayModal: 'prepay', refundModal: 'refund', caseModal: 'openCase', acceptCase: 'acceptReturn', rejectCaseModal: 'rejectCase', replacementModal: 'createReplacement', closeCase: 'closeCase', pickup: 'pickup', ofd: 'setDeliveryStatus', returnStart: 'startReturn', receive: 'receiveAtWarehouse', cancelAssign: 'reassign', reassignModal: 'reassign', handoffModal: 'driverHandover', failModal: 'setDeliveryStatus', retryModal: 'setDeliveryStatus', deliverModal: 'deliver', collectModal: 'collect', handoverModal: 'recordHandover', expenseDriverModal: 'addDriverExpense', decideExp: 'decideDriverExpense', resolveModal: 'resolveDiscrepancy', driverModal: 'saveDriver', courierModal: 'saveCourier', settlementModal: 'recordSettlement', boughtSkuModal: 'saveSku', itemModal: 'saveMaterial', payCourierModal: 'recordSettlement', stockModal: 'adjustStock', materialModal: 'receiveMaterial', skuModal: 'saveSku', productionModal: 'createProduction', startMO: 'startProduction', completeMO: 'completeProduction', cancelMO: 'cancelProduction', customerModal: 'saveCustomer', contactModal: 'logContact', toggleTag: 'setCustomerTags', campaignModal: 'saveCampaign', spendModal: 'addSpend', expenseModal: 'addExpense', removeExpense: 'removeExpense' };
function btn(label, name, arg, o = {}) { if (ACTION_COMMAND[name] && !Session.can(ACTION_COMMAND[name])) return ''; return `<button type="button" class="${o.cls || ''}${o.why ? ' is-off' : ''}" ${act(name, arg)} ${o.why ? `aria-disabled="true" data-why="${esc(o.why)}" title="${esc(o.why)}"` : ''} ${o.aria ? `aria-label="${esc(o.aria)}"` : ''}>${label}</button>`; }
const tone = {
  green: ['Present', 'Active', 'Delivered', 'Paid', 'Reconciled', 'Settled', 'Handed over', 'Completed', 'VIP', 'Available', 'Approved', 'Accepted', 'Closed', 'Resolved', 'Healthy', 'Returned to Warehouse', 'Pass', 'Unchanged'],
  red: ['Absent', 'Failed Delivery', 'Failed Attempt', 'Refund review', 'Overpaid', 'Discrepancy', 'Open', 'Rejected', 'Low stock', 'Courier short-paid', 'Overdue', 'Unpaid', 'Fail', 'Inactive', 'Changed'],
  orange: ['Late', 'Leave', 'New', 'Pending', 'Part-prepaid', 'Partially collected', 'Part handed over', 'Driver holds cash', 'Courier owes', 'Retry Scheduled', 'Return in Transit', 'Busy', 'Follow-up', 'Planned', 'Requested', 'Assigned', 'Ready', 'Prepaid', 'Reorder soon'],
  blue: ['Confirmed', 'Processing', 'Shipped', 'Picked Up', 'Out for Delivery', 'WIP', 'CSV', 'Manual', 'Repeat', 'Item received', 'Replacement created'],
  purple: ['Partially Delivered', 'Partially Returned', 'Returned', 'Exchange', 'Handed Over'],
};
const toneOf = new Map(); for (const k in tone) for (const v of tone[k]) toneOf.set(v, k);
const badge = t => `<span class="badge ${toneOf.get(t) || ''}">${esc(t)}</span>`;
const ICONS = { search: '<circle cx="11" cy="11" r="6.5"/><path d="m20 20-4.2-4.2"/>', plus: '<path d="M12 5v14M5 12h14"/>', upload: '<path d="M12 15V4m0 0-4 4m4-4 4 4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>', download: '<path d="M12 4v11m0 0-4-4m4 4 4-4M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>', refresh: '<path d="M20 11a8 8 0 0 0-14.6-4.5L4 8m0-4v4h4M4 13a8 8 0 0 0 14.6 4.5L20 16m0 4v-4h-4"/>', user: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>', more: '<circle cx="5" cy="12" r="1.2"/><circle cx="12" cy="12" r="1.2"/><circle cx="19" cy="12" r="1.2"/>', arrow: '<path d="M7 17 17 7M8 7h9v9"/>', truck: '<path d="M3 6h11v10H3zM14 10h4l3 3v3h-7"/><circle cx="7" cy="18" r="1.6"/><circle cx="17" cy="18" r="1.6"/>', overview: '<path d="m3 10 9-7 9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/>', orders: '<rect x="5" y="3" width="14" height="18" rx="3"/><path d="M9 8h6M9 12h6M9 16h4"/>', order360: '<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3"/><path d="M12 1v3m0 16v3M1 12h3m16 0h3"/>', crm: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3m1-16a3 3 0 0 1 0 6m2 3a5 5 0 0 1 3 4v3"/>', inventory: '<path d="m12 3 9 5v10l-9 5-9-5V8Zm0 10v10M3 8l9 5 9-5"/>', shipping: '<path d="M3 5h12v12H3m12-8h4l3 4v4h-7"/><circle cx="7" cy="18" r="2"/><circle cx="18" cy="18" r="2"/>', finance: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 5V3h8v2M8 15v3m4-6v6m4-9v9"/>', campaigns: '<path d="M3 11v5h4l10 4V5L7 10H4a1 1 0 0 0-1 1Zm4 5 2 6h3l-2-5"/>', settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M5 5l2 2m10 10 2 2M5 19l2-2M17 7l2-2"/>', roadmap: '<path d="M5 3v18M5 5h14l-3 4 3 4H5"/>', money: '<rect x="3" y="6" width="18" height="12" rx="2"/><circle cx="12" cy="12" r="3"/>', bag: '<rect x="5" y="7" width="14" height="15" rx="3"/><path d="M9 8V5a3 3 0 0 1 6 0v3"/>', clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>', alert: '<circle cx="12" cy="12" r="8"/><path d="M12 7v6m0 3v1"/>', hand: '<path d="M4 14h4l3 2h5a2 2 0 0 0 0-4h-3M4 20h12l5-4M9 8a3 3 0 1 0 6 0 3 3 0 0 0-6 0"/>', products: '<path d="M3 12.5V4a1 1 0 0 1 1-1h8.5l8.5 8.5-9.5 9.5Z"/><circle cx="8" cy="8" r="1.6"/>', staff: '<rect x="4" y="5" width="16" height="16" rx="3"/><path d="M8 3v4m8-4v4M4 10h16m-11 5 2 2 4-4"/>', store: '<path d="M4 9 5.5 4h13L20 9M4 9v11h16V9M4 9h16M9 20v-6h6v6"/>', print: '<path d="M7 9V4h10v5M7 17H5a1 1 0 0 1-1-1v-6a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-2M7 14h10v6H7Z"/>' };
const icon = k => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[k] || ICONS.orders}</svg>`;
/* Product mark: an open ring (the order cycle) with the parcel that travels it. */
const LOGO = (size = 32) => `<svg class="logo-svg" width="${size}" height="${size}" viewBox="0 0 40 40" aria-hidden="true"><defs><linearGradient id="lg-${size}" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#5d7bff"/><stop offset="1" stop-color="#2f4bf0"/></linearGradient></defs><rect width="40" height="40" rx="12" fill="url(#lg-${size})"/><path d="M27.5 13.2A10 10 0 1 0 27.5 26.8" fill="none" stroke="#fff" stroke-width="3.6" stroke-linecap="round"/><rect x="25" y="16.5" width="7" height="7" rx="2" fill="#ffd43b"/></svg>`;
/* Round icon button, used in card corners and the side bar. Hidden when the role can't run its command. */
const iconBtn = (ic, name, arg, label, o = {}) => { if (ACTION_COMMAND[name] && !Session.can(ACTION_COMMAND[name])) return ''; return `<button type="button" class="iconbtn ${o.cls || ''}" ${act(name, arg)} aria-label="${esc(label)}" title="${esc(label)}">${icon(ic)}</button>`; };
/* Segmented control: one pill, the current option raised. */
const seg = (path, options) => `<div class="seg" role="group">${options.map(([v, l]) => `<button type="button" class="${getPath(path) === v ? 'on' : ''}" ${act('setTab', [path, v])} aria-pressed="${getPath(path) === v}">${esc(l)}</button>`).join('')}</div>`;
/* Half-circle gauge for a single rate (0 to 1). */
function gauge(rate, label, sub) {
  const r = 70, c = Math.PI * r, v = rate === null ? 0 : Math.max(0, Math.min(1, rate));
  return `<div class="gauge"><svg viewBox="0 0 180 104" role="img" aria-label="${esc(label)}: ${rate === null ? 'no data' : Math.round(v * 100) + '%'}"><path d="M20 94a70 70 0 0 1 140 0" class="g-track"/><path d="M20 94a70 70 0 0 1 140 0" class="g-fill" stroke-dasharray="${(c * v).toFixed(1)} ${c.toFixed(1)}"/></svg><div class="g-val"><strong>${rate === null ? '—' : Math.round(v * 100) + '%'}</strong><small>${esc(sub)}</small></div></div>`;
}
const NAV = [['overview', 'Overview'], ['orders', 'Orders'], ['order360', 'Order 360'], ['crm', 'CRM'], ['products', 'Products'], ['inventory', 'Inventory'], ['shipping', 'Shipping'], ['finance', 'Finance'], ['campaigns', 'Campaigns'], ['staff', 'Staff'], ['settings', 'Settings'], ['roadmap', 'Roadmap']];

/* ---------- UI state, per-screen and never persisted with the records ---------- */
const blankOrderFilters = () => ({ q: '', from: '', to: '', status: '', delivery: '', collection: '', channel: '', campaign: '', method: '', courier: '', driver: '', exception: '', source: '' });
const ui = {
  route: { page: 'overview', id: null, sub: null }, selected: new Set(), tbl: {}, lastOrder: null,
  ov: { preset: '30', from: '', to: '', campaign: '', sku: '', courier: '', driver: '' },
  orders: blankOrderFilters(), crm: { q: '', seg: '' }, products: { q: '' }, staff: { tab: 'Today', date: '', month: '', q: '' }, inv: { tab: 'Finished goods', q: '', kind: '' },
  ship: { tab: 'Dispatch queue', q: '', avail: '', courier: '' }, drv: { tab: 'Current assignments', from: '', to: '', status: '', collection: '', area: '' },
  fin: { tab: 'Profit & loss', preset: 'all', from: '', to: '', courier: '', outcome: '', driver: '', method: '', receipt: '' }, camp: { focus: '' }, set: { tab: 'Workspace', activity: '' }, team: null,
};
const getPath = p => p.split('.').reduce((o, k) => o?.[k], ui);
const setPath = (p, v) => { const ks = p.split('.'), last = ks.pop(); ks.reduce((o, k) => o[k], ui)[last] = v; };

/* ---------- Components ---------- */
const heading = (title, desc, actions = '', crumb = '') => `<div class="heading"><div>${crumb ? `<div class="crumb">${crumb}</div>` : ''}<h1>${title}</h1>${desc ? `<p>${desc}</p>` : ''}</div><div class="actions">${actions}</div></div>`;
const card = (title, body, sub = '', action = '', cls = '') => `<section class="card ${cls}">${title ? `<div class="cardhead"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ''}</div>${action ? `<div class="actions">${action}</div>` : ''}</div>` : ''}${body}</section>`;
const pad = s => `<div class="pad">${s}</div>`;
const kpi = (label, value, sub, o = {}) => { const tag = o.a ? 'button' : 'div'; return `<${tag} class="kpi ${o.a ? 'is-link' : ''} ${o.cls || ''}" ${o.a ? `type="button" ${act(o.a, o.v)}` : ''} ${o.help ? `title="${esc(o.help)}"` : ''}>${o.icon ? `<span class="metric-icon">${icon(o.icon)}</span>` : ''}<span class="kpi-body"><span class="label">${label}</span><span class="value">${value}</span>${sub ? `<small>${sub}</small>` : ''}</span></${tag}>`; };
const row = (l, v, cls = '') => `<div class="row ${cls}"><span>${l}</span><strong>${v}</strong></div>`;
/* A figure with its working: opens to show how it was calculated. */
const expl = (label, value, how, entries = [], cls = '') => `<details class="ex ${cls}"><summary><span>${label}</span><strong>${value}</strong></summary><div class="ex-body"><p>${how}</p>${entries.length ? `<ul>${entries.map(e => `<li><span>${esc(e.why)}${e.at ? ` <small>${fd(e.at)}</small>` : ''}</span><b>${m(e.amt)}</b></li>`).join('')}</ul>` : ''}</div></details>`;
const note = (s, cls = '') => `<div class="note ${cls}">${s}</div>`;
const tabs = (path, list) => `<div class="tabs" role="tablist">${list.map(t => { const cur = getPath(path) === t; return `<button type="button" role="tab" aria-selected="${cur}" class="${cur ? 'active' : ''}" ${act('setTab', [path, t])}>${t}</button>`; }).join('')}</div>`;
const sel = (path, label, options, tbl = '') => { const cur = getPath(path) ?? ''; return `<label class="fsel"><span>${label}</span><select data-f="${path}" data-t="${tbl}">${options.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(cur) ? 'selected' : ''}>${esc(t)}</option>`; }).join('')}</select></label>`; };
const search = (path, placeholder, tbl = '') => `<label class="fsearch"><span class="sr">Search</span><input id="s-${path}" type="search" data-f="${path}" data-t="${tbl}" data-live="1" value="${esc(getPath(path) || '')}" placeholder="${esc(placeholder)}"></label>`;
const dateF = (path, label, tbl = '') => `<label class="fsel"><span>${label}</span><input type="date" data-f="${path}" data-t="${tbl}" value="${esc(getPath(path) || '')}"></label>`;
/* Data grid: filtering happens first, then sort and page, so only the visible
   rows reach the DOM however many records exist. */
function grid(id, rows, cols, o = {}) {
  cols = cols.filter(c => !c.cost || Session.seesCosts);
  const st = ui.tbl[id] || (ui.tbl[id] = { p: 0, s: o.sort ?? null, d: o.dir ?? -1, size: o.size || Number(S().pageSize) || 25 });
  let list = rows;
  const sc = cols.find(c => c.k === st.s);
  if (sc?.sort) { const f = sc.sort; const keyed = list.map(r => [f(r), r]); keyed.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0) * st.d); list = keyed.map(x => x[1]); }
  const pages = Math.max(1, Math.ceil(list.length / st.size)); if (st.p >= pages) st.p = pages - 1;
  const shown = list.slice(st.p * st.size, st.p * st.size + st.size);
  const head = cols.map(c => {
    const label = typeof c.label === 'function' ? c.label(shown) : c.label;
    if (!c.sort) return `<th class="${c.num ? 'number' : ''}" scope="col">${label}</th>`;
    const on = st.s === c.k; return `<th class="${c.num ? 'number' : ''}" scope="col" aria-sort="${on ? (st.d > 0 ? 'ascending' : 'descending') : 'none'}"><button type="button" class="th" ${act('sort', [id, c.k])}>${label}<i>${on ? (st.d > 0 ? '↑' : '↓') : ''}</i></button></th>`;
  }).join('');
  const body = shown.map(r => `<tr class="${o.rowCls ? o.rowCls(r) : ''}">${cols.map(c => `<td class="${c.num ? 'number' : ''} ${c.wrap ? 'wrap' : ''}">${c.render(r)}</td>`).join('')}</tr>`).join('');
  const footer = list.length > Math.min(st.size, 10) ? `<div class="table-footer">${btn('← Previous', 'page', [id, -1], { cls: 'ghost', why: st.p === 0 ? 'Already on the first page.' : '' })}<span>Page ${st.p + 1} of ${pages} · ${list.length.toLocaleString('en-US')} records</span><span class="pgsz"><label>Rows <select data-pagesize="${id}">${[10, 25, 50, 100].map(n => `<option value="${n}" ${n === st.size ? 'selected' : ''}>${n}</option>`).join('')}</select></label>${btn('Next →', 'page', [id, 1], { cls: 'ghost', why: st.p >= pages - 1 ? 'Already on the last page.' : '' })}</span></div>` : '';
  return `<div class="tablewrap"><table class="${o.cls || ''}"><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${cols.length}" class="empty">${o.empty || 'No records match these filters.'}</td></tr>`}</tbody></table></div>${footer}`;
}
const simpleTable = (heads, rows, empty = 'Nothing recorded yet.') => `<div class="tablewrap"><table><thead><tr>${heads.map(h => `<th scope="col">${h}</th>`).join('')}</tr></thead><tbody>${rows.join('') || `<tr><td colspan="${heads.length}" class="empty">${empty}</td></tr>`}</tbody></table></div>`;
const timeline = evs => evs.length ? `<div class="timeline">${evs.map(e => `<div class="event"><strong>${esc(e.text)}</strong><p>${fdt(e.at)} · ${esc(e.by || '')}</p></div>`).join('')}</div>` : '<p class="muted">No activity yet.</p>';
const orderA = id => Session.canSee('order360') ? `<a class="link" href="#/orders/${esc(id)}">#${esc(id)}</a>` : `#${esc(id)}`;
const skuA = (id, label) => Session.canSee('products') ? `<a class="link" href="#/products/${esc(id)}">${esc(label ?? id)}</a>` : esc(label ?? id);
const custA = c => c ? (Session.canSee('crm') ? `<a class="link" href="#/customers/${esc(c.id)}">${esc(c.name)}</a>` : esc(c.name)) : '—';
const driverA = id => { const d = Repo.get('drivers', id); return d ? `<a class="link" href="#/drivers/${esc(id)}">${esc(d.name)}</a>` : esc(id); };
const carrierA = d => d.mode === 'driver' ? driverA(d.carrierId) : esc(carrierName(d));
const delA = d => `<button type="button" class="link" ${act('openDelivery', d.id)}>${esc(d.id)}</button>`;
const initials = n => n.replace(/[^\p{L} ]/gu, '').split(' ').filter(Boolean).map(x => x[0]).slice(0, 2).join('');
const campaignOptions = (first = [['', 'All campaigns'], ['none', 'Unattributed']]) => [...first, ...Repo.all('campaigns').map(c => [c.id, c.name])];
const driverOptions = (first = [['', 'All drivers']]) => [...first, ...Repo.all('drivers').map(d => [d.id, d.name])];
const courierOptions = (first = [['', 'All couriers']]) => [...first, ...Repo.all('couriers').map(c => [c.id, c.name])];
const latestDelivery = o => { let best = null; for (const d of Repo.by('deliveries', 'orderId', o.id)) if (!best || d.assignedAt >= best.assignedAt) best = d; return best; };
/* Date presets used by Overview and Finance. */
function presetRange(st) {
  const t = today();
  if (st.preset === 'all') return { from: '', to: '' };
  if (st.preset === 'custom') return { from: st.from, to: st.to };
  if (st.preset === 'month') return { from: t.slice(0, 8) + '01', to: t };
  return { from: dayShift(t, -(Number(st.preset) - 1)), to: t };
}
const PRESETS = [['7', 'Last 7 days'], ['30', 'Last 30 days'], ['month', 'This month'], ['all', 'All time'], ['custom', 'Custom range']];
const rangeLabel = r => r.from || r.to ? `${r.from ? fd(r.from + 'T12:00:00Z') : 'start'} to ${r.to ? fd(r.to + 'T12:00:00Z') : 'today'}` : 'all recorded dates';

/* Exceptions shown as flags on orders and in queues. */
function orderFlags(o) {
  const f = [];
  if (o.status === 'New' && Guards.confirm(o)) f.push('Stock short');
  const a = activeDelivery(o); if (a && isOverdue(a)) f.push('Overdue');
  if (o.status === 'Failed Delivery') f.push('Failed delivery');
  const ps = paymentStatus(o); if (ps === 'Refund review') f.push('Refund review');
  if (Repo.by('discrepancies', 'orderId', o.id).some(x => x.status === 'Open')) f.push('Discrepancy');
  if (casesOf(o).some(c => !['Closed', 'Rejected'].includes(c.status))) f.push('Open case');
  if (o.status === 'Ready' && !a) f.push('No carrier');
  return f;
}
const FLAG_LIST = ['Stock short', 'Overdue', 'Failed delivery', 'Refund review', 'Discrepancy', 'Open case', 'No carrier'];
const _searchCache = { v: -1, m: new Map() };
function orderSearchText(o) {
  if (_searchCache.v !== Repo.version) { _searchCache.v = Repo.version; _searchCache.m.clear(); }
  let t = _searchCache.m.get(o.id); if (t) return t;
  const c = customerOf(o);
  t = [o.id, c?.name, c?.phone, o.area, o.externalRef, ...linesOf(o).flatMap(l => [l.sku, l.name])].join(' ').toLowerCase(); _searchCache.m.set(o.id, t); return t;
}
function filteredOrders(f = ui.orders) {
  const q = f.q.trim().toLowerCase().replace(/^#/, '');
  return Repo.all('orders').filter(o => {
    if (q && !orderSearchText(o).includes(q)) return false;
    const day = dateKey(o.at);
    if (f.from && day < f.from) return false;
    if (f.to && day > f.to) return false;
    if (f.status && o.status !== f.status) return false;
    if (f.channel && o.channel !== f.channel) return false;
    if (f.source && o.source !== f.source) return false;
    if (f.campaign && (f.campaign === 'none' ? o.campaignId : o.campaignId !== f.campaign)) return false;
    if (f.delivery || f.method || f.courier || f.driver) {
      const d = latestDelivery(o);
      if (f.delivery === 'Unassigned' ? d : f.delivery && d?.status !== f.delivery) return false;
      if (f.method && d?.mode !== f.method) return false;
      if (f.courier && d?.carrierKey !== carrierKey('courier', f.courier)) return false;
      if (f.driver && d?.carrierKey !== carrierKey('driver', f.driver)) return false;
    }
    if (f.collection && collectionOutcome(o) !== f.collection) return false;
    if (f.exception && !orderFlags(o).includes(f.exception)) return false;
    return true;
  });
}
/* ---------- Chart: one axis, thin lines, crosshair tooltip, legend + direct labels ---------- */
/* Checked on white: lightness band, colorblind separation and contrast. */
const CHART_COLORS = ['#3b5bfd', '#0ea472', '#f76707'];
const _charts = {};
/* Monotone cubic curve through the points: smooth, and never overshoots past a real value. */
function smoothPath(pts) {
  const n = pts.length; if (n < 3) return pts.map(([px, py], i) => `${i ? 'L' : 'M'}${px.toFixed(1)} ${py.toFixed(1)}`).join('');
  const d = [], t = [];
  for (let i = 0; i < n - 1; i++) d.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]));
  t[0] = d[0]; t[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) t[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2;
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / d[i], b = t[i + 1] / d[i], q = a * a + b * b;
    if (q > 9) { const k = 3 / Math.sqrt(q); t[i] = k * a * d[i]; t[i + 1] = k * b * d[i]; }
  }
  let out = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let i = 0; i < n - 1; i++) {
    const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], h = (x1 - x0) / 3;
    out += `C${(x0 + h).toFixed(1)} ${(y0 + t[i] * h).toFixed(1)} ${(x1 - h).toFixed(1)} ${(y1 - t[i + 1] * h).toFixed(1)} ${x1.toFixed(1)} ${y1.toFixed(1)}`;
  }
  return out;
}
function lineChart(id, buckets, series, unitLabel) {
  const W = 760, H = 260, L = 62, R = 96, T = 14, B = 30, max = Math.max(1, ...series.flatMap(s => s.values)), min = Math.min(0, ...series.flatMap(s => s.values));
  const pow = 10 ** Math.floor(Math.log10(Math.max(max - min, 1))), stepTry = [1, 2, 5, 10].map(x => x * pow / 2).find(s => (max - min) / s <= 4.5) || pow * 5, top = Math.ceil(max / stepTry) * stepTry, bot = Math.floor(min / stepTry) * stepTry;
  const x = i => buckets.length < 2 ? L : L + i * (W - L - R) / (buckets.length - 1), y = v => T + (top - v) * (H - T - B) / ((top - bot) || 1);
  let g = ''; for (let v = bot; v <= top + 1e-6; v += stepTry) g += `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="gl"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="tick">${v >= 1000 || v <= -1000 ? (v / 1000).toLocaleString('en-US') + 'k' : v}</text>`;
  const every = Math.max(1, Math.ceil(buckets.length / 7)); let xl = '';
  buckets.forEach((b, i) => { if (i % every === 0) xl += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle" class="tick">${esc(b.short)}</text>`; });
  /* Direct labels sit at the line ends, nudged apart if they would collide. */
  const ends = series.map((s, i) => ({ i, name: s.name, y: y(s.values.at(-1) ?? 0) })).sort((a, b) => a.y - b.y);
  for (let i = 1; i < ends.length; i++) if (ends[i].y - ends[i - 1].y < 14) ends[i].y = ends[i - 1].y + 14;
  const curves = series.map(s => smoothPath(s.values.map((v, j) => [x(j), y(v)])));
  const base = y(Math.max(bot, 0)), area = curves[0] && buckets.length > 1 ? `<defs><linearGradient id="ga-${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${CHART_COLORS[0]}" stop-opacity=".22"/><stop offset="1" stop-color="${CHART_COLORS[0]}" stop-opacity="0"/></linearGradient></defs><path class="area" d="${curves[0]}L${x(buckets.length - 1).toFixed(1)} ${base.toFixed(1)}L${x(0).toFixed(1)} ${base.toFixed(1)}Z" fill="url(#ga-${id})"/>` : '';
  const lines = area + series.map((s, i) => `<path class="ln" pathLength="1" d="${curves[i]}" fill="none" stroke="${CHART_COLORS[i]}" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round" style="--i:${i}"/>`).join('');
  const labels = ends.map(e => `<text x="${W - R + 8}" y="${e.y + 4}" class="endl">${esc(series[e.i].short)}</text>`).join('');
  _charts[id] = { buckets, series, x: buckets.map((_, i) => x(i)), W, H, L, R, T, B, y: series.map(s => s.values.map(y)) };
  return `<div class="legend">${series.map((s, i) => `<span><b style="background:${CHART_COLORS[i]}"></b>${esc(s.name)}</span>`).join('')}</div>
  <div class="chart" data-chart="${id}"><svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(unitLabel)} by period for ${series.map(s => s.name).join(', ')}. The same figures are in the table below.">${g}${xl}${lines}${labels}<g class="hover" style="display:none"><line class="ch" y1="${T}" y2="${H - B}"/>${series.map((_, i) => `<circle r="4.5" fill="${CHART_COLORS[i]}" stroke="#fff" stroke-width="2"/>`).join('')}</g></svg><div class="tip" hidden></div></div>
  <details class="tv"><summary>View as table</summary>${simpleTable(['Period', ...series.map(s => s.name)], buckets.map((b, i) => `<tr><td>${esc(b.label)}</td>${series.map(s => `<td>${m(s.values[i])}</td>`).join('')}</tr>`))}</details>`;
}
function chartHover(e) {
  const el = e.target.closest?.('[data-chart]'); document.querySelectorAll('.chart .tip').forEach(t => { if (!el || t.parentElement !== el) t.hidden = true; });
  document.querySelectorAll('.chart .hover').forEach(h => { if (!el || h.closest('.chart') !== el) h.style.display = 'none'; });
  if (!el) return; const c = _charts[el.dataset.chart]; if (!c) return;
  const svg = el.querySelector('svg'), r = svg.getBoundingClientRect(), mx = (e.clientX - r.left) * c.W / r.width;
  let best = 0, bd = 1e9; c.x.forEach((v, i) => { const dd = Math.abs(v - mx); if (dd < bd) { bd = dd; best = i; } });
  const hov = svg.querySelector('.hover'); hov.style.display = ''; const ln = hov.querySelector('line'); ln.setAttribute('x1', c.x[best]); ln.setAttribute('x2', c.x[best]);
  hov.querySelectorAll('circle').forEach((cc, i) => { cc.setAttribute('cx', c.x[best]); cc.setAttribute('cy', c.y[i][best]); });
  const tip = el.querySelector('.tip'); tip.hidden = false;
  tip.innerHTML = `<strong>${esc(c.buckets[best].label)}</strong>` + c.series.map((s, i) => `<div><b style="background:${CHART_COLORS[i]}"></b><span>${esc(s.name)}</span><em>${m(s.values[best])}</em></div>`).join('');
  const px = c.x[best] * r.width / c.W, w = tip.offsetWidth; tip.style.left = Math.max(0, Math.min(r.width - w, px + 12 + w > r.width ? px - w - 12 : px + 12)) + 'px';
}

export { skuA, LOGO, gauge, iconBtn, seg, ACTION_COMMAND, CHART_COLORS, FLAG_LIST, ICONS, NAV, PRESETS, _charts, _fd, _fdt, _fmt, _ftz, _searchCache, act, badge, blankOrderFilters, btn, campaignOptions, card, carrierA, chartHover, courierOptions, custA, dateF, dayShift, delA, driverA, driverOptions, expl, fd, fdt, filteredOrders, getPath, grid, heading, icon, initials, kpi, latestDelivery, lineChart, m, note, orderA, orderFlags, orderSearchText, pad, presetRange, rangeLabel, row, search, sel, setPath, simpleTable, tabs, timeline, today, tone, toneOf, ui };
