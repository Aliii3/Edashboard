import { Session } from './api.js';
import { isAr } from './i18n.js';
import { Repo, esc, round2, sum } from '@commerce-os/domain';
import { ATTENDANCE_STATUSES, S, availableOf, bomCost, customerOf, dateKey, lateMinutes, netUnit, orderOf, productStats, reservedOf, stockOnHand } from '@commerce-os/domain';
import { act, badge, btn, card, custA, dayShift, fd, fdt, grid, heading, kpi, lineChart, m, note, orderA, pad, row, search, simpleTable, tabs, today, ui } from './ui-kit.js';
import { materialsCard, skuHealth } from './views-ops.js';
/* ==========================================================================
   LAYER 5 · VIEWS: Products (a profile per product, like customers) and
   Staff (daily attendance, the monthly sheet and employee profiles).
   ========================================================================== */

/* ---------- Products ---------- */
const pct = (a, b) => b ? `${(a / b * 100).toFixed(1)}%` : '—';
function productsView() {
  if (ui.route.id) return productProfile(ui.route.id);
  const q = ui.products.q.trim().toLowerCase(), skus = Repo.all('skus'), stats = new Map(skus.map(s => [s.id, productStats(s.id)]));
  const list = skus.filter(s => !q || `${s.id} ${s.name} ${s.variant}`.toLowerCase().includes(q));
  const t = { kept: 0, revenue: 0, delivered: 0, returned: 0 }; for (const x of stats.values()) for (const k in t) t[k] += x[k];
  const st = id => stats.get(id);
  return heading('Products', 'Sales, returns, customers and stock for every product, with a profile for each one.', btn('+ New item', 'newItemModal', undefined, { cls: 'primary' }))
    + `<div class="kpi-grid k4 mb">${kpi('Products', skus.length, 'SKUs, one per variant')}${kpi('Units sold', t.kept.toLocaleString('en-US'), 'Delivered and kept')}${kpi('Product revenue', m(t.revenue), 'After discounts, delivery fees excluded')}${kpi('Return rate', pct(t.returned, t.delivered), 'Returned ÷ delivered units')}</div>`
    + `<section class="card"><div class="filters">${search('products.q', 'Search product or SKU…', 'prods')}</div>${grid('prods', list, [
      { k: 'n', label: 'Product', sort: s => s.name, render: s => `<a class="link" href="#/products/${esc(s.id)}">${esc(s.name)}</a><br><small>${esc(s.variant)} · ${esc(s.id)}${Repo.get('boms', s.id)?.lines.length === 0 ? ' · <span>Bought ready-made</span>' : ''}</small>` },
      { k: 'u', label: 'Units sold', num: true, sort: s => st(s.id).kept, render: s => st(s.id).kept.toLocaleString('en-US') },
      { k: 'r', label: 'Revenue', num: true, sort: s => st(s.id).revenue, render: s => m(st(s.id).revenue) },
      { k: 'c', cost: true, label: 'Gross profit', num: true, sort: s => st(s.id).revenue - st(s.id).cogs, render: s => m(st(s.id).revenue - st(s.id).cogs) },
      { k: 'x', label: 'Return rate', num: true, sort: s => st(s.id).delivered ? st(s.id).returned / st(s.id).delivered : 0, render: s => pct(st(s.id).returned, st(s.id).delivered) },
      { k: 'a', label: 'Available', num: true, sort: s => availableOf(s.id), render: s => availableOf(s.id) },
      { k: 'l', label: 'Last ordered', sort: s => st(s.id).last, render: s => st(s.id).last ? fd(st(s.id).last) : '<span class="muted">Never</span>' },
      { k: 'h', label: 'Stock', sort: s => skuHealth(s), render: s => badge(skuHealth(s)) },
    ], { sort: 'r', empty: 'No products match. Try a different search.' })}</section><div class="sp"></div>${Session.canSee('inventory') ? materialsCard() : ''}`;
}
/* Twelve weeks ending today. */
function weekBuckets() {
  const from = dayShift(today(), -83), out = [];
  for (let k = 0; k < 12; k++) { const s = dayShift(from, 7 * k), e = dayShift(s, 6), f = x => fd(x + 'T12:00:00Z').slice(0, 6); out.push({ from: s, to: e, short: f(s), label: `${f(s)} to ${f(e)}` }); }
  return out;
}
/* Revenue from one product by week: delivered units at their net price, less accepted returns. */
function productSeries(sku, buckets) {
  const vals = buckets.map(() => 0), first = buckets[0].from, last = buckets.at(-1).to;
  const idx = iso => { const d = dateKey(iso); return d < first || d > last ? -1 : Math.floor(Math.round((new Date(d) - new Date(first)) / 864e5) / 7); };
  for (const l of Repo.by('lines', 'sku', sku)) {
    const o = orderOf(l.orderId); if (!o) continue; const u = netUnit(l, o);
    for (const d of Repo.by('deliveries', 'orderId', o.id)) if (d.completedAt) for (const it of d.items) if (it.lineId === l.id && it.delivered) { const i = idx(d.completedAt); if (i >= 0) vals[i] += it.delivered * u; }
    for (const c of Repo.by('cases', 'orderId', o.id)) if (c.acceptedAt) for (const it of c.items) if (it.lineId === l.id) { const i = idx(c.acceptedAt); if (i >= 0) vals[i] -= it.qty * u; }
  }
  return vals.map(round2);
}
function productProfile(id) {
  const s = Repo.get('skus', id); if (!s) return `<div class="card"><p class="empty">Product not found. <a class="link" href="#/products">Back to products</a></p></div>`;
  const st = productStats(id), on = stockOnHand(id), res = reservedOf(id), av = availableOf(id), prod = Repo.by('production', 'sku', id), wip = sum(prod.filter(p => p.status === 'WIP'), p => p.qty), planned = sum(prod.filter(p => p.status === 'Planned'), p => p.qty);
  const since = dayShift(today(), -29); let sold30 = 0;
  for (const l of Repo.by('lines', 'sku', id)) for (const d of Repo.by('deliveries', 'orderId', l.orderId)) if (d.completedAt && dateKey(d.completedAt) >= since) for (const it of d.items) if (it.lineId === l.id) sold30 += it.delivered;
  const cover = sold30 ? Math.floor(av / (sold30 / 30)) : null;
  const buckets = weekBuckets(), series = [{ name: 'Revenue from this product', short: 'Revenue', values: productSeries(id, buckets) }];
  const top = (map, n) => [...map].sort((a, b) => b[1].units - a[1].units).slice(0, n);
  const bars = (rows, label) => { const max = Math.max(1, ...rows.map(r => r[1].units)); return rows.length ? `<div class="bars">${rows.map(([k, v]) => `<div class="barrow"><span>${label(k)}</span><i><u style="width:${v.units / max * 100}%"></u></i><strong>${v.units}</strong></div>`).join('')}</div>` : '<p class="muted">No units sold yet.</p>'; };
  const cases = st.orders.flatMap(o => Repo.by('cases', 'orderId', o.id).flatMap(c => c.items.filter(i => Repo.get('lines', i.lineId)?.sku === id).map(i => ({ c, qty: i.qty })))).sort((a, b) => b.c.at.localeCompare(a.c.at));
  const moves = Repo.by('movements', 'item', id).sort((a, b) => b.at.localeCompare(a.at)).slice(0, 12);
  const lineOf = o => Repo.by('lines', 'orderId', o.id).find(l => l.sku === id);
  const cost = bomCost(id).total;
  return heading(esc(s.name), `${esc(s.variant)} · ${esc(s.id)} · ${m(s.price)}`, `${btn('Edit', 'skuModal', id)}${btn('Adjust stock', 'stockModal', ['sku', id])}${btn('+ Production order', 'productionModal', undefined, { cls: 'primary' })}`, `<a href="#/products">Products</a> / ${esc(s.id)}`)
    + `<div class="kpi-grid k4 mb">${kpi('Units sold', st.kept.toLocaleString('en-US'), `${st.delivered} delivered, ${st.returned} returned`)}${kpi('Revenue', m(st.revenue), 'After discounts, by delivery date')}${kpi('Return rate', pct(st.returned, st.delivered), 'Returned ÷ delivered units')}${kpi('Available now', av, `${on} on hand, ${res} reserved`, { cls: av < s.min ? 'hl' : '' })}</div>`
    + note(`<span>Figures cover sales recorded here.</span>${st.first ? ` <span>First order:</span> ${fd(st.first)}.` : ''} <span>Revenue counts units the customer kept, at the price after line and order discounts.</span>`)
    + `<div class="grid cols"><div class="grid stack">`
    + card('Revenue by week', pad(lineChart(`p-${id}`, buckets, series, 'EGP')), 'Last 12 weeks. Returns are taken off in the week they were accepted.')
    + card('Orders with this product', grid(`po-${id}`, st.orders, [
      { k: 'i', label: 'Order', sort: o => o.id, render: o => `${orderA(o.id)}<br><small>${fd(o.at)}</small>` },
      { k: 'c', label: 'Customer', render: o => custA(customerOf(o)) },
      { k: 'ch', label: 'Channel', render: o => esc(o.channel) },
      { k: 'q', label: 'Qty', num: true, render: o => lineOf(o)?.qty ?? 0 },
      { k: 'u', label: 'Net unit', num: true, render: o => { const l = lineOf(o); return l ? m(netUnit(l, o)) : '—'; } },
      { k: 's', label: 'Status', sort: o => o.status, render: o => badge(o.status) },
    ], { sort: 'i', size: 10, empty: 'No orders with this product yet.' }))
    + card('Returns and exchanges', simpleTable(['Case', 'Order', 'Units', 'Reason', 'Status'], cases.slice(0, 20).map(({ c, qty }) => `<tr><td>${esc(c.id)}<br><small>${fd(c.at)}</small></td><td>${orderA(c.orderId)}</td><td>${qty}</td><td class="wrap">${esc(c.reason)}</td><td>${badge(c.status)}</td></tr>`), 'No returns or exchanges for this product.'))
    + `</div><div class="grid stack">`
    + card('Stock', pad(`${row('On hand', on)}${row('Reserved for confirmed orders', res)}${row('Available', `<strong>${av}</strong>`)}${row('Reorder at', s.min)}${row('In production', `${wip} in progress · ${planned} planned`)}${row('Sold in the last 30 days', sold30)}${row('Days of stock left', cover === null ? '<span class="muted">No recent sales</span>' : `${cover} days`, 'total')}<p class="inlinehelp">Days left = available ÷ average daily units delivered over the last 30 days.</p>`), '', badge(skuHealth(s)))
    + (Session.seesCosts ? card('Price and margin', pad(`${row('Price', m(s.price))}${row('Standard unit cost', m(cost))}${row('Gross margin at list price', s.price ? `${Math.round((s.price - cost) / s.price * 100)}%` : '—')}${row('Gross profit on units sold', m(st.revenue - st.cogs), 'total')}<p class="inlinehelp">Gross profit uses each order's cost snapshot and the price actually paid.</p>`)) : '')
    + card('Top customers', pad(top(st.customers, 6).map(([cid, v]) => row(custA(Repo.get('customers', cid)), `${v.units} · ${m(v.revenue)}`)).join('') || '<p class="muted">No units sold yet.</p>'), 'By units kept')
    + card('Sales channels', pad(bars(top(st.channels, 8), k => esc(k))), 'Units kept, by channel')
    + card('Areas', pad(bars(top(st.areas, 8), k => esc(k))), 'Units kept, by delivery area')
    + card('Recent stock movements', simpleTable(['When', 'Movement', 'Qty', 'Reference'], moves.map(x => `<tr><td>${fdt(x.at)}</td><td>${esc(x.kind)}</td><td class="${x.qty < 0 ? 'negative' : 'positive'}">${x.qty > 0 ? '+' : ''}${x.qty}</td><td>${esc(x.ref)}</td></tr>`), 'No movements yet.'), '', btn('Journal', 'goInvJournal', id, { cls: 'small' }))
    + `</div></div>`;
}

/* ---------- Staff and attendance ---------- */
const attOf = (empId, date) => Repo.get('attendance', `ATT-${empId}-${date}`);
const isWork = s => s === 'Present' || s === 'Late';
function monthCounts(empId, mo) {
  const c = { Present: 0, Late: 0, Absent: 0, Leave: 0, 'Day off': 0, lateMin: 0 };
  for (const a of Repo.by('attendance', 'employeeId', empId)) if (a.date.startsWith(mo)) { c[a.status]++; c.lateMin += isWork(a.status) ? lateMinutes(a) : 0; }
  return c;
}
function staffView() {
  if (ui.route.id) return employeeProfile(ui.route.id);
  const body = { 'Today': attendanceDay, 'Monthly sheet': attendanceMonth, 'Employees': employeesList };
  if (!body[ui.staff.tab]) ui.staff.tab = 'Today';
  return heading('Staff and attendance', 'Who came in, who was late or absent, and the monthly sheet. Recorded by hand, nothing is tracked automatically.', btn('+ Employee', 'employeeModal', undefined, { cls: 'primary' }))
    + tabs('staff.tab', Object.keys(body)) + body[ui.staff.tab]();
}
function attendanceDay() {
  const date = ui.staff.date || today(), isToday = date === today(), can = Session.can('recordAttendance');
  const es = Repo.all('employees').filter(e => e.active !== false || attOf(e.id, date));
  const n = s => es.filter(e => attOf(e.id, date)?.status === s).length, none = es.filter(e => !attOf(e.id, date)).length;
  const statusBtns = e => { const r = attOf(e.id, date); return `<div class="seg att" role="group" aria-label="Attendance status">${ATTENDANCE_STATUSES.map(s => `<button type="button" class="${r?.status === s ? `on st-${s.replace(' ', '-').toLowerCase()}` : ''}" ${act('attSet', [e.id, s])} aria-pressed="${r?.status === s}" ${can ? '' : 'disabled'}>${s}</button>`).join('')}</div>`; };
  const time = (e, k) => { const r = attOf(e.id, date), on = r ? isWork(r.status) : true; return `<input type="time" class="tinput" value="${esc(r?.[k] || '')}" data-att-time="${esc(e.id)}" data-k="${k}" aria-label="${k === 'checkIn' ? 'Check in' : 'Check out'}: ${esc(e.name)}" ${can && on ? '' : 'disabled'}>`; };
  return `<div class="filterbar"><button type="button" class="ghost" ${act('staffDay', -1)} aria-label="Previous day">←</button><label class="fsel"><span>Day</span><input type="date" data-f="staff.date" value="${date}" max="${today()}"></label><button type="button" class="ghost" ${act('staffDay', 1)} aria-label="Next day" ${isToday ? 'disabled' : ''}>→</button>${isToday ? '' : btn('Today', 'staffDay', 0, { cls: 'ghost' })}<span class="muted small">${fd(date + 'T12:00:00Z')}</span></div>`
    + `<div class="kpi-grid k4 mb">${kpi('Present', n('Present'), `${n('Late')} late`)}${kpi('Absent', n('Absent'), 'Without leave')}${kpi('Leave or day off', n('Leave') + n('Day off'), `${n('Leave')} on leave`)}${kpi('Not recorded yet', none, `of ${es.length} employees`, { cls: none ? 'hl' : '' })}</div>`
    + (es.length ? '' : note('Add your employees first with <strong>+ Employee</strong>. Then mark attendance here each day.'))
    + card(isToday ? 'Today' : `Attendance for ${fd(date + 'T12:00:00Z')}`, grid('att', es, [
      { k: 'n', label: 'Employee', sort: e => e.name, render: e => `<a class="link" href="#/staff/${esc(e.id)}">${esc(e.name)}</a><br><small>${esc(e.jobTitle || '')}</small>` },
      { k: 'sh', label: 'Shift starts', render: e => esc(e.shiftStart || '—') },
      { k: 's', label: 'Status', render: statusBtns },
      { k: 'i', label: 'Check in', render: e => time(e, 'checkIn') },
      { k: 'o', label: 'Check out', render: e => { const r = attOf(e.id, date); return time(e, 'checkOut') + (isToday && can && r && isWork(r.status) && !r.checkOut ? ` ${btn('Now', 'attNow', [e.id], { cls: 'small' })}` : ''); } },
      { k: 'l', label: 'Late by', num: true, render: e => { const r = attOf(e.id, date), x = r && isWork(r.status) ? lateMinutes(r) : 0; return x ? `<span class="negative">${x} min</span>` : '<span class="muted">—</span>'; } },
      { k: 'x', label: '', render: e => { const r = attOf(e.id, date); return btn('Note', 'attendanceModal', [e.id, date], { cls: 'small' }) + (r ? btn('Clear', 'attRemove', r.id, { cls: 'small ghost' }) : ''); } },
    ], { sort: 'n', dir: 1, size: 50, empty: 'No employees yet.' }), 'Tap a status to save it. Present keeps the shift start as the check-in time unless they came earlier. Late records the time now.', btn('Mark everyone not recorded as present', 'attAllPresent', undefined, { why: none ? '' : 'Everyone already has attendance for this day.' }));
}
function attendanceMonth() {
  const mo = ui.staff.month || today().slice(0, 7), [y, mm] = mo.split('-').map(Number), days = new Date(Date.UTC(y, mm, 0)).getUTCDate(), t = today();
  const dates = Array.from({ length: days }, (_, i) => `${mo}-${String(i + 1).padStart(2, '0')}`);
  const es = Repo.all('employees').filter(e => e.active !== false || Repo.by('attendance', 'employeeId', e.id).some(a => a.date.startsWith(mo)));
  const CODE = isAr() ? { Present: 'ح', Late: 'ت', Absent: 'غ', Leave: 'إ', 'Day off': 'ر' } : { Present: 'P', Late: 'L', Absent: 'A', Leave: 'LV', 'Day off': 'off' };
  const wd = new Intl.DateTimeFormat(isAr() ? 'ar-EG' : 'en-GB', { weekday: 'narrow', timeZone: 'UTC' }), can = Session.can('recordAttendance');
  const cell = (e, d) => { const a = attOf(e.id, d); if (d > t) return '<td class="ac"></td>'; const label = a ? `${a.status}${a.checkIn ? ` ${a.checkIn}` : ''}${a.checkOut ? `–${a.checkOut}` : ''}` : 'Not recorded'; return `<td class="ac ${a ? `st-${a.status.replace(' ', '-').toLowerCase()}` : ''}" title="${esc(label)}">${can ? `<button type="button" class="acell" ${act('attendanceModal', [e.id, d])} data-no-i18n>${a ? CODE[a.status] : '·'}</button>` : `<span data-no-i18n>${a ? CODE[a.status] : '·'}</span>`}</td>`; };
  return `<div class="filterbar"><button type="button" class="ghost" ${act('staffMonth', -1)} aria-label="Previous month">←</button><label class="fsel"><span>Month</span><input type="month" data-f="staff.month" value="${mo}" max="${t.slice(0, 7)}"></label><button type="button" class="ghost" ${act('staffMonth', 1)} aria-label="Next month" ${mo >= t.slice(0, 7) ? 'disabled' : ''}>→</button><div class="spacer"></div>${btn('↓ Export month CSV', 'exportAttendance', mo)}</div>`
    + card(`Monthly sheet · ${esc(mo)}`, `<div class="tablewrap"><table class="sheet"><thead><tr><th scope="col">Employee</th>${dates.map(d => `<th scope="col" class="ac"><span>${Number(d.slice(8))}</span><small data-no-i18n>${esc(wd.format(new Date(d + 'T12:00:00Z')))}</small></th>`).join('')}<th scope="col" class="number">Present</th><th scope="col" class="number">Late</th><th scope="col" class="number">Absent</th><th scope="col" class="number">Leave</th><th scope="col" class="number">Day off</th><th scope="col" class="number">Late minutes</th></tr></thead><tbody>${es.map(e => { const c = monthCounts(e.id, mo); return `<tr><td><a class="link" href="#/staff/${esc(e.id)}">${esc(e.name)}</a></td>${dates.map(d => cell(e, d)).join('')}<td class="number">${c.Present + c.Late}</td><td class="number">${c.Late}</td><td class="number ${c.Absent ? 'negative' : ''}">${c.Absent}</td><td class="number">${c.Leave}</td><td class="number">${c['Day off']}</td><td class="number">${c.lateMin}</td></tr>`; }).join('') || `<tr><td colspan="${days + 7}" class="empty">No employees yet.</td></tr>`}</tbody></table></div>`
      + pad(`<p class="legend att-legend" data-no-i18n>${ATTENDANCE_STATUSES.map(s => `<span><b class="ac st-${s.replace(' ', '-').toLowerCase()}">${CODE[s]}</b> ${esc(isAr() ? { Present: 'حاضر', Late: 'متأخر', Absent: 'غائب', Leave: 'إجازة', 'Day off': 'راحة' }[s] : s)}</span>`).join('')}<span><b class="ac">·</b> ${isAr() ? 'لم يُسجَّل' : 'Not recorded'}</span></p><p class="inlinehelp">Present counts late days too. Tap a day to change it.</p>`), 'One row per employee, one column per day');
}
function employeesList() {
  const mo = today().slice(0, 7), q = (ui.staff.q || '').toLowerCase();
  const list = Repo.all('employees').filter(e => !q || `${e.name} ${e.jobTitle} ${e.phone}`.toLowerCase().includes(q));
  return `<section class="card"><div class="filters">${search('staff.q', 'Search name, job or phone…', 'emps')}</div>${grid('emps', list, [
    { k: 'n', label: 'Employee', sort: e => e.name, render: e => `<a class="link" href="#/staff/${esc(e.id)}">${esc(e.name)}</a><br><small>${esc(e.id)}</small>` },
    { k: 'j', label: 'Job title', sort: e => e.jobTitle || '', render: e => esc(e.jobTitle || '—') },
    { k: 'p', label: 'Mobile', render: e => esc(e.phone || '—') },
    { k: 's', label: 'Shift starts', render: e => esc(e.shiftStart || '—') },
    { k: 'm', label: 'This month: present / late / absent', render: e => { const c = monthCounts(e.id, mo); return `${c.Present + c.Late} / ${c.Late} / <span class="${c.Absent ? 'negative' : ''}">${c.Absent}</span>`; } },
    { k: 'a', label: 'State', sort: e => e.active === false ? 1 : 0, render: e => badge(e.active === false ? 'Inactive' : 'Active') },
    { k: 'x', label: '', render: e => btn('Edit', 'employeeModal', e.id, { cls: 'small' }) },
  ], { sort: 'n', dir: 1, empty: 'No employees yet. Add one with + Employee.' })}</section>`;
}
function employeeProfile(id) {
  const e = Repo.get('employees', id); if (!e) return `<div class="card"><p class="empty">Employee not found. <a class="link" href="#/staff">Back to staff</a></p></div>`;
  const mo = ui.staff.month || today().slice(0, 7), c = monthCounts(id, mo), recs = Repo.by('attendance', 'employeeId', id).sort((a, b) => b.date.localeCompare(a.date));
  const worked = recs.filter(a => a.date.startsWith(mo) && isWork(a.status) && a.checkIn && a.checkOut), mins = t => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  const hours = round2(sum(worked, a => (mins(a.checkOut) - mins(a.checkIn)) / 60));
  return heading(esc(e.name), `${esc(e.jobTitle || 'No job title')}${e.phone ? ` · ${esc(e.phone)}` : ''}${e.shiftStart ? ` · Shift starts ${esc(e.shiftStart)}` : ''}`, `${btn('Edit', 'employeeModal', id)}${btn('Record a day', 'attendanceModal', [id, today()], { cls: 'primary', why: e.active === false ? 'This employee is inactive.' : '' })}`, `<a href="#/staff">Staff</a> / ${esc(e.name)}`)
    + (e.active === false ? note('This employee is inactive. Their attendance history is kept.', 'warning') : '')
    + `<div class="filterbar"><button type="button" class="ghost" ${act('staffMonth', -1)} aria-label="Previous month">←</button><label class="fsel"><span>Month</span><input type="month" data-f="staff.month" value="${mo}" max="${today().slice(0, 7)}"></label><button type="button" class="ghost" ${act('staffMonth', 1)} aria-label="Next month" ${mo >= today().slice(0, 7) ? 'disabled' : ''}>→</button></div>`
    + `<div class="kpi-grid k4 mb">${kpi('Days present', c.Present + c.Late, `${hours} hours with check-in and check-out`)}${kpi('Late days', c.Late, `${c.lateMin} minutes late in total`)}${kpi('Absent', c.Absent, 'Without leave', { cls: c.Absent ? 'hl' : '' })}${kpi('Leave and days off', c.Leave + c['Day off'], `${c.Leave} leave · ${c['Day off']} days off`)}</div>`
    + `<div class="grid cols">${card('Attendance history', grid(`emp-${id}`, recs, [
      { k: 'd', label: 'Day', sort: a => a.date, render: a => esc(fd(a.date + 'T12:00:00Z')) },
      { k: 's', label: 'Status', sort: a => a.status, render: a => badge(a.status) },
      { k: 'i', label: 'Check in', render: a => esc(a.checkIn || '—') },
      { k: 'o', label: 'Check out', render: a => esc(a.checkOut || '—') },
      { k: 'l', label: 'Late by', num: true, render: a => { const x = isWork(a.status) ? lateMinutes(a) : 0; return x ? `${x} min` : '—'; } },
      { k: 'n', label: 'Note', wrap: true, render: a => esc(a.note || '') },
      { k: 'b', label: 'Recorded', render: a => `<small>${esc(a.by || '')}<br>${fdt(a.at)}</small>` },
      { k: 'x', label: '', render: a => btn('Edit', 'attendanceModal', [id, a.date], { cls: 'small' }) },
    ], { sort: 'd', size: 31, empty: 'No attendance recorded yet.' }), 'Newest first')}
    ${card('Details', pad(`${row('Job title', esc(e.jobTitle || '—'))}${row('Mobile', esc(e.phone || '—'))}${row('Shift starts', esc(e.shiftStart || '—'))}${row('State', badge(e.active === false ? 'Inactive' : 'Active'))}${e.note ? `<p class="subtitle">${esc(e.note)}</p>` : ''}<p class="inlinehelp">Workspace time zone: ${esc(S().timezone)}.</p>`))}</div>`;
}

export { attendanceDay, attendanceMonth, employeeProfile, employeesList, productProfile, productsView, staffView };
