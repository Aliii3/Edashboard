import { DELIVERY_STATUSES } from '@commerce-os/domain';
import { Session } from './api.js';
import { Repo, esc, fail, round2, sum } from '@commerce-os/domain';
import { Guards, S, TERMINAL_DELIVERY, activeDelivery, availableOf, bomCost, calc, carrierKey, contributionOf, courierOutcome, courierSummary, customerOf, dateKey, deliveriesOf, deliveryCash, driverCash, driverStats, expectedFromCustomer, isOverdue, linesOf, log, orderOf, orderValue, overdueWhy, paymentStatus, reservedOf, stockOnHand, tol } from '@commerce-os/domain';
import { badge, btn, card, carrierA, courierOptions, custA, dateF, delA, fd, fdt, grid, heading, initials, kpi, m, note, orderA, pad, row, search, sel, simpleTable, tabs, timeline, ui } from './ui-kit.js';
import { caseButtons } from './views-core.js';
import { A } from './actions.js';
import { VIEWS, render } from './main.js';
/* ==========================================================================
   LAYER 5 · VIEWS: CRM, Inventory and production, Shipping, Private delivery
   ========================================================================== */
function customerTags(c) { const n = Repo.by('orders', 'customerId', c.id).filter(o => o.status !== 'Cancelled').length; return [...new Set([...(c.tags || []), ...(n >= 2 ? ['Repeat'] : [])])]; }
function customerStats(c) {
  const os = Repo.by('orders', 'customerId', c.id), real = os.filter(o => o.status !== 'Cancelled');
  let del = 0, ret = 0; for (const o of os) for (const l of linesOf(o)) { del += l.delivered; ret += l.returned; }
  return { os, n: os.length, revenue: sum(os, o => calc(o).revenue), contribution: sum(os, contributionOf), aov: real.length ? sum(real, orderValue) / real.length : 0, ret: del ? ret / del : 0, last: os.reduce((x, o) => o.at > x ? o.at : x, ''), first: os.reduce((x, o) => !x || o.at < x ? o.at : x, '') };
}
function crmView() {
  if (ui.route.id) return customerProfile(ui.route.id);
  const q = ui.crm.q.trim().toLowerCase(), seg = ui.crm.seg;
  const list = Repo.all('customers').filter(c => (!q || `${c.name} ${c.phone} ${c.area} ${c.id}`.toLowerCase().includes(q)) && (!seg || customerTags(c).includes(seg) || (seg === 'First order' && Repo.count('orders', 'customerId', c.id) === 1)));
  return heading('Customers', 'Order history, delivery preferences and contact logs in one place.', btn('+ New customer', 'customerModal', undefined, { cls: 'primary' }))
    + `<section class="card"><div class="filters">${search('crm.q', 'Name, phone, area or ID…', 'crm')}${sel('crm.seg', 'Segment', [['', 'All customers'], 'VIP', 'Repeat', 'Follow-up', 'First order'], 'crm')}</div>${grid('crm', list, [
      { k: 'n', label: 'Customer', sort: c => c.name, render: c => `${custA(c)}<br><small>${esc(c.id)} · ${esc(c.phone)}</small>` },
      { k: 'a', label: 'Area', sort: c => c.area, render: c => esc(c.area) },
      { k: 't', label: 'Tags', render: c => customerTags(c).map(badge).join(' ') || '<span class="muted">None</span>' },
      { k: 'o', label: 'Orders', num: true, sort: c => Repo.count('orders', 'customerId', c.id), render: c => Repo.count('orders', 'customerId', c.id) },
      { k: 'r', label: 'Recorded revenue', num: true, sort: c => customerStats(c).revenue, render: c => m(customerStats(c).revenue) },
      { k: 'k', label: 'Recorded contribution', num: true, sort: c => customerStats(c).contribution, render: c => m(customerStats(c).contribution) },
      { k: 'l', label: 'Last order', sort: c => customerStats(c).last, render: c => { const s = customerStats(c); return s.last ? fd(s.last) : '<span class="muted">Never</span>'; } },
    ], { sort: 'r', empty: 'No customers match. Try a different search or add a customer.' })}</section>`;
}
function customerProfile(id) {
  const c = Repo.get('customers', id); if (!c) return `<div class="card"><p class="empty">Customer not found. <a class="link" href="#/crm">Back to customers</a></p></div>`;
  const s = customerStats(c), contacts = Repo.by('contacts', 'customerId', id).sort((a, b) => b.at.localeCompare(a.at));
  const deliveries = s.os.flatMap(o => deliveriesOf(o)).sort((a, b) => b.assignedAt.localeCompare(a.assignedAt));
  const tagBtn = t => btn(`${(c.tags || []).includes(t) ? '✓ ' : '+ '}${t}`, 'toggleTag', [c.id, t], { cls: 'small ' + ((c.tags || []).includes(t) ? 'on' : '') });
  return heading(esc(c.name), `${esc(c.id)} · ${esc(c.phone)} · ${esc(c.area)}`, `${btn('Edit profile', 'customerModal', c.id)}${btn('Log contact', 'contactModal', c.id)}${btn('+ New order', 'newOrder', c.id, { cls: 'primary' })}`, `<a href="#/crm">Customers</a> / ${esc(c.name)}`)
    + `<div class="kpi-grid k4 mb">${kpi('Recorded lifetime revenue', m(s.revenue), `From ${s.n} orders in this workspace only`)}${kpi('Recorded contribution', m(s.contribution), 'After costs and marketing allocation')}${kpi('Average order value', m(s.aov), 'Non-cancelled orders')}${kpi('Return rate', `${(s.ret * 100).toFixed(0)}%`, 'Returned ÷ delivered units')}</div>`
    + note(`Lifetime figures cover history recorded here${s.first ? ` since ${fd(s.first)}` : ''}. Earlier purchases made outside this workspace are not included.`)
    + `<div class="grid cols"><div class="grid stack">${card('Orders', grid(`cust-${c.id}`, s.os, [
      { k: 'i', label: 'Order', sort: o => o.id, render: o => `${orderA(o.id)}<br><small>${fd(o.at)}</small>` },
      { k: 's', label: 'Status', render: o => badge(o.status) },
      { k: 'p', label: 'Payment', render: o => badge(paymentStatus(o)) },
      { k: 'v', label: 'Value', num: true, sort: o => orderValue(o), render: o => m(orderValue(o)) },
      { k: 'r', label: 'Revenue', num: true, render: o => m(calc(o).revenue) },
      { k: 'c', label: 'Contribution', num: true, render: o => m(contributionOf(o)) },
    ], { sort: 'i', size: 10, empty: 'No orders yet.' }))}
    ${card('Delivery history', simpleTable(['Delivery', 'Order', 'Carrier', 'Status', 'Attempts', 'Updated'], deliveries.slice(0, 30).map(d => `<tr><td>${delA(d)}</td><td>${orderA(d.orderId)}</td><td>${carrierA(d)}</td><td>${badge(d.status)}</td><td>${d.attempts.length}</td><td>${fdt(d.updatedAt)}</td></tr>`), 'No deliveries yet.'))}
    ${card('Contact log', pad(contacts.map(x => `<div class="row"><span>${esc(x.summary)}<br><small>${fdt(x.at)} · ${esc(x.channel)} · ${esc(x.direction)} · ${esc(x.by)}${x.followUp ? ` · Follow up ${esc(x.followUp)}` : ''}</small></span></div>`).join('') || '<p class="muted">No contacts logged yet.</p>') , 'Internal record of conversations. Nothing here sends a message.', btn('+ Log contact', 'contactModal', c.id))}</div>
    <div class="grid stack">${card('Contact and address', pad(`${row('Phone', esc(c.phone))}${row('Area', esc(c.area))}<p class="subtitle">${esc(c.address)}</p>${(c.altAddresses || []).map(a => `<p class="subtitle">Alternate: ${esc(a)}</p>`).join('')}`))}
    ${card('Delivery preferences', pad(`${row('Preferred time', esc(c.preferredTime || 'Any time'))}<p class="subtitle">${esc(c.deliveryNotes || 'No delivery instructions recorded.')}</p>`), 'Copied onto new orders')}
    ${card('Tags', pad(`<div class="actions">${tagBtn('VIP')}${tagBtn('Follow-up')}</div><p class="inlinehelp">Repeat is automatic, from two or more non-cancelled orders.</p><div class="tags mt">${customerTags(c).map(badge).join(' ')}</div>`))}
    ${card('Activity', pad(timeline(Repo.by('events', 'customerId', id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 15))))}</div></div>`;
}

/* ---------- Inventory ---------- */
function skuHealth(s) { const a = availableOf(s.id); return a < s.min ? 'Low stock' : a < s.min * 1.4 ? 'Reorder soon' : 'Healthy'; }
function inventoryView() {
  const st = ui.inv, skus = Repo.all('skus'), prod = Repo.all('production'), wip = prod.filter(p => p.status === 'WIP'), mats = Repo.all('materials');
  const q = st.q.trim().toLowerCase();
  const body = {
    'Finished goods': () => `<section class="card"><div class="filters">${search('inv.q', 'Search SKU or product…', 'skus')}</div>${grid('skus', skus.filter(s => !q || `${s.id} ${s.name} ${s.variant}`.toLowerCase().includes(q)), [
      { k: 'id', label: 'SKU', sort: s => s.id, render: s => `<strong>${esc(s.id)}</strong>` },
      { k: 'n', label: 'Product / variant', sort: s => s.name, render: s => `${esc(s.name)}<br><small>${esc(s.variant)}</small>` },
      { k: 'h', label: 'On hand', num: true, sort: s => stockOnHand(s.id), render: s => stockOnHand(s.id) },
      { k: 'r', label: 'Reserved', num: true, sort: s => reservedOf(s.id), render: s => reservedOf(s.id) },
      { k: 'a', label: 'Available', num: true, sort: s => availableOf(s.id), render: s => `<strong>${availableOf(s.id)}</strong>` },
      { k: 'm', label: 'Reorder at', num: true, render: s => s.min },
      { k: 'c', label: 'Std. unit cost', num: true, render: s => m(bomCost(s.id).total) },
      { k: 'p', label: 'Price', num: true, render: s => m(s.price) },
      { k: 's', label: 'Health', sort: s => skuHealth(s), render: s => badge(skuHealth(s)) },
      { k: 'x', label: '', render: s => btn('Adjust', 'stockModal', ['sku', s.id], { cls: 'small' }) + btn('Edit', 'skuModal', s.id, { cls: 'small' }) },
    ], { sort: 'id', dir: 1, empty: 'No SKUs match.' })}</section>`,
    'Raw materials': () => card('Materials', simpleTable(['Material', 'Category', 'On hand', 'Reorder at', 'Unit cost', 'Stock value', 'Health', ''], mats.map(x => { const o = stockOnHand(x.id); return `<tr><td><strong>${esc(x.id)}</strong><br><small>${esc(x.name)}</small></td><td>${esc(x.category)}</td><td>${o} ${esc(x.unit)}</td><td>${x.min} ${esc(x.unit)}</td><td>${m(x.cost)}</td><td>${m(o * x.cost)}</td><td>${badge(o < x.min ? 'Low stock' : 'Healthy')}</td><td>${btn('Receive', 'materialModal', x.id, { cls: 'small' })}${btn('Adjust', 'stockModal', ['material', x.id], { cls: 'small' })}</td></tr>`; })), 'Starting production consumes these. Purchase receipts need a unique reference per material.'),
    'Production': () => note('<strong>Raw materials → Work in progress → Finished goods → Orders.</strong> Starting consumes the BOM once. Completing receives finished goods once. Unique journal keys block a repeat of either.') + card('Production orders', grid('prod', prod, [
      { k: 'i', label: 'Order', sort: p => p.id, render: p => esc(p.id) },
      { k: 's', label: 'SKU', render: p => `${esc(p.sku)}<br><small>${esc(Repo.get('skus', p.sku)?.name)}</small>` },
      { k: 'q', label: 'Units', num: true, render: p => p.qty },
      { k: 'u', label: 'Unit cost', num: true, render: p => m(p.unitCost) },
      { k: 'v', label: 'Value', num: true, render: p => m(p.unitCost * p.qty) },
      { k: 'd', label: 'Due', render: p => esc(p.due || '—') },
      { k: 't', label: 'State', sort: p => p.status, render: p => badge(p.status) },
      { k: 'a', label: 'Action', render: p => p.status === 'Planned' ? btn('Start and consume', 'startMO', p.id, { cls: 'small primary' }) + btn('Cancel', 'cancelMO', p.id, { cls: 'small' }) : p.status === 'WIP' ? btn('Complete and receive', 'completeMO', p.id, { cls: 'small primary' }) : `<span class="muted">${p.status === 'Completed' ? 'Received ' + fd(p.completedAt) : 'Cancelled'}</span>` },
    ], { sort: 'i', empty: 'No production orders yet.' }), 'Simplified: no scrap or partial receipts'),
    'BOM & costing': () => card('Bills of materials and standard cost', simpleTable(['SKU', 'Materials', 'Packaging', 'Labor', 'Overhead', 'Unit cost', 'Price', 'Gross margin', 'BOM'], skus.map(s => { const c = bomCost(s.id), b = Repo.get('boms', s.id); return `<tr><td><strong>${esc(s.id)}</strong><br><small>${esc(s.name)}</small></td><td>${m(c.materials)}</td><td>${m(c.packaging)}</td><td>${m(c.labor)}</td><td>${m(c.overhead)}</td><td><strong>${m(c.total)}</strong></td><td>${m(s.price)}</td><td>${Math.round((s.price - c.total) / s.price * 100)}%</td><td class="wrap"><small>${b.lines.map(x => `${x.qty} ${esc(Repo.get('materials', x.material).unit)} ${esc(Repo.get('materials', x.material).name)}`).join(' · ')}</small></td></tr>`; })), 'New orders snapshot this cost per line. Existing orders never change.'),
    'Reservations': () => { const held = Repo.all('lines').filter(l => l.reserved > 0); return note('<strong>Created</strong> when an order is confirmed. <strong>Released</strong> if it is cancelled. <strong>Converted</strong> to a dispatch deduction when the carrier picks up the parcel. Reserved units stay on hand until then.') + card('Active reservations', grid('resv', held, [
      { k: 'o', label: 'Order', sort: l => l.orderId, render: l => orderA(l.orderId) },
      { k: 's', label: 'SKU', sort: l => l.sku, render: l => esc(l.sku) },
      { k: 'q', label: 'Reserved', num: true, sort: l => l.reserved, render: l => l.reserved },
      { k: 't', label: 'Order status', render: l => badge(orderOf(l.orderId).status) },
    ], { sort: 'o', empty: 'No active reservations.' })); },
    'Movement journal': () => { const k = st.kind; const rows = Repo.all('movements').filter(x => (!k || x.kind === k) && (!q || `${x.item} ${x.ref} ${x.note}`.toLowerCase().includes(q))); return `<section class="card"><div class="filters">${search('inv.q', 'Search item or reference…', 'journal')}${sel('inv.kind', 'Movement', [['', 'All'], 'Opening balance', 'Adjustment', 'Purchase receipt', 'Production consumption', 'Production receipt', 'Dispatch', 'Inspected return'], 'journal')}</div>${grid('journal', rows, [
      { k: 'd', label: 'When', sort: x => x.at, render: x => fdt(x.at) },
      { k: 'i', label: 'Item', sort: x => x.item, render: x => esc(x.item) },
      { k: 'k', label: 'Movement', render: x => esc(x.kind) },
      { k: 'q', label: 'Qty', num: true, sort: x => x.qty, render: x => `<span class="${x.qty < 0 ? 'negative' : 'positive'}">${x.qty > 0 ? '+' : ''}${x.qty}</span>` },
      { k: 'r', label: 'Reference', render: x => esc(x.ref) },
      { k: 'n', label: 'Note', wrap: true, render: x => esc(x.note) },
      { k: 'b', label: 'By', render: x => esc(x.by) },
    ], { sort: 'd', empty: 'No movements match.' })}<div class="pad"><p class="inlinehelp">On-hand stock is the running total of this journal. Records are only ever added: corrections are new adjustments.</p></div></section>`; },
  };
  return heading('Inventory and production', 'Single warehouse. Stock changes only through the movement journal.', `${btn('Adjust stock', 'stockModal')}${btn('+ SKU', 'skuModal')}${btn('+ Production order', 'productionModal', undefined, { cls: 'primary' })}`)
    + `<div class="kpi-grid k4 mb">${kpi('Finished goods on hand', sum(skus, s => stockOnHand(s.id)).toLocaleString('en-US'), `${sum(skus, s => reservedOf(s.id))} reserved for confirmed orders`)}${kpi('Available stock value', m(sum(skus, s => Math.max(0, availableOf(s.id)) * bomCost(s.id).total)), 'Available × standard unit cost')}${kpi('Work in progress', `${sum(wip, p => p.qty)} units`, m(sum(wip, p => p.qty * p.unitCost)))}${kpi('Low-stock items', skus.filter(s => skuHealth(s) === 'Low stock').length + mats.filter(x => stockOnHand(x.id) < x.min).length, 'SKUs and materials below reorder')}</div>`
    + tabs('inv.tab', Object.keys(body)) + body[st.tab]()
    + `<details class="whynot mt"><summary>Simplified assumptions</summary><ul><li>One warehouse. Each movement could carry a location in a future version.</li><li>Accepted returns are inspected and resellable. Damaged returns are rejected in this version.</li><li>Standard costing from the BOM. No scrap, landed cost or actual-cost variance.</li></ul></details>`;
}

/* ---------- Delivery actions, shared by Order 360, Shipping and driver profiles ---------- */
function deliveryActions(d) {
  const o = orderOf(d.orderId), a = [], isD = d.mode === 'driver', due = round2(calc(o).revenue - calc(o).paid);
  const add = (label, name, arg, why, primary) => a.push({ label, name, arg, why: why || null, primary });
  switch (d.status) {
    case 'Assigned': add('Record pickup', 'pickup', d.id, Guards.pickup(d), 1); add('Reassign', 'reassignModal', d.id); add('Cancel assignment', 'cancelAssign', d.id); break;
    case 'Picked Up': add('Out for delivery', 'ofd', d.id, null, 1); add('Start return', 'returnStart', d.id); if (isD) add('Hand over to driver', 'handoffModal', d.id); break;
    case 'Out for Delivery': add('Record delivery', 'deliverModal', d.id, null, 1); add('Failed attempt', 'failModal', d.id); if (isD) add('Hand over to driver', 'handoffModal', d.id); break;
    case 'Failed Attempt': add('Schedule retry', 'retryModal', d.id, null, 1); add('Start return', 'returnStart', d.id); if (isD) add('Hand over to driver', 'handoffModal', d.id); break;
    case 'Retry Scheduled': add('Out for delivery', 'ofd', d.id, null, 1); add('Start return', 'returnStart', d.id); if (isD) add('Hand over to driver', 'handoffModal', d.id); break;
    case 'Partially Delivered': add('Start return of undelivered units', 'returnStart', d.id, null, 1); break;
    case 'Return in Transit': add('Receive at warehouse', 'receive', d.id, null, 1); break;
  }
  if (d.completedAt && due > tol()) add('Record collection', 'collectModal', d.id, null, !a.length);
  return a;
}
const rowActions = d => { const a = deliveryActions(d).filter(x => !x.why || x.primary), p = a.find(x => x.primary); return (p ? btn(p.label, p.name, p.arg, { cls: 'small primary', why: p.why }) : '') + btn('Details', 'openDelivery', d.id, { cls: 'small' }); };
const deliveryOutcome = d => { const o = orderOf(d.orderId); const c = deliveryCash(d); if (d.mode === 'courier') return courierOutcome(d); const exp = expectedFromCustomer(d); if (!d.completedAt) return exp > 0 && c.collected === 0 ? 'Pending' : 'Not due'; if (c.cash === 0 && c.collected === 0) return exp > tol() ? 'Pending' : 'Reconciled'; if (exp - c.collected > tol()) return 'Partially collected'; return c.unhanded > tol() ? 'Pending' : 'Reconciled'; };
function deliveryCols(o = {}) {
  return [
    { k: 'id', label: 'Delivery / order', sort: d => d.id, render: d => `${delA(d)}<br><small>${orderA(d.orderId)}</small>` },
    ...(o.carrier ? [{ k: 'car', label: 'Carrier', render: d => carrierA(d) }] : []),
    { k: 'c', label: 'Customer', render: d => { const c = customerOf(orderOf(d.orderId)); return `${custA(c)}<br><small>${esc(c.phone)}</small>`; } },
    { k: 'ad', label: 'Address / instructions', wrap: true, render: d => { const x = orderOf(d.orderId); return `<span class="clip">${esc(x.address)}</span>${x.instructions ? `<br><small>${esc(x.instructions)}</small>` : ''}`; } },
    { k: 'q', label: 'Items', render: d => { const t = d.items.reduce((n, i) => n + i.qty, 0), dl = d.items.reduce((n, i) => n + i.delivered, 0); return `${t} unit${t > 1 ? 's' : ''}${d.completedAt ? `<br><small>${dl} delivered</small>` : ''}`; } },
    { k: 'as', label: 'Assigned / pickup', sort: d => d.assignedAt, render: d => `${fdt(d.assignedAt)}<br><small>${d.pickedUpAt ? 'Pickup ' + fdt(d.pickedUpAt) : 'Not picked up'}</small>` },
    { k: 'st', label: 'Status / update', sort: d => d.status, render: d => `${badge(d.status)}${isOverdue(d) ? ` <span class="flag" title="${esc(overdueWhy(d))}">Overdue</span>` : ''}<br><small>${fdt(d.updatedAt)}</small>` },
    { k: 'at', label: 'Attempts / done', render: d => `${d.attempts.length}<br><small>${d.completedAt ? fdt(d.completedAt) : '—'}</small>` },
    { k: 'ex', label: 'Expected', num: true, sort: d => expectedFromCustomer(d), render: d => m(expectedFromCustomer(d)) },
    { k: 'co', label: 'Collected', num: true, render: d => m(deliveryCash(d).collected) },
    { k: 'me', label: 'Method', render: d => { const c = deliveryCash(d); return c.method || (orderOf(d.orderId).paymentMethod === 'COD' ? '<span class="muted">Not yet</span>' : `<small>Prepaid ${esc(orderOf(d.orderId).paymentMethod)}</small>`); } },
    { k: 'no', label: 'Notes / reasons', wrap: true, render: d => { const lastF = [...d.attempts].reverse().find(a => a.outcome !== 'Delivered'); return `<small>${esc(lastF ? [lastF.reason, lastF.note].filter(Boolean).join(': ') : d.history.at(-1)?.note || '')}</small>`; } },
    { k: 'ac', label: 'Actions', render: rowActions },
  ];
}

/* ---------- Shipping ---------- */
function shippingView() {
  const st = ui.ship, all = Repo.all('deliveries'), active = all.filter(d => !TERMINAL_DELIVERY.has(d.status));
  const q = st.q.trim().toLowerCase();
  const body = {
    'Dispatch queue': () => {
      const unassigned = Repo.all('orders').filter(o => ['Confirmed', 'Processing', 'Ready'].includes(o.status) && !activeDelivery(o));
      const waiting = all.filter(d => d.status === 'Assigned');
      return card('Needs a carrier', `${grid('dq', unassigned, [
        { k: 'sel', label: '', render: o => `<input type="checkbox" aria-label="Select order ${o.id}" data-sel="${o.id}" ${ui.selected.has(o.id) ? 'checked' : ''}>` },
        { k: 'i', label: 'Order', sort: o => o.id, render: o => `${orderA(o.id)}<br><small>${fd(o.at)}</small>` },
        { k: 'c', label: 'Customer / area', render: o => `${custA(customerOf(o))}<br><small>${esc(o.area)}</small>` },
        { k: 'n', label: 'Units', num: true, render: o => linesOf(o).reduce((n, l) => n + l.qty, 0) },
        { k: 'v', label: 'To collect', num: true, render: o => m(Math.max(0, calc(o).value - calc(o).paid)) },
        { k: 's', label: 'Status', render: o => badge(o.status) },
        { k: 'a', label: '', render: o => btn('Assign', 'assignModal', [o.id], { cls: 'small primary' }) },
      ], { sort: 'i', dir: 1, size: 10, empty: 'Every confirmed order has a carrier.' })}<div class="pad">${btn('Assign selected', 'bulkAssign', undefined, { why: ui.selected.size ? '' : 'Select orders in the list above first.' })}</div>`, 'Two fulfillment options: external courier or private delivery. Both use the same records.')
        + `<div class="sp"></div>` + card('Awaiting pickup', grid('dw', waiting, deliveryCols({ carrier: true }), { sort: 'as', dir: 1, size: 10, empty: 'Nothing is waiting for pickup.' }), 'Pickup needs the order to be Ready. It converts the reservation into a stock deduction.');
    },
    'External couriers': () => {
      const couriers = Repo.all('couriers');
      const rows = active.filter(d => d.mode === 'courier' && (!st.courier || d.carrierId === st.courier));
      return `<div class="grid thirds">${couriers.map(c => { const s = courierSummary(c), sent = s.deliveries.filter(d => d.pickedUpAt), done = sent.filter(d => d.completedAt).length, closed = sent.filter(d => d.completedAt || d.returnedAt).length, fails = sent.reduce((n, d) => n + d.attempts.filter(a => a.outcome === 'Failed').length, 0); return card(esc(c.name), pad(`<div class="triad two"><div><small>Delivered / closed</small><strong>${done} / ${closed}</strong></div><div><small>Success rate</small><strong>${closed ? Math.round(done / closed * 100) + '%' : '—'}</strong></div></div>${row('Failed attempts', fails)}${row('Shipping and return charges', m(s.deductions))}${row('Customer cash with courier', m(s.customer))}${row('Outstanding settlement', m(s.gap))}<div class="actions mt">${btn('Reconcile →', 'goFinance', ['Courier reconciliation', { courier: c.id }], { cls: 'small' })}${btn('Edit', 'courierModal', c.id, { cls: 'small' })}</div>`), `${m(c.shipRate)} ship · ${m(c.returnRate)} return · ${m(c.codFee)} COD fee. Status entered manually, no API.`); }).join('')}</div>`
        + `<section class="card"><div class="cardhead"><div><h2>Active shipments</h2><p>Update status by hand or import later. No tracking feed is connected.</p></div><div class="actions">${btn('+ Courier', 'courierModal')}</div></div><div class="filters">${sel('ship.courier', 'Courier', courierOptions(), 'cs')}</div>${grid('cs', rows, deliveryCols({ carrier: true }), { sort: 'st', empty: 'No active courier shipments.' })}</section>`;
    },
    'Private delivery': () => {
      const list = Repo.all('drivers').filter(d => (!q || `${d.name} ${d.phone} ${d.zones}`.toLowerCase().includes(q)) && (!st.avail || (st.avail === 'Inactive' ? d.active === false : d.active !== false && d.availability === st.avail)));
      const holding = sum(Repo.all('drivers'), d => Math.max(0, driverCash(d.id).outstanding));
      return note('<strong>Operational tracking only.</strong> Assignments, statuses, attempts, timestamps and collections. There is no GPS, map or live location in this product.')
        + `<div class="kpi-grid k4 mb">${kpi('Parcels with drivers', active.filter(d => d.mode === 'driver' && d.custody.startsWith('driver:')).length, 'In physical custody now')}${kpi('Awaiting pickup', active.filter(d => d.mode === 'driver' && d.status === 'Assigned').length, 'Still in the warehouse')}${kpi('Driver-held cash', m(holding), 'Owed to the business', { a: 'goFinance', v: ['Driver reconciliation'] })}${kpi('Overdue updates', active.filter(d => d.mode === 'driver' && isOverdue(d)).length, `No update in ${S().overdueHours} hours, or retry missed`)}</div>`
        + `<section class="card"><div class="filters">${search('ship.q', 'Search driver, phone or zone…')}${sel('ship.avail', 'Availability', [['', 'All'], 'Available', 'Busy', 'Off duty', 'Inactive'])}<div class="spacer"></div>${btn('Assign orders', 'assignPicker')}${btn('+ New driver', 'driverModal', undefined, { cls: 'primary' })}</div><div class="pad"><div class="driver-grid">${list.map(driverCard).join('') || '<p class="empty">No drivers match.</p>'}</div></div></section>`;
    },
    'Failed follow-up': () => {
      const rows = active.filter(d => ['Failed Attempt', 'Retry Scheduled', 'Return in Transit', 'Partially Delivered'].includes(d.status));
      return note('A failed attempt does not mean the parcel is back. It stays in the carrier\'s custody until a physical handover at the warehouse is recorded.', 'warning') + card('Follow-ups', grid('ff', rows, deliveryCols({ carrier: true }), { sort: 'as', dir: 1, empty: 'No failed deliveries to follow up.' }));
    },
    'Returns & exchanges': () => {
      const rows = Repo.all('cases');
      return card('Service cases', grid('cases', rows, [
        { k: 'i', label: 'Case', sort: x => x.at, render: x => `${esc(x.id)}<br><small>${fd(x.at)}</small>` },
        { k: 't', label: 'Type', render: x => esc(x.type) },
        { k: 'o', label: 'Order', render: x => orderA(x.orderId) },
        { k: 'c', label: 'Customer', render: x => custA(customerOf(orderOf(x.orderId))) },
        { k: 'n', label: 'Items', render: x => x.items.map(i => `${i.qty} × ${esc(Repo.get('lines', i.lineId).sku)}`).join(', ') },
        { k: 'r', label: 'Reason', wrap: true, render: x => esc(x.reason) },
        { k: 'p', label: 'Return cost', num: true, render: x => m(x.returnCost) },
        { k: 's', label: 'Status', render: x => `${badge(x.status)}${x.replacementOrderId ? `<br><small>Replacement ${orderA(x.replacementOrderId)}</small>` : ''}` },
        { k: 'a', label: 'Actions', render: caseButtons },
      ], { sort: 'i', empty: 'No return or exchange cases.' }), 'Open a new case from the order. Replacements are separate linked orders.');
    },
  };
  const tabList = Object.keys(body);
  return heading('Shipping', 'Two fulfillment options connected to the same orders and financial records.', '') + tabs('ship.tab', tabList) + body[st.tab]();
}
function driverCard(d) {
  const s = driverStats(d.id), c = driverCash(d.id), inactive = d.active === false;
  return `<article class="driver-card ${inactive ? 'is-inactive' : ''}"><header><span class="avatar">${esc(initials(d.name))}</span><div><h3><a class="link stretch" href="#/drivers/${d.id}">${esc(d.name)}</a></h3><small>${esc(d.phone)} · ${esc(d.vehicle || '')}</small></div>${badge(inactive ? 'Inactive' : d.availability)}</header>
  <div class="dc-grid"><div><small>Awaiting pickup</small><b>${s.awaiting}</b></div><div><small>In custody</small><b>${s.custody}</b></div><div><small>Out for delivery</small><b>${s.ofd}</b></div><div><small>Completed</small><b>${s.completed}</b></div><div><small>Failed attempts</small><b>${s.failed}</b></div></div>
  ${row('Expected COD, active', m(c.expected))}${row('Cash collected', m(c.collected))}${row('Handed over', m(c.handed))}${row('Outstanding held cash', m(c.outstanding), c.outstanding > tol() ? 'total warn' : 'total')}
  <footer><small>${s.latest ? `${esc(s.latest.text.slice(0, 80))} · ${fdt(s.latest.at)}` : 'No activity yet'}</small></footer></article>`;
}
function driverProfile(id) {
  const d = Repo.get('drivers', id); if (!d) return `<div class="card"><p class="empty">Driver not found. <a class="link" href="#/shipping">Back to shipping</a></p></div>`;
  const s = driverStats(id), c = driverCash(id), f = ui.drv, key = carrierKey('driver', id), inactive = d.active === false;
  const custody = s.deliveries.filter(x => x.custody === key);
  const applyF = rows => rows.filter(x => {
    const day = dateKey(x.assignedAt);
    if (f.from && day < f.from) return false; if (f.to && day > f.to) return false;
    if (f.status && x.status !== f.status) return false; if (f.area && x.area !== f.area) return false;
    if (f.collection && deliveryOutcome(x) !== f.collection) return false; return true;
  });
  const hos = Repo.by('handovers', 'driverId', id).sort((a, b) => b.at.localeCompare(a.at)), exps = Repo.by('driverExpenses', 'driverId', id).sort((a, b) => b.at.localeCompare(a.at));
  const discs = Repo.by('discrepancies', 'carrierKey', key).sort((a, b) => b.at.localeCompare(a.at)), colls = Repo.by('payments', 'holderKey', key).sort((a, b) => b.at.localeCompare(a.at));
  const tb = {
    'Current assignments': () => grid(`d-cur-${id}`, applyF(s.deliveries.filter(x => !TERMINAL_DELIVERY.has(x.status))), deliveryCols(), { sort: 'as', empty: 'No current assignments match.' }),
    'Completed & history': () => grid(`d-his-${id}`, applyF(s.deliveries.filter(x => TERMINAL_DELIVERY.has(x.status))), deliveryCols(), { sort: 'as', empty: 'No past deliveries match. History is kept even after a driver becomes inactive.' }),
    'Failed & retry': () => grid(`d-fail-${id}`, applyF(s.deliveries.filter(x => ['Failed Attempt', 'Retry Scheduled'].includes(x.status))), deliveryCols(), { sort: 'as', empty: 'No failed attempts are awaiting follow-up.' }),
    'Returns awaiting handover': () => grid(`d-ret-${id}`, applyF(s.deliveries.filter(x => ['Return in Transit', 'Partially Delivered'].includes(x.status))), deliveryCols(), { sort: 'as', empty: 'No parcels are waiting to go back to the warehouse.' }),
    'Cash': () => pad(`<div class="cash-formula"><div><small>Cash collected</small><b>${m(c.collected)}</b></div><i>−</i><div><small>Handed over</small><b>${m(c.handed)}</b></div><i>−</i><div><small>Approved cash expenses</small><b>${m(c.approvedCash)}</b></div><i>−</i><div><small>Cash refunds</small><b>${m(c.refunds)}</b></div><i>=</i><div class="res"><small>Outstanding</small><b>${m(c.outstanding)}</b></div></div><p class="inlinehelp">Non-cash payments collected on this driver's deliveries (${m(c.nonCash)}) went straight to the business and are excluded. Expected on active deliveries: ${m(c.expected)}. Pending expenses: ${m(c.pendingExp)}. Open discrepancies: ${m(c.openDisc)}.</p>`)
      + `<h3 class="sub">Customer collections</h3>` + simpleTable(['When', 'Reference', 'Order', 'Delivery', 'Method', 'Amount'], colls.slice(0, 50).map(p => `<tr><td>${fdt(p.at)}</td><td>${esc(p.ref)}</td><td>${orderA(p.orderId)}</td><td>${esc(p.deliveryId || '—')}</td><td>${esc(p.method)}</td><td class="${p.amount < 0 ? 'negative' : ''}">${m(p.amount)}${p.reason ? `<br><small>${esc(p.reason)}</small>` : ''}</td></tr>`), 'No cash collected yet.')
      + `<h3 class="sub">Cash handovers to the business</h3>` + simpleTable(['Date', 'Reference', 'Received by', 'Amount', 'Allocated to'], hos.map(h => `<tr><td>${fdt(h.at)}</td><td>${esc(h.ref)}</td><td>${esc(h.receivedBy)}</td><td>${m(h.amount)}</td><td class="wrap"><small>${Repo.by('handoverAllocs', 'handoverId', h.id).map(a => `${a.deliveryId} ${m(a.amount)}`).join(' · ')}</small></td></tr>`), 'No handovers yet.')
      + `<h3 class="sub">Expenses and deductions</h3>` + simpleTable(['Date', 'ID', 'Category', 'Amount', 'From collected cash', 'Status', ''], exps.map(e => `<tr><td>${fd(e.at)}</td><td>${e.id}</td><td>${esc(e.category)}</td><td>${m(e.amount)}</td><td>${e.paidFromCash ? 'Yes' : 'No'}</td><td>${badge(e.status)}</td><td>${e.status === 'Pending' ? btn('Approve', 'decideExp', [e.id, 'Approved'], { cls: 'small primary' }) + btn('Reject', 'decideExp', [e.id, 'Rejected'], { cls: 'small' }) : ''}</td></tr>`), 'No expenses submitted.')
      + `<h3 class="sub">Discrepancies</h3>` + simpleTable(['Raised', 'Type', 'Order', 'Amount', 'Reason', 'Status', ''], discs.map(x => `<tr><td>${fd(x.at)}</td><td>${esc(x.type)}</td><td>${x.orderId ? orderA(x.orderId) : '—'}</td><td>${m(x.amount)}</td><td class="wrap">${esc(x.reason)}${x.resolution ? `<br><small>Resolved: ${esc(x.resolution)}</small>` : ''}</td><td>${badge(x.status)}</td><td>${x.status === 'Open' ? btn('Resolve', 'resolveModal', x.id, { cls: 'small' }) : ''}</td></tr>`), 'No discrepancies.'),
    'Activity': () => pad(timeline(Repo.by('events', 'driverId', id).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id).slice(0, 60))),
  };
  const areas = [...new Set(s.deliveries.map(x => x.area))].sort();
  const tabFilters = !['Cash', 'Activity'].includes(f.tab);
  return heading(esc(d.name), `${esc(d.phone)} · ${esc(d.vehicle || 'Vehicle not set')} · Zones: ${esc(d.zones || 'not set')}`, `${inactive || !Session.can('setAvailability') ? '' : `<label class="fsel inline"><span>Availability</span><select data-avail="${d.id}">${['Available', 'Busy', 'Off duty'].map(x => `<option ${x === d.availability ? 'selected' : ''}>${x}</option>`).join('')}</select></label>`}${btn('Edit', 'driverModal', d.id)}${btn('Assign orders', 'assignPicker', d.id, { why: inactive ? 'This driver is inactive.' : d.availability === 'Off duty' ? 'This driver is off duty.' : '' })}${btn('Add expense', 'expenseDriverModal', d.id)}${btn('Record cash handover', 'handoverModal', d.id, { cls: 'primary', why: c.outstanding <= 0 ? 'This driver holds no outstanding cash.' : '' })}`, Session.isDriver ? '' : `<a href="#/shipping">Shipping</a> / Private delivery / ${esc(d.name)}`)
    + (inactive ? note('This driver is inactive. Their delivery and cash history is preserved.', 'warning') : '')
    + `<div class="kpi-grid k4 mb">${kpi('In custody now', s.custody, `${s.ofd} out for delivery · ${s.awaiting} awaiting pickup`)}${kpi('Completed', s.completed, `${s.failed} failed attempts recorded`)}${kpi('Expected COD, active', m(c.expected), 'Still to collect on current parcels')}${kpi('Outstanding held cash', m(c.outstanding), `Collected ${m(c.collected)}, handed over ${m(c.handed)}`, { cls: c.outstanding > tol() ? 'hl' : '' })}</div>`
    + card(`Currently with this driver (${custody.length})`, grid(`d-cust-${id}`, custody, deliveryCols(), { sort: 'as', size: 10, empty: 'No parcels in this driver\'s custody right now.' }), 'Physical custody. A parcel leaves this list only through delivery, a driver handover or a warehouse receipt.', '', 'prominent')
    + `<div class="sp"></div>` + tabs('drv.tab', Object.keys(tb))
    + `<section class="card">${tabFilters ? `<div class="filters">${dateF('drv.from', 'Assigned from')}${dateF('drv.to', 'To')}${sel('drv.status', 'Delivery status', [['', 'All'], ...DELIVERY_STATUSES])}${sel('drv.collection', 'Collection', [['', 'All'], 'Not due', 'Pending', 'Partially collected', 'Reconciled'])}${sel('drv.area', 'Area', [['', 'All'], ...areas])}</div>` : ''}${tb[f.tab]()}</section>`;
}

export { crmView, customerProfile, customerStats, customerTags, deliveryActions, deliveryCols, deliveryOutcome, driverCard, driverProfile, inventoryView, rowActions, shippingView, skuHealth };
