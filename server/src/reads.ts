/* Read endpoints for the browser: a paged first load, then only what changed. */
import { carrierKey, seesCosts, canReadTable, redactRow, redactSettings } from '@commerce-os/domain';
import { pool, withTx, selectRows, readWorkspace, colList, q, snake, fromDb, idParam, TABLES, ensureColumns, type Client } from './db.ts';
import type { User } from './store.ts';

const PAGE_BYTES = 3_000_000;   // stays well under Vercel's 4.5 MB response limit
export async function version(user: User) {
  await ensureColumns();
  const w = await readWorkspace(pool);
  return { v: Number(w.version), schema: w.schema, settings: redactSettings(user.role, w.settings), roadmap: w.roadmap };
}
/* A command's changes, cut down to what this role may read. */
export function redactDelta(user: User, delta: { v: number; changes: { t: string; op: string; row: any }[]; meta: any }) {
  if (seesCosts(user.role)) return delta;
  const changes = [];
  for (const c of delta.changes) {
    if (c.op === 'delete') { if (canReadTable(user.role, c.t)) changes.push(c); continue; }
    const row = redactRow(user.role, c.t, c.row); if (row) changes.push({ ...c, row });
  }
  return { v: delta.v, changes, meta: { ...delta.meta, settings: redactSettings(user.role, delta.meta.settings) } };
}
/* One page of one table, sized by bytes, ordered by insertion. Returns JSON text. */
export async function snapshotPage(table: string, after: number, user: User) {
  if (!TABLES.includes(table)) return null;
  if (!canReadTable(user.role, table)) return '{"rows":[],"next":null}';
  await ensureColumns();
  const hideFinance = table === 'events' && !seesCosts(user.role) ? ` AND audience IS DISTINCT FROM 'finance'` : '';
  const r = await pool.query(`SELECT "_seq", ${colList(table)} FROM ${q(snake(table))} WHERE "_seq" > $1${hideFinance} ORDER BY "_seq" LIMIT 4000`, [after]);
  let size = 0, next: number | null = null; const parts: string[] = [];
  for (const row of r.rows) {
    const s = JSON.stringify(redactRow(user.role, table, fromDb(row)));
    if (size + s.length > PAGE_BYTES && parts.length) { next = Number(row._seq) - 1; break; }
    parts.push(s); size += s.length + 1;
  }
  if (next === null && r.rows.length === 4000) next = Number(r.rows.at(-1)._seq);
  return `{"rows":[${parts.join(',')}],"next":${next}}`;
}
/* The whole first load in as few requests as possible: every table is read in parallel, and rows
   are packed into one response up to the size limit. If data is left over, `next` says where the
   following request picks up. Same filtering by role as snapshotPage. */
const BATCH_ROWS = 4000;
export async function snapshotBatch(user: User, fromTable: string | undefined, fromAfter: number) {
  await ensureColumns();
  const start = fromTable ? TABLES.indexOf(fromTable) : 0; if (start < 0) return null;
  const todo = TABLES.slice(start);
  const fetched = await Promise.all(todo.map(async (t, i) => {
    if (!canReadTable(user.role, t)) return { t, rows: [] as any[], more: false };
    const after = i === 0 ? fromAfter : 0;
    const hideFinance = t === 'events' && !seesCosts(user.role) ? ` AND audience IS DISTINCT FROM 'finance'` : '';
    const r = await pool.query(`SELECT "_seq", ${colList(t)} FROM ${q(snake(t))} WHERE "_seq" > $1${hideFinance} ORDER BY "_seq" LIMIT ${BATCH_ROWS}`, [after]);
    return { t, rows: r.rows, more: r.rows.length === BATCH_ROWS };
  }));
  const out: string[] = []; let size = 0;
  for (const { t, rows, more } of fetched) {
    const parts: string[] = []; let last = 0;
    for (const row of rows) {
      const x = redactRow(user.role, t, fromDb(row)); last = Number(row._seq); if (!x) continue;
      const s = JSON.stringify(x);
      if (size + s.length > PAGE_BYTES && size > 0) { out.push(`${JSON.stringify(t)}:[${parts.join(',')}]`); return `{"tables":{${out.join(',')}},"next":${JSON.stringify({ t, after: last - 1 })}}`; }
      parts.push(s); size += s.length + 1;
    }
    out.push(`${JSON.stringify(t)}:[${parts.join(',')}]`);
    if (more) return `{"tables":{${out.join(',')}},"next":${JSON.stringify({ t, after: last })}}`;
  }
  return `{"tables":{${out.join(',')}},"next":null}`;
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
    tables.events = (await c.query(`SELECT ${colList('events')} FROM events WHERE driver_id=$1 AND audience IS DISTINCT FROM 'finance' ORDER BY "_seq" DESC LIMIT 300`, [user.driverId])).rows.map(fromDb).reverse();
    return { version: Number(w.version), schema: w.schema, seq: {}, settings: redactSettings('driver', w.settings), roadmap: {}, tables };
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
    for (const r of last.values()) {
      if (!canReadTable(user.role, r.t)) continue;
      if (r.op === 'delete') out.push({ t: r.t, op: 'delete', row: { id: idParam(r.t, [r.row_id])[0] } }); else (want[r.t] ??= []).push(r.row_id);
    }
    for (const t in want) for (const row of await selectRows(c, t, 'id = ANY($1)', [idParam(t, want[t])])) { const x = redactRow(user.role, t, row); if (x) out.push({ t, op: 'upsert', row: x }); }
    return { v, changes: out, meta: { settings: redactSettings(user.role, w.settings), roadmap: w.roadmap } };
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
