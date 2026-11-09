import { DELIVERY_STATUSES, COLLECTION_OUTCOMES, CHANNELS } from '@commerce-os/domain';
import { FLAG_LIST } from './ui-kit.js';
import { Session } from './api.js';
import { Repo, esc, round2, sum } from '@commerce-os/domain';
import { Guards, ORDER_STATUSES, S, activeDelivery, allocationOf, availableOf, calc, campaignSpend, carrierKey, carrierName, casesOf, contributionOf, courierSummary, customerOf, dateKey, deliveriesOf, driverCash, isOverdue, ledger, linesOf, money, netUnit, orderOf, orderValue, paymentStatus, paymentsOf, settlementStatus, stockOnHand, totals } from '@commerce-os/domain';
import { PRESETS, act, badge, btn, campaignOptions, card, carrierA, courierOptions, custA, dateF, dayShift, delA, driverA, driverOptions, expl, fd, fdt, filteredOrders, grid, heading, icon, initials, kpi, latestDelivery, lineChart, m, note, orderA, orderFlags, pad, presetRange, rangeLabel, row, search, sel, simpleTable, timeline, today, ui } from './ui-kit.js';
import { customerTags, deliveryActions } from './views-ops.js';
import { A } from './actions.js';
import { VIEWS, render } from './main.js';
/* ==========================================================================
   LAYER 5 · VIEWS: Overview, Orders, Order 360
   ========================================================================== */
function overviewOrderSet(f) {
  if (!f.campaign && !f.sku && !f.courier && !f.driver) return null;
  const set = new Set();
  for (const o of Repo.all('orders')) {
    if (f.campaign && (f.campaign === 'none' ? o.campaignId : o.campaignId !== f.campaign)) continue;
    if (f.sku && !linesOf(o).some(l => l.sku === f.sku)) continue;
    if (f.courier || f.driver) { const ds = Repo.by('deliveries', 'orderId', o.id); if (f.courier && !ds.some(d => d.carrierKey === carrierKey('courier', f.courier))) continue; if (f.driver && !ds.some(d => d.carrierKey === carrierKey('driver', f.driver))) continue; }
    set.add(o.id);
  }
  return set;
}
function trendBuckets(r) {
  const entries = ledger(); let from = r.from, to = r.to || today();
  if (!from) { from = to; for (const e of entries) if (e.d < from) from = e.d; }
  const days = Math.round((new Date(to) - new Date(from)) / 864e5) + 1, size = days <= 16 ? 1 : days <= 70 ? 7 : 30, out = [];
  for (let s = from; s <= to; s = dayShift(s, size)) { const e = dayShift(s, size - 1), end = e > to ? to : e, f = k => fd(k + 'T12:00:00Z').slice(0, 6); out.push({ from: s, to: end, short: f(s), label: size === 1 ? fd(s + 'T12:00:00Z') : `${f(s)} to ${f(end)}` }); }
  return { list: out, size };
}
function overview() {
  const f = ui.ov, r = presetRange(f), set = overviewOrderSet(f), t = totals({ ...r, orders: set }), scoped = !!set;
  const os = Repo.all('orders').filter(o => { if (set && !set.has(o.id)) return false; const d = dateKey(o.at); return (!r.from || d >= r.from) && (!r.to || d <= r.to); });
  const orderValueSum = sum(os, orderValue);
  const drivers = Repo.all('drivers').filter(d => !f.driver || d.id === f.driver), couriers = Repo.all('couriers').filter(c => !f.courier || c.id === f.courier);
  const driverHeld = sum(drivers, d => Math.max(0, driverCash(d.id).outstanding));
  const courierOwed = sum(couriers, c => Math.max(0, courierSummary(c).gap));
  const counts = new Map(ORDER_STATUSES.map(s => [s, 0])); for (const o of os) counts.set(o.status, counts.get(o.status) + 1);
  const maxC = Math.max(1, ...counts.values());
  const { list, size } = trendBuckets(r), rows = ledger();
  const series = [['revenue', 'Recognized revenue', 'Revenue'], ['collected', 'Customer payments collected', 'Collected'], ['bizcash', 'Cash received by the business', 'Biz cash']].map(([acct, name, short]) => {
    const values = list.map(() => 0);
    for (const e of rows) { if (e.acct !== acct || (set && !set.has(e.orderId))) continue; if (e.d < list[0].from || e.d > list.at(-1).to) continue; const i = Math.floor(Math.round((new Date(e.d) - new Date(list[0].from)) / 864e5) / size); if (i < values.length) values[i] += e.amt; }
    return { name, short, values: values.map(round2) };
  });
  const perf = [...Repo.all('couriers').map(c => ({ name: c.name, key: carrierKey('courier', c.id), type: 'Courier', href: '' })), ...Repo.all('drivers').map(d => ({ name: d.name, key: carrierKey('driver', d.id), type: 'Driver', href: `#/drivers/${d.id}` }))].filter(p => (!f.courier || p.key === carrierKey('courier', f.courier)) && (!f.driver || p.key === carrierKey('driver', f.driver))).map(p => {
    const ds = Repo.by('deliveries', 'carrierKey', p.key).filter(d => d.pickedUpAt && d.status !== 'Handed Over' && (!r.from || dateKey(d.pickedUpAt) >= r.from) && (!r.to || dateKey(d.pickedUpAt) <= r.to)), fin = ds.filter(d => d.completedAt || d.status === 'Returned to Warehouse' || d.status === 'Return in Transit');
    const done = ds.filter(d => d.completedAt).length, back = ds.filter(d => !d.completedAt && (d.status === 'Returned to Warehouse' || d.status === 'Return in Transit')).length;
    return { ...p, sent: ds.length, closed: fin.length, done, back, failedAttempts: ds.reduce((n, d) => n + d.attempts.filter(a => a.outcome === 'Failed').length, 0), rate: fin.length ? done / fin.length : null };
  }).filter(p => p.sent);
  const low = [...Repo.all('skus').filter(s => availableOf(s.id) < s.min).map(s => ({ id: s.id, label: `${s.name} · ${s.variant}`, sub: `${availableOf(s.id)} available, reorder at ${s.min}` })), ...Repo.all('materials').filter(x => stockOnHand(x.id) < x.min).map(x => ({ id: x.id, label: x.name, sub: `${stockOnHand(x.id)} ${x.unit} on hand, reorder at ${x.min}` }))];
  const allO = Repo.all('orders');
  const queue = (label, n, action, arg) => `<button type="button" class="queue" ${act(action, arg)}><span>${label}</span><strong>${n.toLocaleString('en-US')}</strong></button>`;
  const overdue = Repo.all('deliveries').filter(isOverdue);
  const openCases = Repo.all('cases').filter(c => !['Closed', 'Rejected'].includes(c.status)).length;
  const openDisc = Repo.all('discrepancies').filter(x => x.status === 'Open');
  const pendingExp = Repo.all('driverExpenses').filter(x => x.status === 'Pending').length;
  const ret = Repo.all('deliveries').filter(d => d.status === 'Return in Transit' || (d.status === 'Partially Delivered')).length;
  return heading('Overview', `${esc(S().company)} · figures for ${rangeLabel(r)}. Filters on campaign, product or carrier limit figures to matching orders.`, btn('+ New order', 'newOrder', undefined, { cls: 'primary' }))
    + `<div class="filterbar">${sel('ov.preset', 'Period', PRESETS)}${f.preset === 'custom' ? dateF('ov.from', 'From') + dateF('ov.to', 'To') : ''}${sel('ov.campaign', 'Campaign', campaignOptions())}${sel('ov.sku', 'Product', [['', 'All products'], ...Repo.all('skus').map(s => [s.id, `${s.id} · ${s.name}`])])}${sel('ov.courier', 'Courier', courierOptions())}${sel('ov.driver', 'Private driver', driverOptions())}${(f.campaign || f.sku || f.courier || f.driver) ? btn('Clear filters', 'clearOv', undefined, { cls: 'ghost' }) : ''}</div>`
    + `<section class="panel"><div class="panel-head"><h2>Sales, revenue and cash are different numbers</h2></div><div class="kpi-grid k4">
      ${kpi('Order value', m(orderValueSum), `${os.length.toLocaleString('en-US')} orders placed in the period, not revenue`, { icon: 'bag', a: 'goOrders', v: { from: r.from, to: r.to, campaign: f.campaign }, help: 'Sum of order totals by order date, including orders not yet delivered.' })}
      ${kpi('Recognized revenue', m(t.revenue), 'Delivered, retained items, by delivery date', { icon: 'finance', a: 'goFinance', v: ['Profit & loss'], help: 'Delivered units net of discounts and accepted returns, plus delivery fees charged.' })}
      ${kpi('Customer payments collected', m(t.collected), 'By payment date, net of refunds', { icon: 'hand', a: 'goFinance', v: ['Customer collections'], help: 'Everything customers paid: to drivers, couriers or the business.' })}
      ${kpi('Cash received by the business', m(t.bizcash), 'Direct receipts, handovers, net settlements', { icon: 'money', a: 'goFinance', v: ['Business cash & refunds'], help: 'Excludes money still with drivers or couriers.' })}
    </div></section>`
    + `<div class="grid equal"><section class="panel"><div class="panel-head"><h2>Money still outside the business</h2><span class="muted small">As of now, not period-filtered</span></div><div class="kpi-grid k2">
      ${kpi('Outstanding courier settlements', m(courierOwed), 'Expected net less actual received', { icon: 'shipping', a: 'goFinance', v: ['Courier reconciliation'] })}
      ${kpi('Driver-held cash', m(driverHeld), 'Collected − handed over − approved cash expenses − cash refunds', { icon: 'hand', a: 'goFinance', v: ['Driver reconciliation'] })}
    </div></section><section class="panel"><div class="panel-head"><h2>Action queues</h2><span class="muted small">Live, not period-filtered</span></div><div class="queues">
      ${queue('New orders to confirm', Repo.count('orders', 'status', 'New'), 'goOrders', { status: 'New' })}
      ${queue('Ready, no carrier yet', allO.filter(o => o.status === 'Ready' && !activeDelivery(o)).length, 'goOrders', { status: 'Ready', exception: 'No carrier' })}
      ${queue('Failed deliveries to follow up', Repo.count('orders', 'status', 'Failed Delivery'), 'goShip', 'Failed follow-up')}
      ${queue('Overdue delivery updates', overdue.length, 'goOrders', { exception: 'Overdue' })}
      ${queue('Parcels to bring back', ret, 'goShip', 'Failed follow-up')}
      ${queue('Open returns and exchanges', openCases, 'goShip', 'Returns & exchanges')}
      ${queue('Refund reviews', allO.filter(o => paymentStatus(o) === 'Refund review').length, 'goOrders', { exception: 'Refund review' })}
      ${queue('Open discrepancies', openDisc.length, 'goFinance', ['Driver reconciliation'])}
      ${queue('Driver expenses to approve', pendingExp, 'goFinance', ['Driver reconciliation'])}
    </div></section></div>`
    + `<div class="grid cols">${card('Revenue and collection trend', pad(lineChart('trend', list, series, 'EGP') + `<p class="inlinehelp">${size === 1 ? 'Daily' : size === 7 ? 'Weekly' : 'Monthly'} totals. Revenue is dated by delivery and accepted return. Customer payments by the day the customer paid. Business cash by the day money reached the business.</p>`), '', '')}
      ${card('Order lifecycle', pad(`<div class="bars">${[...counts].filter(([, n]) => n).map(([s, n]) => `<button type="button" class="barrow" ${act('goOrders', { status: s, from: r.from, to: r.to })} title="${n} ${esc(s)}"><span>${esc(s)}</span><i><u style="width:${n / maxC * 100}%"></u></i><strong>${n}</strong></button>`).join('') || '<p class="empty">No orders in this period.</p>'}</div>`), `${os.length.toLocaleString('en-US')} orders by current status, placed in the period`)}</div>`
    + `<div class="grid cols">${card('Delivery performance', simpleTable(['Carrier', 'Type', 'Dispatched', 'Delivered', 'Returned undelivered', 'Failed attempts', 'Success rate'], perf.map(p => `<tr><td>${p.href ? `<a class="link" href="${p.href}">${esc(p.name)}</a>` : esc(p.name)}</td><td>${p.type}</td><td>${p.sent}</td><td>${p.done}</td><td>${p.back}</td><td>${p.failedAttempts}</td><td>${p.rate === null ? '<span class="muted">No closed deliveries</span>' : Math.round(p.rate * 100) + '%'}</td></tr>`), 'No dispatches in this period.'), `Deliveries picked up in the period. Success rate = delivered ÷ deliveries that reached a final outcome. Customer return rate: ${returnRate(os)}.`)}
      ${card('Low stock', pad(low.length ? low.map(x => `<div class="row"><span><a class="link" href="#/inventory">${esc(x.label)}</a><br><small>${esc(x.sub)}</small></span>${badge('Low stock')}</div>`).join('') : '<p class="empty">All stock is above its reorder threshold.</p>'), 'Available = on hand − reserved')}</div>`
    + `<div class="grid cols">${!Session.seesCosts ? '' : card('Profit summary', pad(`${row('Recognized revenue', m(t.revenue))}${row('Cost of goods sold', m(-t.cogs))}${row('Gross profit', m(t.gross), 'sub')}${row('Delivery and return costs', m(-t.delivery))}${row('Payment and COD fees', m(-t.fees))}${scoped ? `<p class="inlinehelp">Marketing, operating expenses and profit are company-wide, so they are hidden while filtering by campaign, product or carrier. Clear the filters to see them.</p>` : `${row('Marketing spend', m(-t.marketing))}${row('Operating expenses', m(-t.opex - t.driverexp))}${row('Operating profit before tax', m(t.profit), 'total')}`}`), 'Accrual view, dated by when each item occurred', btn('Open P&L →', 'goFinance', ['Profit & loss'], { cls: 'ghost' }))}
      ${card('Operational exceptions', pad(exceptionsList(allO)), 'Newest first, click through to the record')}</div>`;
}
function returnRate(os) { let delivered = 0, ret = 0; for (const o of os) for (const l of linesOf(o)) { delivered += l.delivered; ret += l.returned; } return delivered ? `${(ret / delivered * 100).toFixed(1)}% of delivered units (${ret} of ${delivered})` : 'no delivered units yet'; }
function exceptionsList(allO) {
  const rows = [];
  for (const o of allO) { const fl = orderFlags(o).filter(x => x !== 'No carrier'); if (fl.length) rows.push({ o, fl }); }
  rows.sort((a, b) => b.o.at.localeCompare(a.o.at));
  return rows.slice(0, 6).map(({ o, fl }) => `<div class="row"><span>${orderA(o.id)} · ${esc(customerOf(o).name)}</span><span class="tags">${fl.map(x => `<span class="flag">${esc(x)}</span>`).join('')}</span></div>`).join('') + (rows.length > 6 ? `<p class="inlinehelp">${rows.length - 6} more. ${btn('See failed deliveries in Orders →', 'goOrders', { exception: 'Failed delivery' }, { cls: 'link' })}</p>` : '') || '<p class="empty">No open exceptions.</p>';
}

/* ---------- Orders ---------- */
function ordersView() {
  const list = filteredOrders(), f = ui.orders, hasF = Object.entries(f).some(([, v]) => v), selN = [...ui.selected].filter(id => Repo.get('orders', id)).length;
  const cols = [
    { k: 'sel', label: (shown) => `<input type="checkbox" aria-label="Select all orders on this page" data-selall="${esc(JSON.stringify(shown.map(o => o.id)))}" ${shown.length && shown.every(o => ui.selected.has(o.id)) ? 'checked' : ''}>`, render: o => `<input type="checkbox" aria-label="Select order ${o.id}" data-sel="${o.id}" ${ui.selected.has(o.id) ? 'checked' : ''}>` },
    { k: 'id', label: 'Order', sort: o => o.id, render: o => `${orderA(o.id)}<br><small>${fd(o.at)}</small>` },
    { k: 'cust', label: 'Customer', sort: o => customerOf(o).name, render: o => { const c = customerOf(o); return `${custA(c)}<br><small>${esc(o.area)}</small>`; } },
    { k: 'items', label: 'Items', render: o => { const ls = linesOf(o); return `${esc(ls[0].name)} × ${ls[0].qty}${ls.length > 1 ? `<br><small>+${ls.length - 1} more line${ls.length > 2 ? 's' : ''}</small>` : `<br><small>${esc(ls[0].sku)}</small>`}`; } },
    { k: 'ch', label: 'Channel / entry / campaign', sort: o => o.channel, render: o => `${esc(o.channel)} <small>· ${esc(o.source)} entry</small><br><small>${o.campaignId ? esc(Repo.get('campaigns', o.campaignId)?.name) : 'Unattributed'}</small>` },
    { k: 'st', label: 'Order status', sort: o => o.status, render: o => badge(o.status) },
    { k: 'del', label: 'Delivery', render: o => { const d = latestDelivery(o); return d ? `${badge(d.status)}<br><small>${d.mode === 'driver' ? driverA(d.carrierId) : esc(carrierName(d))}</small>` : '<span class="muted">Unassigned</span>'; } },
    { k: 'pay', label: 'Payment / settlement', render: o => { const s = settlementStatus(o); return `${badge(paymentStatus(o))}<br>${s === 'None' ? '<small>No carrier money</small>' : badge(s)}`; } },
    { k: 'val', label: 'Value', num: true, sort: o => orderValue(o), render: o => m(orderValue(o)) },
    { k: 'con', cost: true, label: 'Contribution', num: true, sort: o => contributionOf(o), render: o => { const n = contributionOf(o); return `<span class="${n < 0 ? 'negative' : ''}">${m(n)}</span>`; } },
    { k: 'fl', label: 'Flags', wrap: true, render: o => orderFlags(o).map(x => `<span class="flag">${esc(x)}</span>`).join(' ') },
  ];
  return heading('Orders', 'One record for every order, however it was entered. Entry method and sales channel are tracked separately.', `${btn('↓ Export filtered CSV', 'exportOrders')}${btn('Import CSV', 'importModal')}${btn('+ New order', 'newOrder', undefined, { cls: 'primary' })}`)
    + `<div class="kpi-grid k4 mb">${kpi('Orders shown', list.length.toLocaleString('en-US'), `of ${Repo.all('orders').length.toLocaleString('en-US')} in the workspace`)}${kpi('Order value shown', m(sum(list, orderValue)), 'Not revenue until delivered')}${kpi('Recognized revenue', m(sum(list, o => calc(o).revenue)), 'From these orders')}${Session.seesCosts ? kpi('Contribution', m(sum(list, contributionOf)), 'Before company overhead') : ''}</div>`
    + `<section class="card"><div class="filters">${search('orders.q', 'Search order, name, phone, SKU…', 'orders')}${dateF('orders.from', 'From', 'orders')}${dateF('orders.to', 'To', 'orders')}${sel('orders.status', 'Order status', [['', 'All'], ...ORDER_STATUSES], 'orders')}${sel('orders.delivery', 'Delivery status', [['', 'All'], 'Unassigned', ...DELIVERY_STATUSES], 'orders')}${sel('orders.collection', 'Collection', [['', 'All'], ...COLLECTION_OUTCOMES], 'orders')}${sel('orders.channel', 'Channel', [['', 'All'], ...CHANNELS], 'orders')}${sel('orders.source', 'Entry method', [['', 'All'], 'Manual', 'CSV'], 'orders')}${sel('orders.campaign', 'Campaign', campaignOptions(), 'orders')}${sel('orders.method', 'Fulfillment', [['', 'All'], ['courier', 'External courier'], ['driver', 'Private delivery']], 'orders')}${sel('orders.courier', 'Courier', courierOptions(), 'orders')}${sel('orders.driver', 'Private driver', driverOptions(), 'orders')}${sel('orders.exception', 'Exception', [['', 'All'], ...FLAG_LIST], 'orders')}${hasF ? btn('Clear', 'clearOrders', undefined, { cls: 'ghost' }) : ''}</div>
    <div class="bulk"><strong>${selN} selected</strong>${btn('Confirm', 'bulkConfirm', undefined, { why: selN ? '' : 'Select one or more orders first.' })}${btn('Advance to next step', 'bulkAdvance', undefined, { why: selN ? '' : 'Select one or more orders first.' })}${btn('Assign delivery', 'bulkAssign', undefined, { why: selN ? '' : 'Select one or more orders first.' })}${selN ? btn('Clear selection', 'clearSelection', undefined, { cls: 'ghost' }) : ''}<span class="muted small">Invalid orders are skipped and reported individually.</span></div>
    ${grid('orders', list, cols, { sort: 'id', dir: -1, empty: hasF ? 'No orders match these filters. Clear a filter to widen the search.' : 'No orders yet. Create one or import a CSV.' })}</section>`;
}

/* ---------- Order 360 ---------- */
function orderActionsList(o) {
  const a = activeDelivery(o), fulfil = a ? deliveryActions(a) : [];
  return [
    { label: 'Confirm and reserve stock', name: 'confirmOrder', arg: o.id, why: Guards.confirm(o), primary: 1 },
    { label: 'Start processing', name: 'advance', arg: [o.id, 'Processing'], why: Guards.process(o), primary: 1 },
    { label: 'Mark ready', name: 'advance', arg: [o.id, 'Ready'], why: Guards.ready(o), primary: 1 },
    { label: 'Assign delivery', name: 'assignModal', arg: [o.id], why: Guards.assign(o) },
    ...fulfil,
    { label: 'Record direct payment', name: 'prepayModal', arg: o.id, why: o.status === 'Cancelled' ? 'A cancelled order cannot take payments.' : round2(calc(o).value - calc(o).paid) <= 0 ? 'The order is already fully paid.' : null },
    { label: 'Refund', name: 'refundModal', arg: o.id, why: Guards.refund(o) },
    { label: 'Open return', name: 'caseModal', arg: [o.id, 'Return'], why: Guards.returnCase(o) },
    { label: 'Open exchange', name: 'caseModal', arg: [o.id, 'Exchange'], why: Guards.returnCase(o) },
    { label: 'Cancel order', name: 'cancelModal', arg: o.id, why: Guards.cancel(o), cls: 'danger' },
  ];
}
function order360() {
  const id = ui.route.id ?? ui.lastOrder ?? Repo.all('orders').at(-1)?.id, o = orderOf(Number(id));
  if (!o) return heading('Order 360', '') + `<div class="card"><p class="empty">Order not found. <a class="link" href="#/orders">Back to orders</a></p></div>`;
  ui.lastOrder = o.id;
  const c = customerOf(o), ls = linesOf(o), ca = calc(o), ds = deliveriesOf(o), pays = paymentsOf(o).sort((a, b) => a.at.localeCompare(b.at)), cases = casesOf(o);
  const alloc = allocationOf(o), contr = contributionOf(o), acts = orderActionsList(o), on = acts.filter(x => !x.why), off = acts.filter(x => x.why);
  const seq = ['New', 'Confirmed', 'Processing', 'Ready', 'Shipped', 'Delivered'], idx = seq.indexOf(o.status === 'Failed Delivery' ? 'Shipped' : ['Partially Delivered', 'Partially Returned', 'Returned'].includes(o.status) && ca.deliveredAny ? 'Delivered' : o.status);
  const handed = Repo.by('handoverAllocs', 'orderId', o.id), settled = Repo.by('settlementAllocs', 'orderId', o.id);
  const remitted = ca.bizcash, expected = ca.deliveredAny || ['Cancelled', 'Returned'].includes(o.status) ? ca.revenue : ca.value;
  const ents = acct => ca.entries.filter(e => e.acct === acct);
  const camp = Repo.get('campaigns', o.campaignId), camOrders = camp ? Repo.by('orders', 'campaignId', camp.id).filter(x => x.status !== 'Cancelled').length : 0;
  const related = Repo.all('orders').length < 20000 && o.relatedOrderId ? orderOf(o.relatedOrderId) : null;
  const delSteps = d => `<details class="delivery"><summary><span>${delA(d)} · ${carrierName(d) && (d.mode === 'driver' ? 'Private driver' : 'External courier')} ${esc(carrierName(d))}</span>${badge(d.status)}</summary><div class="timeline tight">${[...d.history].reverse().map(h => `<div class="event"><strong>${esc(h.status)}</strong>${h.note ? ` <span class="muted">${esc(h.note)}</span>` : ''}<p>${fdt(h.at)} · ${esc(h.by)}</p></div>`).join('')}</div></details>`;
  return heading(`Order #${o.id}`, `${fd(o.at)} · ${esc(o.channel)} channel · ${esc(o.source)} entry · ${esc(o.paymentMethod)}${o.externalRef ? ' · Ref ' + esc(o.externalRef) : ''}${related ? ` · Related to ${orderA(related.id)}` : ''}`, on.slice(0, 5).map(x => btn(x.label, x.name, x.arg, { cls: x.primary ? 'primary' : x.cls || '' })).join(''), `<a href="#/orders">Orders</a> / #${o.id}`)
    + `${on.length > 5 ? `<div class="actions mb">${on.slice(5).map(x => btn(x.label, x.name, x.arg, { cls: x.cls || '' })).join('')}</div>` : ''}${off.length ? `<details class="whynot mb"><summary>Why ${off.length} other action${off.length > 1 ? 's are' : ' is'} unavailable</summary><ul>${off.map(x => `<li><strong>${esc(x.label)}:</strong> ${esc(x.why)}</li>`).join('')}</ul></details>` : ''}`
    + `<div class="stepper">${seq.map((s, i) => `<div class="step ${o.status !== 'Cancelled' && i === idx ? 'current' : i > idx || o.status === 'Cancelled' ? 'future' : ''}">${s}</div>`).join('')}</div>`
    + (!seq.includes(o.status) ? note(`Current state: ${badge(o.status)} ${o.status === 'Failed Delivery' ? 'The parcel stays in carrier custody until a physical handover is recorded.' : ''}`, 'warning') : '')
    + `<div class="kpi-grid k4 mb">${kpi('Order status', badge(o.status), 'Fulfillment progress')}${kpi('Delivery status', ds.length ? badge(ds.at(-1).status) : '<span class="muted">Unassigned</span>', ds.length ? carrierA(ds.at(-1)) : 'No carrier yet')}${kpi('Customer payment', badge(paymentStatus(o)), `${m(ca.paid)} paid of ${m(expected)}`)}${kpi('Carrier settlement', badge(settlementStatus(o)), 'Whether money reached the business')}</div>`
    + `<div class="grid cols"><div class="grid stack">`
    + card('Line items', simpleTable(['Product', 'Qty', 'Unit price', 'Line discount', 'Net unit', ...(Session.seesCosts ? ['COGS snapshot'] : []), 'Reserved', 'Dispatched', 'Delivered', 'Returned'], ls.map(l => `<tr><td>${esc(l.name)}<br><small>${esc(l.variant)} · ${esc(l.sku)}</small></td><td>${l.qty}</td><td>${m(l.price)}</td><td>${m(l.discount)}</td><td>${m(netUnit(l, o))}</td>${Session.seesCosts ? `<td>${m(l.unitCost)}</td>` : ''}<td>${l.reserved}</td><td>${l.dispatched}</td><td>${l.delivered}</td><td>${l.returned}${l.pendingReturn ? ` <small>(+${l.pendingReturn} pending)</small>` : ''}</td></tr>`)) + pad(`${row('Order discount', m(-o.discount))}${row('Delivery fee charged', m(o.deliveryFee))}${row('Order total', m(ca.value), 'total')}<p class="inlinehelp">${Session.seesCosts ? 'Price and COGS are snapshots' : 'Prices are snapshots'} from order creation. Later price or BOM changes do not alter this order. Order discount is shared across lines by value.</p>`), 'Item-level quantities drive revenue, returns and stock')
    + card('Expected, collected, remitted', pad(`<div class="triad"><div><small>Expected from customer</small><strong>${m(expected)}</strong></div><div><small>Collected from customer</small><strong>${m(ca.collected)}</strong></div><div><small>Reached the business</small><strong>${m(remitted)}</strong></div></div>
      ${expl('Expected from customer', m(expected), ca.deliveredAny || ['Cancelled', 'Returned'].includes(o.status) ? 'Recognized revenue on this order: what the customer owes for items delivered and kept.' : 'The order total, since nothing has been delivered yet.')}
      ${expl('Collected from customer', m(ca.collected), 'All customer payments on this order, less refunds, whoever is holding the money.', ents('collected'))}
      ${expl('Reached the business', m(remitted), 'Direct receipts (net of gateway fees), driver handovers and courier net settlements, less refunds paid by the business. Courier charges are already netted out of settlements.', ents('bizcash'))}`), 'Three different questions about the same money')
    + (!Session.seesCosts ? '' : card('Profitability', pad(`${expl('Recognized revenue', m(ca.revenue), 'Delivered units × net unit price, plus delivery fee, less accepted returns. Dated by delivery. Payments do not create revenue.', ents('revenue'))}
      ${expl('Cost of goods sold', m(-ca.cogs), 'Delivered units at the COGS snapshot. Accepted resellable returns reverse it.', ents('cogs'))}
      ${expl('Delivery and return costs', m(-ca.delivery), 'Incurred when a parcel leaves or comes back, even if delivery failed.', ents('delivery'))}
      ${expl('Payment and COD fees', m(-ca.fees), 'Courier COD fees and card gateway fees.', ents('fees'))}
      ${expl('Marketing allocation', m(-alloc), camp ? (S().allocationPolicy === 'value' ? `${esc(camp.name)} spend of ${m(campaignSpend(camp))} shared by order value across attributed non-cancelled orders.` : `${esc(camp.name)} spend of ${m(campaignSpend(camp))} ÷ ${camOrders} attributed non-cancelled orders.`) : 'No campaign is attributed, so no marketing cost is allocated.')}
      ${row('Order contribution', `<span class="${contr < 0 ? 'negative' : ''}">${m(contr)}</span>`, 'total')}<p class="inlinehelp">Contribution is before company overhead. Operating profit appears in Finance. Tap any line to see the working.</p>`), 'Each figure opens to show its calculation'))
    + card('Customer payment history', simpleTable(['Date', 'Reference', 'Kind', 'Method', 'Held by', 'Amount'], pays.map(p => `<tr><td>${fdt(p.at)}</td><td>${esc(p.ref)}</td><td>${p.kind === 'refund' ? 'Refund' : 'Collection'}</td><td>${esc(p.method)}</td><td>${holderLabel(p)}</td><td class="${p.amount < 0 ? 'negative' : ''}">${m(p.amount)}</td></tr>`), 'No customer payments recorded.'))
    + card('Carrier money', simpleTable(['Date', 'Reference', 'Type', 'Delivery', 'Amount'], [...handed.map(a => { const h = Repo.get('handovers', a.handoverId); return `<tr><td>${fd(h.at)}</td><td>${esc(h.ref)}</td><td>Driver cash handover · ${driverA(h.driverId)}</td><td>${esc(a.deliveryId)}</td><td>${m(a.amount)}</td></tr>`; }), ...settled.map(a => { const s = Repo.get('settlements', a.settlementId); return `<tr><td>${fd(s.at)}</td><td>${esc(s.ref)}</td><td>Courier settlement · ${esc(Repo.get('couriers', s.courierId).name)}</td><td>${esc(a.deliveryId)}</td><td>${m(a.net)}</td></tr>`; })], 'No handovers or settlements on this order.'), 'Moves custody of cash. Never creates revenue.')
    + (cases.length || ca.deliveredAny ? card('Returns and exchanges', simpleTable(['Case', 'Type', 'Items', 'Reason', 'Status', 'Actions'], cases.map(x => `<tr><td>${x.id}</td><td>${x.type}</td><td>${x.items.map(i => `${i.qty} × ${esc(Repo.get('lines', i.lineId).sku)}`).join(', ')}</td><td class="wrap">${esc(x.reason)}</td><td>${badge(x.status)}${x.replacementOrderId ? `<br><small>Replacement ${orderA(x.replacementOrderId)}</small>` : ''}</td><td>${caseButtons(x)}</td></tr>`), 'No return or exchange cases.'), 'Accepting a return reverses revenue and COGS and restocks. A cash refund is a separate step.') : '')
    + `</div><div class="grid stack">`
    + card('Customer', pad(`<div class="profile"><span class="avatar">${esc(initials(c.name))}</span><div><h3>${custA(c)}</h3><small>${esc(c.phone)}</small></div></div><p class="subtitle">${esc(o.address)}</p>${o.instructions ? `<p class="subtitle"><strong>Instructions:</strong> ${esc(o.instructions)}</p>` : ''}<div class="tags">${customerTags(c).map(badge).join(' ')}</div>`))
    + card('Fulfillment', pad(`${ds.length ? `${row('Method', ds.at(-1).mode === 'driver' ? 'Private delivery' : 'External courier')}${row('Carrier', carrierA(ds.at(-1)))}${row('Parcel custody', custodyLabel(ds.at(-1).custody))}${ds.at(-1).tracking ? row('Tracking no.', esc(ds.at(-1).tracking)) : ''}` : '<p class="muted">No carrier assigned yet.</p>'}<h3 class="mt">Assignments and attempts</h3>${[...ds].reverse().map(delSteps).join('') || '<p class="muted">None yet.</p>'}`), `${ds.length} assignment${ds.length === 1 ? '' : 's'}, kept for history`)
    + card('Campaign attribution', pad(`${row('Campaign', camp ? `<a class="link" href="#/campaigns">${esc(camp.name)}</a>` : 'Unattributed')}${row('Marketing allocation', m(alloc))}${btn('Correct attribution', 'attributeModal', o.id)}`))
    + card('Internal notes', pad(`${o.notes.map(n => `<div class="note">${esc(n.text)}<br><small>${fdt(n.at)} · ${esc(n.by)}</small></div>`).join('') || '<p class="muted">No notes yet.</p>'}${btn('+ Add note', 'orderNoteModal', o.id)}`))
    + card('Activity history', pad(timeline(Repo.by('events', 'orderId', o.id).sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id))), 'Timestamps and operator for every change')
    + `</div></div>`;
}
function holderLabel(p) { if (p.holderKey === 'business') return 'Business'; if (p.holderKey === 'credit') return 'Non-cash credit'; const [t, id] = p.holderKey.split(':'); return t === 'driver' ? `Driver ${driverA(id)}` : `Courier ${esc(Repo.get('couriers', id)?.name)}`; }
function custodyLabel(k) { if (k === 'warehouse') return 'Warehouse'; if (k === 'customer') return 'With customer'; const [t, id] = k.split(':'); return t === 'driver' ? driverA(id) : esc(Repo.get('couriers', id)?.name || id); }
function caseButtons(x) {
  if (x.status === 'Requested') return btn('Accept item', 'acceptCase', x.id, { cls: 'small' }) + btn('Reject', 'rejectCaseModal', x.id, { cls: 'small' });
  if (x.type === 'Exchange' && x.status === 'Item received') return btn('Create replacement', 'replacementModal', x.id, { cls: 'small' });
  if (x.status === 'Accepted' || x.status === 'Replacement created' || x.status === 'Item received') return btn('Close case', 'closeCase', x.id, { cls: 'small' });
  return `<span class="muted">${esc(x.resolution || 'Done')}</span>`;
}

export { caseButtons, custodyLabel, exceptionsList, holderLabel, order360, orderActionsList, ordersView, overview, overviewOrderSet, returnRate, trendBuckets };
