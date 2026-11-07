/* Read endpoints for the browser: a paged first load, then only what changed. */
import { carrierKey } from '@commerce-os/domain';
import { pool, withTx, selectRows, readWorkspace, colList, q, snake, fromDb, idParam, TABLES, ensureColumns, type Client } from './db.ts';
import type { User } from './store.ts';

const PAGE_BYTES = 3_000_000;   // stays well under Vercel's 4.5 MB response limit
export async function version() {
  await ensureColumns();
  const w = await readWorkspace(pool);
  return { v: Number(w.version), schema: w.schema, settings: w.settings, roadmap: w.roadmap };
}
/* One page of one table, sized by bytes, ordered by insertion. Returns JSON text. */
export async function snapshotPage(table: string, after: number) {
  if (!TABLES.includes(table)) return null;
  await ensureColumns();
  const r = await pool.query(`SELECT "_seq", ${colList(table)} FROM ${q(snake(table))} WHERE "_seq" > $1 ORDER BY "_seq" LIMIT 4000`, [after]);
  let size = 0, next: number | null = null; const parts: string[] = [];
  for (const row of r.rows) {
    const s = JSON.stringify(fromDb(row));
    if (size + s.length > PAGE_BYTES && parts.length) { next = Number(row._seq) - 1; break; }
    parts.push(s); size += s.length + 1;
  }
  if (next === null && r.rows.length === 4000) next = Number(r.rows.at(-1)._seq);
  return `{"rows":[${parts.join(',')}],"next":${next}}`;
}
/* A driver receives only their own deliveries and the orders behind them. */
export async function driverSnapshot(user: User) {
  await ensureColumns();
  return withTx(async c => {
    const w = await readWorkspace(c), key = carrierKey('driver', user.driverId!);
    const mine = await selectRows(c, 'deliveries', 'carrier_key=$1', [key]), orderIds = [...new Set(mine.map(d => d.orderId))];
    const byOrder = (t: string) => selectRows(c, t, 'order_id = ANY($1)', [orderIds]);
    const tables: Record<string, any[]> = Object.fromEntries(TABLES.map(t => [t, []]));
    tables.orders = await selectRows(c, 'orders', 'id = ANY($1)', [orderIds]);
    for (const t of ['lines', 'deliveries', 'payments', 'cases', 'handoverAllocs']) tables[t] = await byOrder(t);
    tables.lines = tables.lines.map(l => ({ ...l, unitCost: 0 }));
    const hoIds = [...new Set(tables.handoverAllocs.map(a => a.handoverId))];
    tables.handovers = await selectRows(c, 'handovers', 'driver_id=$1 OR id = ANY($2)', [user.driverId, hoIds]);
    tables.drivers = await selectRows(c, 'drivers', 'id=$1', [user.driverId]);
    const custIds = [...new Set(tables.orders.map(o => o.customerId))];
    tables.customers = (await selectRows(c, 'customers', 'id = ANY($1)', [custIds])).map(x => ({ id: x.id, name: x.name, phone: x.phone, area: x.area, address: x.address, deliveryNotes: x.deliveryNotes, tags: [] }));
    tables.driverExpenses = await selectRows(c, 'driverExpenses', 'driver_id=$1', [user.driverId]);
    tables.discrepancies = await selectRows(c, 'discrepancies', 'carrier_key=$1', [key]);
    tables.events = (await c.query(`SELECT ${colList('events')} FROM events WHERE driver_id=$1 ORDER BY "_seq" DESC LIMIT 300`, [user.driverId])).rows.map(fromDb).reverse();
    return { version: Number(w.version), schema: w.schema, seq: {}, settings: w.settings, roadmap: {}, tables };
  }, 'REPEATABLE READ');
}
/* Everything that changed after `since`, read from one consistent view of the database. */
export async function changesSince(since: number, user: User) {
  await ensureColumns();
  return withTx(async (c: Client) => {
    const w = await readWorkspace(c), v = Number(w.version);
    if (since >= v) return { v, changes: [] };
    if (user.role === 'driver') return { v, resync: true };
    if (since < Number(w.changes_floor)) return { v, resync: true };
    const log = (await c.query('SELECT version, t, row_id, op FROM changes WHERE version > $1 AND version <= $2 ORDER BY version, ord', [since, v])).rows;
    if (log.length > 20000 || log.some(r => r.op === 'resync')) return { v, resync: true };
    const last = new Map<string, any>(); for (const r of log) { const k = r.t + ':' + r.row_id; last.delete(k); last.set(k, r); }
    const want: Record<string, string[]> = {};
    const out: any[] = [];
    for (const r of last.values()) if (r.op === 'delete') out.push({ t: r.t, op: 'delete', row: { id: idParam(r.t, [r.row_id])[0] } }); else (want[r.t] ??= []).push(r.row_id);
    for (const t in want) for (const row of await selectRows(c, t, 'id = ANY($1)', [idParam(t, want[t])])) out.push({ t, op: 'upsert', row });
    return { v, changes: out, meta: { settings: w.settings, roadmap: w.roadmap } };
  }, 'REPEATABLE READ');
}
/* Streams a full backup table by table, so its size isn't limited by one response. */
export async function* backupChunks() {
  await ensureColumns();
  const w = await readWorkspace(pool);
  yield `{"schema":${w.schema},"workspaceId":"ws-1","seq":${JSON.stringify(w.seq)},"settings":${JSON.stringify(w.settings)},"roadmap":${JSON.stringify(w.roadmap)},"tables":{`;
  for (let i = 0; i < TABLES.length; i++) {
    const t = TABLES[i]; yield `${i ? ',' : ''}"${t}":[`;
    let after = 0, firstRow = true;
    for (;;) {
      const r = await pool.query(`SELECT "_seq", ${colList(t)} FROM ${q(snake(t))} WHERE "_seq" > $1 ORDER BY "_seq" LIMIT 2000`, [after]);
      if (!r.rows.length) break;
      yield r.rows.map(x => (firstRow ? (firstRow = false, '') : ',') + JSON.stringify(fromDb(x))).join('');
      after = Number(r.rows.at(-1)._seq);
    }
    yield ']';
  }
  yield '}}';
}
