import Fastify, { type FastifyReply, type FastifyRequest } from 'fastify';
import cookie from '@fastify/cookie';
import compress from '@fastify/compress';
import helmet from '@fastify/helmet';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { Rule, ROLES } from '@commerce-os/domain';
import { pool, ensureColumns, migrateDb, describeDbError } from './db.ts';
import { COOKIE, SESSION_DAYS, createSession, destroySession, destroyUserSessions, userFromToken, hashPassword, checkPassword, validPassword, dummyHash, tooManyAttempts, recordFailure, ensureAdmin } from './auth.ts';
import { Forbidden, runCommand, resetDemo, loadTest, restore, ensureWorkspace, type User } from './store.ts';
import { version, snapshotPage, driverSnapshot, changesSince, backupChunks } from './reads.ts';

declare module 'fastify' { interface FastifyRequest { user: User | null } }
/* Demo data tools: on outside production, or when DEMO_TOOLS=1 (for example on a preview deployment). */
export const demoTools = () => process.env.DEMO_TOOLS === '1' || (process.env.NODE_ENV !== 'production' && process.env.DEMO_TOOLS !== '0');
const UNIQUE: Record<string, string> = {
  orders_external_ref_unique: 'That external reference was already imported.', payments_ref_key: 'That payment reference has already been used.',
  handovers_ref_key: 'That handover reference already exists.', settlements_ref_key: 'That settlement reference already exists.',
  movements_key_unique: 'That stock movement was already recorded, so it was not repeated.', customers_phone_key: 'That phone number already belongs to another customer.',
  users_email_key: 'A login with that email already exists.', deliveries_one_active_per_order: 'This order already has an active delivery.',
};

/* Database setup runs once per server instance, on the first request, and retries after a failure. */
let setup: Promise<void> | null = null;
class SetupError extends Error {}
export function databaseReady() {
  return setup ??= (async () => { await migrateDb(); await ensureColumns(); await ensureWorkspace(); })()
    .catch(e => { setup = null; console.error('Database setup failed:', e?.code, e?.message); throw new SetupError(describeDbError(e)); });
}

export async function buildApp({ serveStatic = false } = {}) {
  const app = Fastify({ logger: process.env.LOG === '1' ? { level: 'info' } : false, bodyLimit: 4 * 1024 * 1024, trustProxy: true });
  await app.register(helmet, { contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], scriptSrc: ["'self'"], imgSrc: ["'self'", 'data:'], connectSrc: ["'self'"], objectSrc: ["'none'"], baseUri: ["'self'"], frameAncestors: ["'none'"], upgradeInsecureRequests: null } } });
  await app.register(cookie);
  await app.register(compress, { encodings: ['gzip'], threshold: 1024 });
  app.decorateRequest('user', null);
  app.setErrorHandler((err: any, _req, reply) => {
    if (err instanceof SetupError) return reply.code(503).send({ error: err.message });
    if (err instanceof Rule) return reply.code(422).send({ error: err.message });
    if (err instanceof Forbidden) return reply.code(403).send({ error: err.message });
    if (err.statusCode && err.statusCode < 500) return reply.code(err.statusCode).send({ error: err.message });
    if (err.code === '23505') return reply.code(409).send({ error: UNIQUE[err.constraint] || 'That would create a duplicate record, so nothing was saved.' });
    if (err.code?.startsWith?.('23')) return reply.code(422).send({ error: 'The database rejected this change, so nothing was saved.' });
    if (err.code === '40001' || err.code === '40P01') return reply.code(409).send({ error: 'Someone else changed this at the same moment. Please try again.' });
    console.error(err);
    return reply.code(500).send({ error: 'Something went wrong. No changes were saved.' });
  });
  const auth = async (req: FastifyRequest, reply: FastifyReply) => { req.user = await userFromToken(req.cookies[COOKIE]); if (!req.user) return reply.code(401).send({ error: 'Please sign in.' }); };
  const staff = async (req: FastifyRequest, reply: FastifyReply) => { await auth(req, reply); if (!reply.sent && req.user!.role === 'driver') return reply.code(403).send({ error: 'Not available to drivers.' }); };
  const owner = async (req: FastifyRequest, reply: FastifyReply) => { await auth(req, reply); if (!reply.sent && req.user!.role !== 'owner') return reply.code(403).send({ error: 'Owner access required.' }); };
  const demoOnly = async (_: FastifyRequest, reply: FastifyReply) => { if (!demoTools()) return reply.code(404).send({ error: 'Demo tools are turned off.' }); };
  const secure = process.env.COOKIE_SECURE === '1' || !!process.env.VERCEL;
  const setCookie = (reply: FastifyReply, token: string) => reply.setCookie(COOKIE, token, { path: '/', httpOnly: true, sameSite: 'strict', secure, maxAge: SESSION_DAYS * 86400 });
  const noStore = (reply: FastifyReply) => reply.header('Cache-Control', 'no-store');
  app.addHook('onSend', async (req, reply) => { if (req.url.startsWith('/api/')) noStore(reply); });
  app.addHook('onRequest', async req => { if (req.url.startsWith('/api/') && !req.url.startsWith('/api/health')) await databaseReady(); });

  /* Open /api/health in a browser to check the deployment's configuration. */
  app.get('/api/health', async (_req, reply) => {
    const report: any = { database: 'not checked', owner: 'unknown', settings: { DATABASE_URL: !!process.env.DATABASE_URL, ADMIN_EMAIL: !!process.env.ADMIN_EMAIL, ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD } };
    try { await databaseReady(); report.database = 'connected, tables ready'; }
    catch (e: any) { report.database = 'error'; report.problem = e.message; return reply.code(503).send({ ok: false, ...report }); }
    const users = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
    report.owner = users ? `${users} login${users > 1 ? 's' : ''} exist` : process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD ? 'will be created on first sign-in' : 'missing: set ADMIN_EMAIL and ADMIN_PASSWORD';
    return { ok: !!users || (!!process.env.ADMIN_EMAIL && (process.env.ADMIN_PASSWORD || '').length >= 10), ...report };
  });
  app.get('/api/config', async () => ({ demoTools: demoTools() }));
  app.post('/api/auth/login', async (req, reply) => {
    const { email, password } = (req.body || {}) as any, e = String(email ?? '').trim().toLowerCase(), ip = req.ip || '';
    if (await tooManyAttempts(e, ip)) return reply.code(429).send({ error: 'Too many attempts. Wait 15 minutes and try again.' });
    await ensureAdmin();
    if (!(await pool.query('SELECT 1 FROM users LIMIT 1')).rowCount) return reply.code(503).send({ error: 'No owner login exists yet. Set ADMIN_EMAIL and ADMIN_PASSWORD (10+ characters) in Vercel → Settings → Environment Variables, then redeploy.' });
    const u = e ? (await pool.query('SELECT id, password_hash, active FROM users WHERE email=$1', [e])).rows[0] : null;
    const good = await checkPassword(String(password ?? ''), u?.password_hash || await dummyHash());
    if (!u || !good || !u.active) { await recordFailure(e, ip); return reply.code(401).send({ error: 'Wrong email or password.' }); }
    setCookie(reply, await createSession(u.id));
    return { user: (await pool.query('SELECT id, email, name, role, driver_id AS "driverId" FROM users WHERE id=$1', [u.id])).rows[0] };
  });
  app.post('/api/auth/logout', async (req, reply) => { const t = req.cookies[COOKIE]; if (t) await destroySession(t); return reply.clearCookie(COOKIE, { path: '/' }).send({ ok: true }); });
  app.get('/api/me', { preHandler: auth }, async req => ({ user: req.user }));
  app.post('/api/me/password', { preHandler: auth }, async (req, reply) => {
    const { current, next } = (req.body || {}) as any;
    if (await tooManyAttempts(`pw:${req.user!.id}`, '')) return reply.code(429).send({ error: 'Too many attempts. Wait 15 minutes and try again.' });
    const row = (await pool.query('SELECT password_hash FROM users WHERE id=$1', [req.user!.id])).rows[0];
    if (!(await checkPassword(String(current ?? ''), row.password_hash))) { await recordFailure(`pw:${req.user!.id}`, ''); return reply.code(422).send({ error: 'Your current password is wrong.' }); }
    if (!validPassword(next)) return reply.code(422).send({ error: 'Use at least 10 characters.' });
    await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [await hashPassword(next), req.user!.id]);
    await destroyUserSessions(req.user!.id); setCookie(reply, await createSession(req.user!.id));
    return { ok: true };
  });

  /* Sync */
  app.get('/api/version', { preHandler: auth }, async () => version());
  app.get<{ Querystring: { table?: string; after?: string } }>('/api/snapshot', { preHandler: staff }, async (req, reply) => {
    const body = await snapshotPage(String(req.query.table), Number(req.query.after) || 0);
    return body === null ? reply.code(400).send({ error: 'Unknown table.' }) : reply.type('application/json').send(body);
  });
  app.get('/api/snapshot/mine', { preHandler: auth }, async (req, reply) => req.user!.role === 'driver' ? driverSnapshot(req.user!) : reply.code(400).send({ error: 'Staff load the workspace with /api/snapshot.' }));
  app.get<{ Querystring: { since?: string } }>('/api/changes', { preHandler: auth }, async req => changesSince(Number(req.query.since) || 0, req.user!));
  app.post<{ Params: { name: string } }>('/api/commands/:name', { preHandler: auth }, async (req, reply) => {
    const { args } = (req.body || {}) as any;
    if (!Array.isArray(args)) return reply.code(400).send({ error: 'Invalid request.' });
    const { result, delta } = await runCommand(req.user!, req.params.name, args);
    return req.user!.role === 'driver' ? { result, resync: true, v: delta.v } : { result, delta };
  });

  /* Team */
  const pub = `id, email, name, role, driver_id AS "driverId", active`;
  const checkRole = async (role: unknown, driverId: unknown) => {
    if (!ROLES.includes(role as string)) throw new Rule('Choose a valid role.');
    if (role === 'driver' && !(await pool.query('SELECT 1 FROM drivers WHERE id=$1', [driverId])).rowCount) throw new Rule('Link this login to a driver record.');
  };
  app.get('/api/users', { preHandler: owner }, async () => ({ users: (await pool.query(`SELECT ${pub} FROM users ORDER BY id`)).rows, drivers: (await pool.query('SELECT id, name FROM drivers ORDER BY "_seq"')).rows }));
  app.post('/api/users', { preHandler: owner }, async (req, reply) => {
    const { email, name, role, driverId, password } = (req.body || {}) as any;
    if (typeof email !== 'string' || !/^\S+@\S+\.\S+$/.test(email)) throw new Rule('Enter a valid email.');
    if (typeof name !== 'string' || !name.trim()) throw new Rule('Enter a name.');
    if (!validPassword(password)) throw new Rule('Use a password of at least 10 characters.');
    await checkRole(role, driverId);
    const r = await pool.query(`INSERT INTO users (email, name, password_hash, role, driver_id) VALUES ($1,$2,$3,$4,$5) RETURNING ${pub}`, [email.trim().toLowerCase(), name.trim(), await hashPassword(password), role, role === 'driver' ? driverId : null]);
    return reply.code(201).send({ user: r.rows[0] });
  });
  app.patch<{ Params: { id: string } }>('/api/users/:id', { preHandler: owner }, async req => {
    const id = Number(req.params.id), { name, role, driverId, active, password } = (req.body || {}) as any;
    const cur = (await pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0]; if (!cur) throw new Rule('User not found.');
    const nextRole = role ?? cur.role, nextDriver = nextRole === 'driver' ? (driverId ?? cur.driver_id) : null, nextActive = active ?? cur.active;
    await checkRole(nextRole, nextDriver);
    if (cur.role === 'owner' && (nextRole !== 'owner' || !nextActive)) { const n = (await pool.query(`SELECT count(*)::int AS n FROM users WHERE role='owner' AND active`)).rows[0].n; if (n <= 1) throw new Rule('There must always be one active owner.'); }
    if (password !== undefined && !validPassword(password)) throw new Rule('Use a password of at least 10 characters.');
    const r = await pool.query(`UPDATE users SET name=$1, role=$2, driver_id=$3, active=$4, password_hash=COALESCE($5,password_hash) WHERE id=$6 RETURNING ${pub}`, [name ?? cur.name, nextRole, nextDriver, nextActive, password ? await hashPassword(password) : null, id]);
    if (!nextActive || password || nextRole !== cur.role) await destroyUserSessions(id);
    return { user: r.rows[0] };
  });

  /* Workspace data */
  app.get('/api/admin/backup', { preHandler: owner }, async (_req, reply) => reply.type('application/json').header('Content-Disposition', `attachment; filename="commerce-os-backup-${new Date().toISOString().slice(0, 10)}.json"`).send(Readable.from(backupChunks())));
  app.post('/api/admin/restore', { preHandler: owner }, async req => { await restore(req.body); return { ok: true }; });
  app.post('/api/admin/reset', { preHandler: [demoOnly, owner] }, async () => { await resetDemo(); return { ok: true }; });
  app.post('/api/admin/load-test', { preHandler: [demoOnly, owner] }, async req => {
    const n = Number((req.body as any)?.orders); if (![1000, 5000, 20000].includes(n)) throw new Rule('Choose 1,000, 5,000 or 20,000 orders.');
    const t = performance.now(), r = await loadTest(n); return { ...r, totalMs: performance.now() - t };
  });

  if (serveStatic) {
    const { default: fstatic } = await import('@fastify/static');
    await app.register(fstatic, { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist') });
  }
  return app;
}
