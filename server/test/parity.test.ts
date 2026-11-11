/* The server loads only part of the workspace per command. This test proves
   that changes nothing: hundreds of random operations run both through the
   server (PostgreSQL, partial loads) and against a complete in-memory copy, and
   every outcome and the final records must match exactly. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/commerce_os_test';
const { migrateDb, ensureColumns, pool, loadAll, replaceAll, withTx } = await import('../src/db.ts');
const { runCommand } = await import('../src/store.ts');
const D = await import('@commerce-os/domain');
const { buildSeedWorkspace, rngFrom } = await import('@commerce-os/domain/seed') as any;
const { Repo, Commands, Clock, Actor, Rule, TERMINAL_DELIVERY, calc, deliveryCash, driverCash, courierDeliveryBalance, linesOf, round2, availableOf } = D as any;
const user = { id: 1, email: 'p@t.test', name: 'Parity', role: 'owner', driverId: null };
let ref: any;
before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrateDb(); await ensureColumns();
  const seed = buildSeedWorkspace(); ref = JSON.parse(JSON.stringify(seed));
  await withTx(c => replaceAll(c, seed, 1));
});
after(async () => { await pool.end(); });

const pick = (r: () => number, a: any[]) => a[Math.floor(r() * a.length)];
/* Chooses a plausible next operation from the reference state, sometimes a deliberately invalid one. */
function nextOp(r: () => number, step: number): [string, any[]] {
  const orders = Repo.all('orders'), dels = Repo.all('deliveries'), by = (s: string) => orders.filter((o: any) => o.status === s), dBy = (s: string) => dels.filter((d: any) => d.status === s);
  const drivers = Repo.all('drivers').filter((d: any) => d.active !== false && d.availability !== 'Off duty').map((d: any) => d.id);
  const any = (a: any[]) => a.length ? pick(r, a) : null;
  const choices: (() => [string, any[]] | null)[] = [
    () => ['createOrder', [{ customerId: pick(r, Repo.all('customers')).id, channel: 'Phone', paymentMethod: r() < .8 ? 'COD' : 'InstaPay', discount: r() < .3 ? 50 : 0, deliveryFee: r() < .5 ? 60 : 0, lines: [{ sku: pick(r, Repo.all('skus')).id, qty: 1 + Math.floor(r() * 3) }, ...(r() < .4 ? [{ sku: 'TOT-NAT', qty: 1 }] : [])] }]],
    () => { const o = any(by('New')); return o && ['confirmOrder', [o.id]]; },
    () => { const o = any(by('Confirmed')); return o && ['advanceOrder', [o.id, 'Processing']]; },
    () => { const o = any(by('Processing')); return o && ['advanceOrder', [o.id, 'Ready']]; },
    () => { const o = any(orders.filter((x: any) => ['Ready', 'Confirmed'].includes(x.status))); return o && ['assign', [o.id, r() < .6 ? 'driver' : 'courier', r() < .6 ? pick(r, drivers) : pick(r, ['BOSTA', 'MYLERZ'])]]; },
    () => { const d = any(dBy('Assigned')); return d && ['pickup', [d.id]]; },
    () => { const d = any([...dBy('Picked Up'), ...dBy('Retry Scheduled')]); return d && ['setDeliveryStatus', [d.id, 'Out for Delivery']]; },
    () => { const d = any(dBy('Out for Delivery')); return d && ['setDeliveryStatus', [d.id, 'Failed Attempt', { reason: 'Customer unreachable' }]]; },
    () => { const d = any(dBy('Failed Attempt')); return d && ['setDeliveryStatus', [d.id, 'Retry Scheduled', { retryAt: Clock.now() }]]; },
    () => { const d = any(dBy('Out for Delivery')); if (!d) return null; const qs: any = {}; for (const it of d.items) qs[it.lineId] = r() < .2 ? Math.max(0, it.qty - 1) : it.qty; const o = Repo.get('orders', d.orderId), c = calc(o); const units = new Map(linesOf(o).map((l: any) => [l.id, D.netUnit(l, o)])); const exp = round2(Math.max(0, d.items.reduce((s: number, it: any) => s + qs[it.lineId] * (units.get(it.lineId) as number), 0) + (Object.values(qs).some((q: any) => q > 0) ? o.deliveryFee : 0) - c.paid)); const roll = r(); return ['deliver', [d.id, { quantities: qs, reason: 'partial', collection: exp <= 0 || roll < .15 ? { amount: 0, shortReason: 'none' } : roll < .3 ? { amount: round2(exp / 2), method: 'Cash', shortReason: 'short' } : roll < .45 ? { amount: exp, method: 'InstaPay', ref: `IP-${step}` } : { amount: exp, method: 'Cash' } }]]; },
    () => { const d = any(dels.filter((x: any) => x.completedAt && round2(calc(Repo.get('orders', x.orderId)).revenue - calc(Repo.get('orders', x.orderId)).paid) > 1)); if (!d) return null; const c = calc(Repo.get('orders', d.orderId)); return ['collect', [d.id, { amount: round2(c.revenue - c.paid), method: 'Cash' }]]; },
    () => { const d = any([...dBy('Failed Attempt'), ...dBy('Partially Delivered'), ...dBy('Retry Scheduled')]); return d && ['startReturn', [d.id]]; },
    () => { const d = any(dBy('Return in Transit')); return d && ['receiveAtWarehouse', [d.id, '', pick(r, [{}, { reason: 'Customer refused', shipping: 'business' }, { reason: 'Customer not available', shipping: 'waived' }, { reason: 'Customer not available', shipping: 'customer', fee: 55, paidTo: pick(r, ['unpaid', 'carrier', 'business']) }])]]; },
    () => { const id = pick(r, ['DRV-1', 'DRV-2', 'DRV-3', 'DRV-4']); let room = driverCash(id).outstanding; const allocs: any[] = []; for (const d of Repo.by('deliveries', 'carrierKey', `driver:${id}`)) { const left = deliveryCash(d).unhanded; if (left > 0 && room > 0) { const a = round2(Math.min(left, room, r() < .3 ? left / 2 : left)); if (a > 0) { allocs.push({ deliveryId: d.id, amount: a }); room = round2(room - a); } } } return allocs.length ? ['recordHandover', [{ driverId: id, ref: `HO-P-${step}`, receivedBy: 'Parity', allocations: allocs, declared: r() < .2 ? 99999 : null }]] : null; },
    () => ['addDriverExpense', [{ driverId: pick(r, ['DRV-1', 'DRV-2', 'DRV-3']), category: pick(r, ['Fuel', 'Parking', 'Delivery fee payout']), amount: 20 + Math.floor(r() * 50), paidFromCash: true }]],
    () => { const e = any(Repo.all('driverExpenses').filter((x: any) => x.status === 'Pending')); return e && ['decideDriverExpense', [e.id, r() < .7 ? 'Approved' : 'Rejected']]; },
    () => { const o = any(orders.filter((x: any) => { const c = calc(x); return c.paid - c.revenue > 1 && (c.deliveredAny || ['Cancelled', 'Returned'].includes(x.status)); })); if (!o) return null; const c = calc(o), drv = Repo.by('deliveries', 'orderId', o.id).find((d: any) => d.mode === 'driver' && deliveryCash(d).unhanded > 0); return ['refund', [o.id, { amount: round2(c.paid - c.revenue), source: drv && r() < .5 ? drv.carrierKey : 'business', ref: `RF-P-${step}` }]]; },
    () => { const o = any(orders.filter((x: any) => linesOf(x).some((l: any) => l.delivered - l.returned - l.pendingReturn > 0))); if (!o) return null; const l = linesOf(o).find((x: any) => x.delivered - x.returned - x.pendingReturn > 0); return ['openCase', [{ orderId: o.id, type: r() < .3 ? 'Exchange' : 'Return', items: [{ lineId: l.id, qty: 1 }], reason: 'fit', returnCost: 40 }]]; },
    () => { const c = any(Repo.all('cases').filter((x: any) => x.status === 'Requested')); return c && [r() < .8 ? 'acceptReturn' : 'rejectCase', r() < .8 ? [c.id] : [c.id, 'damaged']]; },
    () => { const c = any(Repo.all('cases').filter((x: any) => x.type === 'Exchange' && x.status === 'Item received')); return c && ['createReplacement', [c.id, { sku: 'TEE-BLK', qty: 1 }]]; },
    () => { const id = pick(r, ['BOSTA', 'MYLERZ']); const ds = Repo.by('deliveries', 'carrierKey', `courier:${id}`).filter((d: any) => (d.completedAt || d.returnedAt) && Math.abs(courierDeliveryBalance(d).gap) > 0.01).slice(0, 5); return ds.length ? ['recordSettlement', [{ courierId: id, ref: `ST-P-${step}`, allocations: ds.map((d: any, i: number) => ({ deliveryId: d.id, net: round2(courierDeliveryBalance(d).gap + (i === 0 && r() < .3 ? -20 : 0)) })) }]] : null; },
    () => { const o = any(orders.filter((x: any) => ['New', 'Confirmed', 'Processing', 'Ready'].includes(x.status))); return o && ['cancelOrder', [o.id, 'changed mind']]; },
    () => { const d = any(dBy('Assigned')); return d && ['reassign', [d.id, 'driver', pick(r, drivers), 'zone']]; },
    () => { const d = any(dels.filter((x: any) => x.mode === 'driver' && ['Picked Up', 'Out for Delivery', 'Failed Attempt'].includes(x.status))); return d && ['driverHandover', [d.id, pick(r, drivers.filter((x: string) => x !== d.carrierId)), 'swap']]; },
    () => ['adjustStock', [{ item: pick(r, Repo.all('skus')).id, itemType: 'sku', qty: pick(r, [5, 10, -1]), reason: 'count' }]],
    () => ['createProduction', [{ sku: pick(r, Repo.all('skus')).id, qty: 3 }]],
    () => { const p = any(Repo.all('production').filter((x: any) => ['Planned', 'WIP'].includes(x.status))); return p && [p.status === 'Planned' ? 'startProduction' : 'completeProduction', [p.id]]; },
    () => ['addSpend', [{ campaignId: pick(r, Repo.all('campaigns')).id, amount: 100 + Math.floor(r() * 500) }]],
    () => { const o = any(orders); return o && ['attribute', [o.id, pick(r, [...Repo.all('campaigns').map((c: any) => c.id), null]), 'fix']]; },
    () => { const o = any(orders); return o && ['prepay', [o.id, { amount: 100, method: 'Card', ref: `CRD-P-${step}` }]]; },
    () => { const d = any(dels.filter((x: any) => x.mode === 'driver' && !TERMINAL_DELIVERY.has(x.status))); return d && ['saveDriver', [{ ...Repo.get('drivers', d.carrierId), active: false }]]; },
    () => ['saveCustomer', [{ name: 'Parity ' + step, phone: r() < .2 ? Repo.all('customers')[0].phone : `0109${String(1000000 + step).slice(0, 7)}`, area: 'Maadi', address: '1 Road' }]],
    () => { const x = any(Repo.all('discrepancies').filter((d: any) => d.status === 'Open')); return x && ['resolveDiscrepancy', [x.id, 'paid later']]; },
    () => { const o = any(orders.filter((x: any) => ['Delivered', 'Returned'].includes(x.status))); return o && ['confirmOrder', [o.id]]; },
    () => { const d = any(dels.filter((x: any) => TERMINAL_DELIVERY.has(x.status))); return d && ['pickup', [d.id]]; },
    () => r() < .3 && ['closePeriod', [D.dateKey(new Date(Date.parse(Clock.now()) - (1 + Math.floor(r() * 6)) * 864e5).toISOString())]],
    () => r() < .3 && ['reopenPeriod', [null, r() < .8 ? 'Correction' : '']],
    () => ['addExpense', [{ name: 'Parity ' + step, category: 'Rent', amount: 30, at: new Date(Date.parse(Clock.now()) - Math.floor(r() * 8) * 864e5).toISOString() }]],
    () => { const e = any(Repo.all('expenses')); return e && ['removeExpense', [e.id]]; },
  ];
  for (let i = 0; i < 30; i++) { const op = pick(r, choices)(); if (op) return op; }
  return ['addSpend', [{ campaignId: Repo.all('campaigns')[0].id, amount: 10 }]];
}
const outcome = (e: any) => e instanceof Rule ? 'rule:' + e.message : e?.code === '23505' ? 'duplicate' : 'error:' + (e?.message || e);

test('the server matches a complete in-memory model, operation by operation', async () => {
  const r = rngFrom(424242), start = Date.now(), counts: Record<string, number> = {};
  let failures = 0;
  for (let step = 0; step < 450; step++) {
    Clock.fixed = new Date(start + step * 60000).toISOString();
    Repo.load(ref);
    const [name, args] = nextOp(r, step), a1 = JSON.parse(JSON.stringify(args)), a2 = JSON.parse(JSON.stringify(args));
    let refOut: string, refResult: any;
    Actor.current = user.name;
    try { refResult = Repo.tx(() => Commands[name](...a1)); refOut = 'ok'; } catch (e) { refOut = outcome(e); }
    Actor.current = null;
    ref = Repo.data;
    let apiOut: string, apiResult: any;
    try { apiResult = (await runCommand(user, name, a2)).result; apiOut = 'ok'; } catch (e) { apiOut = outcome(e); }
    /* The reference has no unique indexes for every field, so its duplicate checks are only ever stricter. */
    const same = refOut === apiOut || (apiOut === 'duplicate' && refOut.startsWith('rule:'));
    assert.ok(same, `step ${step} ${name}: model said ${refOut}, server said ${apiOut}\nargs ${JSON.stringify(args).slice(0, 300)}`);
    if (refOut === 'ok') assert.deepEqual(JSON.parse(JSON.stringify(apiResult ?? null)), JSON.parse(JSON.stringify(refResult ?? null)), `step ${step} ${name} result`);
    counts[name + (refOut === 'ok' ? '' : ' (rejected)')] = (counts[name + (refOut === 'ok' ? '' : ' (rejected)')] || 0) + 1;
    if (refOut !== 'ok') failures++;
  }
  Clock.fixed = null;
  const db = (await loadAll())!.data;
  const norm = (rows: any[]) => rows.filter((x: any) => !String(x.id).startsWith('base:')).map((x: any) => JSON.parse(JSON.stringify(x, (k, v) => v === undefined ? null : typeof v === 'number' ? round2(v) : v === '' && /At$/.test(k) ? null : v)));
  for (const t of Object.keys(ref.tables)) {
    const x = norm(db.tables[t]), y = norm(ref.tables[t]);
    const byId = (rows: any[]) => new Map(rows.map(r => [String(r.id), r]));
    const mx = byId(x), my = byId(y);
    for (const [id, row] of my) { const o = mx.get(id); if (!o) assert.fail(`${t} ${id} missing in database`); for (const k of new Set([...Object.keys(row), ...Object.keys(o)])) assert.deepEqual(o[k] ?? null, row[k] ?? null, `${t} ${id}.${k}`); }
    assert.equal(mx.size, my.size, `${t} row count`);
  }
  assert.deepEqual(db.seq, ref.seq); assert.deepEqual(db.settings, ref.settings);
  Repo.load(db); assert.deepEqual(D.integrity().filter((x: any) => !x.ok), []);
  console.log(`  ${Object.keys(counts).length} kinds of operation, ${failures} correctly rejected, ${450 - failures} applied`);
});
