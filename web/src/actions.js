import { Commands, Session, request, loadSnapshot, pull } from './api.js';
import { isAr, setLang, trText } from './i18n.js';
import { MANUAL_ACCOUNTS, ACCOUNT, ACCOUNTS, accountBalances, accountLedger, incomeStatement, trialBalance } from '@commerce-os/domain';
import { ROLES } from '@commerce-os/domain';
import { Repo, Rule, esc, fail, round2, sum } from '@commerce-os/domain';
import { unlinkedCashSpend, leaveBalance, plannedStatus, carrierCharge, ATTENDANCE_STATUSES, lateMinutes, RETURN_REASONS, AREAS, CHANNELS, DRIVER_EXPENSE_CATS, EXPENSE_CATS, FAILURE_REASONS, PAYMENT_METHODS, S, activeDelivery, allocationOf, availableOf, calc, carrierKey, carrierName, contributionOf, courierDeliveryBalance, customerOf, dateKey, deliveryCash, driverCash, driverStats, expectedFromCustomer, isOverdue, linesOf, money, netUnit, orderOf, overdueWhy, paymentStatus, settlementStatus, tol, totals } from '@commerce-os/domain';
import { act, areaLabel, govAreaF, badge, blankOrderFilters, btn, carrierA, custA, dayShift, fd, fdt, filteredOrders, grid, kpi, latestDelivery, m, note, orderA, orderSearchText, presetRange, rangeLabel, row, search, setPath, simpleTable, timeline, today, ui } from './ui-kit.js';
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
/* Who carried the shipping on a parcel that came back. */
const shippingLabel = d => d.shippingPaidBy === 'customer' && !d.feeCharged ? 'customer already paid it with the items they kept' : { business: 'business paid the shipping', waived: 'no shipping cost', customer: `customer charged ${m(d.feeCharged)}` }[d.shippingPaidBy || 'business'];
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
/* Receive-cash totals for the ticked orders: commission per order, the rest is received. */
function handoverTotals() {
  let n = 0, com = 0, net = 0;
  for (const el of document.querySelectorAll('#modalForm [data-com]')) {
    const id = el.dataset.com, on = document.querySelector(`#modalForm [data-inc="${id}"]`).checked, cash = Number(el.dataset.cash), k = Math.min(cash, Math.max(0, Number(el.value) || 0));
    document.querySelector(`#modalForm [data-net="${id}"]`).textContent = m(round2(cash - k));
    if (on) { n++; com += k; net += cash - k; }
  }
  return { n, com: round2(com), net: round2(net) };
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
  goWithCarriers(key) { ui.ship.carrier = key || ''; ui.ship.gov = ''; A.goShip('With carriers'); },
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
      <details class="whynot" ${c ? '' : ''}><summary>Or add a new customer</summary><div class="formgrid mt">${field('Name', 'nName')}${field('Mobile', 'nPhone', 'tel', '', 'placeholder="01012345678"')}${govAreaF('nArea', '')}${field('Address', 'nAddress')}</div></details>
      <h3 class="mt">Line items</h3><div id="draftLines"></div><button type="button" data-dl-add="1" class="small">+ Add line</button>
      <div class="note mt"><strong>Which discount?</strong> <strong>Discount on this item</strong> lowers the price of one product only, for example 50 off the shirt. <strong>Discount on the whole order</strong> comes off the total, like a coupon or rounding down. You rarely need both.</div>
      <div class="formgrid mt">${selectF('Sales channel', 'channel', CHANNELS.filter(x => x !== 'Exchange' && x !== 'In-store'), 'Phone')}${selectF('Campaign', 'campaignId', [['', 'Unattributed'], ...Repo.all('campaigns').filter(x => !x.closed).map(x => [x.id, x.name])])}${selectF('Payment', 'paymentMethod', ['COD', 'InstaPay', 'Card', 'Mobile wallet', 'Bank transfer'], 'COD')}${field('Order date', 'date', 'date', today(), `required max="${today()}"`)}${field('Discount on the whole order', 'discount', 'number', 0, 'min="0" step="1" data-dl-total="1"')}${field('Delivery fee charged', 'deliveryFee', 'number', 0, 'min="0" step="1" data-dl-total="1"')}${textF('Internal note (optional)', 'note', '', 'maxlength="500"')}</div><p class="draft-total" id="draftTotal"></p>`, async f => {
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
  attributeModal(id) { const o = orderOf(id); modal(`Attribution for #${id}`, `<div class="formgrid">${selectF('Campaign', 'campaignId', [['', 'Unattributed'], ...Repo.all('campaigns').filter(x => !x.closed || x.id === o.campaignId).map(x => [x.id, x.name])], o.campaignId || '')}${field('Reason (optional)', 'reason')}</div><p class="inlinehelp">Allocation recalculates for every order on both the old and new campaigns.</p>`, async f => { await Commands.attribute(id, f.campaignId || null, f.reason); toast('Attribution corrected. Campaign figures updated.'); }); },
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
  /* Every carrier is a driver (مندوب). Shipping companies stay in past records only. */
  shipModal(ids, pick) {
    ids = (Array.isArray(ids) ? ids : [ids]).map(Number); const many = ids.length > 1;
    if (!ids.length) return toast('Select one or more orders first.', 'bad');
    const drivers = Repo.all('drivers').filter(d => d.active !== false && d.availability !== 'Off duty');
    modal(many ? `Ship ${ids.length} orders` : `Ship order #${ids[0]}`, `${note('Only Ready orders can be shipped: packed, with stock reserved. Any other order is skipped and explained.')}<div class="formgrid"><label class="field">Driver<select name="driver" required>${drivers.map(d => `<option value="${d.id}" ${d.id === pick ? 'selected' : ''}>${esc(d.name)} · ${esc(d.availability)} · ${driverStats(d.id).custody} in custody</option>`).join('')}</select></label></div>${drivers.length ? '' : '<p class="inlinehelp">No driver is available. Create one first.</p>'}<div class="actions">${btn('+ New driver', 'driverModal', [null, ids])}</div><p class="inlinehelp">The driver takes the parcel now and stock is deducted. The commission is entered per order when you receive the cash.</p>
      <label class="checkrow mt"><input type="checkbox" name="print"> Print shipping labels afterwards</label>`, async f => {
      if (!f.driver) fail('Choose a driver, or create one with + New driver.');
      const r = [], done = [];
      for (const id of ids) { try { await Commands.shipOrder(id, 'driver', f.driver, { then: 'out' }); ui.selected.delete(id); done.push(id); r.push(null); } catch (e) { r.push(many && !e.message.startsWith('#') ? `#${id}: ${e.message}` : e.message); } }
      if (!many && r[0]) fail(r[0]);
      if (f.print && done.length) printDocs(done, 'label', printPref().size);
      closeModal(); bulkReport('shipped', r); return false;
    }, many ? 'Ship orders' : 'Ship');
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
      ${row('Items', d.items.map(i => `${i.delivered ? `${i.delivered}/` : ''}${i.qty} × ${esc(i.sku)}`).join(', '))}${row('Expected from customer', m(expectedFromCustomer(d)))}${row('Collected', `${m(cash.collected)}${cash.method ? ' · ' + esc(cash.method) : ''}`)}${d.mode === 'driver' ? row('Cash not yet handed over', m(cash.unhanded)) : ''}${row('Delivery cost incurred', d.shippingPaidBy === 'waived' ? `${m(0)} <small>waived by the carrier</small>` : m(d.pickedUpAt ? d.cost : 0))}${d.returnedAt || d.shippingPaidBy ? row(d.returnedAt ? 'Came back' : 'On its way back', `${esc(d.returnReason || 'No reason recorded')} · ${shippingLabel(d)}`) : ''}${d.tracking ? row('Tracking no.', esc(d.tracking)) : ''}${pred ? row('Follows', esc(pred)) : ''}${succ ? row('Handed to', esc(succ)) : ''}${d.retryAt ? row('Retry scheduled', fd(d.retryAt)) : ''}
      <div class="actions mt mb">${acts.map(x => btn(x.label, x.name, x.arg, { cls: x.primary ? 'primary small' : 'small', why: x.why })).join('') || '<span class="muted">No further actions: this assignment is closed.</span>'}</div>
      <h3 class="mt">Timeline</h3><div class="timeline tight">${[...d.history].reverse().map(h => `<div class="event"><strong>${esc(h.status)}</strong>${h.note ? ` <span class="muted">${esc(h.note)}</span>` : ''}<p>${fdt(h.at)} · ${esc(h.by)}</p></div>`).join('')}</div>`, null, '', { wide: true });
  },
  pickup(id) { closeModal(); run(() => Commands.pickup(id), 'Pickup recorded. Stock deducted and custody moved to the carrier.'); },
  ofd(id) { closeModal(); run(() => Commands.setDeliveryStatus(id, 'Out for Delivery', { note: 'Out for delivery' }), 'Marked out for delivery.'); },
  returnStart(id) { closeModal(); run(() => Commands.startReturn(id), 'Return started. The parcel stays in carrier custody until received at the warehouse.'); },
  /* Receiving an undelivered parcel: why it came back, and who pays the shipping. */
  returnedModal(id) { A.receive(id, true); },
  receive(id, quick = false) {
    const d = Repo.get('deliveries', id), o = orderOf(d.orderId), partial = d.items.some(i => i.delivered > 0), suggested = o.deliveryFee || d.cost || 0;
    /* Marked Returned already: why and who pays were recorded then, so receiving is one confirmation. */
    if (!quick && d.shippingPaidBy) {
      return modal(`Receive ${esc(d.id)} at the warehouse`, `${note(`The units the customer did not keep go back into stock now. Order #${o.id} · ${esc(carrierName(d))}.`)}${row('Why it came back', esc(d.returnReason || 'No reason recorded'))}${row('Shipping', shippingLabel(d))}${textF('Note (optional)', 'note', '', 'maxlength="200"')}`,
        async f => { await Commands.receiveAtWarehouse(id, f.note); toast('Received at the warehouse. Units back in stock.'); }, 'Received at warehouse');
    }
    const opt = (v, t, sub, on) => `<label class="choice"><input type="radio" name="shipping" value="${v}" ${on ? 'checked' : ''}><span><strong>${t}</strong><small>${sub}</small></span></label>`;
    modal(quick ? `Returned · order #${o.id}` : `Receive ${esc(d.id)} at the warehouse`, `${note(quick ? `The parcel is marked as on its way back from ${esc(carrierName(d))}. Stock only goes up when you press Received at warehouse.` : `Undelivered units go back into stock. Order #${o.id} · ${esc(carrierName(d))}.`)}
      <div class="formgrid">${selectF('Why did it come back?', 'reason', [['', 'Choose a reason'], ...RETURN_REASONS])}</div>
      ${partial ? `<h3 class="mt">Shipping</h3><p class="inlinehelp">The customer kept part of the order and already paid the shipping with it, so nothing more is charged and it is not a company cost.</p><input type="hidden" name="shipping" value="customer">` : `<h3 class="mt">Who pays the shipping?</h3><div class="choices">
        ${opt('business', 'The business', `Delivery ${m(d.pickedUpAt ? d.cost : 0)} and return ${m(d.returnCost || 0)} are business costs.`, true)}
        ${opt('waived', 'No cost', 'The carrier charged nothing for this trip, so no shipping cost is booked.')}
        ${opt('customer', 'The customer', 'They pay a shipping fee even though they did not keep the order. It counts as revenue.')}
      </div>
      <div class="formgrid mt" id="feeFields" hidden>${field('Shipping fee charged to the customer', 'fee', 'number', suggested || '', 'min="0.01" step="0.01"')}${selectF('Has the customer paid it?', 'paidTo', [['unpaid', 'Not yet, they owe it'], ['carrier', `Yes, to ${carrierName(d)} in cash`], ['business', 'Yes, directly to the business']])}</div>`}
      ${textF('Note (optional)', 'note', '', 'maxlength="200"')}`,
      async f => { const outcome = { reason: f.reason, shipping: f.shipping, fee: f.shipping === 'customer' && !partial ? Number(f.fee) : undefined, paidTo: f.paidTo, note: f.note }; if (quick) { if (!f.reason) fail('Choose why it came back.'); await Commands.quickReturn(id, outcome); toast('Marked as on its way back. Press Received at warehouse when it arrives.'); } else { await Commands.receiveAtWarehouse(id, f.note, outcome); toast('Received at the warehouse. Undelivered units restocked.'); } }, quick ? 'Record return' : 'Receive parcel');
    if (partial) return;
    modalLive = () => { const form = document.getElementById('modalForm'), on = form.elements.shipping.value === 'customer', box = document.getElementById('feeFields'); box.hidden = !on; box.querySelector('[name=fee]').required = on; };
    modalLive();
  },
  cancelAssign(id) { closeModal(); run(() => Commands.setDeliveryStatus(id, 'Cancelled Assignment', { note: 'Assignment cancelled' }), 'Assignment cancelled. The order can be assigned again.'); },
  reassignModal(id) {
    const d = Repo.get('deliveries', id);
    modal(`Reassign ${id}`, `${note(`Currently ${esc(carrierName(d))}. The parcel has not left the warehouse. The old assignment is kept in history.`)}<div class="formgrid"><label class="field">Driver<select name="driver" required>${Repo.all('drivers').filter(x => x.active !== false && x.availability !== 'Off duty' && !(d.mode === 'driver' && x.id === d.carrierId)).map(x => `<option value="${x.id}">${esc(x.name)}</option>`).join('')}</select></label>${field('Reason (optional)', 'reason')}</div>`, async f => { if (!f.driver) fail('Choose a driver.'); await Commands.reassign(id, 'driver', f.driver, f.reason); toast('Reassigned.'); }, 'Reassign');
  },
  handoffModal(id) {
    const d = Repo.get('deliveries', id), cash = deliveryCash(d);
    modal(`Hand over parcel · ${id}`, `${note(`Physically moves the parcel from ${esc(carrierName(d))}. Any cash ${esc(carrierName(d))} collected (${m(cash.unhanded)} on this delivery) stays their responsibility until handed to the business.`, 'warning')}<div class="formgrid">${selectF('Receiving driver', 'to', Repo.all('drivers').filter(x => x.active !== false && x.id !== d.carrierId).map(x => [x.id, x.name]))}${textF('Why and where did it change hands?', 'note', '', 'required maxlength="200"')}</div>`, async f => { await Commands.driverHandover(id, f.to, f.note); toast('Parcel custody transferred. A new delivery ID was created for the receiving driver.'); }, 'Record handover');
  },
  failModal(id) { modal(`Failed attempt · ${id}`, `${note('The parcel stays in the carrier\'s custody. It only returns to stock when received at the warehouse.')}<div class="formgrid">${selectF('Reason', 'reason', FAILURE_REASONS)}${field('Note', 'note', 'text', '', 'maxlength="200"')}</div>`, async f => { await Commands.setDeliveryStatus(id, 'Failed Attempt', { reason: f.reason, note: f.note }); toast('Failed attempt recorded.'); }, 'Record attempt'); },
  retryModal(id) { modal(`Schedule retry · ${id}`, `<div class="formgrid">${field('Retry date', 'date', 'date', dayShift(today(), 1), `required min="${today()}"`)}${field('Note', 'note', 'text', '', 'maxlength="200"')}</div>`, async f => { await Commands.setDeliveryStatus(id, 'Retry Scheduled', { retryAt: new Date(f.date + 'T18:00:00Z').toISOString(), note: f.note }); toast('Retry scheduled.'); }, 'Schedule'); },
  deliveredModal(id) { A.deliverModal(id, true); },
  /* Undo a Delivered or Returned recorded by mistake: the parcel goes back to the carrier. */
  undoModal(id) {
    const d = Repo.get('deliveries', id), ret = d.status === 'Returned to Warehouse';
    modal(ret ? `Undo the return of #${d.orderId}?` : `Undo the delivery of #${d.orderId}?`, `<p>${ret ? 'The units restocked from this parcel leave stock again, any shipping fee charged on it is removed, and the parcel goes back out for delivery.' : 'The payment recorded with this delivery is removed, revenue goes back, and the parcel goes back out for delivery.'}</p>${row('Back with', esc(carrierName(d)))}<p class="inlinehelp">Then record what really happened.</p>`, async () => { await Commands[ret ? 'undoReturned' : 'undoDelivered'](id); toast(ret ? 'Return undone. The parcel is back with the carrier.' : 'Delivery undone. The parcel is back with the carrier.'); }, ret ? 'Undo return' : 'Undo delivery', { danger: true });
  },
  /* Several parcels delivered in full, each with the cash due collected. */
  bulkDeliveredModal(orderIds) {
    const ds = orderIds.map(id => activeDelivery(orderOf(id))).filter(d => d && !['Partially Delivered', 'Return in Transit'].includes(d.status));
    if (!ds.length) return toast('Tick the delivered orders first.', 'bad');
    const due = sum(ds, expectedFromCustomer);
    modal(`Mark ${ds.length} orders delivered`, `<p>Each order is recorded as delivered in full, with the cash due collected by the carrier.</p>${row('Cash due in total', m(due))}<p class="inlinehelp">For a partial delivery or a different amount, use Delivered on that order instead.</p>`, async () => {
      const r = [];
      for (const d of ds) { const exp = expectedFromCustomer(d); try { await Commands.quickDeliver(d.id, { quantities: Object.fromEntries(d.items.map(i => [i.lineId, i.qty])), collection: exp > 0 ? { amount: exp, method: 'Cash' } : undefined }); ui.selected.delete(d.orderId); r.push(null); } catch (e) { r.push(`#${d.orderId}: ${e.message}`); } }
      closeModal(); bulkReport('delivered', r); return false;
    }, 'Mark delivered');
  },
  deliverModal(id, quick = false) {
    const d = Repo.get('deliveries', id), o = orderOf(d.orderId), ca = calc(o), units = new Map(linesOf(o).map(l => [l.id, netUnit(l, o)])), isCOD = o.paymentMethod === 'COD' || ca.paid < ca.value;
    const expectFor = q => round2(Math.max(0, d.items.reduce((s, it) => s + (Number(q[it.lineId]) || 0) * units.get(it.lineId), 0) + (d.items.some(it => Number(q[it.lineId]) > 0) ? (o.deliveryFee || 0) : 0) - ca.paid));
    modal(`Record delivery · ${id}`, `<div class="choices"><label class="choice"><input type="radio" name="full" value="1" checked data-deliver="1"><span><strong>Delivered in full</strong><small>The customer kept every item.</small></span></label><label class="choice"><input type="radio" name="full" value="" data-deliver="1"><span><strong>Partly delivered</strong><small>The customer kept some items. The rest come back.</small></span></label></div><div id="qtyBox" class="mt"><h3>Delivered quantities</h3>${d.items.map(it => `<label class="checkrow between"><span>${esc(it.sku)} <small>of ${it.qty}</small></span><input class="qtyinput" type="number" min="0" max="${it.qty}" step="1" name="q${it.lineId}" value="${it.qty}" data-deliver="1" aria-label="Delivered quantity for ${esc(it.sku)}"></label>`).join('')}</div>
      <h3 class="mt">Customer payment</h3><p class="subtitle" id="expectHint"></p><div class="formgrid mt">${selectF('Method', 'method', [...PAYMENT_METHODS, 'Not collected'], isCOD ? 'Cash' : 'Not collected', 'data-deliver="1"')}${field('Amount collected', 'amount', 'number', 0, 'min="0" step="0.01" data-amount="1"')}<label class="field" id="refWrap">Transaction reference<input name="ref" maxlength="60"></label>${field('Reason (required for partial delivery or short payment)', 'reason', 'text', '', 'maxlength="200"')}${field('Note', 'note', 'text', '', 'maxlength="200"')}</div><p class="inlinehelp">Delivered does not mean paid. Only cash increases what ${esc(carrierName(d))} holds. Non-cash goes to the business directly.</p>`, async f => {
      const quantities = {}; for (const it of d.items) quantities[it.lineId] = Number(f['q' + it.lineId]);
      const method = f.method, amount = Number(f.amount) || 0;
      if (method !== 'Not collected' && amount <= 0 && expectFor(quantities) > 0) fail('Enter the amount collected, or choose Not collected.');
      await Commands[quick ? 'quickDeliver' : 'deliver'](id, { quantities, reason: f.reason, note: f.note, collection: method === 'Not collected' ? { amount: 0, shortReason: f.reason || 'Not collected at delivery' } : { amount, method, ref: f.ref } });
      toast('Delivery recorded. Revenue recognized for delivered units.');
    }, 'Record delivery');
    modalLive = (ev) => {
      const fm = document.getElementById('modalForm'), q = {}, full = fm.elements.full.value === '1';
      document.getElementById('qtyBox').hidden = full; if (full) d.items.forEach(it => { fm.elements['q' + it.lineId].value = it.qty; });
      d.items.forEach(it => q[it.lineId] = fm.elements['q' + it.lineId].value);
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
    const dr = Repo.get('drivers', driverId), c = driverCash(driverId), spent = sum(unlinkedCashSpend(driverId), e => e.amount);
    const rows = Repo.by('deliveries', 'carrierKey', carrierKey('driver', driverId)).map(d => ({ d, cash: deliveryCash(d) })).filter(x => x.cash.unhanded > 0).sort((a, b) => (a.d.completedAt || a.d.assignedAt).localeCompare(b.d.completedAt || b.d.assignedAt));
    if (!rows.length) return toast(`${dr.name} holds no cash to receive.`);
    /* Tick the orders settled today. Each keeps its own commission; what you receive is calculated. */
    const row = ({ d, cash }) => { const done = cash.commission > 0, def = done ? 0 : Math.min(carrierCharge(d), cash.unhanded); return `<tr><td><input type="checkbox" data-inc="${d.id}" aria-label="Settle order ${d.orderId}"></td><td>#${d.orderId}<br><small>${esc(d.id)} · ${esc(d.status)}</small></td><td>${esc(customerOf(orderOf(d.orderId)).name)}</td><td class="number">${m(cash.unhanded)}</td><td class="number"><input class="qtyinput wide" type="number" min="0" max="${cash.unhanded}" step="0.01" value="${def}" data-com="${d.id}" data-cash="${cash.unhanded}" data-amount="1" ${done ? 'disabled title="Commission already kept on this order"' : ''} aria-label="Commission on order ${d.orderId}"></td><td class="number" data-net="${d.id}"></td></tr>`; };
    modal(`Receive cash · ${esc(dr.name)}`, `<div class="cash-hero"><span><small>Holding now</small><strong>${m(c.outstanding)}</strong></span><small>From ${rows.length} orders</small></div>
      <div class="tablewrap mt"><table><thead><tr><th><input type="checkbox" data-allinc="1" aria-label="Tick every order"></th><th>Order</th><th>Customer</th><th class="number">Cash with driver</th><th class="number">Driver commission</th><th class="number">You receive</th></tr></thead><tbody>${rows.map(row).join('')}</tbody></table></div>
      <p class="draft-total mt" id="allocTotal"></p>${spent ? `<p class="inlinehelp">${esc(dr.name)} paid ${m(spent)} of approved expenses (fuel, parking and similar) out of this cash. It is taken from the orders you tick, so you receive that much less.</p>` : ''}
      <div class="formgrid mt">${field('Received by', 'receivedBy', 'text', Session.user.name, 'required maxlength="60"')}${field('Date', 'date', 'date', today(), `required max="${today()}"`)}${field('Receipt reference (optional)', 'ref', 'text', '', 'maxlength="40" placeholder="Filled in for you if left empty"')}${field('Amount the driver says they handed (optional)', 'declared', 'number', '', 'min="0" step="0.01"')}</div><p class="inlinehelp">The commission is the driver's charge for that order and is booked as shipping cost. If the driver declares more than you receive, a discrepancy is opened for review.</p>`, async f => {
      const picked = [...document.querySelectorAll('#modalForm [data-inc]:checked')].map(el => el.dataset.inc);
      if (!picked.length) fail('Tick the orders the driver is settling.');
      const allocations = picked.map(id => ({ deliveryId: id, commission: Number(document.querySelector(`#modalForm [data-com="${id}"]`).value) || 0 }));
      await Commands.recordHandover({ driverId, ref: f.ref, at: dateToIso(f.date), receivedBy: f.receivedBy, allocations, declared: Number(f.declared) || null });
      toast(`Cash received from ${dr.name}: ${m(Math.max(0, handoverTotals().net - spent))}.`);
    }, 'Receive cash', { wide: true });
    modalLive = ev => {
      const fm = document.getElementById('modalForm'); if (!fm) return;
      if (ev?.target?.dataset?.allinc) fm.querySelectorAll('[data-inc]').forEach(x => { x.checked = ev.target.checked; });
      const t = handoverTotals();
      const less = t.n ? Math.min(spent, t.net) : 0;
      document.getElementById('allocTotal').innerHTML = `<span class="bd"><span>Orders ticked</span> <b>${t.n}</b></span><span class="bd"><span>Commission</span> <b>${m(t.com)}</b></span>${spent ? `<span class="bd"><span>Driver expenses paid from this cash</span> <b>${m(less)}</b></span>` : ''}<span class="bd total"><span>Amount you receive</span> <b>${m(t.net - less)}</b></span>`;
    };
    modalLive();
  },

  expenseDriverModal(driverId) {
    modal('Driver expense', `${note('An expense counts once in profit, when approved. Marking it as paid from collected cash only reduces what the driver owes back. Delivery fee payouts are already in delivery costs, so they only change cash custody.')}<div class="formgrid">${selectF('Category', 'category', DRIVER_EXPENSE_CATS)}${field('Amount', 'amount', 'number', '', 'min="0.01" step="0.01" required')}<label class="checkrow"><input type="checkbox" name="paidFromCash"> Driver paid this from collected cash</label>${field('Note', 'note', 'text', '', 'maxlength="200"')}</div>`, async f => { const id = await Commands.addDriverExpense({ driverId, category: f.category, amount: Number(f.amount), paidFromCash: !!f.paidFromCash, note: f.note }); toast(`${id} submitted for approval.`); }, 'Submit');
  },
  decideExp([id, decision]) { run(() => Commands.decideDriverExpense(id, decision), `${id} ${decision.toLowerCase()}.`); },
  resolveModal(id) { modal(`Resolve ${id}`, textF('How was this resolved?', 'res', '', 'required maxlength="200"'), async f => { await Commands.resolveDiscrepancy(id, f.res); toast('Discrepancy resolved.'); }, 'Resolve'); },
  driverModal(arg) { const [id, back] = Array.isArray(arg) ? arg : [arg]; const d = id ? Repo.get('drivers', id) : { name: '', phone: '', vehicle: 'Motorcycle', zones: '', availability: 'Available', active: true }; modal(id ? `Edit ${esc(d.name)}` : 'New driver', `<div class="formgrid">${field('Name', 'name', 'text', d.name, 'required maxlength="60"')}${field('Mobile', 'phone', 'tel', d.phone, 'required')}${selectF('Vehicle', 'vehicle', ['Motorcycle', 'Van', 'Car', 'Bicycle'], d.vehicle)}${field('Zones', 'zones', 'text', d.zones, 'maxlength="100"')}${selectF('Availability', 'availability', ['Available', 'Busy', 'Off duty'], d.availability)}${selectF('Record state', 'state', [['active', 'Active'], ['inactive', 'Inactive, history preserved']], d.active === false ? 'inactive' : 'active')}</div>`, async f => { const rid = await Commands.saveDriver({ id, ...f, active: f.state === 'active' }); toast('Driver saved.'); if (back) { A.shipModal(back, rid); return false; } if (!id) location.hash = `#/drivers/${rid}`; }); },
  courierModal(id) { const c = id ? Repo.get('couriers', id) : { name: '', shipRate: 60, returnRate: 40, codFee: 15, active: true }; modal(id ? `Edit ${esc(c.name)}` : 'New courier', `<div class="formgrid">${field('Name', 'name', 'text', c.name, 'required maxlength="60"')}${field('Ship rate', 'shipRate', 'number', c.shipRate, 'min="0" required')}${field('Return rate', 'returnRate', 'number', c.returnRate, 'min="0" required')}${field('COD fee', 'codFee', 'number', c.codFee, 'min="0" required')}${selectF('State', 'state', [['active', 'Active'], ['inactive', 'Inactive']], c.active === false ? 'inactive' : 'active')}</div><p class="inlinehelp">Rates apply to new assignments. Past deliveries keep their cost.</p>`, async f => { await Commands.saveCourier({ id, ...f, active: f.state === 'active' }); toast('Courier saved.'); }); },
  /* A courier's payment: tick the deliveries it covers, or let their statement tick them. */
  /* pay: the business pays the courier their charges (deliveries where we owe them). Stored as negative nets, shown positive. */
  payCourierModal(courierId) { A.settlementModal(courierId, true); },
  settlementModal(courierId, pay = false) {
    const cr = Repo.get('couriers', courierId), sg = pay ? -1 : 1;
    const rows = Repo.by('deliveries', 'carrierKey', carrierKey('courier', courierId)).filter(d => d.completedAt || d.returnedAt).map(d => ({ d, b: courierDeliveryBalance(d) })).filter(x => pay ? x.b.gap < -0.001 : Math.abs(x.b.gap) > 0.001).sort((a, b) => (a.d.completedAt || a.d.returnedAt).localeCompare(b.d.completedAt || b.d.returnedAt)).slice(0, 500);
    if (!rows.length) return toast(pay ? `You don't owe ${cr.name} anything.` : `Nothing outstanding from ${cr.name}.`);
    stmt = null; stmtCtx = { courierId };
    modal(pay ? `Pay ${esc(cr.name)}` : `Payment from ${esc(cr.name)}`, `${note(pay ? 'Tick the orders this payment covers. Each one shows what you still owe the courier: their commission less any customer cash they kept.' : 'Tick the orders this payment covers, or let "Match the courier\'s statement" tick them. Each order has its own courier commission. What you receive is calculated.')}
      <div class="formgrid">${field('Payment reference (optional)', 'ref', 'text', '', 'maxlength="40" placeholder="Filled in for you if left empty"')}${field(pay ? 'Date paid' : 'Date received', 'date', 'date', today(), `required max="${today()}"`)}</div>
      ${pay ? '' : `<details class="whynot mt"><summary>Match the courier's statement</summary><p class="inlinehelp">Export the statement from the courier's portal as CSV, or copy the rows in Excel and paste them here with the header row. Rows are matched by tracking number, delivery ID or order number.</p>
        <div class="formgrid mt"><label class="field">Statement file (.csv)<input type="file" id="stmtFile" accept=".csv,.tsv,.txt,text/csv"></label><label class="field">Or paste the rows<textarea name="stmtText" rows="3" data-mi="1" dir="auto"></textarea></label></div>
        <div class="formgrid mt" id="stmtCols" hidden>${selectF('Column with the tracking or order number', 'refCol', [], '', 'data-stmt="1"')}${selectF('Column with the amount paid to you', 'amtCol', [], '', 'data-stmt="1"')}</div><div id="stmtResult" class="mt"></div></details>`}
      <div class="tablewrap mt"><table><thead><tr><th><input type="checkbox" data-allinc="1" aria-label="Tick every order"></th><th>Order</th><th>Customer</th><th class="number">Customer paid</th><th class="number">Courier commission</th><th class="number">${pay ? 'Already settled' : 'Already received'}</th><th class="number">${pay ? 'You pay' : 'You receive'}</th></tr></thead><tbody>${rows.map(({ d, b }) => `<tr><td><input type="checkbox" data-inc="${d.id}" aria-label="Include order ${d.orderId}"></td><td>#${d.orderId}<br><small>${esc(d.tracking || d.id)} · ${esc(d.status)}</small></td><td>${esc(customerOf(orderOf(d.orderId)).name)}</td><td class="number">${m(b.customer)}</td><td class="number"><input class="qtyinput wide" type="number" min="0" step="0.01" value="${b.deductions}" data-ccom="${d.id}" data-base="${round2(b.customer - b.actual)}" data-amount="1" ${!d.pickedUpAt || d.shippingPaidBy === 'waived' ? 'disabled' : ''} aria-label="Commission on order ${d.orderId}"></td><td class="number">${m(b.actual)}</td><td class="number"><input class="qtyinput wide" type="number" step="0.01" value="${sg * b.gap}" data-alloc="${d.id}" data-exp="${sg * b.gap}" aria-label="${pay ? 'Paid' : 'Received'} for order ${d.orderId}"></td></tr>`).join('')}</tbody></table></div>
      <p class="draft-total" id="allocTotal"></p>`, async f => {
      const allocations = ticked().map(el => ({ deliveryId: el.dataset.alloc, net: sg * (Number(el.value) || 0), commission: Number(document.querySelector(`#modalForm [data-ccom="${el.dataset.alloc}"]`).value) || 0 })).filter(a => a.net);
      if (!allocations.length) fail('Tick at least one order.');
      const t = round2(sg * sum(allocations, a => a.net));
      await Commands.recordSettlement({ courierId, ref: f.ref, at: dateToIso(f.date), allocations, note: pay ? `Paid to ${cr.name}` : '' }); toast(`Payment recorded: ${m(t)}.`);
    }, pay ? 'Record payment to courier' : 'Record payment', { wide: true });
    modalLive = async ev => {
      const t = ev?.target, fm = document.getElementById('modalForm'); if (!fm) return;
      if (t?.dataset?.allinc) fm.querySelectorAll('[data-inc]').forEach(x => { x.checked = t.checked; });
      if (t?.id === 'stmtFile' && t.files[0]) { if (t.files[0].size > 5e6) toast('The statement is larger than 5 MB.', 'bad'); else loadStatement(await t.files[0].text()); }
      if (t?.name === 'stmtText') loadStatement(t.value);
      if (t?.dataset?.stmt) matchStatement();
      /* A changed commission changes what that order settles for. */
      if (t?.dataset?.ccom) { const el = fm.querySelector(`[data-alloc="${t.dataset.ccom}"]`); el.value = round2(sg * (Number(t.dataset.base) - (Number(t.value) || 0))); }
      fm.querySelectorAll('[data-alloc]').forEach(el => { el.disabled = !fm.querySelector(`[data-inc="${el.dataset.alloc}"]`).checked; });
      const inc = ticked(), tot = round2(sum(inc, el => Number(el.value) || 0)), com = round2(sum(inc, el => Number(fm.querySelector(`[data-ccom="${el.dataset.alloc}"]`).value) || 0));
      document.getElementById('allocTotal').innerHTML = `<span class="bd"><span>Orders ticked</span> <b>${inc.length}</b></span><span class="bd"><span>Commission</span> <b>${m(com)}</b></span><span class="bd total"><span>${pay ? 'Amount you pay' : 'Amount you receive'}</span> <b>${m(tot)}</b></span>`;
    };
    modalLive();
  },

  /* inventory */
  stockModal(arg) { const [type, item] = arg || ['sku', '']; const opts = type === 'material' ? Repo.all('materials').map(x => [x.id, `${x.id} · ${x.name}`]) : Repo.all('skus').map(s => [s.id, `${s.id} · ${s.name} ${s.variant}`]); modal('Adjust stock', `${note('Adjustments add a row to the movement journal. They never overwrite a balance.')}<div class="formgrid">${selectF('Item', 'item', opts, item)}${field('Change (+ or −)', 'qty', 'number', '', 'step="any" required')}${selectF('Reason', 'reasonKind', ['Cycle count correction', 'Damaged in warehouse', 'Found stock', 'Sample or giveaway', 'Other'])}${field('Details', 'detail', 'text', '', 'maxlength="150"')}</div>`, async f => { await Commands.adjustStock({ item: f.item, itemType: type, qty: Number(f.qty), reason: [f.reasonKind, f.detail].filter(Boolean).join(': ') }); toast('Stock adjusted.'); }, 'Adjust'); },
  materialModal(id) { modal('Receive material', `<div class="formgrid">${selectF('Material', 'item', Repo.all('materials').map(x => [x.id, x.name]), id)}${field('Quantity', 'qty', 'number', '', 'min="0.01" step="any" required')}${field('Purchase reference', 'ref', 'text', '', 'required maxlength="40"')}</div><p class="inlinehelp">A reference can only be received once per material.</p>`, async f => { await Commands.receiveMaterial({ item: f.item, qty: Number(f.qty), ref: f.ref }); toast('Material received.'); }, 'Receive'); },
  /* Products tab: pick what kind of item to add. */
  newItemModal() {
    const opt = (a, title, sub) => `<button type="button" class="queue" ${act(a)}><span><strong>${title}</strong><br><small>${sub}</small></span></button>`;
    modal('New item', `<div class="mini-queues">${opt('skuModal', 'Product we make', 'Sold to customers, produced from materials (bill of materials)')}${opt('boughtSkuModal', 'Ready-made product', 'Sold to customers, bought finished from a supplier')}${opt('itemModal', 'Material or supply', 'Fabric, packaging, office supplies or anything else you stock but don\'t sell on its own')}</div>`, null, null);
  },
  boughtSkuModal() { A.skuModal(null, true); },
  itemModal(id) {
    const x = id ? Repo.get('materials', id) : { name: '', unit: 'pcs', category: '', cost: 0, min: 0 }, cats = [...new Set(Repo.all('materials').map(y => y.category))];
    modal(id ? `Edit ${esc(x.name)}` : 'New material or supply', `<div class="formgrid">${field('Name', 'name', 'text', x.name, 'required maxlength="80"')}${field('Category', 'category', 'text', x.category, 'required maxlength="40" list="itemCats" placeholder="Fabric, Packaging, Supplies…"')}<datalist id="itemCats">${cats.map(c => `<option value="${esc(c)}">`).join('')}</datalist>${field('Unit', 'unit', 'text', x.unit, 'required maxlength="12" placeholder="pcs, m, kg, kit…"')}${Session.seesCosts ? field('Cost per unit', 'cost', 'number', x.cost, 'min="0" step="0.01" required') : ''}${field('Reorder at', 'min', 'number', x.min, 'min="0" step="any" required')}</div><p class="inlinehelp">${id ? 'Products made from it use the new cost for new orders. Existing orders keep their cost.' : 'Add stock after saving with Receive (a purchase) or Adjust.'}</p>`, async f => { await Commands.saveMaterial({ id, ...f }); toast(id ? 'Item saved.' : `${f.name} added.`); }, 'Save');
  },
  skuModal(id, bought = false) {
    const s = id ? Repo.get('skus', id) : null, b = id ? Repo.get('boms', id) : { lines: [], labor: 50, overhead: 20, buyCost: 0 }, qty = mid => b.lines.find(x => x.material === mid)?.qty ?? 0;
    if (id && b && !b.lines.length) bought = true;
    if (bought) return modal(id ? `Edit ${esc(id)}` : 'New ready-made product', `<div class="formgrid">${field('SKU code', 'id', 'text', id || '', `required ${id ? 'readonly' : ''} maxlength="20"`)}${field('Product name', 'name', 'text', s?.name || '', 'required')}${field('Variant', 'variant', 'text', s?.variant || '')}${field('Price', 'price', 'number', s?.price || '', 'min="1" required')}${Session.seesCosts ? field('Purchase cost per unit', 'buyCost', 'number', b.buyCost || 0, 'min="0" step="0.01" required') : ''}${field('Reorder at', 'min', 'number', s?.min ?? 10, 'min="0" required')}</div><p class="inlinehelp">Bought finished, so it has no bill of materials and isn't produced. Add stock with Adjust stock when a delivery from the supplier arrives.${id ? ' Existing orders keep their cost snapshot.' : ''}</p>`, async f => { await Commands.saveSku({ isNew: !id, bought: true, id: f.id, name: f.name, variant: f.variant, price: f.price, min: f.min, buyCost: f.buyCost }); toast('Product saved.'); }, 'Save product');
    modal(id ? `Edit ${esc(id)}` : 'New SKU', `<div class="formgrid">${field('SKU code', 'id', 'text', id || '', `required ${id ? 'readonly' : ''} maxlength="20"`)}${field('Product name', 'name', 'text', s?.name || '', 'required')}${field('Variant', 'variant', 'text', s?.variant || '')}${field('Price', 'price', 'number', s?.price || '', 'min="1" required')}${field('Reorder at', 'min', 'number', s?.min ?? 10, 'min="0" required')}${Session.seesCosts ? field('Labor per unit', 'labor', 'number', b.labor, 'min="0" required') + field('Overhead per unit', 'overhead', 'number', b.overhead, 'min="0" required') : ''}</div><h3 class="mt">Bill of materials, per unit</h3><div class="formgrid mt">${Repo.all('materials').map(x => field(`${esc(x.name)} (${esc(x.unit)})`, 'bom_' + x.id, 'number', qty(x.id), 'min="0" step="0.01"')).join('')}</div><p class="inlinehelp">Existing orders keep their cost snapshot.${Session.seesCosts ? '' : ' Labor and overhead are set by owner or finance.'}</p>`, async f => { await Commands.saveSku({ isNew: !id, id: f.id, name: f.name, variant: f.variant, price: f.price, min: f.min, labor: f.labor, overhead: f.overhead, bom: Repo.all('materials').map(x => ({ material: x.id, qty: f['bom_' + x.id] })) }); toast('SKU saved.'); }, 'Save SKU', { wide: true });
  },
  productionModal() { modal('New production order', `<div class="formgrid">${selectF('SKU', 'sku', Repo.all('skus').map(s => [s.id, `${s.id} · ${s.name} ${s.variant}`]))}${field('Units', 'qty', 'number', 10, 'min="1" required')}${field('Due date', 'due', 'date', dayShift(today(), 7))}</div><p class="inlinehelp">Planned orders consume nothing until started.</p>`, async f => { const id = await Commands.createProduction({ sku: f.sku, qty: Number(f.qty), due: f.due }); ui.inv.tab = 'Production'; toast(`${id} planned.`); }, 'Create'); },
  startMO(id) { run(() => Commands.startProduction(id), `${id} started. Materials consumed into WIP.`); },
  completeMO(id) { run(() => Commands.completeProduction(id), `${id} completed. Finished goods received.`); },
  cancelMO(id) { run(() => Commands.cancelProduction(id), `${id} cancelled.`); },

  /* CRM */
  customerModal(id) { const c = id ? Repo.get('customers', id) : { name: '', phone: '', area: AREAS[0], address: '', deliveryNotes: '', preferredTime: 'Any time', tags: [], altAddresses: [] }; modal(id ? `Edit ${esc(c.name)}` : 'New customer', `<div class="formgrid">${field('Name', 'name', 'text', c.name, 'required maxlength="60"')}${field('Mobile', 'phone', 'tel', c.phone, 'required placeholder="01012345678"')}${govAreaF('area', c.area)}${selectF('Preferred delivery time', 'preferredTime', ['Any time', 'Morning', 'Afternoon', 'Evening'], c.preferredTime)}<label class="field full">Address<input name="address" value="${esc(c.address)}" required maxlength="200"></label><label class="field full">Alternate address (optional)<input name="alt" value="${esc(c.altAddresses?.[0] || '')}" maxlength="200"></label>${textF('Delivery instructions', 'deliveryNotes', c.deliveryNotes, 'maxlength="300"')}</div>`, async f => { const r = await Commands.saveCustomer({ id, ...f, tags: c.tags, altAddresses: f.alt ? [f.alt] : [] }); toast('Customer saved.'); if (!id) location.hash = `#/customers/${r.id}`; }); },
  contactModal(id) { modal('Log a contact', `${note('This records a conversation that already happened. It does not send anything.')}<div class="formgrid">${selectF('Channel', 'channel', ['Phone', 'WhatsApp', 'Instagram', 'Email', 'In person'])}${selectF('Direction', 'direction', ['Outbound', 'Inbound'])}${textF('Summary', 'summary', '', 'required maxlength="500"')}${field('Follow up on (optional)', 'followUp', 'date')}</div>`, async f => { await Commands.logContact({ customerId: id, ...f }); toast('Contact logged. No message was sent.'); }, 'Log contact'); },
  /* staff attendance */
  leaveModal(employeeId) {
    const e = Repo.get('employees', employeeId), y = today().slice(0, 4);
    modal(`Request leave · ${esc(e.name)}`, `${note(`${leaveBalance(e, y)} annual leave days left in ${y}. Weekly days off inside the dates are not counted.`)}<div class="formgrid">${field('First day', 'from', 'date', today(), 'required')}${field('Last day', 'to', 'date', today(), 'required')}${selectF('Type', 'type', [['Annual', 'Annual leave'], ['Sick', 'Sick leave'], ['Unpaid', 'Unpaid leave']])}${textF('Reason (optional)', 'reason', '', 'maxlength="300"')}</div>`, async f => { await Commands.requestLeave({ employeeId, from: f.from, to: f.to, type: f.type, reason: f.reason }); toast('Leave requested. The office will approve or reject it.'); }, 'Send request');
  },
  decideLeave([id, decision]) { run(() => Commands.decideLeave(id, decision), decision === 'Approved' ? 'Leave approved.' : 'Leave rejected.'); },
  /* ID card and document photos: owner only, stored on the server, never in the synced records. */
  async loadEmpFiles(id) { await run(async () => { ui.empFiles = { id, files: (await request(`/api/employees/${encodeURIComponent(id)}/files`)).files }; render(); }); },
  empFileModal(id) {
    modal('Add a document', `<div class="formgrid">${selectF('Kind', 'kind', [['ID', 'National ID card'], ['Document', 'Other document']])}<label class="field">Photo or PDF (under 2.5 MB)<input type="file" name="file" accept="image/jpeg,image/png,image/webp,application/pdf" required></label></div>`, async (f, form) => {
      const file = form.elements.file.files[0]; if (!file) fail('Choose a file.');
      if (file.size > 2.5e6) fail('Files must be under 2.5 MB. Take the photo at a lower size and try again.');
      const data = await new Promise((ok, no) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(',')[1]); r.onerror = no; r.readAsDataURL(file); });
      await request(`/api/employees/${encodeURIComponent(id)}/files`, { method: 'POST', body: { kind: f.kind, name: file.name, mime: file.type, data } });
      await A.loadEmpFiles(id); toast('Document saved.');
    }, 'Upload');
  },
  removeEmpFile([fileId, empId]) { modal('Remove this document?', '<p>The file is deleted for good.</p>', async () => { await request(`/api/files/${fileId}`, { method: 'DELETE', body: {} }); await A.loadEmpFiles(empId); toast('Document removed.'); }, 'Remove', { danger: true }); },
  employeeModal(id) {
    const e = id ? Repo.get('employees', id) : { name: '', phone: '', jobTitle: '', shiftStart: '09:00', active: true, note: '', weeklyOff: [5], annualLeave: 21 };
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    modal(id ? `Edit ${esc(e.name)}` : 'New employee', `<div class="formgrid">${field('Name', 'name', 'text', e.name, 'required maxlength="60"')}${field('Job title', 'jobTitle', 'text', e.jobTitle || '', 'maxlength="60"')}${field('Mobile (optional)', 'phone', 'tel', e.phone || '', 'placeholder="01012345678"')}${field('Shift starts at', 'shiftStart', 'time', e.shiftStart || '')}${field('National ID number (optional)', 'nationalId', 'text', e.nationalId || '', 'inputmode="numeric" maxlength="14" placeholder="14 digits"')}${field('Hire date', 'hireDate', 'date', e.hireDate || '')}${field('Annual leave days per year', 'annualLeave', 'number', e.annualLeave ?? 21, 'min="0" max="60" step="1" required')}<fieldset class="field full"><legend>Weekly days off</legend><div class="chips">${days.map((d, i) => `<label class="checkrow"><input type="checkbox" name="off" value="${i}" ${(e.weeklyOff || []).includes(i) ? 'checked' : ''}> ${d}</label>`).join('')}</div></fieldset>${selectF('State', 'state', [['active', 'Active'], ['inactive', 'Inactive, history kept']], e.active === false ? 'inactive' : 'active')}${textF('Note (optional)', 'note', e.note || '', 'maxlength="300"')}</div><p class="inlinehelp">The shift start shows how late someone checked in. Weekly days off and approved leave are filled in when you mark the day. ID card photos and other documents are added on the employee's page.</p>`, async (f, form) => { await Commands.saveEmployee({ id, ...f, active: f.state === 'active', weeklyOff: [...form.querySelectorAll('[name=off]:checked')].map(x => Number(x.value)) }); toast('Employee saved.'); });
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
    run(() => Commands.recordAttendanceDay(date, es.map(e => { const p = plannedStatus(e, date); return { employeeId: e.id, status: p || 'Present', checkIn: p ? '' : e.shiftStart || '' }; })), n => `${n} marked.`);
  },
  attRemove(id) { run(() => Commands.removeAttendance(id), 'Attendance cleared.'); },
  attendanceModal([employeeId, date]) {
    const e = Repo.get('employees', employeeId), cur = Repo.get('attendance', `ATT-${employeeId}-${date}`) || {};
    modal(`${esc(e.name)} · ${esc(date)}`, `<div class="formgrid">${selectF('Status', 'status', ATTENDANCE_STATUSES, cur.status || 'Present')}${field('Check in', 'checkIn', 'time', cur.checkIn || e.shiftStart || '')}${field('Check out', 'checkOut', 'time', cur.checkOut || '')}${textF('Note (optional)', 'note', cur.note || '', 'maxlength="200"')}</div><p class="inlinehelp">Times are kept only for Present and Late.</p>`, async f => { await Commands.recordAttendance({ employeeId, date, ...f }); toast('Attendance saved.'); });
  },
  toggleTag([id, t]) { const c = Repo.get('customers', id), has = (c.tags || []).includes(t); run(() => Commands.setCustomerTags(id, has ? c.tags.filter(x => x !== t) : [...(c.tags || []), t])); },

  /* campaigns and finance */
  campaignModal(id) { const c = id ? Repo.get('campaigns', id) : { name: '', platform: 'Meta', start: today(), end: dayShift(today(), 30), budget: 5000, reportedRoas: 0 }; modal(id ? `Edit ${esc(c.name)}` : 'New campaign', `<div class="formgrid">${field('Name', 'name', 'text', c.name, 'required maxlength="80"')}${selectF('Platform', 'platform', ['Meta', 'Instagram', 'TikTok', 'Google', 'WhatsApp', 'Influencer', 'Other'], c.platform)}${field('Meta campaign ID (optional)', 'metaId', 'text', c.metaId || '', 'maxlength="40" placeholder="From Ads Manager, e.g. 120210000000000000"')}${field('Start', 'start', 'date', c.start, 'required')}${field('End', 'end', 'date', c.end, 'required')}${field('Budget', 'budget', 'number', c.budget, 'min="0"')}${field('Reported platform ROAS (typed in, optional)', 'reportedRoas', 'number', c.reportedRoas, 'min="0" step="0.1"')}${selectF('Status', 'state', [['running', 'Running'], ['closed', 'Closed, hidden from order forms']], c.closed ? 'closed' : 'running')}</div><p class="inlinehelp">Record actual spend with Add spend. No ad account is connected. The Meta campaign ID links this campaign to the same campaign in Ads Manager, so spend is entered against the right one.</p>`, async f => { await Commands.saveCampaign({ id, ...f, closed: f.state === 'closed' }); toast('Campaign saved.'); }); },
  spendModal(id) { modal(`Record spend · ${esc(Repo.get('campaigns', id).name)}`, `<div class="formgrid">${field('Amount (negative to correct)', 'amount', 'number', '', 'step="0.01" required')}${field('Date', 'date', 'date', today(), 'required')}<label class="field full">Note<input name="note" maxlength="200"></label></div><p class="inlinehelp">Attributed order contribution recalculates. If no orders are attributed, this still reduces company profit.</p>`, async f => { await Commands.addSpend({ campaignId: id, amount: Number(f.amount), at: dateToIso(f.date), note: f.note }); toast('Spend recorded.'); }, 'Record spend'); },
  expenseModal() { modal('Operating expense', `<div class="formgrid">${field('Description', 'name', 'text', '', 'required maxlength="120"')}${selectF('Category', 'category', EXPENSE_CATS)}${field('Amount', 'amount', 'number', '', 'min="0.01" step="0.01" required')}${field('Date', 'date', 'date', today(), 'required')}</div>`, async f => { await Commands.addExpense({ name: f.name, category: f.category, amount: Number(f.amount), at: dateToIso(f.date) }); toast('Expense recorded.'); }); },
  /* Manual debit / credit entry. The presets fill both accounts; "Other" lets finance pick them. */
  journalModal() {
    const presets = { in: ['1100', '3100'], out: ['3200', '1100'], other: ['', ''] }, opts = [['', 'Choose an account'], ...MANUAL_ACCOUNTS.map(a => [a.code, `${a.code} · ${a.name}`])];
    modal('Manual journal entry', `${note('A manual entry moves money between cash, balances and partner capital. Income and costs are recorded through orders, campaign spend and the expense register, so they are not chosen here.')}<div class="formgrid">${selectF('What is it?', 'kind', [['in', 'A partner puts money into the company cash'], ['out', 'A partner takes money out of the company cash'], ['other', 'Other (choose the accounts)']])}${field('Partner or description', 'note', 'text', '', 'required maxlength="200"')}${field('Amount', 'amount', 'number', '', 'min="0.01" step="0.01" required')}${field('Date', 'date', 'date', today(), `required max="${today()}"`)}${selectF('Debit (Dr)', 'debit', opts, '1100')}${selectF('Credit (Cr)', 'credit', opts, '3100')}</div><p class="inlinehelp">Debit is where the money goes, credit is where it comes from.</p>`, async f => {
      if (!f.debit || !f.credit) fail('Choose both accounts.');
      const id = await Commands.addJournalEntry({ at: dateToIso(f.date), debit: f.debit, credit: f.credit, amount: Number(f.amount), note: f.note }); toast(`${id} recorded.`);
    }, 'Record entry');
    modalLive = ev => { const fm = document.getElementById('modalForm'); if (ev?.target?.name !== 'kind') return; const [dr, cr] = presets[fm.elements.kind.value]; fm.elements.debit.value = dr; fm.elements.credit.value = cr; };
  },
  removeJournal(id) { const j = Repo.get('journalEntries', id); modal('Remove entry?', `<p>Remove ${esc(j.id)} “${esc(j.note)}” (${m(j.amount)})? The cash and capital balances will change.</p>`, async () => { await Commands.removeJournalEntry(id); toast('Entry removed.'); }, 'Remove', { danger: true }); },
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
  /* The Accounts report on screen, as a CSV Excel opens directly (the BOM keeps Arabic readable). */
  exportAccounts() {
    const f = ui.fin, r = presetRange(f), view = f.coa || 'tree', nat = (a, v) => ['Liability', 'Equity', 'Revenue'].includes(a.type) ? -v : v;
    const title = { tree: 'Chart of accounts', income: 'Income statement', trial: 'Trial balance', ledger: 'Account ledger' }[view] || 'Chart of accounts';
    let rows;
    if (view === 'income') {
      const st = incomeStatement(r), line = c => { const a = ACCOUNT.get(c); return [a.code, a.name, nat(a, st.balances.get(c))]; };
      rows = [['Code', 'Account', 'Amount'], ...ACCOUNTS.filter(a => a.parent === '4000').map(a => line(a.code)), ['', 'Total revenue', st.revenue], line('5100'), ['', 'Gross profit', st.gross], ...ACCOUNTS.filter(a => a.parent === '6000' || a.parent === '6500').map(a => line(a.code)), ['', 'Total expenses', st.expenses], ['', 'Net profit before tax', st.profit]];
    } else if (view === 'trial') {
      const tb = trialBalance(r.to);
      rows = [['Code', 'Account', 'Debit', 'Credit'], ...tb.rows.map(a => [a.code, a.name, a.debit, a.credit]), ['', 'Total', tb.debit, tb.credit]];
    } else if (view === 'ledger') {
      const a = ACCOUNT.get(f.acct) || ACCOUNTS[1], l = accountLedger(a.code, r);
      rows = [[`${a.code} · ${a.name}`], ['Date', 'Description', 'Order', 'Debit', 'Credit', 'Balance'], ['', 'Balance before the period', '', '', '', nat(a, l.opening)], ...l.rows.map(e => [e.d, e.why, e.orderId ?? '', e.amt > 0 ? e.amt : '', e.amt < 0 ? -e.amt : '', nat(a, e.balance)]), ['', 'Balance at end of period', '', '', '', nat(a, l.closing)]];
    } else {
      const b = accountBalances(r), end = accountBalances({ to: r.to });
      rows = [['Code', 'Account', 'Type', 'Movement in period', 'Balance at end of period'], ...ACCOUNTS.map(a => [a.code, a.name, a.type, nat(a, b.get(a.code)), ['Asset', 'Liability', 'Equity'].includes(a.type) ? nat(a, end.get(a.code)) : ''])];
    }
    const T = c => typeof c === 'string' && c && isAr() ? trText(c) : c;
    rows = [[title, S().company], ['Period', rangeLabel(r)], ['Currency', S().currency], [], ...rows].map(x => x.map(T));
    download(`accounts-${view}-${today()}.csv`, '\uFEFF' + toCsv(rows), 'text/csv;charset=utf-8');
    toast('Report downloaded. It opens in Excel.');
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
  testStartModal() { modal('Start an empty test?', `${note('Every order, customer, product, delivery and payment is set aside, and the app starts empty so you can test from scratch. Logins and settings stay. Everyone using the app sees the empty test data until you end the test.', 'warning')}<p class="subtitle">When you end the test, everything entered during it is deleted and your real data comes back exactly as it is now. Don't take real orders during a test.</p>`, async () => { await request('/api/admin/test-mode/start', { method: 'POST', body: {} }); location.reload(); return false; }, 'Start empty test', { danger: true }); },
  testEndModal() { modal('End the test?', `<p>Everything entered during the test is deleted and your real data comes back exactly as it was when the test started.</p>`, async () => { await request('/api/admin/test-mode/end', { method: 'POST', body: {} }); location.reload(); return false; }, 'End test and restore my data', { danger: true }); },
  resetModal() { modal('Reset demo data?', '<p>This deletes every business record for all users, including orders you created and any load-test data, and rebuilds the fictional dataset. User logins are kept. If the server has a demo password set, a test login is also created for each role.</p>', async () => { const r = await request('/api/admin/reset', { method: 'POST', body: {} }); await loadSnapshot(); ui.selected.clear(); ui.tbl = {}; ui.loadResult = null; toast(r.demoLogins?.length ? `Demo data reset. Test logins ready: ${r.demoLogins.map(x => x.email).join(', ')}.` : 'Demo data reset.'); }, 'Reset demo', { danger: true }); },
  async loadTest(n) { toast(`Generating ${n.toLocaleString('en-US')} orders…`); await run(async () => { ui.loadResult = await request('/api/admin/load-test', { method: 'POST', body: { orders: n } }); await loadSnapshot(); ui.tbl = {}; }, `Added ${n.toLocaleString('en-US')} orders. Reset demo data to remove them.`); },

  /* account and team */
  accountModal() { const u = Session.user; modal('Your account', `${row('Name', esc(u.name))}${row('Email', esc(u.email))}${row('Role', esc(u.role))}${row('Language', `<button type="button" class="small" data-a="toggleLang" data-no-i18n>${isAr() ? 'English' : 'العربية'}</button>`)}<h3 class="mt">Change password</h3><div class="formgrid mt">${field('Current password', 'current', 'password', '', 'autocomplete="current-password"')}${field('New password (10+ characters)', 'next', 'password', '', 'autocomplete="new-password"')}</div><div class="actions mt"><button type="button" data-a="logout">Sign out</button></div>`, async f => { if (!f.next) return; await request('/api/me/password', { method: 'POST', body: f }); toast('Password changed.'); }, 'Save'); },
  async logout() { closeModal(); await request('/api/auth/logout', { method: 'POST', body: {} }); Session.onAuthLost?.(); },
  async loadTeam() { await run(async () => { ui.team = await request('/api/users'); render(); }); },
  userModal(id) {
    const u = id ? ui.team.users.find(x => x.id === id) : { name: '', email: '', role: 'operations', driverId: '', employeeId: '', active: true };
    modal(id ? `Edit ${esc(u.name)}` : 'Add login', `<div class="formgrid">${field('Name', 'name', 'text', u.name, 'required maxlength="60"')}${id ? '' : field('Email', 'email', 'email', '', 'required')}${selectF('Role', 'role', ROLES, u.role)}${selectF('Driver record (driver role only)', 'driverId', [['', 'None'], ...ui.team.drivers.map(d => [d.id, d.name])], u.driverId || '')}${selectF('Employee (employee role only)', 'employeeId', [['', 'None'], ...ui.team.employees.map(d => [d.id, d.name])], u.employeeId || '')}${field(id ? 'New password (optional)' : 'Password (10+ characters)', 'password', 'password', '', `${id ? '' : 'required '}autocomplete="new-password"`)}${id ? selectF('State', 'state', [['active', 'Active'], ['inactive', 'Inactive']], u.active ? 'active' : 'inactive') : ''}</div>`, async f => {
      if (id) await request(`/api/users/${id}`, { method: 'PATCH', body: { name: f.name, role: f.role, driverId: f.driverId || null, employeeId: f.employeeId || null, active: f.state === 'active', password: f.password || undefined } });
      else await request('/api/users', { method: 'POST', body: { email: f.email, name: f.name, role: f.role, driverId: f.driverId || null, employeeId: f.employeeId || null, password: f.password } });
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
  /* The statement's amount implies the courier's commission on that order. */
  for (const [id, v] of got) { const c = fm.querySelector(`[data-ccom="${id}"]`); if (c && !c.disabled) c.value = round2(Math.max(0, Number(c.dataset.base) - v)); }
  const total = round2(sum([...got.values()], x => x));
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

export { normRef, parseTable, printPref, toAmount, A, CSV_COLUMNS, allocInputsTotal, bulkReport, closeModal, csvCell, customerOptionsFor, dateToIso, download, field, globalSearch, handleCsv, lineSum, modal, modalLive, nowLocal, orderDraft, parseCSV, pendingImport, prepareImport, renderDraftLines, run, selectF, textF, toCsv, toast };
