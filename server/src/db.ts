/* PostgreSQL access. Every request borrows a connection briefly, which suits
   serverless functions. Use a pooled connection string in production (Neon,
   Supabase or similar). */
import pg from 'pg';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { SCHEMA } from '@commerce-os/domain';

pg.types.setTypeParser(1700, parseFloat);                       // numeric
pg.types.setTypeParser(20, Number);                             // bigint
pg.types.setTypeParser(1082, (v: string) => v);                 // date stays YYYY-MM-DD
pg.types.setTypeParser(1184, (v: string) => new Date(v).toISOString()); // timestamptz

export const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: Number(process.env.PG_POOL_MAX) || 5, idleTimeoutMillis: 10000, connectionTimeoutMillis: 10000 });
export type Client = pg.PoolClient;
export async function withTx<T>(fn: (c: Client) => Promise<T>, isolation = 'READ COMMITTED'): Promise<T> {
  const c = await pool.connect();
  try { await c.query(`BEGIN ISOLATION LEVEL ${isolation}`); const r = await fn(c); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; }
  finally { c.release(); }
}

const MIGRATIONS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
/* Uses a transaction-scoped lock, which also works through connection poolers. */
export async function migrateDb(): Promise<string[]> {
  return withTx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(7263001)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)), ran: string[] = [];
    for (const f of (await readdir(MIGRATIONS)).filter(x => x.endsWith('.sql')).sort()) {
      if (done.has(f)) continue;
      await c.query(await readFile(path.join(MIGRATIONS, f), 'utf8'));
      await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [f]); ran.push(f);
    }
    return ran;
  });
}

export const snake = (s: string) => s.replace(/[A-Z]/g, c => '_' + c.toLowerCase());
const camel = (s: string) => s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
export const q = (s: string) => `"${s}"`;
type Col = { name: string; type: string };
const columns = new Map<string, Col[]>();
let columnsReady: Promise<void> | null = null;
export const TABLES = Object.keys(SCHEMA);
export const NUMERIC_IDS = new Set(['orders', 'movements', 'events']);
export function ensureColumns() {
  return columnsReady ??= (async () => {
    const r = await pool.query(`SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = current_schema() ORDER BY ordinal_position`);
    for (const t of TABLES) columns.set(t, r.rows.filter(x => x.table_name === snake(t) && x.column_name !== '_seq').map(x => ({ name: x.column_name, type: x.data_type })));
  })().catch(e => { columnsReady = null; throw e; });
}
export const colList = (t: string) => columns.get(t)!.map(x => q(x.name)).join(',');
export function fromDb(row: any) { const o: any = {}; for (const k in row) if (k !== '_seq') o[camel(k)] = row[k]; return o; }
function toParams(t: string, row: any) {
  const cols = columns.get(t)!, known = new Set(cols.map(c => camel(c.name)));
  for (const k in row) if (row[k] !== undefined && !known.has(k)) throw new Error(`${t}.${k} has no database column`);
  return cols.map(c => {
    const v = row[camel(c.name)];
    if (v === undefined || v === null) return null;
    if (c.type === 'jsonb') return JSON.stringify(v);
    if (v === '' && (c.type === 'date' || c.type.startsWith('timestamp'))) return null;
    return v;
  });
}
export const idParam = (t: string, ids: any[]) => NUMERIC_IDS.has(t) ? ids.map(Number) : ids.map(String);

export type Change = { t: string; row: any; op: 'upsert' | 'delete' };
export type Meta = { schema: number; version: number; seq: any; settings: any; roadmap: any };
export async function saveMeta(c: Client, m: Meta) {
  await c.query(`INSERT INTO workspace (id, schema, version, seq, settings, roadmap) VALUES (1,$1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET schema=$1, version=$2, seq=$3, settings=$4, roadmap=$5`, [m.schema, m.version, JSON.stringify(m.seq), JSON.stringify(m.settings), JSON.stringify(m.roadmap)]);
}
export async function persistChanges(c: Client, changes: Change[]) {
  for (const { t, row, op } of changes) {
    const table = q(snake(t));
    if (op === 'delete') { await c.query(`DELETE FROM ${table} WHERE id=$1`, [row.id]); continue; }
    const cols = columns.get(t)!, upd = cols.filter(x => x.name !== 'id').map(x => `${q(x.name)}=EXCLUDED.${q(x.name)}`).join(',');
    await c.query(`INSERT INTO ${table} (${colList(t)}) VALUES (${cols.map((_, i) => `$${i + 1}`)}) ON CONFLICT (id) DO ${upd ? 'UPDATE SET ' + upd : 'NOTHING'}`, toParams(t, row));
  }
}
/* Change log: lets each browser fetch only what changed since its last sync. */
export async function recordChanges(c: Client, version: number, changes: Change[]) {
  if (!changes.length) return;
  await c.query(`INSERT INTO changes (version, ord, t, row_id, op) SELECT $1, o, t, r, p FROM unnest($2::int[], $3::text[], $4::text[], $5::text[]) AS x(o, t, r, p)`,
    [version, changes.map((_, i) => i), changes.map(x => x.t), changes.map(x => String(x.row.id)), changes.map(x => x.op)]);
  if (version % 500 === 0) { const floor = version - 20000; if (floor > 0) { await c.query('DELETE FROM changes WHERE version <= $1', [floor]); await c.query('UPDATE workspace SET changes_floor=$1 WHERE id=1', [floor]); } }
}
/* Replaces every business record: seed, reset, restore and load test. Logins are kept. */
export async function replaceAll(c: Client, data: any, version: number) {
  await c.query(`TRUNCATE ${TABLES.map(t => q(snake(t))).join(',')} RESTART IDENTITY CASCADE`);
  for (const t of TABLES) {
    const cols = columns.get(t)!, rows = (data.tables[t] || []).filter((r: any) => !String(r.id).startsWith('base:')), size = Math.floor(60000 / cols.length);
    for (let i = 0; i < rows.length; i += size) {
      const chunk = rows.slice(i, i + size), params: any[] = [], vals: string[] = [];
      for (const r of chunk) { const start = params.length; params.push(...toParams(t, r)); vals.push(`(${cols.map((_, j) => `$${start + j + 1}`)})`); }
      await c.query(`INSERT INTO ${q(snake(t))} (${colList(t)}) VALUES ${vals.join(',')}`, params);
    }
  }
  await saveMeta(c, { schema: data.schema, version, seq: data.seq, settings: data.settings, roadmap: data.roadmap });
  await c.query('DELETE FROM changes');
  await c.query(`INSERT INTO changes (version, ord, t, row_id, op) VALUES ($1, 0, '*', '*', 'resync')`, [version]);
  await c.query('UPDATE workspace SET changes_floor=$1 WHERE id=1', [version - 1]);
}
export async function readWorkspace(c: Client | pg.Pool, lock = false) {
  return (await c.query(`SELECT * FROM workspace WHERE id=1${lock ? ' FOR UPDATE' : ''}`)).rows[0] || null;
}
export async function loadAll(c: Client | pg.Pool = pool): Promise<{ data: any; version: number } | null> {
  await ensureColumns();
  const w = await readWorkspace(c); if (!w) return null;
  const data: any = { schema: w.schema, workspaceId: 'ws-1', seq: w.seq, settings: w.settings, roadmap: w.roadmap, tables: {} };
  for (const t of TABLES) data.tables[t] = (await c.query(`SELECT ${colList(t)} FROM ${q(snake(t))} ORDER BY "_seq"`)).rows.map(fromDb);
  return { data, version: Number(w.version) };
}
export const selectRows = async (c: Client, t: string, where: string, params: any[] = []) =>
  (await c.query(`SELECT ${colList(t)} FROM ${q(snake(t))} WHERE ${where} ORDER BY "_seq"`, params)).rows.map(fromDb);
