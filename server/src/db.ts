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

/* The Vercel bundle embeds the migration files, since the function can't read the repo. */
declare const __MIGRATIONS__: { name: string; sql: string }[] | undefined;
async function migrationFiles() {
  if (typeof __MIGRATIONS__ !== 'undefined') return __MIGRATIONS__;
  const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../db/migrations');
  return Promise.all((await readdir(dir)).filter(x => x.endsWith('.sql')).sort().map(async name => ({ name, sql: await readFile(path.join(dir, name), 'utf8') })));
}
/* Creates or updates the tables. Safe to call on every cold start: it only locks when something is pending,
   and the lock is transaction-scoped so it works through connection poolers. */
export async function migrateDb(): Promise<string[]> {
  const files = await migrationFiles();
  const applied = await pool.query(`SELECT to_regclass('schema_migrations') IS NOT NULL AS ok`).then(async r => r.rows[0].ok ? new Set((await pool.query('SELECT name FROM schema_migrations')).rows.map(x => x.name)) : new Set<string>());
  if (files.every(f => applied.has(f.name))) return [];
  return withTx(async c => {
    await c.query('SELECT pg_advisory_xact_lock(7263001)');
    await c.query('CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, ran_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await c.query('SELECT name FROM schema_migrations')).rows.map(r => r.name)), ran: string[] = [];
    for (const f of files) {
      if (done.has(f.name)) continue;
      await c.query(f.sql);
      await c.query('INSERT INTO schema_migrations(name) VALUES($1)', [f.name]); ran.push(f.name);
    }
    return ran;
  });
}
/* Turns a connection or setup failure into an instruction the owner can act on. Never includes secrets. */
export function describeDbError(e: any) {
  if (!process.env.DATABASE_URL) return "DATABASE_URL isn't set. Add your PostgreSQL connection string in Vercel → Settings → Environment Variables, then redeploy.";
  const c = e?.code;
  if (c === 'ENOTFOUND' || c === 'EAI_AGAIN') return "The database host in DATABASE_URL couldn't be found. Check the connection string.";
  if (c === 'ECONNREFUSED' || c === 'ETIMEDOUT' || /timeout/i.test(e?.message || '')) return "Couldn't connect to the database in DATABASE_URL. Check the connection string, and that the database is running.";
  if (c === '28P01' || c === '28000') return 'The database rejected the username or password in DATABASE_URL.';
  if (c === '3D000') return "The database named in DATABASE_URL doesn't exist.";
  if (/ssl|tls|certificate/i.test(e?.message || '')) return 'The database connection failed on SSL. Add ?sslmode=require to the end of DATABASE_URL.';
  return `Database setup failed (${c || 'unknown error'}). Check the function logs in Vercel for details.`;
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
