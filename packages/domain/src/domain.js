import { Actor, Clock, Repo, fail, round2, sum } from './core.js';
/* ==========================================================================
   LAYER 2 · DOMAIN: definitions, money calculations and validated commands.
   Every mutation is a Commands.* call inside a transaction. Views never write
   to records. This is the seam a future server API would replace.
   ========================================================================== */
const ORDER_STATUSES = ['New', 'Confirmed', 'Processing', 'Ready', 'Shipped', 'Failed Delivery', 'Partially Delivered', 'Delivered', 'Partially Returned', 'Returned', 'Cancelled'];
const DELIVERY_STATUSES = ['Assigned', 'Picked Up', 'Out for Delivery', 'Delivered', 'Failed Attempt', 'Retry Scheduled', 'Partially Delivered', 'Return in Transit', 'Returned to Warehouse', 'Cancelled Assignment', 'Handed Over'];
const DELIVERY_FLOW = {
  'Assigned': ['Picked Up', 'Cancelled Assignment'],
  'Picked Up': ['Out for Delivery', 'Return in Transit', 'Handed Over'],
  'Out for Delivery': ['Delivered', 'Partially Delivered', 'Failed Attempt', 'Handed Over'],
  'Failed Attempt': ['Retry Scheduled', 'Return in Transit', 'Handed Over'],
  'Retry Scheduled': ['Out for Delivery', 'Return in Transit', 'Handed Over'],
  'Partially Delivered': ['Return in Transit'],
  'Return in Transit': ['Returned to Warehouse'],
  'Delivered': [], 'Returned to Warehouse': [], 'Cancelled Assignment': [], 'Handed Over': [],
};
const TERMINAL_DELIVERY = new Set(['Delivered', 'Returned to Warehouse', 'Cancelled Assignment', 'Handed Over']);
const ACTIVE_CUSTODY = new Set(['Picked Up', 'Out for Delivery', 'Failed Attempt', 'Retry Scheduled', 'Partially Delivered', 'Return in Transit']);
const PAYMENT_METHODS = ['Cash', 'InstaPay', 'Mobile wallet', 'Card', 'Bank transfer'];
const CHANNELS = ['Instagram', 'WhatsApp', 'Facebook', 'Phone', 'Website', 'Walk-in', 'Exchange'];
const ENTRY_METHODS = ['Manual', 'CSV', 'API (planned)'];
const FAILURE_REASONS = ['Customer unreachable', 'Customer refused', 'Wrong address', 'Rescheduled by customer', 'No cash available', 'Other'];
const RETURN_REASONS = ['Customer not available', 'Customer refused', 'Wrong or incomplete address', 'Customer cancelled', 'Damaged in transit', 'Other'];
const EXPENSE_CATS = ['Rent', 'Salaries', 'Utilities', 'Software', 'Packing labor', 'Other'];
const DRIVER_EXPENSE_CATS = ['Fuel', 'Parking', 'Toll', 'Maintenance', 'Delivery fee payout', 'Other'];
const AREAS = ['New Cairo', 'Maadi', 'Nasr City', 'Heliopolis', 'Zamalek', 'Dokki', 'Mohandessin', 'Giza', '6th of October', 'Sheikh Zayed', 'Alexandria', 'Mansoura'];
const DEFAULT_SETTINGS = {
  company: 'Nile Studio', currency: 'EGP', timezone: 'Africa/Cairo', tolerance: 5,
  overdueHours: 24, defaultFulfillment: 'driver', allocationPolicy: 'equal', pageSize: 25,
  driverFee: 45, returnFeeDriver: 0,
  sources: { 'Orders': 'Manual', 'Marketing spend': 'Manual', 'Courier updates': 'Manual', 'Customer payments': 'Manual' },
};
const S = () => Repo.data.settings;
const tol = () => Number(S().tolerance) || 0;
const carrierKey = (mode, id) => `${mode}:${id}`;

/* Date keys are computed in the workspace timezone and cached, since they are hot during aggregation. */
const _dk = new Map(); let _dkf = null, _dktz = null;
function dateKey(iso) {
  if (!iso) return '';
  let v = _dk.get(iso); if (v) return v;
  const tz = S()?.timezone || 'Africa/Cairo';
  if (_dktz !== tz) { _dkf = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }); _dktz = tz; _dk.clear(); }
  v = _dkf.format(new Date(iso)); if (_dk.size > 200000) _dk.clear(); _dk.set(iso, v); return v;
}
const activityBy = () => Actor.current || S().operator || 'System';
/* Closed books: nothing may be added, dated or removed on or before the locked date. */
const lockedThrough = () => S()?.lockedThrough || null;
function assertOpen(at, what) {
  const lock = lockedThrough(), d = dateKey(at || Clock.now());
  if (lock && d <= lock) fail(`${what} is dated ${d}, but the books are closed through ${lock}. Date it after ${lock}, or ask the owner to reopen that period.`);
}
function log(text, refs = {}) { Repo.insert('events', { id: Repo.nextId('EVT'), at: Clock.now(), by: refs.by || activityBy(), text, ...refs }); }

/* ---------- Lookups ---------- */
const orderOf = id => Repo.get('orders', id);
const linesOf = o => Repo.by('lines', 'orderId', o.id);
const deliveriesOf = o => Repo.by('deliveries', 'orderId', o.id).sort((a, b) => a.assignedAt.localeCompare(b.assignedAt));
const activeDelivery = o => Repo.by('deliveries', 'orderId', o.id).find(d => !TERMINAL_DELIVERY.has(d.status) );
const paymentsOf = o => Repo.by('payments', 'orderId', o.id);
const casesOf = o => Repo.by('cases', 'orderId', o.id);
const customerOf = o => Repo.get('customers', o.customerId);
const carrierName = d => d.mode === 'driver' ? (Repo.get('drivers', d.carrierId)?.name || d.carrierId) : (Repo.get('couriers', d.carrierId)?.name || d.carrierId);

/* ---------- Line and order value ---------- */
function orderMerch(o) { return sum(linesOf(o), l => l.qty * l.price - l.discount) - o.discount; }
function orderValue(o) { return round2(orderMerch(o) + (o.deliveryFee || 0)); }
/* Net price of one unit after line discount and its pro-rata share of the order discount. */
function netUnit(l, o) {
  const gross = sum(linesOf(o), x => x.qty * x.price - x.discount);
  const lineNet = l.qty * l.price - l.discount;
  const share = gross ? o.discount * lineNet / gross : 0;
  return (lineNet - share) / l.qty;
}

/* ---------- Dated financial entries, the single source for every money figure ----------
   acct: revenue | cogs | delivery | fees | collected | bizcash
   Revenue and COGS are dated when items are delivered or accepted back, never when cash moves. */
function orderEntries(o) {
  const out = [], push = (acct, at, amt, why, tag) => { if (amt) out.push({ acct, at, d: dateKey(at), amt: round2(amt), orderId: o.id, why, tag }); };
  const ls = linesOf(o), units = new Map(ls.map(l => [l.id, netUnit(l, o)])), byId = new Map(ls.map(l => [l.id, l]));
  let feeBooked = false;
  for (const d of Repo.by('deliveries', 'orderId', o.id)) {
    if (d.pickedUpAt && d.cost) push('delivery', d.pickedUpAt, d.cost, `Delivery cost ${d.id}`);
    if (d.returnedAt && d.returnCost && d.shippingPaidBy !== 'waived') push('delivery', d.returnedAt, d.returnCost, `Return-to-warehouse cost ${d.id}`);
    if (d.returnedAt && d.shippingPaidBy === 'waived' && d.pickedUpAt && d.cost) push('delivery', d.returnedAt, -d.cost, `Carrier waived the delivery cost on returned ${d.id}`);
    if (d.returnedAt && d.feeCharged) push('revenue', d.returnedAt, d.feeCharged, `Shipping fee charged to the customer on returned ${d.id}`, 'fee');
    if (d.completedAt) {
      for (const it of d.items) if (it.delivered) {
        const l = byId.get(it.lineId);
        push('revenue', d.completedAt, it.delivered * units.get(l.id), `${it.delivered} × ${l.sku} delivered`);
        push('cogs', d.completedAt, it.delivered * l.unitCost, `${it.delivered} × ${l.sku} at snapshot cost`);
      }
      if (!feeBooked && d.items.some(i => i.delivered) && o.deliveryFee) { push('revenue', d.completedAt, o.deliveryFee, 'Delivery fee charged to customer', 'fee'); feeBooked = true; }
      if (d.codFee) push('fees', d.completedAt, d.codFee, `COD fee ${d.id}`);
    }
  }
  for (const c of Repo.by('cases', 'orderId', o.id)) if (c.acceptedAt) {
    for (const it of c.items) {
      const l = byId.get(it.lineId);
      push('revenue', c.acceptedAt, -it.qty * units.get(l.id), `Return ${c.id}: ${it.qty} × ${l.sku}`);
      push('cogs', c.acceptedAt, -it.qty * l.unitCost, `Return ${c.id}: COGS reversed, item resellable`);
    }
    if (c.returnCost) push('delivery', c.acceptedAt, c.returnCost, `Return logistics ${c.id}`);
  }
  for (const p of Repo.by('payments', 'orderId', o.id)) {
    if (p.method === 'Exchange credit') continue;
    push('collected', p.at, p.amount, `${p.kind === 'refund' ? 'Refund' : 'Collection'} ${p.ref}`);
    if (p.holderKey === 'business') push('bizcash', p.at, p.amount - (p.fee || 0), `${p.kind === 'refund' ? 'Refund paid by business' : 'Direct receipt'} ${p.ref}`);
    if (p.fee) push('fees', p.at, p.fee, `Payment fee ${p.ref}`);
  }
  for (const a of Repo.by('handoverAllocs', 'orderId', o.id)) push('bizcash', Repo.get('handovers', a.handoverId).at, a.amount, `Driver handover ${Repo.get('handovers', a.handoverId).ref}`);
  for (const a of Repo.by('settlementAllocs', 'orderId', o.id)) push('bizcash', Repo.get('settlements', a.settlementId).at, a.net, `Courier settlement ${Repo.get('settlements', a.settlementId).ref}`);
  return out;
}

/* Per-order calculation, memoized until the next write. */
const _calc = { v: -1, m: new Map(), alloc: null };
function _fresh() { if (_calc.v !== Repo.version) { _calc.v = Repo.version; _calc.m.clear(); _calc.alloc = null; } }
function calc(o) {
  _fresh();
  let c = _calc.m.get(o.id); if (c) return c;
  c = { revenue: 0, cogs: 0, delivery: 0, fees: 0, collected: 0, bizcash: 0, entries: orderEntries(o) };
  for (const e of c.entries) c[e.acct] += e.amt;
  for (const k of ['revenue', 'cogs', 'delivery', 'fees', 'collected', 'bizcash']) c[k] = round2(c[k]);
  const credit = sum(paymentsOf(o).filter(p => p.method === 'Exchange credit'), p => p.amount);
  c.paid = round2(c.collected + credit);        // what the customer has settled, including exchange credit
  c.value = orderValue(o);
  c.deliveredAny = linesOf(o).some(l => l.delivered > 0);
  _calc.m.set(o.id, c); return c;
}
/* Marketing allocation. Equal per attributed non-cancelled order, or pro-rata to order value. */
function marketingAlloc() {
  _fresh(); if (_calc.alloc) return _calc.alloc;
  const m = new Map();
  for (const c of Repo.all('campaigns')) {
    const os = Repo.by('orders', 'campaignId', c.id).filter(o => o.status !== 'Cancelled'), total = campaignSpend(c);
    if (!os.length || !total) continue;
    if (S().allocationPolicy === 'value') {
      const base = os.reduce((s, o) => s + orderValue(o), 0) || 1;
      for (const o of os) m.set(o.id, total * orderValue(o) / base);
    } else for (const o of os) m.set(o.id, total / os.length);
  }
  return _calc.alloc = m;
}
const allocationOf = o => round2(marketingAlloc().get(o.id) || 0);
const contributionOf = o => { const c = calc(o); return round2(c.revenue - c.cogs - c.delivery - c.fees - allocationOf(o)); };
const campaignSpend = c => sum(Repo.by('spend', 'campaignId', c.id), s => s.amount);

/* ---------- Four separate statuses ---------- */
function paymentStatus(o) {
  const c = calc(o), due = c.revenue, paid = c.paid, t = tol();
  if (!c.deliveredAny && o.status !== 'Cancelled' && o.status !== 'Returned') return paid > 0 ? (paid >= c.value - t ? 'Prepaid' : 'Part-prepaid') : 'Not due';
  if (paid > due + t) return 'Refund review';
  if (due <= t && paid <= t) return 'Not due';
  if (paid >= due - t) return 'Paid';
  return paid > 0 ? 'Partially collected' : 'Unpaid';
}
/* Where the customer's money sits now. Separate from whether the customer paid. */
function settlementStatus(o) {
  const ds = Repo.by('deliveries', 'orderId', o.id), t = tol();
  const held = ds.filter(d => d.mode === 'driver');
  let driverHeld = 0, driverGot = 0;
  for (const p of paymentsOf(o)) if (p.holderKey.startsWith('driver:')) { driverGot += p.amount; }
  driverHeld = driverGot - sum(Repo.by('handoverAllocs', 'orderId', o.id), a => a.amount);
  const cs = ds.filter(d => d.mode === 'courier' && d.pickedUpAt);
  if (cs.length) {
    const b = cs.reduce((acc, d) => { const x = courierDeliveryBalance(d); acc.exp += x.expectedNet; acc.got += x.actual; acc.any += x.customer; return acc; }, { exp: 0, got: 0, any: 0 });
    if (Math.abs(b.exp - b.got) <= t && (b.got !== 0 || b.exp !== 0)) return 'Settled';
    const hasSettlement = Repo.count('settlementAllocs', 'orderId', o.id) > 0;
    if (!hasSettlement) return b.any > 0 ? 'Courier owes' : 'Charges pending';
    if (b.got > b.exp + t) return 'Overpaid';
    return 'Courier short-paid';
  }
  if (Math.abs(driverGot) <= t) return held.length ? 'No driver cash' : 'None';
  if (driverHeld <= t) return 'Handed over';
  return driverHeld < driverGot - t ? 'Part handed over' : 'Driver holds cash';
}
function collectionOutcome(o) {
  const ps = paymentStatus(o), ss = settlementStatus(o);
  if (ps === 'Refund review') return 'Refund review';
  if (Repo.by('discrepancies', 'orderId', o.id).some(x => x.status === 'Open')) return 'Discrepancy';
  if (ss === 'Overpaid') return 'Overpaid';
  if (ss === 'Courier short-paid') return 'Discrepancy';
  if (ps === 'Not due') return 'Not due';
  if (ps === 'Prepaid' || ps === 'Part-prepaid') return 'Pending';
  if (ps === 'Unpaid') return 'Pending';
  if (ps === 'Partially collected') return 'Partially collected';
  return ['Settled', 'Handed over', 'No driver cash', 'None', 'Charges pending'].includes(ss) ? 'Reconciled' : 'Pending';
}
const COLLECTION_OUTCOMES = ['Not due', 'Pending', 'Partially collected', 'Reconciled', 'Overpaid', 'Discrepancy', 'Refund review'];
const PAYMENT_STATUSES = ['Not due', 'Prepaid', 'Part-prepaid', 'Unpaid', 'Partially collected', 'Paid', 'Refund review'];

/* ---------- Inventory ---------- */
const stockOnHand = item => Repo.total('movements', 'item', 'qty', item);
const reservedOf = sku => Repo.total('lines', 'sku', 'reserved', sku);
const availableOf = sku => stockOnHand(sku) - reservedOf(sku);
/* The journal is the only way stock changes. A unique key blocks duplicate receipts and deductions. */
function postMovement({ item, itemType, qty, kind, key, ref, note }) {
  if (key && Repo.count('movements', 'key', key)) fail(`Duplicate stock movement blocked (${key}).`);
  const onHandBefore = stockOnHand(item);
  if (onHandBefore + qty < -1e-9) fail(`${item}: movement of ${qty} would take stock below zero (on hand ${onHandBefore}).`);
  Repo.insert('movements', { id: Repo.nextId('MV'), at: Clock.now(), item, itemType, qty: round2(qty), kind, key: key || null, ref: ref || '', note: note || '', by: activityBy() });
}
function bomCost(sku) {
  const b = Repo.get('boms', sku); if (!b) return { materials: 0, packaging: 0, labor: 0, overhead: 0, total: 0 };
  let materials = 0, packaging = 0;
  for (const x of b.lines) { const m = Repo.get('materials', x.material); const v = x.qty * m.cost; if (m.category === 'Packaging') packaging += v; else materials += v; }
  return { materials: round2(materials), packaging: round2(packaging), labor: b.labor, overhead: b.overhead, total: round2(materials + packaging + b.labor + b.overhead) };
}

/* ---------- Delivery money ---------- */
function deliveryCash(d) {
  const ps = Repo.by('payments', 'deliveryId', d.id);
  const collected = sum(ps.filter(p => p.kind === 'collection'), p => p.amount);
  const cash = sum(ps.filter(p => p.kind === 'collection' && p.method === 'Cash' && p.holderKey === carrierKey(d.mode, d.carrierId)), p => p.amount);
  const refunds = sum(ps.filter(p => p.kind === 'refund' && p.holderKey === carrierKey(d.mode, d.carrierId)), p => -p.amount);
  const handed = sum(Repo.by('handoverAllocs', 'deliveryId', d.id), a => a.amount);
  return { collected, cash, refunds, handed, unhanded: round2(cash - refunds - handed), method: ps.find(p => p.kind === 'collection')?.method || '' };
}
/* What the customer is expected to pay on this delivery, given what they have already paid. */
function expectedFromCustomer(d) {
  const o = orderOf(d.orderId), c = calc(o);
  if (d.status === 'Delivered' || d.status === 'Partially Delivered' || d.status === 'Handed Over' || d.status === 'Cancelled Assignment' || d.completedAt || d.status === 'Returned to Warehouse') {
    if (d.status === 'Cancelled Assignment' || d.status === 'Handed Over') return 0;
    return round2(Math.max(0, c.revenue - (c.paid - deliveryCash(d).collected)));
  }
  return round2(Math.max(0, c.value - c.paid));
}
function courierDeliveryBalance(d) {
  const ps = Repo.by('payments', 'deliveryId', d.id).filter(p => p.holderKey === carrierKey('courier', d.carrierId));
  const customer = sum(ps, p => p.amount);
  const waived = d.shippingPaidBy === 'waived';
  const deductions = round2((d.pickedUpAt && !waived ? d.cost : 0) + (d.returnedAt && !waived ? d.returnCost : 0) + (d.completedAt ? d.codFee : 0));
  const expectedNet = round2(customer - deductions);
  const actual = sum(Repo.by('settlementAllocs', 'deliveryId', d.id), a => a.net);
  return { customer, deductions, expectedNet, actual, gap: round2(expectedNet - actual) };
}
function courierOutcome(d) {
  const b = courierDeliveryBalance(d), t = tol(), any = Repo.count('settlementAllocs', 'deliveryId', d.id) > 0;
  if (!d.pickedUpAt) return 'Not due';
  if (!any) return (TERMINAL_DELIVERY.has(d.status) || b.customer) ? 'Pending' : 'Not due';
  if (Math.abs(b.gap) <= t) return 'Reconciled';
  if (b.gap < -t) return 'Overpaid';
  return b.actual > 0 ? 'Partially collected' : 'Discrepancy';
}
function courierSummary(cr) {
  const ds = Repo.by('deliveries', 'carrierKey', carrierKey('courier', cr.id));
  const t = { customer: 0, deductions: 0, expectedNet: 0, actual: 0, gap: 0 };
  for (const d of ds) { const b = courierDeliveryBalance(d); for (const k in t) t[k] += b[k]; }
  for (const k in t) t[k] = round2(t[k]);
  return { ...t, deliveries: ds };
}
function driverCash(id) {
  const key = carrierKey('driver', id), ps = Repo.by('payments', 'holderKey', key);
  const collected = sum(ps.filter(p => p.kind === 'collection' && p.method === 'Cash'), p => p.amount);
  const refunds = sum(ps.filter(p => p.kind === 'refund'), p => -p.amount);
  const handed = sum(Repo.by('handovers', 'driverId', id), h => h.amount);
  const exps = Repo.by('driverExpenses', 'driverId', id);
  const approvedCash = sum(exps.filter(e => e.status === 'Approved' && e.paidFromCash), e => e.amount);
  const pendingExp = sum(exps.filter(e => e.status === 'Pending'), e => e.amount);
  const nonCash = sum(Repo.by('payments', 'holderKey', 'business').filter(p => p.driverId === id && p.kind === 'collection'), p => p.amount);
  const ds = Repo.by('deliveries', 'carrierKey', key);
  const active = ds.filter(d => !TERMINAL_DELIVERY.has(d.status));
  const expected = sum(active, expectedFromCustomer);
  const outstanding = round2(collected - handed - approvedCash - refunds);
  const openDisc = sum(Repo.by('discrepancies', 'carrierKey', key).filter(x => x.status === 'Open'), x => x.amount);
  return { collected, refunds, handed, approvedCash, pendingExp, nonCash, expected, outstanding, openDisc };
}
function driverStats(id) {
  const ds = Repo.by('deliveries', 'carrierKey', carrierKey('driver', id));
  const c = s => ds.filter(d => d.status === s).length;
  const failed = ds.reduce((n, d) => n + d.attempts.filter(a => a.outcome === 'Failed').length, 0);
  const latest = Repo.by('events', 'driverId', id).reduce((m, e) => (!m || e.at > m.at) ? e : m, null);
  return { deliveries: ds, awaiting: c('Assigned'), custody: ds.filter(d => d.custody === carrierKey('driver', id)).length, ofd: c('Out for Delivery'), completed: c('Delivered') + c('Partially Delivered') + ds.filter(d => d.status === 'Returned to Warehouse' && d.items.some(i => i.delivered)).length, failed, returning: c('Return in Transit'), latest };
}
const isOverdue = d => {
  if (TERMINAL_DELIVERY.has(d.status)) return false;
  if (d.status === 'Retry Scheduled') return !!d.retryAt && d.retryAt < Clock.now();
  const hrs = (new Date(Clock.now()) - new Date(d.updatedAt)) / 3600e3;
  return hrs > (Number(S().overdueHours) || 24);
};
const overdueWhy = d => d.status === 'Retry Scheduled' ? `Retry was scheduled for ${dateKey(d.retryAt)} and has not started` : `No update for over ${S().overdueHours} hours`;

/* ---------- Guards: each returns null if allowed, or the reason it is not ---------- */
const Guards = {
  confirm(o) {
    if (o.status !== 'New') return `Only New orders can be confirmed. This order is ${o.status}.`;
    const need = new Map(); for (const l of linesOf(o)) need.set(l.sku, (need.get(l.sku) || 0) + l.qty);
    for (const [sku, q] of need) { const a = availableOf(sku); if (a < q) return `Not enough stock for ${sku}: needs ${q}, ${a} available. Adjust stock or complete production first.`; }
    return null;
  },
  process(o) { return o.status === 'Confirmed' ? null : `Only Confirmed orders can start processing. This order is ${o.status}.`; },
  ready(o) { return o.status === 'Processing' ? null : `Only Processing orders can be marked Ready. This order is ${o.status}.`; },
  cancel(o) {
    if (['Cancelled', 'Delivered', 'Returned', 'Partially Delivered', 'Partially Returned'].includes(o.status)) return `A ${o.status} order cannot be cancelled.`;
    if (['Shipped', 'Failed Delivery'].includes(o.status)) return 'The parcel has been dispatched. Bring it back through the return workflow instead of cancelling.';
    return null;
  },
  assign(o) {
    if (['New', 'Cancelled', 'Delivered', 'Returned', 'Partially Returned', 'Partially Delivered'].includes(o.status)) return o.status === 'New' ? 'Confirm the order first, so stock is reserved before assigning delivery.' : `A ${o.status} order cannot be assigned for delivery.`;
    if (['Shipped', 'Failed Delivery'].includes(o.status)) return 'The parcel is already out. Use a driver-to-driver handover or the delivery actions.';
    const a = activeDelivery(o); if (a) return `Already assigned to ${carrierName(a)} (${a.id}). Reassign it instead, so one order never has two active assignments.`;
    return null;
  },
  pickup(d) {
    if (d.status !== 'Assigned') return `Pickup applies to Assigned deliveries. This one is ${d.status}.`;
    const o = orderOf(d.orderId); return o.status === 'Ready' ? null : `Order #${o.id} is ${o.status}. It must be Ready before the parcel can leave the warehouse.`;
  },
  flow(d, to) { return DELIVERY_FLOW[d.status]?.includes(to) ? null : `A delivery in ${d.status} cannot move to ${to}.`; },
  returnCase(o) { return linesOf(o).some(l => l.delivered - l.returned - l.pendingReturn > 0) ? null : 'No delivered units are left to return on this order.'; },
  refund(o) { const c = calc(o), owed = round2(c.paid - c.revenue); if (o.status !== 'Cancelled' && o.status !== 'Returned' && !c.deliveredAny) return 'The order is still in progress, so its payment is held as a deposit. Refund after cancellation or return.'; return owed > 0 ? null : 'No refund is owed: customer payments do not exceed recognized revenue.'; },
};

/* ---------- Commands ---------- */
const Commands = {
  /* ORDERS */
  createOrder(f) {
    return Repo.tx(() => {
      const cust = Repo.get('customers', f.customerId); if (!cust) fail('Choose a customer.');
      if (!f.lines?.length) fail('Add at least one line item.');
      if (f.externalRef && Repo.count('orders', 'externalRef', f.externalRef)) fail(`External reference ${f.externalRef} was already imported.`);
      const id = Repo.nextId('ORD', 1058), at = f.at || Clock.now();
      let gross = 0;
      for (const l of f.lines) {
        const s = Repo.get('skus', l.sku); if (!s) fail(`Unknown SKU ${l.sku}.`);
        if (!Number.isInteger(l.qty) || l.qty < 1 || l.qty > 500) fail(`${l.sku}: quantity must be a whole number from 1 to 500.`);
        const price = l.price ?? s.price; if (!(price >= 0)) fail(`${l.sku}: invalid price.`);
        if ((l.discount || 0) < 0 || (l.discount || 0) > price * l.qty) fail(`${l.sku}: line discount cannot exceed the line value.`);
        gross += price * l.qty - (l.discount || 0);
      }
      const discount = Number(f.discount || 0); if (discount < 0 || discount > gross) fail('Order discount cannot exceed the order value.');
      const fee = Number(f.deliveryFee || 0); if (fee < 0) fail('Delivery fee cannot be negative.');
      if (f.campaignId && !Repo.get('campaigns', f.campaignId)) fail('Unknown campaign.');
      const o = Repo.insert('orders', { id, at, customerId: cust.id, address: f.address || cust.address, area: f.area || cust.area, instructions: f.instructions ?? cust.deliveryNotes ?? '', channel: f.channel || 'Phone', source: f.source || 'Manual', campaignId: f.campaignId || null, status: 'New', paymentMethod: f.paymentMethod || 'COD', discount, deliveryFee: fee, notes: [], externalRef: f.externalRef || null, relatedOrderId: f.relatedOrderId || null });
      f.lines.forEach((l, i) => { const s = Repo.get('skus', l.sku); Repo.insert('lines', { id: `${id}-${i + 1}`, orderId: id, sku: s.id, name: s.name, variant: s.variant, qty: l.qty, price: l.price ?? s.price, discount: l.discount || 0, unitCost: bomCost(s.id).total, reserved: 0, dispatched: 0, delivered: 0, returned: 0, pendingReturn: 0, undeliveredBack: 0 }); });
      log(`Order created via ${o.source} entry · channel ${o.channel}`, { orderId: id, customerId: cust.id });
      if (f.note) Commands.addOrderNote(id, f.note);
      return o;
    });
  },
  addOrderNote(id, text) { return Repo.tx(() => { const o = orderOf(id); if (!text?.trim()) fail('Enter a note.'); Repo.update('orders', o, { notes: [...o.notes, { at: Clock.now(), by: activityBy(), text: text.trim() }] }); log('Internal note added', { orderId: id }); }); },
  confirmOrder(id) {
    return Repo.tx(() => {
      const o = orderOf(id), why = Guards.confirm(o); if (why) fail(why);
      for (const l of linesOf(o)) Repo.update('lines', l, { reserved: l.qty });
      Repo.update('orders', o, { status: 'Confirmed', confirmedAt: Clock.now() });
      log('Confirmed · stock reserved for every line', { orderId: id });
    });
  },
  advanceOrder(id, to) {
    return Repo.tx(() => {
      const o = orderOf(id), why = to === 'Processing' ? Guards.process(o) : to === 'Ready' ? Guards.ready(o) : 'Use the delivery workflow for this status.'; if (why) fail(why);
      Repo.update('orders', o, { status: to }); log(`Status → ${to}`, { orderId: id });
    });
  },
  cancelOrder(id, reason) {
    return Repo.tx(() => {
      const o = orderOf(id), why = Guards.cancel(o); if (why) fail(why);
      if (!reason?.trim()) fail('Enter a cancellation reason.');
      const a = activeDelivery(o); if (a) Commands.setDeliveryStatus(a.id, 'Cancelled Assignment', { note: 'Order cancelled: ' + reason });
      for (const l of linesOf(o)) if (l.reserved) Repo.update('lines', l, { reserved: 0 });
      Repo.update('orders', o, { status: 'Cancelled', cancelledAt: Clock.now() });
      log(`Cancelled: ${reason} · reservations released`, { orderId: id });
    });
  },
  attribute(id, campaignId, reason) {
    return Repo.tx(() => {
      const o = orderOf(id); if (campaignId && !Repo.get('campaigns', campaignId)) fail('Unknown campaign.');
      const from = Repo.get('campaigns', o.campaignId)?.name || 'Unattributed', to = Repo.get('campaigns', campaignId)?.name || 'Unattributed';
      if (o.campaignId === (campaignId || null)) fail('That is already the attribution for this order.');
      Repo.update('orders', o, { campaignId: campaignId || null });
      log(`Attribution corrected: ${from} → ${to}${reason ? ' · ' + reason : ''}`, { orderId: id });
    });
  },

  /* DELIVERY ASSIGNMENT */
  assign(orderId, mode, carrierId, opts = {}) {
    return Repo.tx(() => {
      const o = orderOf(orderId), why = Guards.assign(o); if (why) fail(`#${orderId}: ${why}`);
      const carrier = Repo.get(mode === 'driver' ? 'drivers' : 'couriers', carrierId); if (!carrier) fail('Choose a valid carrier.');
      if (carrier.active === false) fail(`${carrier.name} is inactive. Choose an active carrier.`);
      if (mode === 'driver' && carrier.availability === 'Off duty') fail(`${carrier.name} is off duty. Change availability or choose another driver.`);
      return Commands._newDelivery(o, mode, carrier, opts);
    });
  },
  _newDelivery(o, mode, carrier, opts = {}) {
    const id = 'DL-' + Repo.nextId('DL', 3001), at = Clock.now(), key = carrierKey(mode, carrier.id);
    const items = linesOf(o).map(l => ({ lineId: l.id, sku: l.sku, qty: l.qty, delivered: 0 }));
    const d = Repo.insert('deliveries', { id, orderId: o.id, mode, carrierId: carrier.id, carrierKey: key, status: opts.status || 'Assigned', custody: opts.custody || 'warehouse', area: o.area, assignedAt: at, updatedAt: at, pickedUpAt: opts.pickedUpAt || null, completedAt: null, returnedAt: null, retryAt: null, items, attempts: [], history: [{ at, status: opts.status || 'Assigned', by: activityBy(), note: opts.note || `Assigned to ${carrier.name}` }], tracking: opts.tracking || '', cost: mode === 'driver' ? (opts.cost ?? (Number(S().driverFee) || 0)) : (opts.cost ?? carrier.shipRate), returnCost: mode === 'driver' ? (Number(S().returnFeeDriver) || 0) : carrier.returnRate, codFee: 0, predecessorId: opts.predecessorId || null, successorId: null });
    log(opts.logText || `Delivery ${id} assigned to ${carrier.name}`, { orderId: o.id, deliveryId: id, driverId: mode === 'driver' ? carrier.id : undefined });
    return d;
  },
  /* Before pickup only: closes the old assignment, opens a new one. No cash moves. */
  reassign(deliveryId, mode, carrierId, reason) {
    return Repo.tx(() => {
      const d = Repo.get('deliveries', deliveryId);
      if (d.status !== 'Assigned') fail(`Reassignment only applies before pickup. ${d.id} is ${d.status}. Use driver handover for a parcel already picked up.`);
      if (d.carrierId === carrierId && d.mode === mode) fail('This delivery is already assigned to that carrier.');
      const carrier = Repo.get(mode === 'driver' ? 'drivers' : 'couriers', carrierId); if (!carrier) fail('Choose a valid carrier.');
      if (carrier.active === false || carrier.availability === 'Off duty') fail(`${carrier.name} cannot take new deliveries right now.`);
      Commands.setDeliveryStatus(d.id, 'Cancelled Assignment', { note: 'Reassigned' + (reason ? ': ' + reason : '') });
      return Commands._newDelivery(orderOf(d.orderId), mode, carrier, { predecessorId: d.id, note: `Reassigned from ${carrierName(d)}`, logText: `Reassigned from ${carrierName(d)} to ${carrier.name}` });
    });
  },
  /* After pickup: explicit physical transfer. Cash already collected stays with the collector. */
  driverHandover(deliveryId, toDriverId, note) {
    return Repo.tx(() => {
      const d = Repo.get('deliveries', deliveryId);
      if (d.mode !== 'driver') fail('Driver handover applies to private-driver deliveries only.');
      const why = Guards.flow(d, 'Handed Over'); if (why) fail(why + ' Handover is only possible after pickup and before delivery.');
      if (d.carrierId === toDriverId) fail('Choose a different driver.');
      if (!note?.trim()) fail('Record why and where the parcel changed hands.');
      const to = Repo.get('drivers', toDriverId); if (!to || to.active === false) fail('Choose an active driver.');
      const at = Clock.now(), fromName = carrierName(d);
      Repo.update('deliveries', d, { status: 'Handed Over', custody: carrierKey('driver', toDriverId), updatedAt: at, history: [...d.history, { at, status: 'Handed Over', by: activityBy(), note: `Physical handover to ${to.name}: ${note}` }] });
      const nd = Commands._newDelivery(orderOf(d.orderId), 'driver', to, { status: 'Picked Up', custody: carrierKey('driver', toDriverId), pickedUpAt: at, cost: 0, predecessorId: d.id, note: `Received from ${fromName}: ${note}`, logText: `Parcel handed over from ${fromName} to ${to.name}. Collected cash stays with ${fromName} until handed to the business.` });
      Repo.update('deliveries', d, { successorId: nd.id });
      log(`Handed parcel for #${d.orderId} to ${to.name}`, { driverId: d.carrierId, orderId: d.orderId, deliveryId: d.id });
      return nd;
    });
  },
  /* Pickup = dispatch: reservation converts to a stock deduction, once. */
  pickup(deliveryId) {
    return Repo.tx(() => {
      const d = Repo.get('deliveries', deliveryId), why = Guards.pickup(d); if (why) fail(why);
      const o = orderOf(d.orderId), at = Clock.now();
      for (const l of linesOf(o)) {
        postMovement({ item: l.sku, itemType: 'sku', qty: -l.qty, kind: 'Dispatch', key: `dispatch:${l.id}`, ref: `#${o.id} · ${d.id}` });
        Repo.update('lines', l, { reserved: 0, dispatched: l.qty });
      }
      Repo.update('deliveries', d, { status: 'Picked Up', custody: d.carrierKey, pickedUpAt: at, updatedAt: at, history: [...d.history, { at, status: 'Picked Up', by: activityBy(), note: 'Left the warehouse · reservation converted to dispatch' }] });
      Repo.update('orders', o, { status: 'Shipped', shippedAt: at });
      log(`Picked up by ${carrierName(d)} · stock deducted`, { orderId: o.id, deliveryId: d.id, driverId: d.mode === 'driver' ? d.carrierId : undefined });
    });
  },
  setDeliveryStatus(deliveryId, to, { note, reason, retryAt } = {}) {
    return Repo.tx(() => {
      const d = Repo.get('deliveries', deliveryId), why = Guards.flow(d, to); if (why) fail(why);
      const o = orderOf(d.orderId), at = Clock.now(), patch = { status: to, updatedAt: at };
      if (to === 'Delivered' || to === 'Partially Delivered') fail('Record delivery with item quantities and collection.');
      if (to === 'Failed Attempt') {
        if (!reason) fail('Choose a failure reason.');
        patch.attempts = [...d.attempts, { no: d.attempts.length + 1, at, outcome: 'Failed', reason, note: note || '', by: activityBy() }];
        Repo.update('orders', o, { status: 'Failed Delivery' });
      }
      if (to === 'Retry Scheduled') { if (!retryAt) fail('Choose a retry date.'); patch.retryAt = retryAt; }
      if (to === 'Out for Delivery') { patch.retryAt = null; if (o.status === 'Failed Delivery') Repo.update('orders', o, { status: 'Shipped' }); }
      if (to === 'Return in Transit') patch.returnStartedAt = at;
      if (to === 'Cancelled Assignment') patch.custody = 'warehouse';
      const text = [to, reason, note].filter(Boolean).join(' · ');
      patch.history = [...d.history, { at, status: to, by: activityBy(), note: [reason, note].filter(Boolean).join(' · ') }];
      Repo.update('deliveries', d, patch);
      log(`${d.id}: ${text}`, { orderId: o.id, deliveryId: d.id, driverId: d.mode === 'driver' ? d.carrierId : undefined });
    });
  },
  /* Delivered, in item quantities. Revenue is recognized here and only here. */
  deliver(deliveryId, { quantities, collection, reason, note }) {
    return Repo.tx(() => {
      const d = Repo.get('deliveries', deliveryId), o = orderOf(d.orderId);
      if (d.status !== 'Out for Delivery') fail(`Delivery can only be recorded from Out for Delivery. ${d.id} is ${d.status}.`);
      let total = 0, full = true;
      const items = d.items.map(it => {
        const q = Number(quantities?.[it.lineId] ?? it.qty);
        if (!Number.isInteger(q) || q < 0 || q > it.qty) fail(`${it.sku}: delivered quantity must be 0 to ${it.qty}.`);
        total += q; if (q < it.qty) full = false; return { ...it, delivered: q };
      });
      if (!total) fail('No units delivered. Record a failed attempt instead.');
      const at = Clock.now(), status = full ? 'Delivered' : 'Partially Delivered';
      const carrier = d.mode === 'courier' ? Repo.get('couriers', d.carrierId) : null;
      Repo.update('deliveries', d, { status, items, completedAt: at, updatedAt: at, custody: full ? 'customer' : d.carrierKey, codFee: carrier && o.paymentMethod === 'COD' ? carrier.codFee : 0, attempts: [...d.attempts, { no: d.attempts.length + 1, at, outcome: full ? 'Delivered' : 'Partial', reason: full ? '' : (reason || 'Partial delivery'), note: note || '', by: activityBy() }], history: [...d.history, { at, status, by: activityBy(), note: note || (full ? '' : 'Undelivered units stay in carrier custody until physically returned') }] });
      for (const it of items) Repo.update('lines', Repo.get('lines', it.lineId), { delivered: it.delivered });
      Repo.update('orders', o, { status: full ? 'Delivered' : 'Partially Delivered', deliveredAt: at });
      log(`${d.id}: ${status} (${total} unit${total > 1 ? 's' : ''}) by ${carrierName(d)}`, { orderId: o.id, deliveryId: d.id, driverId: d.mode === 'driver' ? d.carrierId : undefined });
      if (collection && collection.amount > 0) Commands.collect(d.id, { ...collection, shortReason: reason });
      else if (round2(calc(o).revenue - calc(o).paid) > tol()) Commands._syncShortfall(o, d, collection?.shortReason || reason || 'Not collected at delivery');
    });
  },
  /* Customer collection. Only cash in hand increases the carrier's balance. */
  collect(deliveryId, { amount, method, ref, shortReason, note }) {
    return Repo.tx(() => {
      const d = Repo.get('deliveries', deliveryId), o = orderOf(d.orderId), c = calc(o);
      amount = round2(amount);
      if (!(amount > 0)) fail('Collection amount must be greater than zero.');
      if (!PAYMENT_METHODS.includes(method)) fail('Choose a payment method.');
      if (!d.completedAt) fail('Record the delivery first. Revenue and collections follow what was delivered.');
      const due = round2(c.revenue - c.paid);
      if (amount > due + tol()) fail(`This collection exceeds what is due: ${money(due)} remains after recognized revenue and earlier payments.`);
      const reference = (ref || '').trim() || (method === 'Cash' ? `CASH-${d.id}-${Repo.nextId('CASHREF')}` : '');
      if (method !== 'Cash' && !reference) fail('Non-cash payments need a transaction reference.');
      if (Repo.count('payments', 'ref', reference)) fail(`Reference ${reference} has already been used.`);
      if (round2(due - amount) > tol() && !shortReason?.trim()) fail(`Partial collection: ${money(due - amount)} would remain unpaid. Enter a reason.`);
      const holderKey = method === 'Cash' ? d.carrierKey : 'business';
      const fee = method === 'Card' ? round2(amount * 0.025) : 0;
      Repo.insert('payments', { id: 'PAY-' + Repo.nextId('PAY', 5001), orderId: o.id, deliveryId: d.id, kind: 'collection', method, amount, holderKey, driverId: d.mode === 'driver' ? d.carrierId : null, ref: reference, at: Clock.now(), by: activityBy(), fee, note: note || '', reason: shortReason || '' });
      log(`Collected ${money(amount)} by ${method} · ${method === 'Cash' ? `held by ${carrierName(d)}` : 'paid to the business directly'} · ${reference}`, { orderId: o.id, deliveryId: d.id, driverId: d.mode === 'driver' ? d.carrierId : undefined, customerId: o.customerId });
      Commands._syncShortfall(o, d, shortReason);
    });
  },
  /* Keeps one open shortfall per order. Closes it automatically once paid. */
  _syncShortfall(o, d, reason) {
    const gap = round2(calc(o).revenue - calc(o).paid), open = Repo.by('discrepancies', 'orderId', o.id).find(x => x.type === 'Short collection' && x.status === 'Open');
    if (gap > tol()) {
      if (open) Repo.update('discrepancies', open, { amount: gap });
      else Repo.insert('discrepancies', { id: 'DSC-' + Repo.nextId('DSC', 101), orderId: o.id, deliveryId: d.id, carrierKey: d.carrierKey, type: 'Short collection', amount: gap, reason: reason || 'Customer did not pay in full', status: 'Open', at: Clock.now() });
    } else if (open) Repo.update('discrepancies', open, { status: 'Resolved', resolution: 'Customer balance paid', amount: 0, resolvedAt: Clock.now() });
  },
  prepay(orderId, { amount, method, ref }) {
    return Repo.tx(() => {
      const o = orderOf(orderId); amount = round2(amount);
      if (o.status === 'Cancelled') fail('Cannot record payment on a cancelled order.');
      if (method === 'Cash') fail('Cash at the door is recorded against the delivery. Use a non-cash method here, or Bank transfer for a direct deposit.');
      if (!PAYMENT_METHODS.includes(method)) fail('Choose a payment method.');
      if (!(amount > 0)) fail('Amount must be greater than zero.');
      const remaining = round2(calc(o).value - calc(o).paid); if (amount > remaining + tol()) fail(`Only ${money(remaining)} remains on this order.`);
      if (!ref?.trim()) fail('Enter the transaction reference.');
      if (Repo.count('payments', 'ref', ref.trim())) fail(`Reference ${ref.trim()} has already been used.`);
      Repo.insert('payments', { id: 'PAY-' + Repo.nextId('PAY', 5001), orderId, deliveryId: null, kind: 'collection', method, amount, holderKey: 'business', driverId: null, ref: ref.trim(), at: Clock.now(), by: activityBy(), fee: method === 'Card' ? round2(amount * 0.025) : 0, note: 'Customer payment received directly by the business', reason: '' });
      log(`Direct payment ${money(amount)} by ${method} · ${ref.trim()}`, { orderId, customerId: o.customerId });
      const open = Repo.by('discrepancies', 'orderId', o.id).find(x => x.type === 'Short collection' && x.status === 'Open');
      if (open) Commands._syncShortfall(o, Repo.get('deliveries', open.deliveryId), open.reason);
    });
  },
  startReturn(deliveryId, note) { return Commands.setDeliveryStatus(deliveryId, 'Return in Transit', { note: note || 'Heading back to the warehouse' }); },
  /* Physical handover at the warehouse: undelivered units return to stock, once. */
  /* Physical handover at the warehouse: undelivered units return to stock, once.
     outcome records why it came back and who pays the shipping:
       business  the business carries the delivery and return cost (default)
       waived    the carrier charged nothing, so no shipping cost is booked
       customer  the customer pays a shipping fee, booked as revenue; paidTo says
                 whether they already paid it to the carrier, to the business, or not yet */
  receiveAtWarehouse(deliveryId, note, outcome = {}) {
    return Repo.tx(() => {
      const d = Repo.get('deliveries', deliveryId), why = Guards.flow(d, 'Returned to Warehouse'); if (why) fail(why);
      const o = orderOf(d.orderId), at = Clock.now(); let n = 0;
      const paidBy = outcome?.shipping || 'business', reason = String(outcome?.reason || '').trim();
      if (!['business', 'waived', 'customer'].includes(paidBy)) fail('Choose who pays the shipping.');
      if (reason && !RETURN_REASONS.includes(reason)) fail('Choose a return reason from the list.');
      if (paidBy === 'waived' && d.items.some(i => i.delivered > 0)) fail('Part of this parcel was delivered, so the carrier still charges for the trip. Choose "The business" instead.');
      let fee = 0, paidTo = 'unpaid';
      if (paidBy === 'customer') {
        fee = round2(outcome.fee ?? (o.deliveryFee || d.cost || 0)); if (!(fee > 0)) fail('Enter the shipping fee the customer pays.');
        paidTo = outcome.paidTo || 'unpaid'; if (!['unpaid', 'carrier', 'business'].includes(paidTo)) fail('Choose whether the customer has paid the fee.');
      }
      for (const it of d.items) {
        const back = it.qty - it.delivered; if (back <= 0) continue;
        postMovement({ item: it.sku, itemType: 'sku', qty: back, kind: 'Inspected return', key: `undelivered:${d.id}:${it.lineId}`, ref: `#${o.id} · ${d.id}`, note: 'Undelivered parcel inspected and restocked' });
        const l = Repo.get('lines', it.lineId); Repo.update('lines', l, { undeliveredBack: l.undeliveredBack + back }); n += back;
      }
      const who = { business: 'business pays the shipping', waived: 'no shipping cost (carrier waived it)', customer: `customer pays a ${money(fee)} shipping fee${paidTo === 'unpaid' ? ', not paid yet' : paidTo === 'carrier' ? `, paid to ${carrierName(d)}` : ', paid to the business'}` }[paidBy];
      Repo.update('deliveries', d, { status: 'Returned to Warehouse', custody: 'warehouse', returnedAt: at, updatedAt: at, returnReason: reason || null, shippingPaidBy: paidBy, feeCharged: fee, history: [...d.history, { at, status: 'Returned to Warehouse', by: activityBy(), note: `${note || `${n} unit(s) received and inspected`}${reason ? ` · ${reason}` : ''} · ${who}` }] });
      if (paidTo !== 'unpaid') {
        const toCarrier = paidTo === 'carrier';
        Repo.insert('payments', { id: 'PAY-' + Repo.nextId('PAY', 5001), orderId: o.id, deliveryId: toCarrier ? d.id : null, kind: 'collection', method: toCarrier ? 'Cash' : (PAYMENT_METHODS.includes(outcome.method) ? outcome.method : 'Cash'), amount: fee, holderKey: toCarrier ? d.carrierKey : 'business', driverId: toCarrier && d.mode === 'driver' ? d.carrierId : null, ref: `FEE-${d.id}`, at, by: activityBy(), fee: 0, note: 'Shipping fee on a returned parcel', reason: '' });
      }
      if (!linesOf(o).some(l => l.delivered > 0)) Repo.update('orders', o, { status: 'Returned', returnedAt: at });
      log(`${d.id}: ${n} unit(s) received at warehouse from ${carrierName(d)}${reason ? ` (${reason})` : ''} · ${who}`, { orderId: o.id, deliveryId: d.id, driverId: d.mode === 'driver' ? d.carrierId : undefined });
    });
  },

  /* DRIVER MONEY */
  /* A handover moves custody of cash. It creates no revenue or profit. */
  recordHandover({ driverId, ref, at, receivedBy, allocations, declared, note }) {
    return Repo.tx(() => {
      const dr = Repo.get('drivers', driverId); if (!dr) fail('Unknown driver.');
      ref = (ref || '').trim(); if (!ref) fail('A unique handover reference is required.');
      if (Repo.count('handovers', 'ref', ref)) fail(`Handover reference ${ref} already exists.`);
      if (!receivedBy?.trim()) fail('Enter the employee who received the cash.');
      allocations = (allocations || []).filter(a => Number(a.amount) !== 0);
      if (!allocations.length) fail('Allocate the cash to at least one delivery.');
      const seen = new Set(); let total = 0;
      for (const a of allocations) {
        if (seen.has(a.deliveryId)) fail(`${a.deliveryId} appears twice in this handover.`); seen.add(a.deliveryId);
        const d = Repo.get('deliveries', a.deliveryId), amt = round2(a.amount);
        if (!d || d.carrierKey !== carrierKey('driver', driverId)) fail(`${a.deliveryId} did not have its cash collected by ${dr.name}.`);
        if (!(amt > 0)) fail(`${a.deliveryId}: allocation must be positive.`);
        const left = deliveryCash(d).unhanded;
        if (amt > left + 0.001) fail(`${d.id}: only ${money(left)} is unallocated. ${money(amt)} would allocate the same cash twice.`);
        total = round2(total + amt);
      }
      const out = driverCash(driverId).outstanding;
      if (total > out + 0.001) fail(`Handover total ${money(total)} exceeds ${dr.name}'s outstanding cash of ${money(out)} (approved expenses and refunds already reduce it).`);
      const when = at || Clock.now(), id = 'HO-' + Repo.nextId('HO', 701); assertOpen(when, 'This handover');
      Repo.insert('handovers', { id, driverId, ref, at: when, receivedBy: receivedBy.trim(), amount: total, declared: declared ? round2(declared) : total, note: note || '', by: activityBy() });
      for (const a of allocations) { const d = Repo.get('deliveries', a.deliveryId); Repo.insert('handoverAllocs', { id: `${id}-${a.deliveryId}`, handoverId: id, deliveryId: a.deliveryId, orderId: d.orderId, driverId, amount: round2(a.amount) }); }
      log(`Cash handover ${ref}: ${money(total)} received by ${receivedBy.trim()} across ${allocations.length} deliver${allocations.length > 1 ? 'ies' : 'y'}`, { driverId });
      if (declared && round2(declared - total) > tol()) Repo.insert('discrepancies', { id: 'DSC-' + Repo.nextId('DSC', 101), orderId: null, deliveryId: null, carrierKey: carrierKey('driver', driverId), type: 'Handover shortfall', amount: round2(declared - total), reason: `${dr.name} declared ${money(declared)}, ${money(total)} counted (${ref})`, status: 'Open', at: when });
      return id;
    });
  },
  addDriverExpense({ driverId, deliveryId, category, amount, paidFromCash, note }) {
    return Repo.tx(() => {
      const dr = Repo.get('drivers', driverId); if (!dr) fail('Unknown driver.');
      amount = round2(amount); if (!(amount > 0)) fail('Expense must be greater than zero.');
      if (!DRIVER_EXPENSE_CATS.includes(category)) fail('Choose a category.');
      if (category === 'Delivery fee payout' && !paidFromCash) fail('A delivery fee payout means the driver kept their fee from collected cash, so it must be marked as paid from cash.');
      const id = 'DX-' + Repo.nextId('DX', 201);
      Repo.insert('driverExpenses', { id, driverId, deliveryId: deliveryId || null, category, amount, paidFromCash: !!paidFromCash, status: 'Pending', at: Clock.now(), note: note || '', by: activityBy() });
      log(`Expense ${id} submitted: ${category} ${money(amount)}${paidFromCash ? ' from collected cash' : ''}`, { driverId });
      return id;
    });
  },
  decideDriverExpense(id, decision) {
    return Repo.tx(() => {
      const e = Repo.get('driverExpenses', id); if (e.status !== 'Pending') fail(`${id} is already ${e.status}.`);
      if (decision === 'Approved' && e.paidFromCash && e.amount > driverCash(e.driverId).outstanding + 0.001) fail(`Approving would take outstanding cash below zero. ${money(driverCash(e.driverId).outstanding)} is outstanding.`);
      Repo.update('driverExpenses', e, { status: decision, decidedAt: Clock.now(), decidedBy: activityBy() });
      log(`Expense ${id} ${decision.toLowerCase()}`, { driverId: e.driverId });
    });
  },
  resolveDiscrepancy(id, resolution) {
    return Repo.tx(() => {
      const x = Repo.get('discrepancies', id); if (x.status !== 'Open') fail('Already resolved.');
      if (!resolution?.trim()) fail('Record how this was resolved.');
      Repo.update('discrepancies', x, { status: 'Resolved', resolution: resolution.trim(), resolvedAt: Clock.now() });
      log(`Discrepancy ${id} resolved: ${resolution.trim()}`, { orderId: x.orderId || undefined, driverId: x.carrierKey?.startsWith('driver:') ? x.carrierKey.slice(7) : undefined });
    });
  },
  /* COURIER MONEY: arrives net, so charges are never deducted again from cash. */
  recordSettlement({ courierId, ref, at, allocations, note }) {
    return Repo.tx(() => {
      const cr = Repo.get('couriers', courierId); if (!cr) fail('Unknown courier.');
      ref = (ref || '').trim(); if (!ref) fail('A unique settlement reference is required.');
      if (Repo.count('settlements', 'ref', ref)) fail(`Settlement reference ${ref} already exists.`);
      allocations = (allocations || []).filter(a => Number(a.net) !== 0); if (!allocations.length) fail('Enter an amount for at least one delivery.');
      const seen = new Set();
      for (const a of allocations) {
        if (seen.has(a.deliveryId)) fail(`${a.deliveryId} appears twice.`); seen.add(a.deliveryId);
        const d = Repo.get('deliveries', a.deliveryId); if (!d || d.carrierKey !== carrierKey('courier', courierId)) fail(`${a.deliveryId} does not belong to ${cr.name}.`);
      }
      const id = 'ST-' + Repo.nextId('ST', 901), net = sum(allocations, a => a.net); assertOpen(at, 'This settlement');
      Repo.insert('settlements', { id, courierId, ref, at: at || Clock.now(), net, note: note || '', by: activityBy() });
      for (const a of allocations) { const d = Repo.get('deliveries', a.deliveryId); Repo.insert('settlementAllocs', { id: `${id}-${a.deliveryId}`, settlementId: id, deliveryId: a.deliveryId, orderId: d.orderId, net: round2(a.net) }); log(`Courier settlement ${ref}: net ${money(a.net)}`, { orderId: d.orderId, deliveryId: d.id }); }
      return id;
    });
  },
  /* REFUND: cash movement only. Revenue was reversed when the return was accepted. */
  refund(orderId, { amount, source, ref, reason }) {
    return Repo.tx(() => {
      const o = orderOf(orderId), why = Guards.refund(o); if (why) fail(why);
      amount = round2(amount); const owed = round2(calc(o).paid - calc(o).revenue);
      if (!(amount > 0)) fail('Refund must be greater than zero.');
      if (amount > owed + 0.001) fail(`Refund exceeds the ${money(owed)} owed to the customer.`);
      ref = (ref || '').trim(); if (!ref) fail('Enter a refund reference.');
      if (Repo.count('payments', 'ref', ref)) fail(`Reference ${ref} has already been used.`);
      let holderKey = 'business', deliveryId = null, driverId = null, method = 'Bank transfer';
      if (source && source.startsWith('driver:')) {
        driverId = source.slice(7); holderKey = source; method = 'Cash';
        const out = driverCash(driverId).outstanding;
        if (amount > out + 0.001) fail(`${Repo.get('drivers', driverId).name} only holds ${money(out)}.`);
        const ds = Repo.by('deliveries', 'orderId', o.id).filter(d => d.carrierKey === holderKey);
        deliveryId = ds.map(d => ({ d, left: deliveryCash(d).unhanded })).find(x => x.left >= amount - 0.001)?.d.id || null;
        if (!deliveryId) fail(`Cash refunds from a driver must come from this order's uncleared cash with that driver. None is available, so pay it from the business.`);
      }
      Repo.insert('payments', { id: 'PAY-' + Repo.nextId('PAY', 5001), orderId, deliveryId, kind: 'refund', method, amount: -amount, holderKey, driverId, ref, at: Clock.now(), by: activityBy(), fee: 0, note: reason || '', reason: reason || '' });
      log(`Refund ${money(amount)} paid from ${holderKey === 'business' ? 'business funds' : 'driver-held cash'} · ${ref}`, { orderId, customerId: o.customerId, driverId: driverId || undefined });
    });
  },

  /* RETURNS AND EXCHANGES */
  openCase({ orderId, type, items, reason, returnCost }) {
    return Repo.tx(() => {
      const o = orderOf(orderId), why = Guards.returnCase(o); if (why) fail(why);
      if (!reason?.trim()) fail('Enter a reason.');
      const clean = (items || []).filter(i => Number(i.qty) > 0); if (!clean.length) fail('Select at least one unit.');
      for (const i of clean) {
        const l = Repo.get('lines', i.lineId), max = l.delivered - l.returned - l.pendingReturn;
        if (!Number.isInteger(Number(i.qty)) || i.qty > max) fail(`${l.sku}: at most ${max} unit(s) can be returned.`);
      }
      const id = (type === 'Exchange' ? 'EX-' : 'RX-') + Repo.nextId('CASE', 301);
      Repo.insert('cases', { id, orderId, type, items: clean.map(i => ({ lineId: i.lineId, qty: Number(i.qty) })), reason: reason.trim(), status: 'Requested', at: Clock.now(), acceptedAt: null, returnCost: round2(returnCost || 0), replacementOrderId: null, resolution: '' });
      for (const i of clean) { const l = Repo.get('lines', i.lineId); Repo.update('lines', l, { pendingReturn: l.pendingReturn + Number(i.qty) }); }
      log(`${type} case ${id} opened: ${reason.trim()}`, { orderId, customerId: o.customerId });
      return id;
    });
  },
  /* Inspected, resellable: reverses revenue and COGS, restocks. Cash stays untouched until a refund. */
  acceptReturn(caseId) {
    return Repo.tx(() => {
      const c = Repo.get('cases', caseId); if (c.acceptedAt) fail(`${caseId} was already accepted.`);
      if (c.status === 'Rejected' || c.status === 'Closed') fail(`${caseId} is ${c.status}.`);
      const o = orderOf(c.orderId);
      for (const i of c.items) {
        const l = Repo.get('lines', i.lineId);
        postMovement({ item: l.sku, itemType: 'sku', qty: i.qty, kind: 'Inspected return', key: `return:${c.id}:${l.id}`, ref: `#${o.id} · ${c.id}`, note: 'Customer return inspected, resellable' });
        Repo.update('lines', l, { returned: l.returned + i.qty, pendingReturn: l.pendingReturn - i.qty });
      }
      Repo.update('cases', c, { acceptedAt: Clock.now(), status: c.type === 'Exchange' ? 'Item received' : 'Accepted' });
      const left = linesOf(o).reduce((n, l) => n + l.delivered - l.returned, 0);
      Repo.update('orders', o, { status: left === 0 ? 'Returned' : 'Partially Returned', returnedAt: Clock.now() });
      log(`${c.id}: return accepted · revenue and COGS reversed · stock received`, { orderId: o.id });
    });
  },
  rejectCase(caseId, why) {
    return Repo.tx(() => {
      const c = Repo.get('cases', caseId); if (c.acceptedAt) fail('An accepted return cannot be rejected.');
      if (!why?.trim()) fail('Enter why this was rejected.');
      for (const i of c.items) { const l = Repo.get('lines', i.lineId); Repo.update('lines', l, { pendingReturn: l.pendingReturn - i.qty }); }
      Repo.update('cases', c, { status: 'Rejected', resolution: why.trim() });
      log(`${c.id} rejected: ${why.trim()}`, { orderId: c.orderId });
    });
  },
  /* Replacement is a real linked order. Any amount owed on the original moves across as non-cash credit. */
  createReplacement(caseId, { sku, qty }) {
    return Repo.tx(() => {
      const c = Repo.get('cases', caseId); if (c.type !== 'Exchange') fail('Only exchange cases create replacements.');
      if (!c.acceptedAt) fail('Receive and inspect the returned item first.');
      if (c.replacementOrderId) fail(`Replacement order #${c.replacementOrderId} already exists.`);
      const o = orderOf(c.orderId);
      const r = Commands.createOrder({ customerId: o.customerId, address: o.address, area: o.area, channel: 'Exchange', source: 'Manual', campaignId: null, paymentMethod: 'COD', lines: [{ sku, qty: Number(qty) }], relatedOrderId: o.id, note: `Replacement for ${c.id} on #${o.id}` });
      const credit = round2(Math.min(Math.max(0, calc(o).paid - calc(o).revenue), orderValue(r)));
      if (credit > 0) {
        Repo.insert('payments', { id: 'PAY-' + Repo.nextId('PAY', 5001), orderId: o.id, deliveryId: null, kind: 'refund', method: 'Exchange credit', amount: -credit, holderKey: 'credit', driverId: null, ref: `XCR-${c.id}-OUT`, at: Clock.now(), by: activityBy(), fee: 0, note: `Credit to #${r.id}`, reason: '' });
        Repo.insert('payments', { id: 'PAY-' + Repo.nextId('PAY', 5001), orderId: r.id, deliveryId: null, kind: 'collection', method: 'Exchange credit', amount: credit, holderKey: 'credit', driverId: null, ref: `XCR-${c.id}-IN`, at: Clock.now(), by: activityBy(), fee: 0, note: `Credit from #${o.id}`, reason: '' });
      }
      Repo.update('cases', c, { replacementOrderId: r.id, status: 'Replacement created' });
      log(`Replacement order #${r.id} created${credit ? ` · ${money(credit)} non-cash credit transferred` : ''}`, { orderId: o.id });
      return r;
    });
  },
  closeCase(caseId, resolution) {
    return Repo.tx(() => {
      const c = Repo.get('cases', caseId); if (c.status === 'Requested') fail('Accept or reject the item before closing.');
      if (c.status === 'Closed' || c.status === 'Rejected') fail(`${caseId} is already ${c.status}.`);
      Repo.update('cases', c, { status: 'Closed', resolution: resolution || 'Closed' });
      log(`${c.id} closed`, { orderId: c.orderId });
    });
  },

  /* COMPOSITES: one all-or-nothing request */
  createOrderWithCustomer({ customer, order }) {
    return Repo.tx(() => {
      const c = customer ? Commands.saveCustomer(customer) : Repo.get('customers', order.customerId);
      if (!c) fail('Pick the customer from the list, or add a new one below.');
      return Commands.createOrder({ ...order, customerId: c.id });
    });
  },
  importOrders(groups) {
    return Repo.tx(() => {
      if (!Array.isArray(groups) || !groups.length) fail('Nothing to import.');
      for (const g of groups) {
        let c = Repo.by('customers', 'phone', g.phone)[0];
        if (!c) c = Commands.saveCustomer({ name: g.name, phone: g.phone, area: AREAS.includes(g.area) ? g.area : AREAS[0], address: g.address, tags: [] });
        Commands.createOrder({ customerId: c.id, source: 'CSV', channel: g.channel, campaignId: g.campaignId, paymentMethod: g.paymentMethod, discount: g.discount, deliveryFee: g.deliveryFee, externalRef: g.ref, at: new Date(g.date + 'T12:00:00Z').toISOString(), lines: g.lines });
      }
      return groups.length;
    });
  },
  setRoadmap(phase, accepted) {
    return Repo.tx(() => {
      const before = Repo.data.roadmap; Repo.data.roadmap = { ...before, [phase]: !!accepted };
      if (Repo.undo) Repo.undo.push(() => { Repo.data.roadmap = before; });
      Repo.touch();
    });
  },

  /* INVENTORY AND PRODUCTION */
  adjustStock({ item, qty, reason, itemType }) {
    return Repo.tx(() => {
      qty = Number(qty); if (!qty || !Number.isFinite(qty)) fail('Enter a non-zero quantity.');
      if (!reason?.trim()) fail('A reason is required for every stock adjustment.');
      if (itemType === 'sku') {
        if (!Number.isInteger(qty)) fail('Finished goods adjust in whole units.');
        if (stockOnHand(item) + qty < reservedOf(item)) fail(`${item}: ${reservedOf(item)} units are reserved for orders, so on-hand stock cannot drop below that.`);
      }
      postMovement({ item, itemType, qty, kind: 'Adjustment', ref: 'Manual', note: reason.trim() });
      log(`Stock adjustment ${item}: ${qty > 0 ? '+' : ''}${qty} · ${reason.trim()}`, {});
    });
  },
  createProduction({ sku, qty, due }) {
    return Repo.tx(() => {
      qty = Number(qty); if (!Repo.get('skus', sku)) fail('Choose a SKU.');
      if (!Repo.get('boms', sku)) fail(`${sku} has no bill of materials.`);
      if (!Number.isInteger(qty) || qty < 1 || qty > 5000) fail('Quantity must be 1 to 5000 units.');
      const id = 'MO-' + Repo.nextId('MO', 201);
      Repo.insert('production', { id, sku, qty, due: due || '', status: 'Planned', at: Clock.now(), startedAt: null, completedAt: null, unitCost: bomCost(sku).total });
      log(`Production order ${id} planned: ${qty} × ${sku}`, {});
      return id;
    });
  },
  startProduction(id) {
    return Repo.tx(() => {
      const p = Repo.get('production', id); if (p.status !== 'Planned') fail(`${id} is ${p.status}; only Planned orders can start.`);
      for (const x of Repo.get('boms', p.sku).lines) {
        const need = round2(x.qty * p.qty), have = stockOnHand(x.material);
        if (have < need) fail(`Not enough ${Repo.get('materials', x.material).name}: needs ${need}, ${have} on hand.`);
      }
      for (const x of Repo.get('boms', p.sku).lines) postMovement({ item: x.material, itemType: 'material', qty: -round2(x.qty * p.qty), kind: 'Production consumption', key: `consume:${id}:${x.material}`, ref: id });
      Repo.update('production', p, { status: 'WIP', startedAt: Clock.now(), unitCost: bomCost(p.sku).total });
      log(`${id} started · materials consumed into WIP`, {});
    });
  },
  completeProduction(id) {
    return Repo.tx(() => {
      const p = Repo.get('production', id); if (p.status !== 'WIP') fail(`${id} is ${p.status}; only WIP orders can complete.`);
      postMovement({ item: p.sku, itemType: 'sku', qty: p.qty, kind: 'Production receipt', key: `receipt:${id}`, ref: id });
      Repo.update('production', p, { status: 'Completed', completedAt: Clock.now() });
      log(`${id} completed · ${p.qty} × ${p.sku} received into stock`, {});
    });
  },
  cancelProduction(id) {
    return Repo.tx(() => {
      const p = Repo.get('production', id); if (p.status !== 'Planned') fail('Only Planned production can be cancelled. Consumed materials are already in WIP.');
      Repo.update('production', p, { status: 'Cancelled' }); log(`${id} cancelled`, {});
    });
  },
  saveSku(f) {
    return Repo.tx(() => {
      const id = (f.id || '').trim().toUpperCase(); if (!/^[A-Z0-9-]{3,20}$/.test(id)) fail('SKU must be 3 to 20 letters, digits or dashes.');
      const name = (f.name || '').trim(); if (!name) fail('Enter a product name.');
      if (!(Number(f.price) > 0)) fail('Enter a positive price.');
      const row = { name, variant: (f.variant || '').trim(), price: Number(f.price), min: Number(f.min) || 0 };
      const bomLines = (f.bom || []).filter(x => Number(x.qty) > 0).map(x => ({ material: x.material, qty: Number(x.qty) }));
      if (!bomLines.length) fail('A SKU needs at least one material in its bill of materials.');
      const bom = { lines: bomLines, labor: Number(f.labor) || 0, overhead: Number(f.overhead) || 0 };
      const existing = Repo.get('skus', id);
      if (f.isNew && existing) fail(`SKU ${id} already exists.`);
      if (existing) { Repo.update('skus', existing, row); Repo.update('boms', Repo.get('boms', id), bom); }
      else { Repo.insert('skus', { id, ...row }); Repo.insert('boms', { id, ...bom }); }
      log(`SKU ${id} saved · new orders use the new cost, existing orders keep their snapshot`, {});
    });
  },
  receiveMaterial({ item, qty, ref }) {
    return Repo.tx(() => {
      qty = Number(qty); if (!(qty > 0)) fail('Quantity must be positive.');
      if (!ref?.trim()) fail('Enter a purchase reference.');
      postMovement({ item, itemType: 'material', qty, kind: 'Purchase receipt', key: `purchase:${item}:${ref.trim()}`, ref: ref.trim() });
      log(`Material receipt ${item}: +${qty} · ${ref.trim()}`, {});
    });
  },

  /* CRM */
  saveCustomer(f) {
    return Repo.tx(() => {
      const name = (f.name || '').trim(), phone = (f.phone || '').replace(/[\s-]/g, '');
      if (!name) fail('Enter the customer name.');
      if (!/^01[0125]\d{8}$/.test(phone)) fail('Enter a valid Egyptian mobile number (11 digits, starting 010, 011, 012 or 015).');
      const dup = Repo.all('customers').find(c => c.phone === phone && c.id !== f.id); if (dup) fail(`${phone} already belongs to ${dup.name}.`);
      const row = { name, phone, area: f.area || AREAS[0], address: (f.address || '').trim(), altAddresses: f.altAddresses || [], deliveryNotes: (f.deliveryNotes || '').trim(), preferredTime: f.preferredTime || 'Any time', tags: f.tags || [] };
      if (!row.address) fail('Enter a delivery address.');
      if (f.id) { Repo.update('customers', Repo.get('customers', f.id), row); log('Customer profile updated', { customerId: f.id }); return Repo.get('customers', f.id); }
      const id = 'C-' + String(Repo.nextId('CUS', 1)).padStart(4, '0');
      const c = Repo.insert('customers', { id, ...row, notes: [], at: Clock.now() }); log('Customer created', { customerId: id }); return c;
    });
  },
  setCustomerTags(id, tags) { return Repo.tx(() => { Repo.update('customers', Repo.get('customers', id), { tags }); log('Customer tags updated: ' + (tags.join(', ') || 'none'), { customerId: id }); }); },
  logContact({ customerId, channel, direction, summary, followUp }) {
    return Repo.tx(() => {
      if (!summary?.trim()) fail('Summarize the conversation.');
      Repo.insert('contacts', { id: 'CT-' + Repo.nextId('CT', 1), customerId, channel, direction, summary: summary.trim(), followUp: followUp || '', at: Clock.now(), by: activityBy() });
      log(`Contact logged (${channel}, ${direction})`, { customerId });
    });
  },

  /* CAMPAIGNS */
  saveCampaign(f) {
    return Repo.tx(() => {
      if (!f.name?.trim()) fail('Enter a campaign name.');
      if (f.end && f.start && f.end < f.start) fail('End date must be on or after the start date.');
      const row = { name: f.name.trim(), platform: f.platform, start: f.start, end: f.end, budget: Number(f.budget) || 0, reportedRoas: Number(f.reportedRoas) || 0, source: 'Manual', metaId: String(f.metaId ?? '').trim() || null };
      if (row.metaId && !/^[0-9A-Za-z_-]{3,40}$/.test(row.metaId)) fail('A Meta campaign ID is letters, digits, dashes or underscores, as shown in Ads Manager.');
      if (row.budget < 0 || row.reportedRoas < 0) fail('Budget and ROAS cannot be negative.');
      if (f.id) { Repo.update('campaigns', Repo.get('campaigns', f.id), row); log(`Campaign ${row.name} updated`, {}); return f.id; }
      const id = 'CMP-' + Repo.nextId('CMP', 1); Repo.insert('campaigns', { id, ...row }); log(`Campaign ${row.name} created`, {}); return id;
    });
  },
  addSpend({ campaignId, amount, at, note }) {
    return Repo.tx(() => {
      amount = round2(amount); if (!amount) fail('Enter a non-zero amount. Use a negative amount for a correction.');
      const c = Repo.get('campaigns', campaignId); if (!c) fail('Unknown campaign.');
      if (campaignSpend(c) + amount < 0) fail('A correction cannot take total spend below zero.');
      assertOpen(at, 'This spend');
      Repo.insert('spend', { id: 'SP-' + Repo.nextId('SP', 1), campaignId, amount, at: at || Clock.now(), note: note || '', by: activityBy() });
      log(`Spend recorded on ${c.name}: ${money(amount)}`, { audience: 'finance' });
    });
  },
  addExpense({ name, category, amount, at }) {
    return Repo.tx(() => {
      amount = round2(amount); if (!(amount > 0)) fail('Amount must be positive.');
      if (!name?.trim()) fail('Enter a description.');
      assertOpen(at, 'This expense');
      Repo.insert('expenses', { id: 'EXP-' + Repo.nextId('EXP', 1), name: name.trim(), category, amount, at: at || Clock.now(), by: activityBy() });
      log(`Operating expense: ${name.trim()} ${money(amount)}`, { audience: 'finance' });
    });
  },
  removeExpense(id) { return Repo.tx(() => { const e = Repo.get('expenses', id); if (!e) fail('That expense no longer exists.'); assertOpen(e.at, 'This expense'); Repo.remove('expenses', e); log(`Operating expense removed: ${e.name} ${money(e.amount)}`, { audience: 'finance' }); }); },

  /* CARRIERS */
  saveDriver(f) {
    return Repo.tx(() => {
      const name = (f.name || '').trim(), phone = (f.phone || '').replace(/[\s-]/g, '');
      if (!name) fail('Enter the driver name.');
      if (!/^01[0125]\d{8}$/.test(phone)) fail('Enter a valid Egyptian mobile number.');
      const row = { name, phone, availability: f.availability || 'Available', vehicle: f.vehicle || '', zones: f.zones || '', active: f.active !== false };
      if (f.id) {
        const d = Repo.get('drivers', f.id);
        if (row.active === false && driverCash(f.id).outstanding > tol()) fail(`${name} still holds ${money(driverCash(f.id).outstanding)}. Reconcile the cash before deactivating.`);
        if (row.active === false && driverStats(f.id).deliveries.some(x => !TERMINAL_DELIVERY.has(x.status))) fail(`${name} still has active deliveries. Reassign or finish them first.`);
        Repo.update('drivers', d, row); log('Driver record updated', { driverId: f.id }); return f.id;
      }
      const id = 'DRV-' + Repo.nextId('DRV', 1); Repo.insert('drivers', { id, ...row, at: Clock.now() }); log('Driver record created', { driverId: id }); return id;
    });
  },
  setAvailability(id, availability) { return Repo.tx(() => { const d = Repo.get('drivers', id); if (d.active === false) fail('Reactivate this driver first.'); Repo.update('drivers', d, { availability }); log(`Availability → ${availability}`, { driverId: id }); }); },
  saveCourier(f) {
    return Repo.tx(() => {
      if (!f.name?.trim()) fail('Enter a courier name.');
      const row = { name: f.name.trim(), shipRate: Number(f.shipRate) || 0, returnRate: Number(f.returnRate) || 0, codFee: Number(f.codFee) || 0, active: f.active !== false };
      if ([row.shipRate, row.returnRate, row.codFee].some(n => n < 0)) fail('Rates cannot be negative.');
      if (f.id) { Repo.update('couriers', Repo.get('couriers', f.id), row); log(`Courier ${row.name} updated`, {}); return f.id; }
      const id = row.name.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 10) + '-' + Repo.nextId('CRR', 1);
      Repo.insert('couriers', { id, ...row }); log(`Courier ${row.name} added`, {}); return id;
    });
  },
  /* PERIOD CLOSING. Every figure is dated, so a closed period stays fixed once no
     entry dated inside it can be added or removed. The closing figures are kept so
     the integrity check can prove they never changed. */
  closePeriod(through) {
    return Repo.tx(() => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(through || '') || isNaN(new Date(through + 'T12:00:00Z'))) fail('Choose the last day to close.');
      const today = dateKey(Clock.now()), lock = lockedThrough();
      if (through >= today) fail(`You can only close days that have ended. Choose a date before ${today}.`);
      if (lock && through <= lock) fail(`The books are already closed through ${lock}. Choose a later date.`);
      const t = totals({ to: through });
      const figures = { revenue: t.revenue, cogs: t.cogs, delivery: t.delivery, fees: t.fees, marketing: t.marketing, opex: t.opex, driverexp: t.driverexp, profit: t.profit, collected: t.collected, bizcash: t.bizcash };
      setSettings({ lockedThrough: through, periodLog: [...(S().periodLog || []), { kind: 'close', through, at: Clock.now(), by: activityBy(), figures }] });
      log(`Books closed through ${through}`, {});
      return through;
    });
  },
  reopenPeriod(through, reason) {
    return Repo.tx(() => {
      const lock = lockedThrough(); if (!lock) fail('No period is closed.');
      if (!reason?.trim()) fail('Record why the period is being reopened.');
      through = through || null;
      if (through && (!/^\d{4}-\d{2}-\d{2}$/.test(through) || through >= lock)) fail(`Choose a date before ${lock}, or leave it empty to reopen everything.`);
      setSettings({ lockedThrough: through, periodLog: [...(S().periodLog || []), { kind: 'reopen', through, from: lock, at: Clock.now(), by: activityBy(), reason: reason.trim() }] });
      log(`Books reopened: ${through ? `now closed through ${through}` : 'no period closed'} (was ${lock}). Reason: ${reason.trim()}`, {});
    });
  },
  saveSettings(patch) {
    return Repo.tx(() => {
      const before = Repo.data.settings; Repo.data.settings = { ...before, ...patch };
      if (Repo.undo) Repo.undo.push(() => { Repo.data.settings = before; });
      Repo.touch(); log('Settings updated: ' + Object.keys(patch).join(', '), {});
    });
  },
};

function setSettings(patch) {
  const before = Repo.data.settings; Repo.data.settings = { ...before, ...patch };
  if (Repo.undo) Repo.undo.push(() => { Repo.data.settings = before; });
  Repo.touch();
}
/* The figures recorded when the latest period was closed, compared with today's figures for the same dates. */
function closingCheck() {
  const lock = lockedThrough(), last = [...(S()?.periodLog || [])].reverse().find(x => x.kind === 'close' && x.through === lock && x.figures);
  if (!lock || !last) return null;
  const t = totals({ to: lock }), diffs = Object.keys(last.figures).filter(k => Math.abs(round2(t[k] - last.figures[k])) >= 0.01);
  return { through: lock, closedAt: last.at, by: last.by, figures: last.figures, now: t, diffs };
}

/* Display money for validation messages. UI uses the same function. */
const _nf = new Intl.NumberFormat('en-EG', { maximumFractionDigits: 2 });
function money(n) { return `${S()?.currency || 'EGP'} ${_nf.format(round2(n || 0))}`; }

/* ---------- Company ledger and aggregates ---------- */
const _ledger = { v: -1, rows: [] };
function ledger() {
  if (_ledger.v === Repo.version) return _ledger.rows; _ledger.v = Repo.version;
  const rows = [];
  for (const o of Repo.all('orders')) for (const e of calc(o).entries) rows.push(e);
  for (const s of Repo.all('spend')) rows.push({ acct: 'marketing', at: s.at, d: dateKey(s.at), amt: s.amount, campaignId: s.campaignId, why: s.note || 'Campaign spend' });
  for (const e of Repo.all('expenses')) rows.push({ acct: 'opex', at: e.at, d: dateKey(e.at), amt: e.amount, why: e.name });
  for (const x of Repo.all('driverExpenses')) if (x.status === 'Approved' && x.category !== 'Delivery fee payout') rows.push({ acct: 'driverexp', at: x.decidedAt || x.at, d: dateKey(x.decidedAt || x.at), amt: x.amount, why: `${x.category} ${x.id}` });
  return _ledger.rows = rows;
}
/* filter = { from, to, orders:Set|null }. Order filters hide company-level accounts. */
function totals(filter = {}) {
  const t = { revenue: 0, cogs: 0, delivery: 0, fees: 0, collected: 0, bizcash: 0, marketing: 0, opex: 0, driverexp: 0 };
  for (const e of ledger()) {
    if (filter.from && e.d < filter.from) continue;
    if (filter.to && e.d > filter.to) continue;
    if (filter.orders && (e.orderId === undefined || !filter.orders.has(e.orderId))) continue;
    t[e.acct] += e.amt;
  }
  for (const k in t) t[k] = round2(t[k]);
  t.gross = round2(t.revenue - t.cogs);
  t.profit = round2(t.revenue - t.cogs - t.delivery - t.fees - t.marketing - t.opex - t.driverexp);
  return t;
}

/* ---------- Integrity checks, shown in Settings and run by the test harness ---------- */
function integrity() {
  const out = [], check = (name, a, b) => out.push({ name, a: round2(a), b: round2(b), ok: Math.abs(a - b) < 0.05 });
  const os = Repo.all('orders'), t = totals();
  check('Order revenue totals match the company ledger', sum(os, o => calc(o).revenue), t.revenue);
  check('Order contribution reconciles to operating profit', sum(os, contributionOf) - (t.marketing - sum(os, allocationOf)) - t.opex - t.driverexp, t.profit);
  const drivers = Repo.all('drivers');
  const heldByDrivers = sum(drivers, d => { const c = driverCash(d.id); return c.collected - c.refunds; });
  const courierHeld = sum(Repo.all('payments').filter(p => p.holderKey.startsWith('courier:')), p => p.amount);
  const direct = sum(Repo.all('payments').filter(p => p.holderKey === 'business'), p => p.amount);
  check('Customer collections equal direct receipts + driver cash + courier cash', t.collected, direct + heldByDrivers + courierHeld);
  const handed = sum(Repo.all('handovers'), h => h.amount), allocs = sum(Repo.all('handoverAllocs'), a => a.amount);
  check('Driver handovers equal their per-delivery allocations', handed, allocs);
  const settled = sum(Repo.all('settlements'), s => s.net), sa = sum(Repo.all('settlementAllocs'), a => a.net);
  check('Courier settlements equal their allocations', settled, sa);
  const feesOnDirect = sum(Repo.all('payments').filter(p => p.holderKey === 'business'), p => p.fee || 0);
  check('Business cash equals direct receipts + handovers + settlements', t.bizcash, direct - feesOnDirect + handed + settled);
  check('Driver custody formula holds for every driver', sum(drivers, d => driverCash(d.id).outstanding), sum(drivers, d => { const c = driverCash(d.id); return c.collected - c.handed - c.approvedCash - c.refunds; }));
  const withOrders = Repo.all('campaigns').filter(c => Repo.by('orders', 'campaignId', c.id).some(o => o.status !== 'Cancelled'));
  check('Spend on campaigns with orders is fully allocated to those orders', [...marketingAlloc().values()].reduce((s, v) => s + v, 0), sum(withOrders, campaignSpend));
  let onePerOrder = 0; for (const o of os) if (Repo.by('deliveries', 'orderId', o.id).filter(d => !TERMINAL_DELIVERY.has(d.status)).length > 1) onePerOrder++;
  check('Orders with more than one active delivery', onePerOrder, 0);
  const neg = Repo.all('skus').filter(s => stockOnHand(s.id) < 0).length + Repo.all('materials').filter(m => stockOnHand(m.id) < -1e-6).length;
  check('Items with negative stock', neg, 0);
  const cc = closingCheck(); if (cc) check(`Closed books through ${cc.through} still match their closing figures`, cc.diffs.length, 0);
  let lineBad = 0; for (const l of Repo.all('lines')) if (l.delivered + l.undeliveredBack > l.dispatched || l.returned > l.delivered || l.reserved > l.qty) lineBad++;
  check('Line quantities outside their limits', lineBad, 0);
  const keys = new Set(); let dupKeys = 0; for (const m of Repo.all('movements')) if (m.key) { if (keys.has(m.key)) dupKeys++; keys.add(m.key); }
  check('Duplicate stock-movement keys', dupKeys, 0);
  let overAlloc = 0; for (const d of Repo.all('deliveries')) if (d.mode === 'driver' && deliveryCash(d).unhanded < -0.001) overAlloc++;
  check('Deliveries with cash allocated more than once', overAlloc, 0);
  return out;
}

export { RETURN_REASONS, assertOpen, closingCheck, lockedThrough, ACTIVE_CUSTODY, AREAS, CHANNELS, COLLECTION_OUTCOMES, Commands, DEFAULT_SETTINGS, DELIVERY_FLOW, DELIVERY_STATUSES, DRIVER_EXPENSE_CATS, ENTRY_METHODS, EXPENSE_CATS, FAILURE_REASONS, Guards, ORDER_STATUSES, PAYMENT_METHODS, PAYMENT_STATUSES, S, TERMINAL_DELIVERY, _calc, _dk, _fresh, _ledger, _nf, activeDelivery, activityBy, allocationOf, availableOf, bomCost, calc, campaignSpend, carrierKey, carrierName, casesOf, collectionOutcome, contributionOf, courierDeliveryBalance, courierOutcome, courierSummary, customerOf, dateKey, deliveriesOf, deliveryCash, driverCash, driverStats, expectedFromCustomer, integrity, isOverdue, ledger, linesOf, log, marketingAlloc, money, netUnit, orderEntries, orderMerch, orderOf, orderValue, overdueWhy, paymentStatus, paymentsOf, postMovement, reservedOf, settlementStatus, stockOnHand, tol, totals };
