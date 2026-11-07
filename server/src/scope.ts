/* Loads just the records one command reads, so a request never needs the whole
   workspace in memory. Stock and reservation totals for everything else arrive
   as one summary row per item. */
import { TERMINAL } from './terminal.ts';
import { selectRows, readWorkspace, idParam, type Client } from './db.ts';

export type Scope = { orders: any[]; deliveries: any[]; drivers: any[]; cases: any[]; discrepancies: any[]; driverExpenses: any[]; customers: any[]; phones: any[]; campaignSpend: any[]; expenses: any[]; production: any[] };
const scope = (o: Partial<Scope> = {}): Scope => ({ orders: [], deliveries: [], drivers: [], cases: [], discrepancies: [], driverExpenses: [], customers: [], phones: [], campaignSpend: [], expenses: [], production: [], ...o });
const phone = (p: unknown) => typeof p === 'string' ? p.replace(/[\s-]/g, '') : null;
const first = (a: any[]) => a[0] && typeof a[0] === 'object' ? a[0] : {};

/* Which records each command reads. A command missing here can't run. */
export function scopeFor(name: string, a: any[]): Scope {
  switch (name) {
    case 'createOrder': return scope({ customers: [first(a).customerId] });
    case 'createOrderWithCustomer': return scope({ customers: [a[0]?.order?.customerId], phones: [phone(a[0]?.customer?.phone)] });
    case 'importOrders': return scope({ phones: Array.isArray(a[0]) ? a[0].map((g: any) => phone(g?.phone)) : [] });
    case 'addOrderNote': case 'confirmOrder': case 'advanceOrder': case 'cancelOrder': case 'attribute': case 'prepay': case 'assign': return scope({ orders: [a[0]] });
    case 'openCase': return scope({ orders: [first(a).orderId] });
    case 'refund': { const src = a[1]?.source; return scope({ orders: [a[0]], drivers: typeof src === 'string' && src.startsWith('driver:') ? [src.slice(7)] : [] }); }
    case 'reassign': case 'driverHandover': case 'pickup': case 'setDeliveryStatus': case 'deliver': case 'collect': case 'startReturn': case 'receiveAtWarehouse': return scope({ deliveries: [a[0]] });
    case 'recordHandover': case 'addDriverExpense': return scope({ drivers: [first(a).driverId] });
    case 'decideDriverExpense': return scope({ driverExpenses: [a[0]] });
    case 'resolveDiscrepancy': return scope({ discrepancies: [a[0]] });
    case 'recordSettlement': return scope({ deliveries: Array.isArray(first(a).allocations) ? first(a).allocations.map((x: any) => x?.deliveryId) : [] });
    case 'acceptReturn': case 'rejectCase': case 'createReplacement': case 'closeCase': return scope({ cases: [a[0]] });
    case 'startProduction': case 'completeProduction': case 'cancelProduction': return scope({ production: [a[0]] });
    case 'saveCustomer': return scope({ customers: [first(a).id], phones: [phone(first(a).phone)] });
    case 'setCustomerTags': return scope({ customers: [a[0]] });
    case 'logContact': return scope({ customers: [first(a).customerId] });
    case 'addSpend': return scope({ campaignSpend: [first(a).campaignId] });
    case 'removeExpense': return scope({ expenses: [a[0]] });
    case 'saveDriver': return scope({ drivers: first(a).id ? [first(a).id] : [] });
    case 'adjustStock': case 'createProduction': case 'receiveMaterial': case 'saveSku': case 'saveCampaign': case 'addExpense':
    case 'setAvailability': case 'saveCourier': case 'saveSettings': case 'setRoadmap': return scope();
    default: throw new Error(`No data scope defined for ${name}`);
  }
}
const clean = (a: any[]) => [...new Set(a.filter(x => x !== undefined && x !== null && x !== ''))];

/* Locks the workspace row first, so commands run one at a time across every server instance. */
export async function loadScope(c: Client, s: Scope) {
  const w = await readWorkspace(c, true);
  if (!w) throw new Error('Workspace not initialized. Run npm run db:migrate.');
  const tables: Record<string, Map<any, any>> = {};
  const put = (t: string, rows: any[]) => { const m = tables[t] ??= new Map(); for (const r of rows) m.set(r.id, r); return rows; };
  const byIds = async (t: string, ids: any[]) => ids.length ? put(t, await selectRows(c, t, `id = ANY($1)`, [idParam(t, ids)])) : [];
  for (const t of ['skus', 'boms', 'materials', 'couriers', 'drivers', 'campaigns']) put(t, await selectRows(c, t, 'true'));
  const orderIds = new Set<number>(clean(s.orders).map(Number).filter(Number.isFinite)), driverIds = new Set<string>(clean(s.drivers).map(String));
  for (const d of await byIds('deliveries', clean(s.deliveries))) orderIds.add(d.orderId);
  for (const x of await byIds('cases', clean(s.cases))) orderIds.add(x.orderId);
  for (const x of await byIds('discrepancies', clean(s.discrepancies))) { if (x.orderId) orderIds.add(x.orderId); if (x.carrierKey?.startsWith('driver:')) driverIds.add(x.carrierKey.slice(7)); }
  for (const x of await byIds('driverExpenses', clean(s.driverExpenses))) driverIds.add(x.driverId);
  /* A driver's cash position needs all their deliveries, payments, handovers and expenses. */
  for (const id of driverIds) {
    const key = `driver:${id}`, ds = put('deliveries', await selectRows(c, 'deliveries', 'carrier_key=$1', [key])), dIds = ds.map(d => d.id);
    for (const d of ds) if (!TERMINAL.has(d.status)) orderIds.add(d.orderId);
    put('payments', await selectRows(c, 'payments', 'holder_key=$1 OR delivery_id = ANY($2)', [key, dIds]));
    put('handovers', await selectRows(c, 'handovers', 'driver_id=$1', [id]));
    put('handoverAllocs', await selectRows(c, 'handoverAllocs', 'driver_id=$1 OR delivery_id = ANY($2)', [id, dIds]));
    put('driverExpenses', await selectRows(c, 'driverExpenses', 'driver_id=$1', [id]));
    put('discrepancies', await selectRows(c, 'discrepancies', 'carrier_key=$1', [key]));
  }
  /* Everything about each order, so its money and status can be calculated. */
  const oIds = [...orderIds];
  if (oIds.length) {
    const orders = put('orders', await selectRows(c, 'orders', 'id = ANY($1)', [oIds]));
    for (const t of ['lines', 'deliveries', 'payments', 'cases', 'discrepancies', 'handoverAllocs', 'settlementAllocs']) put(t, await selectRows(c, t, 'order_id = ANY($1)', [oIds]));
    await byIds('handovers', clean([...(tables.handoverAllocs?.values() || [])].map(a => a.handoverId)));
    await byIds('settlements', clean([...(tables.settlementAllocs?.values() || [])].map(a => a.settlementId)));
    await byIds('customers', clean(orders.map(o => o.customerId)));
  }
  await byIds('customers', clean(s.customers));
  const phones = clean(s.phones); if (phones.length) put('customers', await selectRows(c, 'customers', 'phone = ANY($1)', [phones]));
  const camp = clean(s.campaignSpend); if (camp.length) put('spend', await selectRows(c, 'spend', 'campaign_id = ANY($1)', [camp]));
  await byIds('expenses', clean(s.expenses));
  await byIds('production', clean(s.production));
  /* Summary rows: total stock per item, and reservations held by orders not loaded above. */
  const stock = (await c.query(`SELECT item, item_type, sum(qty)::float AS qty FROM movements GROUP BY item, item_type`)).rows;
  put('movements', stock.map(r => ({ id: `base:${r.item}`, item: r.item, itemType: r.item_type, qty: r.qty, kind: 'Balance', key: null })));
  const held = (await c.query(`SELECT sku, sum(reserved)::int AS n FROM lines WHERE reserved > 0 AND NOT (order_id = ANY($1)) GROUP BY sku`, [oIds])).rows;
  put('lines', held.map(r => ({ id: `base:${r.sku}`, orderId: null, sku: r.sku, qty: r.n, reserved: r.n, dispatched: 0, delivered: 0, returned: 0, pendingReturn: 0, undeliveredBack: 0 })));
  const data: any = { schema: w.schema, workspaceId: 'ws-1', seq: w.seq, settings: w.settings, roadmap: w.roadmap, tables: {} };
  for (const t in tables) data.tables[t] = [...tables[t].values()];
  return { data, version: Number(w.version) };
}
