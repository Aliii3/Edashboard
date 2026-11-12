import { Commands, Session, request, loadSnapshot, pull } from './api.js';
import { isAr, setLang } from './i18n.js';
import { ROLES } from '@commerce-os/domain';
import { Repo, Rule, esc, fail, round2, sum } from '@commerce-os/domain';
import { ATTENDANCE_STATUSES, lateMinutes, RETURN_REASONS, AREAS, CHANNELS, DRIVER_EXPENSE_CATS, EXPENSE_CATS, FAILURE_REASONS, PAYMENT_METHODS, S, activeDelivery, allocationOf, availableOf, calc, carrierKey, carrierName, contributionOf, courierDeliveryBalance, customerOf, dateKey, deliveryCash, driverCash, driverStats, expectedFromCustomer, isOverdue, linesOf, money, netUnit, orderOf, overdueWhy, paymentStatus, settlementStatus, tol, totals } from '@commerce-os/domain';
import { badge, blankOrderFilters, btn, carrierA, custA, dayShift, fd, fdt, filteredOrders, grid, kpi, latestDelivery, m, note, orderA, orderSearchText, presetRange, rangeLabel, row, search, setPath, simpleTable, timeline, today, ui } from './ui-kit.js';
import { custodyLabel, returnRate } from './views-core.js';
import { deliveryActions } from './views-ops.js';
import { render } from './main.js';
import { PRINT_SIZES, printDocs } from './print.js';
/* ==========================================================================
   LAYER 6 · ACTIONS AND FORMS: modals call await Commands. The action table is the
   single dispatch point for every button in the app.
   ========================================================================== */
function field(label, name, type = 'text', value = '', extra = '') { return `<label class="field">${label}<input name="${name}" type="${type}" value="${esc(value)}" ${extra}></label>`; }
function selectF(label, name, options, value = '', extra = '') { return `<label class="field">${label}<select name="${name}" ${extra}>${options.map(o => { const [v, t] = Array.isArray(o) ? o : [o, o]; return `<option value="${esc(v)}" ${String(v) === String(value) ? 'selected' : ''}>${esc(t)}</option>`; }).join('')}</select></label>`; }
const textF = (label, name, value = '', extra = '') => `<label class="field full">${label}<textarea name="${name}" ${extra}>${esc(value)}</textarea></label>`;
let modalLive = null;
function modal(title, body, submit, label = 'Save', o = {}) {
  const d = document.getElementById('dialog'); modalLive = null;
  d.className = o.wide ? 'wide' : '';
  d.innerHTML = `<form id="modalForm" novalidate><div class="cardhead"><h2 id="modalTitle">${title}</h2><button type="button" class="close" aria-label="Close dialog" data-close="1">×</button></div><div class="body">${body}<p id="formError" class="form-error" role="alert"></p></div><footer><button type="button" data-close="1">${submit ? 'Cancel' : 'Close'}</button>${submit ? `<button class="${o.danger ? 'danger-solid' : 'primary'}" type="submit">${label}</button>` : ''}</footer></form>`;
  d.querySelector('#modalForm').onsubmit = async e => {
    e.preventDefault(); const form = e.target;
    const bad = [...form.elements].find(el => el.willValidate && !el.checkValidity());
    if (bad) { document.getElementById('formError').textContent = `${bad.closest('label')?.childNodes[0]?.textContent?.trim() || 'This field'}: ${bad.validationMessage}`; bad.focus(); return; }
    const sb = form.querySelector('[type=submit]'); if (sb.disabled) return; sb.disabled = true;   // blocks double submission
    try { const r = await submit(Object.fromEntries(new FormData(form)), form); if (r !== false) { closeModal(); } }
    catch (err) { if (!(err instanceof Rule)) console.error(err); const fe = document.getElementById('formError'); if (fe) fe.textContent = err instanceof Rule ? err.message : 'Something went wrong. No changes were saved.'; }
    finally { sb.disabled = false; }
  };
  if (!d.open) d.showModal();
  d.querySelector('.body input:not([type=hidden]),.body select,.body textarea')?.focus();
}
const closeModal = () => { const d = document.getElementById('dialog'); if (d.open) d.close(); modalLive = null; };
function toast(s, kind = '') { const e = document.getElementById('toast'); e.textContent = s; e.className = 'toast ' + kind; clearTimeout(window._tt); window._tt = setTimeout(() => e.classList.add('hidden'), 5000); }
async function run(fn, ok) { try { const r = await fn(); if (ok) toast(typeof ok === 'function' ? ok(r) : ok); return r; } catch (err) { if (!(err instanceof Rule)) console.error(err); toast(err instanceof Rule ? err.message : 'Something went wrong. No changes were saved.', 'bad'); } }
const nowLocal = () => { const k = today(); return k; };
const dateToIso = (k) => k ? (k === today() ? new Date().toISOString() : new Date(k + 'T12:00:00Z').toISOString()) : null;
const download = (name, text, type) => { const a = document.createElement('a'), url = URL.createObjectURL(new Blob([text], { type })); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 1500); };
const csvCell = v => { let s = String(v ?? ''); if (/^[=+@\-]/.test(s) && typeof v !== 'number') s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
const toCsv = rows => rows.map(r => r.map(csvCell).join(',')).join('\r\n');
function parseCSV(text, delim = ',') { const rows = []; let row = [], cell = '', q = false; for (let i = 0; i < text.length; i++) { const c = text[i]; if (c === '"') { if (q && text[i + 1] === '"') { cell += '"'; i++; } else q = !q; } else if (c === delim && !q) { row.push(cell); cell = ''; } else if ((c === '\n' || c === '\r') && !q) { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some(x => x.trim())) rows.push(row); row = []; cell = ''; } else cell += c; } if (q) throw new Rule('The CSV has an unclosed quotation mark.'); row.push(cell); if (row.some(x => x.trim())) rows.push(row); return rows; }
/* A table pasted from Excel is tab-separated; exports from couriers use commas or semicolons. */
function parseTable(text) { text = text.replace(/^\uFEFF/, ''); const first = text.split(/\r?\n/)[0] || ''; const delim = ['\t', ';', ','].map(d => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0]; return parseCSV(text, delim); }
const DIGITS_AR = '٠١٢٣٤٥٦٧٨٩';
const latinDigits = v => String(v ?? '').replace(/[٠-٩]/g, d => DIGITS_AR.indexOf(d));
const normRef = v => latinDigits(v).trim().toUpperCase().replace(/^#/, '').replace(/\s+/g, '');
const toAmount = v => { const x = latinDigits(v).replace(/٫/g, '.').replace(/[^\d.-]/g, ''); return x === '' || x === '-' ? NaN : Number(x); };
/* Label printer choice, kept on this device only. */
const PKEY = 'cos_print';
function printPref() { const d = { kind: 'label', size: '100x150', receipt: false }; try { return { ...d, ...JSON.parse(localStorage.getItem(PKEY) || '{}') }; } catch { return d; } }
function savePrintPref(p) { try { localStorage.setItem(PKEY, JSON.stringify({ ...printPref(), ...p })); } catch { /* private window: this visit only */ } }
const nowHHMM = () => new Intl.DateTimeFormat('en-GB', { timeZone: S().timezone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date());
const staffDate = () => ui.staff.date || today();
let stmt = null, stmtCtx = null;
const CSV_COLUMNS = ['external_ref', 'date', 'customer_phone', 'customer_name', 'area', 'address', 'sku', 'qty', 'unit_price', 'line_discount', 'order_discount', 'delivery_fee', 'channel', 'campaign', 'payment_method'];
/* Validates a whole file without writing anything, row by row. */
function prepareImport(text) {
  const rows = parseCSV(text.replace(/^﻿/, '')), head = rows.shift()?.map(h => h.trim().toLowerCase());
  if (!head) throw new Rule('The file is empty.');
  const required = ['external_ref', 'date', 'customer_phone', 'sku', 'qty'], missing = required.filter(h => !head.includes(h));
  if (missing.length) throw new Rule(`Missing required column${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}. Download the template to see the format.`);
  if (!rows.length) throw new Rule('The file has a header but no data rows.');
  if (rows.length > 5000) throw new Rule('Import at most 5,000 rows at a time.');
  const groups = new Map(), errors = [], campaignByName = new Map(Repo.all('campaigns').map(c => [c.name.toLowerCase(), c.id]));
  rows.forEach((r, i) => {
    const n = i + 2, g = Object.fromEntries(head.map((h, j) => [h, (r[j] ?? '').trim()])), err = [];
    if (r.length !== head.length) err.push('column count differs from header');
    if (!g.external_ref) err.push('external_ref is required');
    else if (Repo.count('orders', 'externalRef', g.external_ref)) err.push(`${g.external_ref} was already imported`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(g.date) || isNaN(Date.parse(g.date))) err.push('date must be YYYY-MM-DD');
    const phone = (g.customer_phone || '').replace(/[\s-]/g, ''), cust = Repo.by('customers', 'phone', phone)[0];
    if (!/^01[0125]\d{8}$/.test(phone)) err.push('invalid customer_phone');
    else if (!cust && (!g.customer_name || !g.address)) err.push('new customer needs customer_name and address');
    if (!Repo.get('skus', g.sku)) err.push(`unknown SKU ${g.sku}`);
    const qty = Number(g.qty); if (!Number.isInteger(qty) || qty < 1 || qty > 500) err.push('qty must be 1 to 500');
    for (const k of ['unit_price', 'line_discount', 'order_discount', 'delivery_fee']) if (g[k] && !(Number(g[k]) >= 0)) err.push(`${k} must be a non-negative number`);
    if (g.channel && !CHANNELS.includes(g.channel)) err.push(`unknown channel ${g.channel}`);
    if (g.campaign && !campaignByName.has(g.campaign.toLowerCase())) err.push(`unknown campaign ${g.campaign}`);
    if (g.payment_method && !['COD', 'InstaPay', 'Card', 'Mobile wallet', 'Bank transfer'].includes(g.payment_method)) err.push(`unknown payment_method ${g.payment_method}`);
    if (err.length) { errors.push({ row: n, ref: g.external_ref, msg: err.join('; ') }); return; }
    if (!groups.has(g.external_ref)) groups.set(g.external_ref, { ref: g.external_ref, date: g.date, phone, name: g.customer_name, area: g.area, address: g.address, channel: g.channel || 'Website', campaignId: g.campaign ? campaignByName.get(g.campaign.toLowerCase()) : null, paymentMethod: g.payment_method || 'COD', discount: Number(g.order_discount) || 0, deliveryFee: Number(g.delivery_fee) || 0, lines: [] });
    groups.get(g.external_ref).lines.push({ sku: g.sku, qty, price: g.unit_price ? Number(g.unit_price) : undefined, discount: Number(g.line_discount) || 0 });
  });
  return { groups: [...groups.values()], errors, total: rows.length };
}
let pendingImport = null, orderDraft = null;
/* The picker holds a short matching list, so it stays fast with any number of customers. */
const customerOptionsFor = q => { const s = q.trim().toLowerCase(), out = []; for (const x of Repo.all('customers')) { if (!s || `${x.name} ${x.phone} ${x.id}`.toLowerCase().includes(s)) { out.push(`<option value="${esc(`${x.id} · ${x.name} · ${x.phone}`)}"></option>`); if (out.length >= 40) break; } } return out.join(''); };
const lineSum = l => { const s = Repo.get('skus', l.sku); return (l.price ?? s?.price ?? 0) * (Number(l.qty) || 0) - (Number(l.discount) || 0); };
function renderDraftLines() {
  const box = document.getElementById('draftLines'); if (!box) return;
  box.innerHTML = orderDraft.map((l, i) => { const a = availableOf(l.sku), short = a < Number(l.qty); return `<div class="line-row"><label class="field grow">Product<select data-dl="sku" data-i="${i}">${Repo.all('skus').map(s => `<option value="${esc(s.id)}" ${s.id === l.sku ? 'selected' : ''}>${esc(s.id)} · ${esc(s.name)} · ${m(s.price)}</option>`).join('')}</select></label><label class="field qty">Qty<input type="number" min="1" max="500" step="1" data-dl="qty" data-i="${i}" value="${esc(l.qty)}"></label><label class="field qty">Discount on this item<input type="number" min="0" step="1" data-dl="discount" data-i="${i}" value="${esc(l.discount || 0)}"></label><div class="stockhint ${short ? 'negative' : ''}">${a} available${short ? '<br>Short: can be saved, not confirmed' : ''}</div>${orderDraft.length > 1 ? `<button type="button" class="close" aria-label="Remove line" data-dl-rm="${i}">×</button>` : ''}</div>`; }).join('');
  const f = document.getElementById('modalForm'), disc = Number(f?.elements.discount?.value) || 0, fee = Number(f?.elements.deliveryFee?.value) || 0;
  const gross = sum(orderDraft, l => (Repo.get('skus', l.sku)?.price || 0) * (Number(l.qty) || 0)), ld = sum(orderDraft, l => Number(l.discount) || 0), total = round2(gross - ld - disc + fee);
  const bd = (k, v, cls = '') => `<span class="bd ${cls}"><span>${k}</span> <b>${m(v)}</b></span>`;
  const t = document.getElementById('draftTotal'); if (t) t.innerHTML = bd('Items', gross) + (ld ? bd('Item discounts', -ld) : '') + (disc ? bd('Order discount', -disc) : '') + (fee ? bd('Delivery fee', fee) : '') + bd('Total', total, 'total');
  /* Counter sale: the change to give back from the cash handed over. */
  const ch = document.getElementById('changeDue');
  if (ch) { const cash = Number(f.elements.cash?.value) || 0, other = f.elements.method2?.value ? Number(f.elements.amount2?.value) || 0 : 0, due = round2(total - other); ch.innerHTML = f.elements.method.value === 'Cash' && cash > 0 ? (cash >= due ? bd('Change to give back', cash - due, 'positive') : bd('Still to pay in cash', due - cash, 'negative')) : ''; }
}
function allocInputsTotal() { return [...document.querySelectorAll('#modalForm [data-alloc]')].reduce((s, el) => s + (Number(el.value) || 0), 0); }

const A = {
  /* navigation and table */
  setTab([p, t]) { setPath(p, t); render(); },
  toggleLang() { setLang(isAr() ? 'en' : 'ar'); location.reload(); },
  focusSearch() { const i = document.querySelector('#dock input'); if (i) i.focus(); },
  async syncNow() { try { await pull(); render(); toast('Up to date.'); } catch (e) { toast(e.message, 'bad'); } },
  sort([id, k]) { const st = ui.tbl[id]; if (st.s === k) st.d *= -1; else { st.s = k; st.d = 1; } st.p = 0; render(); },
  page([id, n]) { ui.tbl[id].p += n; render(); document.querySelector(`.tablewrap`)?.scrollIntoView?.({ block: 'nearest' }); },
  goOrders(f) { ui.orders = { ...blankOrderFilters(), ...f }; if (ui.tbl.orders) ui.tbl.orders.p = 0; location.hash = '#/orders'; render(); },
  goFinance([tab, extra]) { ui.fin.tab = tab; Object.assign(ui.fin, extra || {}); location.hash = '#/finance'; render(); },
  goInv() { location.hash = '#/inventory'; },
  goInvJournal(sku) { ui.inv.tab = 'Movement journal'; ui.inv.q = sku || ''; location.hash = '#/inventory'; render(); },
  staffDay(n) { const d = n ? dayShift(staffDate(), n) : today(); if (d > today()) return; ui.staff.date = d; render(); },
  staffMonth(n) { const cur = ui.staff.month || today().slice(0, 7), d = new Date(cur + '-15T12:00:00Z'); d.setUTCMonth(d.getUTCMonth() + n); const next = d.toISOString().slice(0, 7); if (next > today().slice(0, 7)) return; ui.staff.month = next; render(); },
  exportAttendance(mo) {
    const rows = [['employee_id', 'employee', 'job_title', 'date', 'status', 'check_in', 'check_out', 'late_minutes', 'note', 'recorded_by']];
    for (const e of Repo.all('employees')) for (const a of Repo.by('attendance', 'employeeId', e.id).filter(x => x.date.startsWith(mo)).sort((x, y) => x.date.localeCompare(y.date))) rows.push([e.id, e.name, e.jobTitle || '', a.date, a.status, a.checkIn || '', a.checkOut || '', lateMinutes(a), a.note || '', a.by || '']);
    download(`attendance-${mo}.csv`, toCsv(rows), 'text/csv'); toast(`${rows.length - 1} attendance records exported.`);
  },
  goShip(tab) { ui.ship.tab = tab; location.hash = '#/shipping'; render(); },
  clearOrders() { ui.orders = blankOrderFilters(); render(); },
  clearOv() { Object.assign(ui.ov, { campaign: '', sku: '', courier: '', driver: '' }); render(); },
  clearSelection() { ui.selected.clear(); render(); },
  focusCampaign(id) { ui.camp.focus = id; render(); },

  /* orders */
  newOrder(customerId) {
    if (!Repo.all('skus').length) return toast('Add a SKU under Inventory first.', 'bad');
    orderDraft = [{ sku: Repo.all('skus')[0].id, qty: 1, discount: 0 }];
    const c = customerId ? Repo.get('customers', customerId) : null;
    modal('New order', `${note('Stock is checked now and reserved when you confirm. Entry method is recorded as Manual. Sales channel is separate.')}<div class="formgrid"><label class="field full">Customer (search by name or phone)<input name="customerPick" list="custList" autocomplete="off" value="${c ? esc(`${c.id} · ${c.name} · ${c.phone}`) : ''}" placeholder="Start typing…"></label><datalist id="custList">${customerOptionsFor('')}</datalist></div>
      <details class="whynot" ${c ? '' : ''}><summary>Or add a new customer</summary><div class="formgrid mt">${field('Name', 'nName')}${field('Mobile', 'nPhone', 'tel', '', 'placeholder="01012345678"')}${selectF('Area', 'nArea', AREAS)}${field('Address', 'nAddress')}</div></details>
      <h3 class="mt">Line items</h3><div id="draftLines"></div><button type="button" data-dl-add="1" class="small">+ Add line</button>
      <div class="note mt"><strong>Which discount?</strong> <strong>Discount on this item</strong> lowers the price of one product only, for example 50 off the shirt. <strong>Discount on the whole order</strong> comes off the total, like a coupon or rounding down. You rarely need both.</div>
      <div class="formgrid mt">${selectF('Sales channel', 'channel', CHANNELS.filter(x => x !== 'Exchange' && x !== 'In-store'), 'Phone')}${selectF('Campaign', 'campaignId', [['', 'Unattributed'], ...Repo.all('campaigns').map(x => [x.id, x.name])])}${selectF('Payment', 'paymentMethod', ['COD', 'InstaPay', 'Card', 'Mobile wallet', 'Bank transfer'], 'COD')}${field('Order date', 'date', 'date', today(), `required max="${today()}"`)}${field('Discount on the whole order', 'discount', 'number', 0, 'min="0" step="1" data-dl-total="1"')}${field('Delivery fee charged', 'deliveryFee', 'number', 0, 'min="0" step="1" data-dl-total="1"')}${textF('Internal note (optional)', 'note', '', 'maxlength="500"')}</div><p class="draft-total" id="draftTotal"></p>`, async f => {
      if (!f.customerPick.trim() && !f.nName.trim()) fail('Choose an existing customer or add a new one.');
      const customer = f.nName.trim() ? { name: f.nName, phone: f.nPhone, area: f.nArea, address: f.nAddress, tags: [] } : null;
      const customerId = customer ? null : f.customerPick.split(' · ')[0];
      if (!customer && !Repo.get('customers', customerId)) fail('Pick the customer from the list, or add a new one below.');
      const o = await Commands.createOrderWithCustomer({ customer, order: { customerId, channel: f.channel, source: 'Manual', campaignId: f.campaignId || null, paymentMethod: f.paymentMethod, discount: Number(f.discount), deliveryFee: Number(f.deliveryFee), note: f.note, at: dateToIso(f.date), lines: orderDraft.map(l => ({ sku: l.sku, qty: Number(l.qty), discount: Number(l.discount) || 0 })) } });
      location.hash = `#/orders/${o.id}`; toast(`Order #${o.id} created. Confirm it to reserve stock.`);
    }, 'Create order', { wide: true });
    renderDraftLines();
  },
  confirmOrder(id) { run(() => Commands.confirmOrder(id), `Order #${id} confirmed and stock reserved.`); },
  advance([id, to]) { run(() => Commands.advanceOrder(id, to), `Order #${id} → ${to}.`); },
  cancelModal(id) { modal(`Cancel order #${id}`, `<p class="subtitle mb">Reservations are released and any active assignment closes. Prepaid money moves to refund review.</p>${textF('Reason', 'reason', '', 'required maxlength="200"')}`, async f => { await Commands.cancelOrder(id, f.reason); toast(`Order #${id} cancelled.`); }, 'Cancel order', { danger: true }); },
  orderNoteModal(id) { modal('Add internal note', textF('Note', 'note', '', 'required maxlength="1000"'), async f => { await Commands.addOrderNote(id, f.note); toast('Note saved.'); }); },
  attributeModal(id) { const o = orderOf(id); modal(`Attribution for #${id}`, `<div class="formgrid">${selectF('Campaign', 'campaignId', [['', 'Unattributed'], ...Repo.all('campaigns').map(x => [x.id, x.name])], o.campaignId || '')}${field('Reason (optional)', 'reason')}</div><p class="inlinehelp">Allocation recalculates for every order on both the old and new campaigns.</p>`, async f => { await Commands.attribute(id, f.campaignId || null, f.reason); toast('Attribution corrected. Campaign figures updated.'); }); },
  setOrderDelivery(v) { ui.orders.delivery = v || ''; if (ui.tbl.orders) ui.tbl.orders.p = 0; render(); },
  async bulkConfirm() { const r = []; for (const id of ui.selected) { try { await Commands.confirmOrder(id); r.push(null); } catch (e) { r.push(`#${id}: ${e.message}`); } } bulkReport('confirmed', r); },
  async bulkAdvance() { const r = []; for (const id of ui.selected) { const o = orderOf(id); try { const to = o.status === 'New' ? null : o.status === 'Confirmed' ? 'Processing' : o.status === 'Processing' ? 'Ready' : null; if (o.status === 'New') await Commands.confirmOrder(id); else if (to) await Commands.advanceOrder(id, to); else fail(`${o.status} orders move through the delivery workflow.`); r.push(null); } catch (e) { r.push(`#${id}: ${e.message}`); } } bulkReport('advanced', r); },
  async bulkReady() { const r = []; for (const id of ui.selected) { try { await Commands.advanceOrder(id, 'Ready'); r.push(null); } catch (e) { r.push(`#${id}: ${e.message}`); } } bulkReport('marked ready', r, true); },
  async bulkPickup() { const r = []; for (const id of [...ui.selected]) { const a = orderOf(id) && activeDelivery(orderOf(id)); try { if (a?.status !== 'Assigned') fail('No delivery is waiting for pickup.'); await Commands.pickup(a.id); r.push(null); } catch (e) { r.push(`#${id}: ${e.message}`); } } bulkReport('picked up', r); },
  bulkShip() { A.shipModal([...ui.selected]); },
  bulkAssign() { A.shipModal([...ui.selected]); },
  bulkPrint(kind) { A.printModal([...ui.selected], kind); },
  assignModal(ids) { A.shipModal(ids); },
  /* Assign a packed order and, in the same step, record the pickup and send it out. */
  shipModal(ids) {
    ids = (Array.isArray(ids) ? ids : [ids]).map(Number); const many = ids.length > 1;
    if (!ids.length) return toast('Select one or more orders first.', 'bad');
    const choice = (v, t, sub, on) => `<label class="choice"><input type="radio" name="then" value="${v}" ${on ? 'checked' : ''}><span><strong>${t}</strong><small>${sub}</small></span></label>`;
    modal(many ? `Ship ${ids.length} orders` : `Ship order #${ids[0]}`, `${note('Only Ready orders can be shipped: packed, with stock reserved. Any other order is skipped and explained.')}<div class="formgrid">${selectF('Fulfillment', 'mode', [['driver', 'Private delivery'], ['courier', 'External courier']], S().defaultFulfillment, 'data-assign-mode="1"')}<label class="field" data-show="driver">Driver<select name="driver">${Repo.all('drivers').filter(d => d.active !== false && d.availability !== 'Off duty').map(d => `<option value="${d.id}">${esc(d.name)} · ${esc(d.availability)} · ${driverStats(d.id).custody} in custody</option>`).join('')}</select></label><label class="field" data-show="courier">Courier<select name="courier">${Repo.all('couriers').filter(c => c.active !== false).map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></label>${many ? '' : '<label class="field" data-show="courier">Tracking no. (optional)<input name="tracking" maxlength="60"></label>'}</div>
      <h3 class="mt">What happens now?</h3><div class="choices">${choice('assigned', 'Wait for pickup', 'The carrier collects the parcel later. Record the pickup when they do.')}${choice('picked', 'Picked up now', 'The carrier is taking the parcel now. Stock is deducted.', true)}${choice('out', 'Picked up and out for delivery', 'The driver leaves with it right away.')}</div>
      <label class="checkrow mt"><input type="checkbox" name="print"> Print shipping labels afterwards</label>`, async f => {
      const r = [], done = [];
      for (const id of ids) { try { await Commands.shipOrder(id, f.mode, f.mode === 'driver' ? f.driver : f.courier, { tracking: f.tracking, then: f.then }); ui.selected.delete(id); done.push(id); r.push(null); } catch (e) { r.push(many && !e.message.startsWith('#') ? `#${id}: ${e.message}` : e.message); } }
      if (!many && r[0]) fail(r[0]);
      if (f.print && done.length) printDocs(done, 'label', printPref().size);
      closeModal(); bulkReport('shipped', r); return false;
    }, many ? 'Ship orders' : 'Ship');
    syncAssign();
  },
  printModal(ids, kind) {
    ids = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(id => orderOf(id));
    if (!ids.length) return toast('Select one or more orders first.', 'bad');
    const pref = printPref();
    modal(`Print · ${ids.length} order${ids.length > 1 ? 's' : ''}`, `<div class="formgrid">${selectF('Document', 'kind', [['label', 'Shipping label (airway bill)'], ['invoice', 'Invoice'], ['both', 'Label and invoice']], kind || pref.kind)}${selectF('Paper size', 'size', Object.entries(PRINT_SIZES).map(([k, v]) => [k, v.label]), pref.size)}</div><p class="inlinehelp">One page per document, sized for a thermal label printer. In the print dialog, choose the label printer, set the paper to the same size and the margins to none. Your choice is remembered on this device.</p>`, async f => {
      savePrintPref({ kind: f.kind, size: f.size }); printDocs(ids, f.kind, f.size); toast('Sent to the print dialog.');
    }, 'Print');
  },
  trackingModal(id) {
    const d = Repo.get('deliveries', id);
    modal(`Tracking no. · ${esc(id)}`, `${note('The airway bill number from the courier. Courier statements are matched on it, so enter it exactly as the courier shows it.')}<div class="formgrid">${field('Tracking no.', 'tracking', 'text', d.tracking || '', 'maxlength="60"')}</div>`, async f => { await Commands.setTracking(id, f.tracking); toast('Tracking number saved.'); }, 'Save');
  },
  /* A counter sale: confirmed, handed over and paid in one step. */
  storeSaleModal() {
    if (!Repo.all('skus').length) return toast('Add a SKU under Inventory first.', 'bad');
    orderDraft = [{ sku: Repo.all('skus')[0].id, qty: 1, discount: 0 }];
    modal('In-store sale', `${note('A customer buying at the counter. The sale is confirmed, handed over and paid in one step, with no driver or courier. Stock goes out at once.')}
      <h3>Items</h3><div id="draftLines"></div><button type="button" data-dl-add="1" class="small">+ Add line</button>
      <div class="formgrid mt">${field('Discount on the whole sale', 'discount', 'number', 0, 'min="0" step="1" data-dl-total="1"')}${selectF('Paid by', 'method', PAYMENT_METHODS, 'Cash')}<label class="field" id="cashWrap">Cash handed over (optional, works out the change)<input name="cash" type="number" min="0" step="1" data-dl-total="1"></label><label class="field" id="refWrap" hidden>Reference (optional)<input name="ref" maxlength="60"></label></div>
      <p class="draft-total" id="draftTotal"></p><p class="draft-total" id="changeDue"></p>
      <details class="whynot mt"><summary>Customer (optional)</summary><div class="formgrid mt"><label class="field full">Existing customer (search by name or phone)<input name="customerPick" list="custList" autocomplete="off" placeholder="Leave empty for a walk-in customer"></label><datalist id="custList">${customerOptionsFor('')}</datalist>${field('Or a new customer: name', 'nName')}${field('Mobile', 'nPhone', 'tel', '', 'placeholder="01012345678"')}</div></details>
      <details class="whynot mt"><summary>Split the payment between two methods</summary><div class="formgrid mt">${selectF('Second method', 'method2', [['', 'None'], ...PAYMENT_METHODS])}${field('Amount paid by the second method', 'amount2', 'number', '', 'min="0" step="0.01" data-dl-total="1"')}${field('Reference (optional)', 'ref2', 'text', '', 'maxlength="60"')}</div></details>
      <div class="formgrid mt">${textF('Note (optional)', 'note', '', 'maxlength="500"')}</div>
      <label class="checkrow"><input type="checkbox" name="print" ${printPref().receipt ? 'checked' : ''}> Print the invoice as a receipt</label>`, async f => {
      const lines = orderDraft.map(l => ({ sku: l.sku, qty: Number(l.qty), discount: Number(l.discount) || 0 }));
      const total = round2(sum(orderDraft, lineSum) - (Number(f.discount) || 0)), a2 = f.method2 ? round2(Number(f.amount2) || 0) : 0;
      if (f.method2 && !(a2 > 0 && a2 < total)) fail('Enter how much was paid by the second method. It must be less than the total.');
      let customerId = null, customer = null;
      if (f.nName.trim() || f.nPhone.trim()) customer = { name: f.nName, phone: f.nPhone };
      else if (f.customerPick.trim()) { customerId = f.customerPick.split(' · ')[0]; if (!Repo.get('customers', customerId)) fail('Pick the customer from the list, or leave it empty for a walk-in customer.'); }
      const payments = [{ method: f.method, amount: round2(total - a2), ref: f.method === 'Cash' ? '' : f.ref }, ...(a2 ? [{ method: f.method2, amount: a2, ref: f.method2 === 'Cash' ? '' : f.ref2 }] : [])];
      const o = await Commands.storeSale({ customerId, customer, lines, discount: Number(f.discount) || 0, payments, note: f.note });
      savePrintPref({ receipt: !!f.print }); if (f.print) printDocs([o.id], 'invoice', printPref().size);
      toast(`Sale #${o.id} recorded and paid.`);
    }, 'Complete sale', { wide: true });
    modalLive = () => { const fm = document.getElementById('modalForm'); if (!fm) return; const cash = fm.elements.method.value === 'Cash'; document.getElementById('cashWrap').hidden = !cash; document.getElementById('refWrap').hidden = cash; renderDraftLines(); };
    modalLive();
  },
  assignPicker(driverId) {
    const cand = Repo.all('orders').filter(o => o.status === 'Ready' && !activeDelivery(o));
    if (!cand.length) return toast('No packed orders need a carrier right now. Mark an order Ready first.');
    const dr = Repo.all('drivers').filter(d => d.active !== false && d.availability !== 'Off duty');
    modal('Assign orders to a driver', `<div class="formgrid">${selectF('Driver', 'driver', dr.map(d => [d.id, d.name]), driverId || dr[0]?.id)}</div><div class="pick-list mt">${cand.slice(0, 200).map(o => `<label class="checkrow"><input type="checkbox" name="o${o.id}"> #${o.id} · ${esc(customerOf(o).name)} · ${esc(o.area)} · ${badge(o.status)} · ${m(Math.max(0, calc(o).value - calc(o).paid))}</label>`).join('')}</div>${cand.length > 200 ? `<p class="inlinehelp">Showing the first 200 of ${cand.length}. Use Orders filters for larger batches.</p>` : ''}`, async f => {
      const ids = Object.keys(f).filter(k => /^o\d+$/.test(k)).map(k => Number(k.slice(1))); if (!ids.length) fail('Select at least one order.');
      const r = []; for (const id of ids) { try { await Commands.assign(id, 'driver', f.driver); r.push(null); } catch (e) { r.push(e.message); } } closeModal(); bulkReport('assigned', r); return false;
    }, 'Assign', { wide: true });
  },

  /* money on orders */
  prepayModal(id) { const c = calc(orderOf(id)), left = round2(c.value - c.paid); modal(`Record direct payment · #${id}`, `${note('Money paid straight to the business, before or after delivery. It sets customer payment status but creates no revenue until delivery.')}<div class="formgrid">${field('Amount', 'amount', 'number', left, `min="0.01" step="0.01" required`)}${selectF('Method', 'method', PAYMENT_METHODS.filter(x => x !== 'Cash'), 'InstaPay')}${field('Transaction reference', 'ref', 'text', '', 'required maxlength="60"')}</div>`, async f => { await Commands.prepay(id, { amount: Number(f.amount), method: f.method, ref: f.ref }); toast('Payment recorded.'); }); },
  refundModal(id) {
    const o = orderOf(id), owed = round2(calc(o).paid - calc(o).revenue), drivers = [...new Set(Repo.by('deliveries', 'orderId', id).filter(d => d.mode === 'driver' && deliveryCash(d).unhanded > 0).map(d => d.carrierId))];
    modal(`Refund · #${id}`, `${note(`The customer has paid ${m(owed)} more than recognized revenue. A refund moves cash only. The revenue was already reversed when the return was accepted.`)}<div class="formgrid">${field('Refund amount', 'amount', 'number', owed, 'min="0.01" step="0.01" required')}${selectF('Paid from', 'source', [['business', 'Business funds'], ...drivers.map(x => [`driver:${x}`, `${Repo.get('drivers', x).name}'s held cash`])])}${field('Reference', 'ref', 'text', '', 'required maxlength="60"')}${field('Reason', 'reason', 'text', '', 'maxlength="200"')}</div>`, async f => { await Commands.refund(id, { amount: Number(f.amount), source: f.source, ref: f.ref, reason: f.reason }); toast('Refund recorded.'); }, 'Record refund');
  },
  caseModal([id, type]) {
    const o = orderOf(id), ls = linesOf(o).filter(l => l.delivered - l.returned - l.pendingReturn > 0);
    modal(`${type} request · #${id}`, `${note(type === 'Exchange' ? 'An exchange is a service case. Receive the item, then create a separate replacement order. Any amount owed moves across as non-cash credit.' : 'Opening a case does not change money or stock. Accepting the inspected item reverses revenue and COGS and restocks it.')}${ls.map(l => `<label class="checkrow between"><span>${esc(l.name)} ${esc(l.variant)} <small>(${l.delivered - l.returned - l.pendingReturn} returnable)</small></span><input class="qtyinput" type="number" name="q${l.id}" min="0" max="${l.delivered - l.returned - l.pendingReturn}" value="0" aria-label="Quantity to return for ${esc(l.sku)}"></label>`).join('')}<div class="formgrid mt">${field('Reason', 'reason', 'text', '', 'required maxlength="200"')}${field('Return logistics cost', 'returnCost', 'number', 40, 'min="0" step="1"')}</div>`, async f => {
      const items = ls.map(l => ({ lineId: l.id, qty: Number(f['q' + l.id]) || 0 })); const cid = await Commands.openCase({ orderId: id, type, items, reason: f.reason, returnCost: Number(f.returnCost) }); toast(`${cid} opened.`);
    }, 'Open case');
  },
  acceptCase(id) { run(() => Commands.acceptReturn(id), `${id}: return accepted. Revenue and COGS reversed, stock received. Review any refund on the order.`); },
  rejectCaseModal(id) { modal(`Reject ${id}`, textF('Why was this rejected?', 'why', '', 'required maxlength="200"'), async f => { await Commands.rejectCase(id, f.why); toast(`${id} rejected.`); }, 'Reject'); },
  replacementModal(id) { modal(`Replacement for ${id}`, `<div class="formgrid">${selectF('Replacement SKU', 'sku', Repo.all('skus').map(s => [s.id, `${s.id} · ${s.name} · ${availableOf(s.id)} available`]))}${field('Quantity', 'qty', 'number', 1, 'min="1" max="50" required')}</div><p class="inlinehelp">Creates a New order linked to this case. It moves through confirmation and delivery like any other order.</p>`, async f => { const r = await Commands.createReplacement(id, { sku: f.sku, qty: Number(f.qty) }); toast(`Replacement order #${r.id} created.`); }, 'Create replacement'); },
  closeCase(id) { run(() => Commands.closeCase(id), `${id} closed.`); },

  /* deliveries */
  openDelivery(id) {
    const d = Repo.get('deliveries', id), o = orderOf(d.orderId), c = customerOf(o), cash = deliveryCash(d), acts = deliveryActions(d), pred = d.predecessorId, succ = d.successorId;
    modal(`Delivery ${d.id}`, `<div class="kpi-grid k2 mb">${kpi('Status', badge(d.status) + (isOverdue(d) ? ' <span class="flag">Overdue</span>' : ''), isOverdue(d) ? overdueWhy(d) : `Updated ${fdt(d.updatedAt)}`)}${kpi('Parcel custody', custodyLabel(d.custody), d.mode === 'driver' ? 'Private delivery' : 'External courier')}</div>
      ${row('Order', orderA(o.id))}${row('Carrier', carrierA(d))}${row('Customer', `${custA(c)} · ${esc(c.phone)}`)}<p class="subtitle">${esc(o.address)}${o.instructions ? `<br><strong>Instructions:</strong> ${esc(o.instructions)}` : ''}</p>
      ${row('Items', d.items.map(i => `${i.delivered ? `${i.delivered}/` : ''}${i.qty} × ${esc(i.sku)}`).join(', '))}${row('Expected from customer', m(expectedFromCustomer(d)))}${row('Collected', `${m(cash.collected)}${cash.method ? ' · ' + esc(cash.method) : ''}`)}${d.mode === 'driver' ? row('Cash not yet handed over', m(cash.unhanded)) : ''}${row('Delivery cost incurred', d.shippingPaidBy === 'waived' ? `${m(0)} <small>waived by the carrier</small>` : m(d.pickedUpAt ? d.cost : 0))}${d.returnedAt ? row('Came back', `${esc(d.returnReason || 'No reason recorded')} · ${{ business: 'business paid the shipping', waived: 'no shipping cost', customer: `customer charged ${m(d.feeCharged)}` }[d.shippingPaidBy || 'business']}`) : ''}${d.tracking ? row('Tracking no.', esc(d.tracking)) : ''}${pred ? row('Follows', esc(pred)) : ''}${succ ? row('Handed to', esc(succ)) : ''}${d.retryAt ? row('Retry scheduled', fd(d.retryAt)) : ''}
      <div class="actions mt mb">${acts.map(x => btn(x.label, x.name, x.arg, { cls: x.primary ? 'primary small' : 'small', why: x.why })).join('') || '<span class="muted">No further actions: this assignment is closed.</span>'}</div>
      <h3 class="mt">Timeline</h3><div class="timeline tight">${[...d.history].reverse().map(h => `<div class="event"><strong>${esc(h.status)}</strong>${h.note ? ` <span class="muted">${esc(h.note)}</span>` : ''}<p>${fdt(h.at)} · ${esc(h.by)}</p></div>`).join('')}</div>`, null, '', { wide: true });
  },
  pickup(id) { closeModal(); run(() => Commands.pickup(id), 'Pickup recorded. Stock deducted and custody moved to the carrier.'); },
  ofd(id) { closeModal(); run(() => Commands.setDeliveryStatus(id, 'Out for Delivery', { note: 'Out for delivery' }), 'Marked out for delivery.'); },
  returnStart(id) { closeModal(); run(() => Commands.startReturn(id), 'Return started. The parcel stays in carrier custody until received at the warehouse.'); },
  /* Receiving an undelivered parcel: why it came back, and who pays the shipping. */
  receive(id) {
    const d = Repo.get('deliveries', id), o = orderOf(d.orderId), partial = d.items.some(i => i.delivered > 0), suggested = o.deliveryFee || d.cost || 0;
    const opt = (v, t, sub, on) => `<label class="choice"><input type="radio" name="shipping" value="${v}" ${on ? 'checked' : ''} ${v === 'waived' && partial ? 'disabled' : ''}><span><strong>${t}</strong><small>${sub}</small></span></label>`;
    modal(`Receive ${esc(d.id)} at the warehouse`, `${note(`Undelivered units go back into stock. Order #${o.id} · ${esc(carrierName(d))}.`)}
      <div class="formgrid">${selectF('Why did it come back?', 'reason', [['', 'Choose a reason'], ...RETURN_REASONS])}</div>
      <h3 class="mt">Who pays the shipping?</h3><div class="choices">
        ${opt('business', 'The business', `Delivery ${m(d.pickedUpAt ? d.cost : 0)} and return ${m(d.returnCost || 0)} are business costs.`, true)}
        ${opt('waived', 'No cost', partial ? 'Not available: part of this parcel was delivered.' : 'The carrier charged nothing for this trip, so no shipping cost is booked.')}
        ${opt('customer', 'The customer', 'They pay a shipping fee even though they did not keep the order. It counts as revenue.')}
      </div>
      <div class="formgrid mt" id="feeFields" hidden>${field('Shipping fee charged to the customer', 'fee', 'number', suggested || '', 'min="0.01" step="0.01"')}${selectF('Has the customer paid it?', 'paidTo', [['unpaid', 'Not yet, they owe it'], ['carrier', `Yes, to ${carrierName(d)} in cash`], ['business', 'Yes, directly to the business']])}</div>
      ${textF('Note (optional)', 'note', '', 'maxlength="200"')}`,
      async f => { await Commands.receiveAtWarehouse(id, f.note, { reason: f.reason, shipping: f.shipping, fee: f.shipping === 'customer' ? Number(f.fee) : undefined, paidTo: f.paidTo }); toast('Received at the warehouse. Undelivered units restocked.'); }, 'Receive parcel');
    modalLive = () => { const form = document.getElementById('modalForm'), on = form.elements.shipping.value === 'customer', box = document.getElementById('feeFields'); box.hidden = !on; box.querySelector('[name=fee]').required = on; };
    modalLive();
  },
  cancelAssign(id) { closeModal(); run(() => Commands.setDeliveryStatus(id, 'Cancelled Assignment', { note: 'Assignment cancelled' }), 'Assignment cancelled. The order can be assigned again.'); },
  reassignModal(id) {
    const d = Repo.get('deliveries', id);
    modal(`Reassign ${id}`, `${note(`Currently ${esc(carrierName(d))}. The parcel has not left the warehouse. The old assignment is kept in history.`)}<div class="formgrid">${selectF('Fulfillment', 'mode', [['driver', 'Private delivery'], ['courier', 'External courier']], d.mode, 'data-assign-mode="1"')}<label class="field" data-show="driver">Driver<select name="driver">${Repo.all('drivers').filter(x => x.active !== false && x.availability !== 'Off duty' && !(d.mode === 'driver' && x.id === d.carrierId)).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label><label class="field" data-show="courier">Courier<select name="courier">${Repo.all('couriers').filter(x => x.active !== false).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>${field('Reason (optional)', 'reason')}</div>`, async f => { await Commands.reassign(id, f.mode, f.mode === 'driver' ? f.driver : f.courier, f.reason); toast('Reassigned.'); }, 'Reassign');
    syncAssign();
  },
  handoffModal(id) {
    const d = Repo.get('deliveries', id), cash = deliveryCash(d);
    modal(`Hand over parcel · ${id}`, `${note(`Physically moves the parcel from ${esc(carrierName(d))}. Any cash ${esc(carrierName(d))} collected (${m(cash.unhanded)} on this delivery) stays their responsibility until handed to the business.`, 'warning')}<div class="formgrid">${selectF('Receiving driver', 'to', Repo.all('drivers').filter(x => x.active !== false && x.id !== d.carrierId).map(x => [x.id, x.name]))}${textF('Why and where did it change hands?', 'note', '', 'required maxlength="200"')}</div>`, async f => { await Commands.driverHandover(id, f.to, f.note); toast('Parcel custody transferred. A new delivery ID was created for the receiving driver.'); }, 'Record handover');
  },
  failModal(id) { modal(`Failed attempt · ${id}`, `${note('The parcel stays in the carrier\'s custody. It only returns to stock when received at the warehouse.')}<div class="formgrid">${selectF('Reason', 'reason', FAILURE_REASONS)}${field('Note', 'note', 'text', '', 'maxlength="200"')}</div>`, async f => { await Commands.setDeliveryStatus(id, 'Failed Attempt', { reason: f.reason, note: f.note }); toast('Failed attempt recorded.'); }, 'Record attempt'); },
  retryModal(id) { modal(`Schedule retry · ${id}`, `<div class="formgrid">${field('Retry date', 'date', 'date', dayShift(today(), 1), `required min="${today()}"`)}${field('Note', 'note', 'text', '', 'maxlength="200"')}</div>`, async f => { await Commands.setDeliveryStatus(id, 'Retry Scheduled', { retryAt: new Date(f.date + 'T18:00:00Z').toISOString(), note: f.note }); toast('Retry scheduled.'); }, 'Schedule'); },
  deliverModal(id) {
    const d = Repo.get('deliveries', id), o = orderOf(d.orderId), ca = calc(o), units = new Map(linesOf(o).map(l => [l.id, netUnit(l, o)])), isCOD = o.paymentMethod === 'COD' || ca.paid < ca.value;
    const expectFor = q => round2(Math.max(0, d.items.reduce((s, it) => s + (Number(q[it.lineId]) || 0) * units.get(it.lineId), 0) + (d.items.some(it => Number(q[it.lineId]) > 0) ? (o.deliveryFee || 0) : 0) - ca.paid));
    modal(`Record delivery · ${id}`, `<h3>Delivered quantities</h3>${d.items.map(it => `<label class="checkrow between"><span>${esc(it.sku)} <small>of ${it.qty}</small></span><input class="qtyinput" type="number" min="0" max="${it.qty}" step="1" name="q${it.lineId}" value="${it.qty}" data-deliver="1" aria-label="Delivered quantity for ${esc(it.sku)}"></label>`).join('')}
      <h3 class="mt">Customer payment</h3><p class="subtitle" id="expectHint"></p><div class="formgrid mt">${selectF('Method', 'method', [...PAYMENT_METHODS, 'Not collected'], isCOD ? 'Cash' : 'Not collected', 'data-deliver="1"')}${field('Amount collected', 'amount', 'number', 0, 'min="0" step="0.01" data-amount="1"')}<label class="field" id="refWrap">Transaction reference<input name="ref" maxlength="60"></label>${field('Reason (required for partial delivery or short payment)', 'reason', 'text', '', 'maxlength="200"')}${field('Note', 'note', 'text', '', 'maxlength="200"')}</div><p class="inlinehelp">Delivered does not mean paid. Only cash increases what ${esc(carrierName(d))} holds. Non-cash goes to the business directly.</p>`, async f => {
      const quantities = {}; for (const it of d.items) quantities[it.lineId] = Number(f['q' + it.lineId]);
      const method = f.method, amount = Number(f.amount) || 0;
      if (method !== 'Not collected' && amount <= 0 && expectFor(quantities) > 0) fail('Enter the amount collected, or choose Not collected.');
      await Commands.deliver(id, { quantities, reason: f.reason, note: f.note, collection: method === 'Not collected' ? { amount: 0, shortReason: f.reason || 'Not collected at delivery' } : { amount, method, ref: f.ref } });
      toast('Delivery recorded. Revenue recognized for delivered units.');
    }, 'Record delivery');
    modalLive = (ev) => {
      const fm = document.getElementById('modalForm'), q = {}; d.items.forEach(it => q[it.lineId] = fm.elements['q' + it.lineId].value);
      const exp = expectFor(q), method = fm.elements.method.value; document.getElementById('expectHint').textContent = `Due for delivered items: ${m(exp)}${ca.paid ? ` (after ${m(ca.paid)} already paid)` : ''}`;
      if (!ev || ev.target.dataset.deliver) fm.elements.amount.value = method === 'Not collected' ? 0 : exp;
      fm.elements.amount.disabled = method === 'Not collected'; document.getElementById('refWrap').hidden = method === 'Cash' || method === 'Not collected';
    };
    modalLive();
  },
  collectModal(id) {
    const d = Repo.get('deliveries', id), o = orderOf(d.orderId), due = round2(calc(o).revenue - calc(o).paid);
    modal(`Record collection · ${id}`, `${note(`${m(due)} is due on order #${o.id}. Only cash increases what ${esc(carrierName(d))} holds.`)}<div class="formgrid">${field('Amount', 'amount', 'number', due, `min="0.01" max="${due + tol()}" step="0.01" required`)}${selectF('Method', 'method', PAYMENT_METHODS, 'Cash')}${field('Reference (required if non-cash)', 'ref', 'text', '', 'maxlength="60"')}${field('Reason if partial', 'shortReason', 'text', '', 'maxlength="200"')}</div>`, async f => { await Commands.collect(id, { amount: Number(f.amount), method: f.method, ref: f.ref, shortReason: f.shortReason }); toast('Collection recorded.'); }, 'Record collection');
  },

  /* driver money */
  /* Receiving cash from a driver: type the amount counted; it is matched to their oldest deliveries. */
  handoverModal(driverId) {
    const dr = Repo.get('drivers', driverId), c = driverCash(driverId);
    const rows = Repo.by('deliveries', 'carrierKey', carrierKey('driver', driverId)).map(d => ({ d, left: deliveryCash(d).unhanded })).filter(x => x.left > 0).sort((a, b) => (a.d.completedAt || a.d.assignedAt).localeCompare(b.d.completedAt || b.d.assignedAt));
    if (!rows.length || c.outstanding <= 0) return toast(`${dr.name} holds no cash to receive.`);
    const split = amt => { let room = round2(Math.min(Math.max(0, amt), c.outstanding)); return rows.map(x => { const a = round2(Math.min(room, x.left)); room = round2(room - a); return a; }); };
    const def = split(c.outstanding), n = Repo.count('handovers', 'driverId', driverId) + 1;
    modal(`Receive cash · ${esc(dr.name)}`, `<div class="cash-hero"><span><small>Holding now</small><strong>${m(c.outstanding)}</strong></span><small>From ${rows.length} deliveries, after approved expenses and refunds</small></div>
      <div class="formgrid mt">${field('Amount you counted and received', 'amount', 'number', c.outstanding, `min="0.01" max="${c.outstanding}" step="0.01" required data-amount="1"`)}${field('Received by', 'receivedBy', 'text', Session.user.name, 'required maxlength="60"')}${field('Date', 'date', 'date', today(), `required max="${today()}"`)}${field('Receipt reference', 'ref', 'text', `HO-${driverId}-${today().replaceAll('-', '')}-${n}`, 'required maxlength="40"')}</div>
      <p class="draft-total" id="allocTotal"></p>
      <details class="whynot mt"><summary>Which deliveries this cash is for</summary><p class="inlinehelp">Filled in for you, oldest delivery first. Change it only if the driver says the cash is for different deliveries.</p><div class="tablewrap mt"><table><thead><tr><th>Delivery</th><th>Order</th><th class="number">Cash not handed over</th><th class="number">From this cash</th></tr></thead><tbody>${rows.map((x, i) => `<tr><td>${x.d.id}</td><td>#${x.d.orderId}</td><td class="number">${m(x.left)}</td><td class="number"><input class="qtyinput wide" type="number" min="0" max="${x.left}" step="0.01" value="${def[i]}" data-alloc="${x.d.id}" aria-label="Allocation for ${x.d.id}"></td></tr>`).join('')}</tbody></table></div><div class="formgrid mt">${field('Amount the driver says they handed (optional)', 'declared', 'number', '', 'min="0" step="0.01"')}</div><p class="inlinehelp">If the driver declares more than you counted, a discrepancy is opened for review.</p></details>`, async f => {
      const allocations = [...document.querySelectorAll('#modalForm [data-alloc]')].map(el => ({ deliveryId: el.dataset.alloc, amount: Number(el.value) || 0 }));
      const t = round2(sum(allocations, a => a.amount)), amt = round2(Number(f.amount) || 0);
      if (Math.abs(t - amt) > 0.009) fail(`The deliveries add up to ${m(t)}, but you entered ${m(amt)}. Make them match under "Which deliveries this cash is for".`);
      await Commands.recordHandover({ driverId, ref: f.ref, at: dateToIso(f.date), receivedBy: f.receivedBy, allocations, declared: Number(f.declared) || null }); toast(`Cash received from ${dr.name}: ${m(amt)}.`);
    }, 'Receive cash', { wide: true });
    modalLive = ev => {
      const fm = document.getElementById('modalForm'); if (!fm) return;
      const amt = Number(fm.elements.amount.value) || 0;
      if (!ev || ev.target?.name === 'amount') { const parts = split(amt); fm.querySelectorAll('[data-alloc]').forEach((el, i) => { el.value = parts[i]; }); }
      const t = allocInputsTotal();
      document.getElementById('allocTotal').innerHTML = `<span class="bd"><span>Left with the driver after this</span> <b>${m(c.outstanding - amt)}</b></span>${Math.abs(t - amt) > 0.009 ? `<span class="bd negative"><span>Deliveries add up to</span> <b>${m(t)}</b></span>` : ''}`;
    };
    modalLive();
  },
  expenseDriverModal(driverId) {
    modal('Driver expense', `${note('An expense counts once in profit, when approved. Marking it as paid from collected cash only reduces what the driver owes back. Delivery fee payouts are already in delivery costs, so they only change cash custody.')}<div class="formgrid">${selectF('Category', 'category', DRIVER_EXPENSE_CATS)}${field('Amount', 'amount', 'number', '', 'min="0.01" step="0.01" required')}<label class="checkrow"><input type="checkbox" name="paidFromCash"> Driver paid this from collected cash</label>${field('Note', 'note', 'text', '', 'maxlength="200"')}</div>`, async f => { const id = await Commands.addDriverExpense({ driverId, category: f.category, amount: Number(f.amount), paidFromCash: !!f.paidFromCash, note: f.note }); toast(`${id} submitted for approval.`); }, 'Submit');
  },
  decideExp([id, decision]) { run(() => Commands.decideDriverExpense(id, decision), `${id} ${decision.toLowerCase()}.`); },
  resolveModal(id) { modal(`Resolve ${id}`, textF('How was this resolved?', 'res', '', 'required maxlength="200"'), async f => { await Commands.resolveDiscrepancy(id, f.res); toast('Discrepancy resolved.'); }, 'Resolve'); },
  driverModal(id) { const d = id ? Repo.get('drivers', id) : { name: '', phone: '', vehicle: 'Motorcycle', zones: '', availability: 'Available', active: true }; modal(id ? `Edit ${esc(d.name)}` : 'New driver', `<div class="formgrid">${field('Name', 'name', 'text', d.name, 'required maxlength="60"')}${field('Mobile', 'phone', 'tel', d.phone, 'required')}${selectF('Vehicle', 'vehicle', ['Motorcycle', 'Van', 'Car', 'Bicycle'], d.vehicle)}${field('Zones', 'zones', 'text', d.zones, 'maxlength="100"')}${selectF('Availability', 'availability', ['Available', 'Busy', 'Off duty'], d.availability)}${selectF('Record state', 'state', [['active', 'Active'], ['inactive', 'Inactive, history preserved']], d.active === false ? 'inactive' : 'active')}</div>`, async f => { const rid = await Commands.saveDriver({ id, ...f, active: f.state === 'active' }); toast('Driver saved.'); if (!id) location.hash = `#/drivers/${rid}`; }); },
  courierModal(id) { const c = id ? Repo.get('couriers', id) : { name: '', shipRate: 60, returnRate: 40, codFee: 15, active: true }; modal(id ? `Edit ${esc(c.name)}` : 'New courier', `<div class="formgrid">${field('Name', 'name', 'text', c.name, 'required maxlength="60"')}${field('Ship rate', 'shipRate', 'number', c.shipRate, 'min="0" required')}${field('Return rate', 'returnRate', 'number', c.returnRate, 'min="0" required')}${field('COD fee', 'codFee', 'number', c.codFee, 'min="0" required')}${selectF('State', 'state', [['active', 'Active'], ['inactive', 'Inactive']], c.active === false ? 'inactive' : 'active')}</div><p class="inlinehelp">Rates apply to new assignments. Past deliveries keep their cost.</p>`, async f => { await Commands.saveCourier({ id, ...f, active: f.state === 'active' }); toast('Courier saved.'); }); },
  /* A courier's payment: tick the deliveries it covers, or let their statement tick them. */
  settlementModal(courierId) {
    const cr = Repo.get('couriers', courierId);
    const rows = Repo.by('deliveries', 'carrierKey', carrierKey('courier', courierId)).filter(d => d.completedAt || d.returnedAt).map(d => ({ d, b: courierDeliveryBalance(d) })).filter(x => Math.abs(x.b.gap) > 0.001).sort((a, b) => (a.d.completedAt || a.d.returnedAt).localeCompare(b.d.completedAt || b.d.returnedAt)).slice(0, 500);
    if (!rows.length) return toast(`Nothing outstanding from ${cr.name}.`);
    stmt = null; stmtCtx = { courierId };
    modal(`Payment from ${esc(cr.name)}`, `${note('Tick the deliveries this payment covers. Each one is filled in with what the courier should send you: the customer\'s cash less their shipping, return and COD charges. To tick them for you, open "Match the courier\'s statement" below.')}
      <div class="formgrid">${field('Amount received', 'received', 'number', '', 'step="0.01" data-amount="1" placeholder="From the bank transfer or cash"')}${field('Payment reference', 'ref', 'text', '', 'required maxlength="40"')}${field('Date received', 'date', 'date', today(), `required max="${today()}"`)}</div>
      <details class="whynot mt"><summary>Match the courier's statement</summary><p class="inlinehelp">Export the statement from the courier's portal as CSV, or copy the rows in Excel and paste them here with the header row. Rows are matched by tracking number, delivery ID or order number.</p>
        <div class="formgrid mt"><label class="field">Statement file (.csv)<input type="file" id="stmtFile" accept=".csv,.tsv,.txt,text/csv"></label><label class="field">Or paste the rows<textarea name="stmtText" rows="3" data-mi="1" dir="auto"></textarea></label></div>
        <div class="formgrid mt" id="stmtCols" hidden>${selectF('Column with the tracking or order number', 'refCol', [], '', 'data-stmt="1"')}${selectF('Column with the amount paid to you', 'amtCol', [], '', 'data-stmt="1"')}</div><div id="stmtResult" class="mt"></div></details>
      <div class="tablewrap mt"><table><thead><tr><th><input type="checkbox" data-allinc="1" checked aria-label="Tick every delivery"></th><th>Delivery</th><th>Order</th><th>Tracking no.</th><th class="number">Customer paid</th><th class="number">Charges</th><th class="number">Already received</th><th class="number">Received now</th></tr></thead><tbody>${rows.map(({ d, b }) => `<tr><td><input type="checkbox" data-inc="${d.id}" checked aria-label="Include ${d.id}"></td><td>${d.id}<br><small>${esc(d.status)}</small></td><td>#${d.orderId}</td><td>${esc(d.tracking || '—')}</td><td class="number">${m(b.customer)}</td><td class="number">${m(-b.deductions)}</td><td class="number">${m(b.actual)}</td><td class="number"><input class="qtyinput wide" type="number" step="0.01" value="${b.gap}" data-alloc="${d.id}" data-exp="${b.gap}" aria-label="Net received for ${d.id}"></td></tr>`).join('')}</tbody></table></div>
      <p class="draft-total" id="allocTotal"></p>`, async f => {
      const allocations = ticked().map(el => ({ deliveryId: el.dataset.alloc, net: Number(el.value) || 0 })).filter(a => a.net);
      if (!allocations.length) fail('Tick at least one delivery.');
      const t = round2(sum(allocations, a => a.net));
      if (f.received !== '' && Math.abs(t - Number(f.received)) > tol()) fail(`The ticked deliveries add up to ${m(t)}, but you received ${m(Number(f.received))}. Untick or correct deliveries until the difference is zero, or leave "Amount received" empty.`);
      await Commands.recordSettlement({ courierId, ref: f.ref, at: dateToIso(f.date), allocations }); toast(`Payment ${f.ref} recorded: ${m(t)}.`);
    }, 'Record payment', { wide: true });
    modalLive = async ev => {
      const t = ev?.target, fm = document.getElementById('modalForm'); if (!fm) return;
      if (t?.dataset?.allinc) fm.querySelectorAll('[data-inc]').forEach(x => { x.checked = t.checked; });
      if (t?.id === 'stmtFile' && t.files[0]) { if (t.files[0].size > 5e6) toast('The statement is larger than 5 MB.', 'bad'); else loadStatement(await t.files[0].text()); }
      if (t?.name === 'stmtText') loadStatement(t.value);
      if (t?.dataset?.stmt) matchStatement();
      fm.querySelectorAll('[data-alloc]').forEach(el => { el.disabled = !fm.querySelector(`[data-inc="${el.dataset.alloc}"]`).checked; });
      const inc = ticked(), tot = round2(sum(inc, el => Number(el.value) || 0)), rec = fm.elements.received.value, diff = rec === '' ? null : round2(Number(rec) - tot);
      document.getElementById('allocTotal').innerHTML = `<span class="bd"><span>Deliveries ticked</span> <b>${inc.length}</b></span><span class="bd"><span>Their total</span> <b>${m(tot)}</b></span>${diff === null ? '' : `<span class="bd ${Math.abs(diff) > tol() ? 'negative' : 'positive'}"><span>Difference from the amount received</span> <b>${m(diff)}</b></span>`}`;
    };
    modalLive();
  },

  /* inventory */
  stockModal(arg) { const [type, item] = arg || ['sku', '']; const opts = type === 'material' ? Repo.all('materials').map(x => [x.id, `${x.id} · ${x.name}`]) : Repo.all('skus').map(s => [s.id, `${s.id} · ${s.name} ${s.variant}`]); modal('Adjust stock', `${note('Adjustments add a row to the movement journal. They never overwrite a balance.')}<div class="formgrid">${selectF('Item', 'item', opts, item)}${field('Change (+ or −)', 'qty', 'number', '', 'step="any" required')}${selectF('Reason', 'reasonKind', ['Cycle count correction', 'Damaged in warehouse', 'Found stock', 'Sample or giveaway', 'Other'])}${field('Details', 'detail', 'text', '', 'maxlength="150"')}</div>`, async f => { await Commands.adjustStock({ item: f.item, itemType: type, qty: Number(f.qty), reason: [f.reasonKind, f.detail].filter(Boolean).join(': ') }); toast('Stock adjusted.'); }, 'Adjust'); },
  materialModal(id) { modal('Receive material', `<div class="formgrid">${selectF('Material', 'item', Repo.all('materials').map(x => [x.id, x.name]), id)}${field('Quantity', 'qty', 'number', '', 'min="0.01" step="any" required')}${field('Purchase reference', 'ref', 'text', '', 'required maxlength="40"')}</div><p class="inlinehelp">A reference can only be received once per material.</p>`, async f => { await Commands.receiveMaterial({ item: f.item, qty: Number(f.qty), ref: f.ref }); toast('Material received.'); }, 'Receive'); },
  skuModal(id) {
    const s = id ? Repo.get('skus', id) : null, b = id ? Repo.get('boms', id) : { lines: [], labor: 50, overhead: 20 }, qty = mid => b.lines.find(x => x.material === mid)?.qty ?? 0;
    modal(id ? `Edit ${esc(id)}` : 'New SKU', `<div class="formgrid">${field('SKU code', 'id', 'text', id || '', `required ${id ? 'readonly' : ''} maxlength="20"`)}${field('Product name', 'name', 'text', s?.name || '', 'required')}${field('Variant', 'variant', 'text', s?.variant || '')}${field('Price', 'price', 'number', s?.price || '', 'min="1" required')}${field('Reorder at', 'min', 'number', s?.min ?? 10, 'min="0" required')}${Session.seesCosts ? field('Labor per unit', 'labor', 'number', b.labor, 'min="0" required') + field('Overhead per unit', 'overhead', 'number', b.overhead, 'min="0" required') : ''}</div><h3 class="mt">Bill of materials, per unit</h3><div class="formgrid mt">${Repo.all('materials').map(x => field(`${esc(x.name)} (${esc(x.unit)})`, 'bom_' + x.id, 'number', qty(x.id), 'min="0" step="0.01"')).join('')}</div><p class="inlinehelp">Existing orders keep their cost snapshot.${Session.seesCosts ? '' : ' Labor and overhead are set by owner or finance.'}</p>`, async f => { await Commands.saveSku({ isNew: !id, id: f.id, name: f.name, variant: f.variant, price: f.price, min: f.min, labor: f.labor, overhead: f.overhead, bom: Repo.all('materials').map(x => ({ material: x.id, qty: f['bom_' + x.id] })) }); toast('SKU saved.'); }, 'Save SKU', { wide: true });
  },
  productionModal() { modal('New production order', `<div class="formgrid">${selectF('SKU', 'sku', Repo.all('skus').map(s => [s.id, `${s.id} · ${s.name} ${s.variant}`]))}${field('Units', 'qty', 'number', 10, 'min="1" required')}${field('Due date', 'due', 'date', dayShift(today(), 7))}</div><p class="inlinehelp">Planned orders consume nothing until started.</p>`, async f => { const id = await Commands.createProduction({ sku: f.sku, qty: Number(f.qty), due: f.due }); ui.inv.tab = 'Production'; toast(`${id} planned.`); }, 'Create'); },
  startMO(id) { run(() => Commands.startProduction(id), `${id} started. Materials consumed into WIP.`); },
  completeMO(id) { run(() => Commands.completeProduction(id), `${id} completed. Finished goods received.`); },
  cancelMO(id) { run(() => Commands.cancelProduction(id), `${id} cancelled.`); },

  /* CRM */
  customerModal(id) { const c = id ? Repo.get('customers', id) : { name: '', phone: '', area: AREAS[0], address: '', deliveryNotes: '', preferredTime: 'Any time', tags: [], altAddresses: [] }; modal(id ? `Edit ${esc(c.name)}` : 'New customer', `<div class="formgrid">${field('Name', 'name', 'text', c.name, 'required maxlength="60"')}${field('Mobile', 'phone', 'tel', c.phone, 'required placeholder="01012345678"')}${selectF('Area', 'area', AREAS, c.area)}${selectF('Preferred delivery time', 'preferredTime', ['Any time', 'Morning', 'Afternoon', 'Evening'], c.preferredTime)}<label class="field full">Address<input name="address" value="${esc(c.address)}" required maxlength="200"></label><label class="field full">Alternate address (optional)<input name="alt" value="${esc(c.altAddresses?.[0] || '')}" maxlength="200"></label>${textF('Delivery instructions', 'deliveryNotes', c.deliveryNotes, 'maxlength="300"')}</div>`, async f => { const r = await Commands.saveCustomer({ id, ...f, tags: c.tags, altAddresses: f.alt ? [f.alt] : [] }); toast('Customer saved.'); if (!id) location.hash = `#/customers/${r.id}`; }); },
  contactModal(id) { modal('Log a contact', `${note('This records a conversation that already happened. It does not send anything.')}<div class="formgrid">${selectF('Channel', 'channel', ['Phone', 'WhatsApp', 'Instagram', 'Email', 'In person'])}${selectF('Direction', 'direction', ['Outbound', 'Inbound'])}${textF('Summary', 'summary', '', 'required maxlength="500"')}${field('Follow up on (optional)', 'followUp', 'date')}</div>`, async f => { await Commands.logContact({ customerId: id, ...f }); toast('Contact logged. No message was sent.'); }, 'Log contact'); },
  /* staff attendance */
  employeeModal(id) {
    const e = id ? Repo.get('employees', id) : { name: '', phone: '', jobTitle: '', shiftStart: '09:00', active: true, note: '' };
    modal(id ? `Edit ${esc(e.name)}` : 'New employee', `<div class="formgrid">${field('Name', 'name', 'text', e.name, 'required maxlength="60"')}${field('Job title', 'jobTitle', 'text', e.jobTitle || '', 'maxlength="60"')}${field('Mobile (optional)', 'phone', 'tel', e.phone || '', 'placeholder="01012345678"')}${field('Shift starts at', 'shiftStart', 'time', e.shiftStart || '')}${selectF('State', 'state', [['active', 'Active'], ['inactive', 'Inactive, history kept']], e.active === false ? 'inactive' : 'active')}${textF('Note (optional)', 'note', e.note || '', 'maxlength="300"')}</div><p class="inlinehelp">The shift start shows how late someone checked in. The status is always the one you choose.</p>`, async f => { await Commands.saveEmployee({ id, ...f, active: f.state === 'active' }); toast('Employee saved.'); });
  },
  /* One tap per person. Present keeps the shift start unless they came earlier; Late takes the time now. */
  attSet([employeeId, status]) {
    const date = staffDate(), cur = Repo.get('attendance', `ATT-${employeeId}-${date}`), e = Repo.get('employees', employeeId), isToday = date === today(), now = nowHHMM();
    const works = status === 'Present' || status === 'Late';
    const checkIn = !works ? '' : cur?.checkIn || (status === 'Late' ? (isToday ? now : '') : (isToday && (!e.shiftStart || now < e.shiftStart) ? now : e.shiftStart || ''));
    run(() => Commands.recordAttendance({ employeeId, date, status, checkIn, checkOut: works ? cur?.checkOut || '' : '', note: cur?.note || '' }));
  },
  attTime([employeeId, k, v]) {
    const date = staffDate(), cur = Repo.get('attendance', `ATT-${employeeId}-${date}`);
    run(() => Commands.recordAttendance({ employeeId, date, status: cur && cur.status !== 'Absent' && cur.status !== 'Leave' && cur.status !== 'Day off' ? cur.status : 'Present', checkIn: k === 'checkIn' ? v : cur?.checkIn || '', checkOut: k === 'checkOut' ? v : cur?.checkOut || '', note: cur?.note || '' }));
  },
  attNow([employeeId]) { A.attTime([employeeId, 'checkOut', nowHHMM()]); },
  attAllPresent() {
    const date = staffDate(), es = Repo.all('employees').filter(e => e.active !== false && !Repo.get('attendance', `ATT-${e.id}-${date}`));
    if (!es.length) return toast('Everyone already has attendance for this day.');
    run(() => Commands.recordAttendanceDay(date, es.map(e => ({ employeeId: e.id, status: 'Present', checkIn: e.shiftStart || '' }))), n => `${n} marked present.`);
  },
  attRemove(id) { run(() => Commands.removeAttendance(id), 'Attendance cleared.'); },
  attendanceModal([employeeId, date]) {
    const e = Repo.get('employees', employeeId), cur = Repo.get('attendance', `ATT-${employeeId}-${date}`) || {};
    modal(`${esc(e.name)} · ${esc(date)}`, `<div class="formgrid">${selectF('Status', 'status', ATTENDANCE_STATUSES, cur.status || 'Present')}${field('Check in', 'checkIn', 'time', cur.checkIn || e.shiftStart || '')}${field('Check out', 'checkOut', 'time', cur.checkOut || '')}${textF('Note (optional)', 'note', cur.note || '', 'maxlength="200"')}</div><p class="inlinehelp">Times are kept only for Present and Late.</p>`, async f => { await Commands.recordAttendance({ employeeId, date, ...f }); toast('Attendance saved.'); });
  },
  toggleTag([id, t]) { const c = Repo.get('customers', id), has = (c.tags || []).includes(t); run(() => Commands.setCustomerTags(id, has ? c.tags.filter(x => x !== t) : [...(c.tags || []), t])); },

  /* campaigns and finance */
  campaignModal(id) { const c = id ? Repo.get('campaigns', id) : { name: '', platform: 'Meta', start: today(), end: dayShift(today(), 30), budget: 5000, reportedRoas: 0 }; modal(id ? `Edit ${esc(c.name)}` : 'New campaign', `<div class="formgrid">${field('Name', 'name', 'text', c.name, 'required maxlength="80"')}${selectF('Platform', 'platform', ['Meta', 'Instagram', 'TikTok', 'Google', 'WhatsApp', 'Influencer', 'Other'], c.platform)}${field('Meta campaign ID (optional)', 'metaId', 'text', c.metaId || '', 'maxlength="40" placeholder="From Ads Manager, e.g. 120210000000000000"')}${field('Start', 'start', 'date', c.start, 'required')}${field('End', 'end', 'date', c.end, 'required')}${field('Budget', 'budget', 'number', c.budget, 'min="0"')}${field('Reported platform ROAS (typed in, optional)', 'reportedRoas', 'number', c.reportedRoas, 'min="0" step="0.1"')}</div><p class="inlinehelp">Record actual spend with Add spend. No ad account is connected. The Meta campaign ID links this campaign to the same campaign in Ads Manager, so spend is entered against the right one.</p>`, async f => { await Commands.saveCampaign({ id, ...f }); toast('Campaign saved.'); }); },
  spendModal(id) { modal(`Record spend · ${esc(Repo.get('campaigns', id).name)}`, `<div class="formgrid">${field('Amount (negative to correct)', 'amount', 'number', '', 'step="0.01" required')}${field('Date', 'date', 'date', today(), 'required')}<label class="field full">Note<input name="note" maxlength="200"></label></div><p class="inlinehelp">Attributed order contribution recalculates. If no orders are attributed, this still reduces company profit.</p>`, async f => { await Commands.addSpend({ campaignId: id, amount: Number(f.amount), at: dateToIso(f.date), note: f.note }); toast('Spend recorded.'); }, 'Record spend'); },
  expenseModal() { modal('Operating expense', `<div class="formgrid">${field('Description', 'name', 'text', '', 'required maxlength="120"')}${selectF('Category', 'category', EXPENSE_CATS)}${field('Amount', 'amount', 'number', '', 'min="0.01" step="0.01" required')}${field('Date', 'date', 'date', today(), 'required')}</div>`, async f => { await Commands.addExpense({ name: f.name, category: f.category, amount: Number(f.amount), at: dateToIso(f.date) }); toast('Expense recorded.'); }); },
  removeExpense(id) { const e = Repo.get('expenses', id); modal('Remove expense?', `<p>Remove “${esc(e.name)}” (${m(e.amount)})? Operating profit will change.</p>`, async () => { await Commands.removeExpense(id); toast('Expense removed.'); }, 'Remove', { danger: true }); },
  closePeriodModal() {
    const lock = S().lockedThrough, last = dayShift(today().slice(0, 8) + '01', -1);
    modal('Close the books', `<div class="formgrid">${field('Close every day up to and including', 'through', 'date', lock && last <= lock ? dayShift(today(), -1) : last, `required max="${dayShift(today(), -1)}"${lock ? ` min="${dayShift(lock, 1)}"` : ''}`)}</div><p class="inlinehelp">After closing, handovers, settlements, spend and expenses can't be added, back-dated or removed on these days. The figures at this moment are recorded so you can check later that nothing changed.</p>`,
      async f => { await Commands.closePeriod(f.through); ui.fin.tab = 'Closed periods'; toast(`Books closed through ${f.through}.`); }, 'Close books');
  },
  reopenPeriodModal() {
    const lock = S().lockedThrough;
    modal('Reopen closed days', `${note(`The books are closed through <strong>${esc(lock)}</strong>. Reopening lets figures in those days change again. Use it only to fix a real mistake, then close again.`, 'warning')}<div class="formgrid">${field('Keep closed through (leave empty to reopen everything)', 'through', 'date', '', `max="${dayShift(lock, -1)}"`)}${textF('Reason', 'reason', '', 'required maxlength="300"')}</div>`,
      async f => { await Commands.reopenPeriod(f.through || null, f.reason); toast('Period reopened.'); }, 'Reopen', { danger: true });
  },
  exportFinance() { const r = presetRange(ui.fin), t = totals(r); download('commerce-os-pnl.csv', toCsv([['metric', S().currency], ['Period', rangeLabel(r)], ['Recognized revenue', t.revenue], ['COGS', t.cogs], ['Gross profit', t.gross], ['Delivery and return costs', t.delivery], ['Payment and COD fees', t.fees], ['Marketing spend', t.marketing], ['Operating expenses', t.opex], ['Approved driver expenses', t.driverexp], ['Operating profit before tax', t.profit], ['Customer payments collected', t.collected], ['Business cash received', t.bizcash]]), 'text/csv'); toast('P&L exported.'); },

  /* import and export */
  exportOrders() {
    const rows = filteredOrders(), hide = new Set(Session.seesCosts ? [] : ['cogs', 'marketing_allocation', 'contribution']), table = [['order_id', 'date', 'customer', 'phone', 'area', 'items', 'units', 'channel', 'entry_method', 'campaign', 'order_status', 'delivery_status', 'carrier', 'payment_status', 'settlement_status', 'order_value', 'recognized_revenue', 'cogs', 'delivery_costs', 'fees', 'marketing_allocation', 'contribution', 'customer_collected', 'business_cash'], ...rows.map(o => { const c = customerOf(o), a = calc(o), d = latestDelivery(o), ls = linesOf(o); return [o.id, dateKey(o.at), c.name, c.phone, o.area, ls.map(l => `${l.qty}x${l.sku}`).join(' '), ls.reduce((n, l) => n + l.qty, 0), o.channel, o.source, Repo.get('campaigns', o.campaignId)?.name || '', o.status, d?.status || '', d ? carrierName(d) : '', paymentStatus(o), settlementStatus(o), a.value, a.revenue, a.cogs, a.delivery, a.fees, allocationOf(o), contributionOf(o), a.collected, a.bizcash]; })], keep = table[0].map((h, i) => !hide.has(h) ? i : -1).filter(i => i >= 0);
    download('commerce-os-orders.csv', toCsv(table.map(r => keep.map(i => r[i]))), 'text/csv'); toast(`${rows.length} orders exported.`);
  },
  template() { download('commerce-os-orders-template.csv', [CSV_COLUMNS.join(','), `WEB-1001,${today()},01099990001,Reem Fouad,Maadi,"12 Road 9, Maadi",TEE-IVR,2,,0,0,50,Website,,COD`, `WEB-1001,${today()},01099990001,Reem Fouad,Maadi,"12 Road 9, Maadi",TOT-NAT,1,,0,0,50,Website,,COD`, `WEB-1002,${today()},01099990002,Tamer Sobhy,Dokki,"5 Tahrir St, Dokki",LIN-SND,1,850,0,0,0,Instagram,Autumn essentials,InstaPay`].join('\n'), 'text/csv'); },
  importModal() {
    pendingImport = null;
    modal('Import orders from CSV', `${note('Each row is a line item. Rows sharing an external_ref become one order. Nothing is saved until you review the preview. Importing the same external_ref twice is blocked. Entry method is recorded as CSV.')}${btn('↓ Download template', 'template')}<label class="field mt">Choose CSV file (max 5 MB)<input id="csvFile" type="file" accept=".csv,text/csv"></label><div id="importPreview" class="mt"></div>`, async () => {
      if (!pendingImport?.groups.length) fail('Choose a file with at least one valid order first.');
      const n = await Commands.importOrders(pendingImport.groups);
      toast(`${n} orders imported.`); pendingImport = null;
    }, 'Import valid orders', { wide: true });
  },
  downloadBackup() { location.href = '/api/admin/backup'; toast('Backup downloading.'); },
  restoreModal() { modal('Restore backup', `${note('This replaces every business record, for all users, with the file\'s contents. User logins are kept.', 'warning')}<label class="field">Backup file (.json)<input type="file" name="file" accept=".json,application/json" required></label>`, async (f, form) => { const file = form.elements.file.files[0]; if (!file) fail('Choose a file.'); let d; try { d = JSON.parse(await file.text()); } catch { fail('That file is not valid JSON.'); } await request('/api/admin/restore', { method: 'POST', body: d }); await loadSnapshot(); ui.selected.clear(); ui.tbl = {}; toast('Backup restored.'); }, 'Replace workspace', { danger: true }); },
  resetModal() { modal('Reset demo data?', '<p>This deletes every business record for all users, including orders you created and any load-test data, and rebuilds the fictional dataset. User logins are kept. If the server has a demo password set, a test login is also created for each role.</p>', async () => { const r = await request('/api/admin/reset', { method: 'POST', body: {} }); await loadSnapshot(); ui.selected.clear(); ui.tbl = {}; ui.loadResult = null; toast(r.demoLogins?.length ? `Demo data reset. Test logins ready: ${r.demoLogins.map(x => x.email).join(', ')}.` : 'Demo data reset.'); }, 'Reset demo', { danger: true }); },
  async loadTest(n) { toast(`Generating ${n.toLocaleString('en-US')} orders…`); await run(async () => { ui.loadResult = await request('/api/admin/load-test', { method: 'POST', body: { orders: n } }); await loadSnapshot(); ui.tbl = {}; }, `Added ${n.toLocaleString('en-US')} orders. Reset demo data to remove them.`); },

  /* account and team */
  accountModal() { const u = Session.user; modal('Your account', `${row('Name', esc(u.name))}${row('Email', esc(u.email))}${row('Role', esc(u.role))}${row('Language', `<button type="button" class="small" data-a="toggleLang" data-no-i18n>${isAr() ? 'English' : 'العربية'}</button>`)}<h3 class="mt">Change password</h3><div class="formgrid mt">${field('Current password', 'current', 'password', '', 'autocomplete="current-password"')}${field('New password (10+ characters)', 'next', 'password', '', 'autocomplete="new-password"')}</div><div class="actions mt"><button type="button" data-a="logout">Sign out</button></div>`, async f => { if (!f.next) return; await request('/api/me/password', { method: 'POST', body: f }); toast('Password changed.'); }, 'Save'); },
  async logout() { closeModal(); await request('/api/auth/logout', { method: 'POST', body: {} }); Session.onAuthLost?.(); },
  async loadTeam() { await run(async () => { ui.team = await request('/api/users'); render(); }); },
  userModal(id) {
    const u = id ? ui.team.users.find(x => x.id === id) : { name: '', email: '', role: 'operations', driverId: '', active: true };
    modal(id ? `Edit ${esc(u.name)}` : 'Add login', `<div class="formgrid">${field('Name', 'name', 'text', u.name, 'required maxlength="60"')}${id ? '' : field('Email', 'email', 'email', '', 'required')}${selectF('Role', 'role', ROLES, u.role)}${selectF('Driver record (driver role only)', 'driverId', [['', 'None'], ...ui.team.drivers.map(d => [d.id, d.name])], u.driverId || '')}${field(id ? 'New password (optional)' : 'Password (10+ characters)', 'password', 'password', '', `${id ? '' : 'required '}autocomplete="new-password"`)}${id ? selectF('State', 'state', [['active', 'Active'], ['inactive', 'Inactive']], u.active ? 'active' : 'inactive') : ''}</div>`, async f => {
      if (id) await request(`/api/users/${id}`, { method: 'PATCH', body: { name: f.name, role: f.role, driverId: f.driverId || null, active: f.state === 'active', password: f.password || undefined } });
      else await request('/api/users', { method: 'POST', body: { email: f.email, name: f.name, role: f.role, driverId: f.driverId || null, password: f.password } });
      ui.team = await request('/api/users'); render(); toast('Login saved.');
    });
  },
};
function bulkReport(verb, results, keepSelection = false) {
  const ok = results.filter(x => !x).length, bad = results.filter(Boolean);
  if (!keepSelection) ui.selected.clear();
  if (!bad.length) return toast(`${ok} order${ok === 1 ? '' : 's'} ${verb}.`), render();
  render();
  modal(`${ok} ${verb}, ${bad.length} skipped`, `<ul class="plain">${bad.slice(0, 30).map(x => `<li>${esc(x)}</li>`).join('')}</ul>${bad.length > 30 ? `<p class="inlinehelp">And ${bad.length - 30} more.</p>` : ''}`, null);
}
function syncAssign() { const f = document.getElementById('modalForm'); if (!f) return; const mode = f.elements.mode?.value; f.querySelectorAll('[data-show]').forEach(el => { el.hidden = el.dataset.show !== mode; }); }

/* ---------- Courier statement matching ---------- */
const ticked = () => [...document.querySelectorAll('#modalForm [data-alloc]')].filter(el => document.querySelector(`#modalForm [data-inc="${el.dataset.alloc}"]`)?.checked);
function loadStatement(text) {
  const fm = document.getElementById('modalForm'), box = document.getElementById('stmtResult'), cols = document.getElementById('stmtCols'); if (!fm) return;
  try {
    if (!text.trim()) { stmt = null; cols.hidden = true; box.innerHTML = ''; return; }
    const rows = parseTable(text), head = (rows.shift() || []).map(h => h.trim());
    if (!rows.length) throw new Rule('The statement needs a header row and at least one data row.');
    stmt = { head, rows };
    const find = re => head.findIndex(h => re.test(h));
    let ri = find(/track|awb|airway|waybill|bill|barcode|shipment|بوليص|الشحن|تتبع/i); if (ri < 0) ri = find(/order|ref|reference|code|id\b|رقم|كود/i); if (ri < 0) ri = 0;
    let ai = find(/net|صافي/i); if (ai < 0) ai = find(/cod|amount|collected|cash|value|total|paid|المبلغ|التحصيل|قيمة|إجمالي/i); if (ai < 0) ai = head.length - 1;
    const opts = head.map((h, i) => `<option value="${i}">${esc(h || `Column ${i + 1}`)}</option>`).join('');
    fm.elements.refCol.innerHTML = opts; fm.elements.amtCol.innerHTML = opts; fm.elements.refCol.value = String(ri); fm.elements.amtCol.value = String(ai); cols.hidden = false;
    matchStatement();
  } catch (e) { stmt = null; cols.hidden = true; box.innerHTML = `<p class="form-error">${esc(e instanceof Rule ? e.message : 'That statement could not be read.')}</p>`; }
}
function matchStatement() {
  const fm = document.getElementById('modalForm'), box = document.getElementById('stmtResult'); if (!stmt || !fm || !stmtCtx) return;
  const ri = Number(fm.elements.refCol.value), ai = Number(fm.elements.amtCol.value), keys = new Map();
  for (const d of Repo.by('deliveries', 'carrierKey', carrierKey('courier', stmtCtx.courierId))) for (const k of [d.id, d.orderId, orderOf(d.orderId)?.externalRef, d.tracking]) if (k !== null && k !== undefined && k !== '') keys.set(normRef(k), d);
  const got = new Map(), missing = [], settled = [], noAmount = [];
  for (const r of stmt.rows) {
    const raw = r[ri] ?? '', ref = normRef(raw); if (!ref) continue;
    const amt = toAmount(r[ai]); if (!Number.isFinite(amt)) { noAmount.push(raw); continue; }
    const d = keys.get(ref); if (!d) { missing.push(raw); continue; }
    if (!fm.querySelector(`[data-inc="${d.id}"]`)) { settled.push(raw); continue; }
    got.set(d.id, round2((got.get(d.id) || 0) + amt));
  }
  fm.querySelectorAll('[data-inc]').forEach(x => { x.checked = got.has(x.dataset.inc); }); fm.querySelector('[data-allinc]').checked = false;
  fm.querySelectorAll('[data-alloc]').forEach(el => { el.value = got.has(el.dataset.alloc) ? got.get(el.dataset.alloc) : el.dataset.exp; });
  const total = round2(sum([...got.values()], x => x)); if (got.size) fm.elements.received.value = total;
  const odd = [...got].filter(([id, v]) => Math.abs(v - Number(fm.querySelector(`[data-alloc="${id}"]`).dataset.exp)) > tol());
  const list = (title, xs, html) => xs.length ? `<p class="mt"><strong>${title}</strong> <span class="badge">${xs.length}</span></p><p class="small">${xs.slice(0, 25).map(x => html ? x : esc(x)).join(html ? '<br>' : ' · ')}${xs.length > 25 ? ' …' : ''}</p>` : '';
  box.innerHTML = `<div class="stmt-sum"><span class="bd"><span>Rows in the statement</span> <b>${stmt.rows.length}</b></span><span class="bd positive"><span>Matched and ticked</span> <b>${got.size}</b></span><span class="bd"><span>Statement total</span> <b>${m(total)}</b></span></div>`
    + list('Paid differently from what we expected', odd.map(([id, v]) => `${esc(id)}: <span>statement</span> <b>${m(v)}</b>, <span>expected</span> <b>${m(Number(fm.querySelector(`[data-alloc="${id}"]`).dataset.exp))}</b>`), true)
    + list('Not found for this courier. Check the tracking numbers on these deliveries', missing)
    + list('Already settled earlier', settled) + list('No amount in the amount column', noAmount);
}

/* ---------- Global search ---------- */
function globalSearch(q) {
  q = q.trim().toLowerCase().replace(/^#/, ''); if (q.length < 2) return [];
  const out = [], cap = 4;
  let n = 0; for (const o of Repo.all('orders')) { if (orderSearchText(o).includes(q)) { out.push({ href: `#/orders/${o.id}`, title: `Order #${o.id}`, sub: `${customerOf(o).name} · ${o.status}` }); if (++n >= cap) break; } }
  n = 0; for (const c of Repo.all('customers')) { if (`${c.name} ${c.phone} ${c.id}`.toLowerCase().includes(q)) { out.push({ href: `#/customers/${c.id}`, title: c.name, sub: `Customer · ${c.phone}` }); if (++n >= cap) break; } }
  for (const d of Repo.all('drivers')) if (`${d.name} ${d.phone}`.toLowerCase().includes(q)) out.push({ href: `#/drivers/${d.id}`, title: d.name, sub: `Driver · ${d.availability}` });
  n = 0; for (const s of Repo.all('skus')) { if (`${s.id} ${s.name}`.toLowerCase().includes(q)) { out.push({ href: Session.canSee('products') ? `#/products/${s.id}` : '#/inventory', title: s.id, sub: `${s.name} · ${availableOf(s.id)} available` }); if (++n >= cap) break; } }
  if (Session.canSee('staff')) for (const e of Repo.all('employees')) if (`${e.name} ${e.phone} ${e.jobTitle}`.toLowerCase().includes(q)) out.push({ href: `#/staff/${e.id}`, title: e.name, sub: `Employee · ${e.jobTitle || ''}` });
  const del = Repo.get('deliveries', q.toUpperCase()); if (del) out.unshift({ href: `#/orders/${del.orderId}`, title: del.id, sub: `Delivery · ${del.status} · ${carrierName(del)}` });
  return out.slice(0, 10);
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

export { normRef, parseTable, printPref, toAmount, A, CSV_COLUMNS, allocInputsTotal, bulkReport, closeModal, csvCell, customerOptionsFor, dateToIso, download, field, globalSearch, handleCsv, lineSum, modal, modalLive, nowLocal, orderDraft, parseCSV, pendingImport, prepareImport, renderDraftLines, run, selectF, syncAssign, textF, toCsv, toast };
