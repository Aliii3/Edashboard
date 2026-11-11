import { Clock, Repo, addHours, round2, sum } from './core.js';
import { AREAS, Commands, DEFAULT_SETTINGS, FAILURE_REASONS, S, calc, carrierKey, courierDeliveryBalance, dateKey, deliveryCash, driverCash, linesOf, postMovement, reservedOf, stockOnHand, totals } from './domain.js';
/* ==========================================================================
   LAYER 3 · DEMO DATA: fictional records built by running the real commands
   against a simulated clock, so sample data obeys the same rules as live use.
   ========================================================================== */
/* Rotates through the return outcomes so the demo shows each one. */
const seedReturns = { n: 0 };
function rngFrom(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
const FIRST = ['Ahmed', 'Sara', 'Omar', 'Nour', 'Mariam', 'Youssef', 'Farah', 'Karim', 'Hana', 'Tarek', 'Salma', 'Laila', 'Mostafa', 'Dina', 'Amr', 'Yasmin', 'Hassan', 'Rana', 'Sherif', 'Malak', 'Ziad', 'Habiba', 'Adham', 'Jana'];
const LAST = ['Samir', 'Hassan', 'Mostafa', 'Adel', 'Khaled', 'Ali', 'Ibrahim', 'Nabil', 'Mahmoud', 'Fathy', 'Hossam', 'Yasser', 'Saad', 'Lotfy', 'Zaki', 'Shawky', 'Rashad', 'Helmy'];
const STREETS = ['Palm Street', 'Road 9', 'Port Said Street', 'Tahrir Street', 'El Nozha Street', 'Abbas El Akkad', 'Gameat El Dowal', 'Corniche Road', 'Makram Ebeid', 'Mesaha Square'];
const pick = (rng, a) => a[Math.floor(rng() * a.length)];

function seedMasters() {
  Repo.data.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS));
  const mats = [['FAB-LIN', 'Linen fabric', 'm', 145, 'Fabric', 900, 150], ['FAB-COT', 'Cotton jersey', 'm', 80, 'Fabric', 700, 120], ['FAB-CNV', 'Canvas', 'm', 60, 'Fabric', 180, 40], ['TRM-KIT', 'Trims kit', 'kit', 22, 'Trims', 900, 150], ['PKG-KIT', 'Packaging kit', 'kit', 18, 'Packaging', 1400, 200]];
  for (const [id, name, unit, cost, category, stock, min] of mats) {
    Repo.insert('materials', { id, name, unit, cost, category, min });
    postMovement({ item: id, itemType: 'material', qty: stock, kind: 'Opening balance', key: `open:${id}`, ref: 'Opening' });
  }
  const skus = [['LIN-SND', 'Linen shirt', 'Sand / M', 890, 15, 'FAB-LIN', 1.6, 70, 25], ['LIN-OLV', 'Linen shirt', 'Olive / L', 890, 15, 'FAB-LIN', 1.7, 70, 25], ['TRS-BLK', 'Everyday trousers', 'Black / M', 1150, 12, 'FAB-LIN', 2.1, 90, 30], ['TEE-IVR', 'Essential tee', 'Ivory / M', 490, 20, 'FAB-COT', 1.2, 30, 15], ['TEE-BLK', 'Essential tee', 'Black / L', 490, 20, 'FAB-COT', 1.25, 30, 15], ['SET-OAT', 'Lounge set', 'Oat / L', 1650, 10, 'FAB-COT', 3.6, 120, 40], ['DRS-TER', 'Wrap dress', 'Terracotta / S', 1390, 10, 'FAB-LIN', 2.6, 110, 35], ['TOT-NAT', 'Canvas tote', 'Natural', 350, 25, 'FAB-CNV', 0.8, 20, 10]];
  for (const [id, name, variant, price, min, fab, q, labor, overhead] of skus) {
    Repo.insert('skus', { id, name, variant, price, min });
    Repo.insert('boms', { id, lines: [{ material: fab, qty: q }, { material: 'TRM-KIT', qty: 1 }, { material: 'PKG-KIT', qty: 1 }], labor, overhead });
    postMovement({ item: id, itemType: 'sku', qty: 90, kind: 'Opening balance', key: `open:${id}`, ref: 'Opening' });
  }
  Repo.insert('couriers', { id: 'BOSTA', name: 'Bosta', shipRate: 65, returnRate: 40, codFee: 15, active: true });
  Repo.insert('couriers', { id: 'MYLERZ', name: 'Mylerz', shipRate: 60, returnRate: 45, codFee: 12, active: true });
  [['Mahmoud Fawzy', '01012340011', 'Motorcycle', 'New Cairo, Heliopolis, Nasr City'], ['Ibrahim Sayed', '01112340022', 'Motorcycle', 'Maadi, New Cairo'], ['Hany Ragab', '01212340033', 'Van', 'Giza, Dokki, Mohandessin'], ['Khaled Mansour', '01512340044', 'Motorcycle', 'Zamalek, Mohandessin, Dokki'], ['Ashraf Gaber', '01012340055', 'Van', '6th of October, Sheikh Zayed'], ['Walid Tawfik', '01112340066', 'Motorcycle', 'Heliopolis']].forEach(([name, phone, vehicle, zones], i) => {
    Repo.insert('drivers', { id: 'DRV-' + (i + 1), name, phone, vehicle, zones, availability: 'Available', active: true, at: Clock.now() });
  });
  Repo.data.seq.DRV = 6;
}
function seedCustomers(n, rng) {
  const made = [];
  for (let i = 0; i < n; i++) {
    const seqNo = (Repo.data.seq.CUS || 0) + 1, name = `${FIRST[(seqNo - 1) % FIRST.length]} ${LAST[(seqNo * 7) % LAST.length]}`;
    const area = pick(rng, AREAS), phone = ['010', '011', '012', '015'][seqNo % 4] + String(20000000 + seqNo * 137).slice(0, 8);
    const c = Commands.saveCustomer({ name, phone, area, address: `${1 + Math.floor(rng() * 90)} ${pick(rng, STREETS)}, ${area}`, deliveryNotes: rng() < .3 ? pick(rng, ['Call before arrival', 'Deliver after 6 pm', 'Leave with the building guard', 'Ring the bell once, baby sleeping']) : '', preferredTime: pick(rng, ['Any time', 'Morning', 'Afternoon', 'Evening']), tags: [] });
    made.push(c);
  }
  return made;
}
/* Drives one order through the real workflow to the requested state. */
function runScenario(o, target, mode, carrierId, rng, t0, ctx = {}) {
  let t = t0; const latest = addHours(ctx.now || t0, -0.05), step = h => { t = addHours(t, h); if (ctx.now && t > latest) t = latest; Clock.fixed = t; }, id = o.id;
  const netCollect = () => { const c = calc(o); return round2(c.revenue - c.paid); };
  if (target === 'new') return;
  if (target === 'cancel') { step(3); Commands.cancelOrder(id, pick(rng, ['Customer changed their mind', 'Duplicate order', 'Could not confirm by phone'])); return; }
  step(2); Commands.confirmOrder(id);
  if (target === 'confirmed') return;
  step(3); Commands.advanceOrder(id, 'Processing');
  if (target === 'processing') return;
  if (target === 'cancelLate') { step(2); Commands.cancelOrder(id, 'Customer cancelled during processing'); return; }
  step(4); Commands.advanceOrder(id, 'Ready');
  if (target === 'ready') return;
  step(1); const d = Commands.assign(id, mode, carrierId, { tracking: mode === 'courier' ? `${carrierId.slice(0, 2)}${100000 + id}` : '' });
  if (target === 'assigned') return;
  if (target === 'reassigned') { step(2); const alt = mode === 'driver' ? (carrierId === 'DRV-1' ? 'DRV-2' : 'DRV-1') : carrierId; if (alt !== carrierId) Commands.reassign(d.id, mode, alt, 'Better zone match'); return; }
  step(3); Commands.pickup(d.id);
  if (target === 'picked') return;
  if (target === 'handover' && mode === 'driver') { step(2); const to = carrierId === 'DRV-3' ? 'DRV-4' : 'DRV-3'; Commands.driverHandover(d.id, to, 'Zone swap at the warehouse gate'); return; }
  step(2); Commands.setDeliveryStatus(d.id, 'Out for Delivery', { note: 'Left for delivery round' });
  if (target === 'ofd') return;
  const failFirst = ['failed', 'retry', 'failedReturn', 'failedRTW'].includes(target) || rng() < .08;
  if (failFirst) { step(3); Commands.setDeliveryStatus(d.id, 'Failed Attempt', { reason: pick(rng, FAILURE_REASONS.slice(0, 5)), note: 'Called twice, no answer at the door' }); }
  if (target === 'failed') return;
  if (target === 'retry') { step(1); Commands.setDeliveryStatus(d.id, 'Retry Scheduled', { retryAt: addHours(t, ctx.retryIn ?? 30), note: 'Customer asked for another day' }); return; }
  if (target === 'failedReturn' || target === 'failedRTW') { step(5); Commands.startReturn(d.id, 'Customer unreachable after follow-up'); if (target === 'failedRTW') { step(4); const k = (seedReturns.n++) % 3; Commands.receiveAtWarehouse(d.id, '', [{ reason: 'Customer not available', shipping: 'customer', paidTo: 'unpaid' }, { reason: 'Customer refused', shipping: 'business' }, { reason: 'Wrong or incomplete address', shipping: 'waived' }][k]); } return; }
  if (failFirst) { step(10); Commands.setDeliveryStatus(d.id, 'Retry Scheduled', { retryAt: addHours(t, 4) }); step(5); Commands.setDeliveryStatus(d.id, 'Out for Delivery'); }
  step(3);
  const prepaid = o.paymentMethod !== 'COD';
  if (target === 'partial' || target === 'partialBack') {
    const qs = {}; let reduced = false; for (const it of d.items) { if (!reduced && it.qty > 1) { qs[it.lineId] = it.qty - 1; reduced = true; } else if (!reduced && d.items.length > 1) { qs[it.lineId] = 0; reduced = true; } else qs[it.lineId] = it.qty; }
    Commands.deliver(d.id, { quantities: qs, reason: 'Customer kept part of the order' });
    const due = netCollect(); if (due > 0 && !prepaid) Commands.collect(d.id, { amount: due, method: 'Cash' });
    if (target === 'partialBack') { step(3); Commands.startReturn(d.id, 'Bringing back the undelivered units'); step(4); Commands.receiveAtWarehouse(d.id, '', { reason: 'Customer refused', shipping: 'business' }); }
    return;
  }
  Commands.deliver(d.id, {});
  const due = netCollect();
  if (target === 'unpaid') return;
  if (target === 'shortpaid' && due > 100) { Commands.collect(d.id, { amount: round2(due - Math.min(200, Math.floor(due / 2))), method: 'Cash', shortReason: 'Customer short on cash, will transfer the rest' }); return; }
  if (due > 0) {
    if (target === 'wallet' || rng() < .1) Commands.collect(d.id, { amount: due, method: pick(rng, ['InstaPay', 'Mobile wallet']), ref: `TX-${id}-${Math.floor(rng() * 90000 + 10000)}` });
    else Commands.collect(d.id, { amount: due, method: 'Cash' });
  }
  if (target === 'returned' || target === 'exchange') {
    step(30); const ls = linesOf(o), l = ls[0];
    const cid = Commands.openCase({ orderId: id, type: target === 'exchange' ? 'Exchange' : 'Return', items: [{ lineId: l.id, qty: 1 }], reason: target === 'exchange' ? 'Size exchange: needs a larger size' : pick(rng, ['Size did not fit', 'Colour differs from photos', 'Changed mind within policy']), returnCost: 40 });
    step(20); if (ctx.leaveOpen) return;
    Commands.acceptReturn(cid);
    if (target === 'returned' && ctx.refund !== false) { step(4); const owed = round2(calc(o).paid - calc(o).revenue); if (owed > 0) Commands.refund(id, { amount: owed, source: 'business', ref: `RF-${id}`, reason: 'Accepted return' }); }
  }
}
const SCENARIOS = [
  ['paid', 34], ['wallet', 4], ['unpaid', 3], ['shortpaid', 3], ['partial', 2], ['partialBack', 2], ['returned', 5], ['exchange', 1],
  ['failed', 3], ['retry', 4], ['failedReturn', 3], ['failedRTW', 3], ['handover', 2], ['reassigned', 2], ['assigned', 5], ['picked', 4], ['ofd', 6],
  ['ready', 4], ['processing', 3], ['confirmed', 4], ['new', 6], ['cancel', 2], ['cancelLate', 1],
];
const STEP_HOURS = { confirmed: 3, processing: 6, ready: 10, assigned: 11, reassigned: 13, picked: 14, handover: 16, ofd: 16, failed: 19, retry: 20, failedReturn: 24 };
const ACTIVE_TARGETS = new Set(['failed', 'retry', 'failedReturn', 'handover', 'reassigned', 'assigned', 'picked', 'ofd', 'ready', 'processing', 'confirmed', 'new']);
function pickScenario(rng) { const total = SCENARIOS.reduce((s, x) => s + x[1], 0); let r = rng() * total; for (const [n, w] of SCENARIOS) { if ((r -= w) < 0) return n; } return 'paid'; }
function generateOrders(n, rng, now, { customers, campaigns, drivers, couriers, skus, spanDays = 26, forced = [] }) {
  const plan = Array.from({ length: n }, (_, i) => { const f = forced[i], target = f ? f[0] : pickScenario(rng); return { f, target, ageH: ACTIVE_TARGETS.has(target) ? (STEP_HOURS[target] || 6) + rng() * rng() * 44 : 130 + rng() * (spanDays * 24 - 130) }; }).sort((a, b) => b.ageH - a.ageH);
  for (const { f, target, ageH } of plan) {
    const t0 = addHours(now, -ageH); Clock.fixed = t0;
    const cust = pick(rng, customers), lineCount = rng() < .62 ? 1 : rng() < .75 ? 2 : 3, used = new Set(), ls = [];
    for (let j = 0; j < lineCount; j++) { let s = pick(rng, skus); if (used.has(s.id)) continue; used.add(s.id); ls.push({ sku: s.id, qty: rng() < .78 ? 1 : 2, discount: 0 }); }
    if (['partial', 'partialBack'].includes(target) && ls.length === 1 && ls[0].qty === 1) ls[0].qty = 2;
    const pm = rng(), paymentMethod = pm < .82 ? 'COD' : pm < .93 ? 'InstaPay' : 'Card';
    const o = Commands.createOrder({ customerId: cust.id, channel: pick(rng, ['Instagram', 'Instagram', 'WhatsApp', 'Facebook', 'Phone', 'Website']), source: rng() < .2 ? 'CSV' : 'Manual', campaignId: rng() < .62 ? pick(rng, campaigns).id : null, paymentMethod, discount: rng() < .18 ? pick(rng, [50, 100, 150]) : 0, deliveryFee: rng() < .55 ? pick(rng, [50, 60, 75]) : 0, lines: ls, at: t0, externalRef: null });
    if (paymentMethod !== 'COD' && target !== 'new' && target !== 'cancel') { const c = calc(o); Clock.fixed = addHours(t0, 1); Commands.prepay(o.id, { amount: c.value, method: paymentMethod, ref: `${paymentMethod === 'Card' ? 'CRD' : 'IPN'}-${o.id}-${Math.floor(rng() * 9000 + 1000)}` }); }
    const useDriver = f ? f[1].startsWith('DRV') : rng() < .52, mode = useDriver ? 'driver' : 'courier', carrierId = f ? f[1] : useDriver ? pick(rng, drivers) : pick(rng, couriers);
    runScenario(o, target, mode, carrierId, rng, t0, { now });
  }
}
function buildSeedWorkspace() {
  seedReturns.n = 0;
  Repo.load(Repo.empty());
  const rng = rngFrom(20261105), realNow = new Date().toISOString(); const now = realNow;
  Clock.fixed = addHours(now, -24 * 40);
  seedMasters();
  const customers = seedCustomers(36, rng);
  const camp = [['Autumn essentials', 'Meta', 30, -6, 16000, 4.8], ['Creators / linen edit', 'Instagram', 24, -3, 9000, 3.6], ['Returning customers', 'WhatsApp', 28, -10, 2500, 0], ['Winter teaser', 'Google', 8, -30, 3000, 2.1]];
  const camps = camp.map(([name, platform, ago, ahead, budget, reportedRoas]) => Repo.get('campaigns', Commands.saveCampaign({ name, platform, start: dateKey(addHours(now, -ago * 24)), end: dateKey(addHours(now, -ahead * 24)), budget, reportedRoas })));
  [[0, 3800, 28], [0, 4200, 18], [0, 3400, 7], [1, 2600, 20], [1, 2100, 9], [2, 450, 20], [3, 1600, 4]].forEach(([i, amount, ago]) => { Clock.fixed = addHours(now, -ago * 24); Commands.addSpend({ campaignId: camps[i].id, amount, at: Clock.fixed, note: 'Entered from platform invoice' }); });
  /* Walid (DRV-6): a completed history, then deactivated once fully reconciled. */
  for (let i = 0; i < 3; i++) { const t = addHours(now, -24 * (20 - i)); Clock.fixed = t; const o = Commands.createOrder({ customerId: customers[i].id, channel: 'Phone', lines: [{ sku: 'TEE-IVR', qty: 1 }], at: t }); runScenario(o, 'paid', 'driver', 'DRV-6', rng, t, { now }); }
  /* Winter teaser (index 3) has spend but no attributed orders, so it must appear as unallocated. */
  generateOrders(132, rng, now, { customers, campaigns: camps.slice(0, 3), drivers: ['DRV-1', 'DRV-2', 'DRV-3', 'DRV-4'], couriers: ['BOSTA', 'MYLERZ'], skus: Repo.all('skus'), forced: [
    ...['DRV-1', 'DRV-2', 'DRV-3', 'DRV-4'].flatMap(x => ['assigned', 'picked', 'ofd', 'retry', 'failed', 'failedReturn', 'paid', 'shortpaid'].map(t => [t, x])),
    ['handover', 'DRV-1'], ['handover', 'DRV-2'], ['reassigned', 'DRV-3'], ['reassigned', 'DRV-4'], ['partial', 'DRV-3'], ['partialBack', 'DRV-1'], ['returned', 'DRV-3'], ['exchange', 'DRV-1'], ['failedRTW', 'DRV-2'], ['paid', 'DRV-5'], ['paid', 'DRV-5'], ['paid', 'DRV-5'], ['wallet', 'DRV-5'], ['failedRTW', 'DRV-5'], ['paid', 'DRV-5'],
    ...['BOSTA', 'MYLERZ'].flatMap(x => ['assigned', 'picked', 'ofd', 'retry', 'failedReturn', 'failedRTW', 'partial', 'returned', 'unpaid'].map(t => [t, x])),
  ] });
  /* Driver cash reconciliation states. */
  const receive = (drv, ago, frac, ref, by, opts = {}) => {
    Clock.fixed = addHours(now, -ago);
    let ds = Repo.by('deliveries', 'carrierKey', carrierKey('driver', drv)).filter(d => d.completedAt && d.completedAt <= Clock.fixed).map(d => ({ d, left: deliveryCash(d).unhanded })).filter(x => x.left > 0);
    let target = round2(sum(ds, x => x.left) * frac); const allocs = [];
    for (const { d, left } of ds) { if (target <= 0) break; const a = Math.min(left, target); allocs.push({ deliveryId: d.id, amount: a }); target = round2(target - a); }
    if (allocs.length) Commands.recordHandover({ driverId: drv, ref, at: Clock.fixed, receivedBy: by, allocations: allocs, declared: opts.declared?.(sum(allocs, a => a.amount)), note: opts.note || '' });
  };
  const addExp = (drv, cat, amt, fromCash, decide, ago) => { Clock.fixed = addHours(now, -ago); const id = Commands.addDriverExpense({ driverId: drv, category: cat, amount: amt, paidFromCash: fromCash, note: `${cat} on delivery round` }); if (decide && driverCash(drv).outstanding >= amt) Commands.decideDriverExpense(id, decide); };
  receive('DRV-1', 3, 1, 'HO-MF-1101', 'Mona (Finance)');
  receive('DRV-5', 4, 1, 'HO-AG-1102', 'Mona (Finance)');
  receive('DRV-6', 100, 1, 'HO-WT-1050', 'Mona (Finance)');
  addExp('DRV-2', 'Fuel', 180, true, 'Approved', 26);
  receive('DRV-2', 20, .55, 'HO-IS-1103', 'Sherine (Operations)');
  addExp('DRV-3', 'Parking', 45, true, 'Approved', 12);
  addExp('DRV-3', 'Fuel', 220, true, null, 5);
  receive('DRV-4', 16, .7, 'HO-KM-1104', 'Sherine (Operations)', { declared: a => a + 150, note: 'Driver declared more than was counted' });
  addExp('DRV-4', 'Maintenance', 350, false, 'Approved', 8);
  Clock.fixed = addHours(now, -2);
  Commands.setAvailability('DRV-2', 'Busy'); Commands.setAvailability('DRV-5', 'Off duty');
  const w = Repo.get('drivers', 'DRV-6'); Commands.saveDriver({ ...w, availability: 'Off duty', active: false });
  /* Courier settlement states. */
  const settle = (cr, ago, frac, ref, adj = () => 0) => {
    Clock.fixed = addHours(now, -ago);
    const ds = Repo.by('deliveries', 'carrierKey', carrierKey('courier', cr)).filter(d => (d.completedAt || d.returnedAt) && (d.completedAt || d.returnedAt) <= Clock.fixed).sort((a, b) => a.assignedAt.localeCompare(b.assignedAt));
    const take = ds.slice(0, Math.floor(ds.length * frac));
    const allocations = take.map((d, i) => ({ deliveryId: d.id, net: round2(courierDeliveryBalance(d).expectedNet + adj(i)) })).filter(a => a.net !== 0);
    if (allocations.length) Commands.recordSettlement({ courierId: cr, ref, at: Clock.fixed, allocations, note: 'Weekly remittance statement' });
  };
  settle('BOSTA', 24, .7, 'BST-STM-4471', i => i === 2 ? -120 : 0);
  settle('MYLERZ', 20, .5, 'MYZ-STM-2093', i => i === 1 ? 80 : 0);
  /* Inventory: production, purchasing and a stock count that leaves some SKUs low. */
  Clock.fixed = addHours(now, -96); const m1 = Commands.createProduction({ sku: 'TEE-BLK', qty: 30, due: dateKey(addHours(now, -24)) }); Commands.startProduction(m1); Clock.fixed = addHours(now, -30); Commands.completeProduction(m1);
  Clock.fixed = addHours(now, -30); const m2 = Commands.createProduction({ sku: 'LIN-OLV', qty: 20, due: dateKey(addHours(now, 48)) }); Commands.startProduction(m2);
  Clock.fixed = addHours(now, -6); Commands.createProduction({ sku: 'SET-OAT', qty: 15, due: dateKey(addHours(now, 96)) });
  Commands.receiveMaterial({ item: 'FAB-LIN', qty: 120, ref: 'PO-7781' });
  for (const [sku, leave] of [['SET-OAT', 6], ['LIN-OLV', 9], ['TOT-NAT', 18]]) { const delta = reservedOf(sku) + leave - stockOnHand(sku); if (delta) Commands.adjustStock({ item: sku, itemType: 'sku', qty: delta, reason: 'Cycle count correction' }); }
  /* Company costs. */
  [['Studio rent', 'Rent', 9000, 25], ['Packing team salaries', 'Salaries', 7500, 12], ['Internet and phone lines', 'Utilities', 1350, 18], ['Shopfront and design software', 'Software', 900, 14]].forEach(([name, category, amount, ago]) => { Clock.fixed = addHours(now, -ago * 24); Commands.addExpense({ name, category, amount, at: Clock.fixed }); });
  /* CRM context. */
  Clock.fixed = addHours(now, -20);
  customers.slice(0, 5).forEach(c => Commands.setCustomerTags(c.id, ['VIP']));
  customers.slice(5, 9).forEach(c => Commands.setCustomerTags(c.id, ['Follow-up']));
  Commands.logContact({ customerId: customers[0].id, channel: 'Phone', direction: 'Outbound', summary: 'Confirmed size before dispatch. Prefers delivery after 6 pm.', followUp: '' });
  Commands.logContact({ customerId: customers[5].id, channel: 'WhatsApp', direction: 'Inbound', summary: 'Asked about the exchange policy for the linen shirt.', followUp: dateKey(addHours(now, 24)) });
  Clock.fixed = null;
  return Repo.data;
}
/* Load test: appends generated orders through the same commands and times them. */
function runLoadTest(n) {
  const listeners = Repo.listeners; Repo.listeners = [];
  const rng = rngFrom(Date.now() % 1e9), now = new Date().toISOString(), started = performance.now();
  try {
    Clock.fixed = addHours(now, -24 * 60);
    const customers = seedCustomers(Math.max(50, Math.floor(n / 6)), rng);
    for (const s of Repo.all('skus')) Commands.adjustStock({ item: s.id, itemType: 'sku', qty: Math.ceil(n / 2), reason: 'Load-test opening stock' });
    const drivers = Repo.all('drivers').filter(d => d.active !== false && d.availability !== 'Off duty').map(d => d.id);
    generateOrders(n, rng, now, { customers, campaigns: Repo.all('campaigns').slice(0, 3), drivers, couriers: Repo.all('couriers').filter(c => c.active !== false).map(c => c.id), skus: Repo.all('skus'), spanDays: 55 });
  } finally { Clock.fixed = null; Repo.listeners = listeners; }
  const writeMs = performance.now() - started, t2 = performance.now(); Repo.touch(); const t = totals(); const aggMs = performance.now() - t2;
  return { writeMs, aggMs, revenue: t.revenue, orders: Repo.all('orders').length };
}

export { ACTIVE_TARGETS, FIRST, LAST, SCENARIOS, STEP_HOURS, STREETS, buildSeedWorkspace, generateOrders, pick, pickScenario, rngFrom, runLoadTest, runScenario, seedCustomers, seedMasters };
