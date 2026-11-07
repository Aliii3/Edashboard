/* Runs the real API against a real PostgreSQL test database. */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/commerce_os_test';
process.env.NODE_ENV = 'test';
const { migrateDb, ensureColumns, pool, loadAll, replaceAll, withTx } = await import('../src/db.ts');
const { hashPassword } = await import('../src/auth.ts');
const { buildApp } = await import('../src/app.ts');
const { Repo, integrity, driverCash, stockOnHand } = await import('@commerce-os/domain');
const { buildSeedWorkspace } = await import('@commerce-os/domain/seed');
const PW = 'test-password-123';
let app: any; const cookies: Record<string, string> = {};
const call = async (who: string | null, method: string, url: string, body?: any) => {
  const r = await app.inject({ method, url, headers: who ? { cookie: cookies[who] } : {}, ...(body !== undefined ? { payload: body } : {}) });
  return { status: r.statusCode, json: () => JSON.parse(r.body), body: r.body, headers: r.headers };
};
const cmd = (who: string, name: string, ...args: any[]) => call(who, 'POST', `/api/commands/${name}`, { args });
const dbCount = async (sql: string, p: any[] = []) => (await pool.query(sql, p)).rows[0].n;
let seeded: any;
/* Loads every record into the in-process model, to inspect state the way a full browser copy would. */
const full = async () => { const r = await loadAll(); Repo.load(r!.data); return r!; };
const norm = (x: any): any => JSON.parse(JSON.stringify(x, (_, v) => v === undefined ? null : v));

before(async () => {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public');
  await migrateDb(); await ensureColumns();
  const seed = buildSeedWorkspace(); seeded = JSON.parse(JSON.stringify(seed));
  await withTx(c => replaceAll(c, seed, 1));
  await full();
  const h = await hashPassword(PW);
  for (const [e, r, d] of [['owner', 'owner', null], ['ops', 'operations', null], ['wh', 'warehouse', null], ['fin', 'finance', null], ['drv', 'driver', 'DRV-1'], ['drv3', 'driver', 'DRV-3']]) await pool.query('INSERT INTO users (email,name,password_hash,role,driver_id) VALUES ($1,$2,$3,$4,$5)', [`${e}@t.test`, `T ${e}`, h, r, d]);
  app = await buildApp();
  for (const u of ['owner', 'ops', 'wh', 'fin', 'drv', 'drv3']) {
    const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${u}@t.test`, password: PW } });
    assert.equal(r.statusCode, 200); cookies[u] = String(r.headers['set-cookie']).split(';')[0];
  }
});
after(async () => { await app.close(); await pool.end(); });
const newOrder = async (who = 'ops', qty = 1) => (await cmd(who, 'createOrder', { customerId: 'C-0001', lines: [{ sku: 'TEE-IVR', qty }], channel: 'Phone' })).json().result;
const readyDelivery = async (driver = 'DRV-1') => {
  const o = await newOrder(); await cmd('ops', 'confirmOrder', o.id); await cmd('ops', 'advanceOrder', o.id, 'Processing'); await cmd('ops', 'advanceOrder', o.id, 'Ready');
  const d = (await cmd('ops', 'assign', o.id, 'driver', driver)).json().result; assert.equal((await cmd('wh', 'pickup', d.id)).status, 200); return { o, d };
};

test('seed data survives a PostgreSQL round trip unchanged', async () => {
  const saved = (await full()).data;
  for (const t of Object.keys(seeded.tables)) {
    const a = norm(seeded.tables[t]), b = norm(saved.tables[t]); assert.equal(b.length, a.length, t);
    for (let i = 0; i < a.length; i++) for (const k of Object.keys(a[i])) assert.deepEqual(b[i][k], a[i][k] === '' && /At$/.test(k) ? null : a[i][k], `${t}[${i}].${k}`);
  }
  assert.equal(integrity().filter((x: any) => !x.ok).length, 0);
});
test('authentication', async () => {
  assert.equal((await call(null, 'GET', '/api/snapshot')).status, 401);
  assert.equal((await call(null, 'POST', '/api/commands/confirmOrder', { args: [1] })).status, 401);
  assert.equal((await call(null, 'POST', '/api/auth/login', { email: 'owner@t.test', password: 'wrong-password' })).status, 401);
  assert.equal((await call(null, 'POST', '/api/auth/login', { email: 'nobody@t.test', password: PW })).status, 401);
  const r = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'OWNER@t.test', password: PW } });
  const set = String(r.headers['set-cookie']); assert.match(set, /HttpOnly/); assert.match(set, /SameSite=Strict/);
  assert.equal(JSON.parse(r.body).user.password_hash, undefined);
  assert.equal((await pool.query('SELECT count(*)::int n FROM sessions WHERE token_hash=$1', [set.split(';')[0].split('=')[1]])).rows[0].n, 0, 'raw tokens are not stored');
  assert.match((await pool.query(`SELECT password_hash FROM users WHERE email='owner@t.test'`)).rows[0].password_hash, /^scrypt\$/);
});
test('roles are enforced on the server', async () => {
  await full(); const id = Repo.by('orders', 'status', 'New')[0].id;
  assert.equal((await cmd('wh', 'createOrder', {})).status, 403);
  assert.equal((await cmd('fin', 'confirmOrder', id)).status, 403);
  assert.equal((await cmd('drv', 'confirmOrder', id)).status, 403);
  assert.equal((await cmd('ops', 'refund', id, {})).status, 403);
  assert.equal((await cmd('ops', 'saveSettings', { company: 'x' })).status, 403);
  for (const internal of ['_newDelivery', '_syncShortfall', 'constructor', '__proto__', 'toString', 'nope']) assert.equal((await cmd('owner', internal)).status, 403, internal);
  assert.equal((await cmd('owner', 'saveSettings', { __proto__x: 1, evil: 1 })).status, 422);
  assert.equal((await call('ops', 'GET', '/api/users')).status, 403);
  assert.equal((await call('fin', 'GET', '/api/admin/backup')).status, 403);
});
test('drivers only reach their own deliveries', async () => {
  const mine = await readyDelivery('DRV-1'), other = await readyDelivery('DRV-3');
  assert.equal((await cmd('drv', 'setDeliveryStatus', other.d.id, 'Out for Delivery')).status, 403);
  assert.equal((await cmd('drv', 'setDeliveryStatus', mine.d.id, 'Out for Delivery')).status, 200);
  assert.equal((await cmd('drv', 'setDeliveryStatus', mine.d.id, 'Cancelled Assignment')).status, 403);
  assert.equal((await cmd('drv', 'addDriverExpense', { driverId: 'DRV-3', category: 'Fuel', amount: 10 })).status, 403);
  const snap = (await call('drv', 'GET', '/api/snapshot/mine')).json();
  assert.ok(snap.tables.deliveries.some((d: any) => d.id === mine.d.id));
  assert.ok(!snap.tables.deliveries.some((d: any) => d.id === other.d.id));
  assert.equal(snap.tables.drivers.length, 1); assert.equal(snap.tables.drivers[0].id, 'DRV-1');
  for (const t of ['campaigns', 'spend', 'expenses', 'skus', 'boms', 'materials', 'settlements', 'movements']) assert.equal(snap.tables[t].length, 0, t);
  assert.ok(snap.tables.lines.every((l: any) => l.unitCost === 0), 'no cost data');
  const r = await cmd('drv', 'deliver', mine.d.id, { collection: { amount: 490, method: 'Cash' } });
  assert.equal(r.status, 200); assert.equal(r.json().delta, undefined, 'drivers never receive raw deltas');
});
test('a command is saved to PostgreSQL and credited to the signed-in user', async () => {
  const o = await newOrder();
  assert.equal(await dbCount('SELECT count(*)::int n FROM orders WHERE id=$1', [o.id]), 1);
  assert.equal((await pool.query('SELECT "by" FROM events WHERE order_id=$1 LIMIT 1', [o.id])).rows[0].by, 'T ops');
  await cmd('ops', 'confirmOrder', o.id);
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [o.id])).rows[0].status, 'Confirmed');
  assert.equal((await pool.query('SELECT reserved FROM lines WHERE order_id=$1', [o.id])).rows[0].reserved, 1);
});
test('a rejected command changes nothing in the database', async () => {
  const before = await dbCount('SELECT count(*)::int n FROM events'), w = (await pool.query('SELECT version, seq FROM workspace')).rows[0];
  const r = await cmd('ops', 'createOrder', { customerId: 'C-0001', lines: [{ sku: 'NOPE', qty: 1 }] });
  assert.equal(r.status, 422); assert.match(r.json().error, /Unknown SKU/);
  const w2 = (await pool.query('SELECT version, seq FROM workspace')).rows[0];
  assert.equal(await dbCount('SELECT count(*)::int n FROM events'), before); assert.deepEqual(w2, w);
});
test('a database failure rolls the whole command back', async () => {
  const { o, d } = await readyDelivery(); await cmd('ops', 'setDeliveryStatus', d.id, 'Out for Delivery');
  await pool.query(`ALTER TABLE deliveries ADD CONSTRAINT boom CHECK (status <> 'Delivered') NOT VALID`);
  const ev = await dbCount('SELECT count(*)::int n FROM events'), v = (await pool.query('SELECT version FROM workspace')).rows[0].version;
  const r = await cmd('ops', 'deliver', d.id, {});
  await pool.query('ALTER TABLE deliveries DROP CONSTRAINT boom');
  assert.equal(r.status, 422);
  assert.equal((await pool.query('SELECT status FROM orders WHERE id=$1', [o.id])).rows[0].status, 'Shipped');
  assert.equal((await pool.query('SELECT delivered FROM lines WHERE order_id=$1', [o.id])).rows[0].delivered, 0);
  assert.equal(await dbCount('SELECT count(*)::int n FROM events'), ev); assert.equal((await pool.query('SELECT version FROM workspace')).rows[0].version, v);
  assert.equal((await cmd('ops', 'deliver', d.id, {})).status, 200, 'retry succeeds');
});
test('simultaneous requests cannot double-apply', async () => {
  const o = await newOrder();
  const conf = await Promise.all([1, 2, 3].map(() => cmd('ops', 'confirmOrder', o.id)));
  assert.deepEqual(conf.map(r => r.status).sort(), [200, 422, 422]);
  await cmd('ops', 'advanceOrder', o.id, 'Processing'); await cmd('ops', 'advanceOrder', o.id, 'Ready');
  const assigned = await Promise.all([cmd('ops', 'assign', o.id, 'driver', 'DRV-1'), cmd('ops', 'assign', o.id, 'driver', 'DRV-2')]);
  assert.deepEqual(assigned.map(r => r.status).sort(), [200, 422]);
  const d = assigned.find(r => r.status === 200)!.json().result; await full(); const onHand = stockOnHand('TEE-IVR');
  const picks = await Promise.all([cmd('wh', 'pickup', d.id), cmd('ops', 'pickup', d.id)]);
  assert.deepEqual(picks.map(r => r.status).sort(), [200, 422]); await full(); assert.equal(stockOnHand('TEE-IVR'), onHand - 1);
  await cmd('ops', 'setDeliveryStatus', d.id, 'Out for Delivery'); await cmd('ops', 'deliver', d.id, { collection: { amount: 490, method: 'Cash' } });
  await full(); const held = driverCash(d.carrierId).outstanding, body = { driverId: d.carrierId, ref: 'RACE-1', receivedBy: 'x', allocations: [{ deliveryId: d.id, amount: 490 }] };
  const hos = await Promise.all([cmd('fin', 'recordHandover', body), cmd('fin', 'recordHandover', { ...body, ref: 'RACE-2' })]);
  assert.deepEqual(hos.map(r => r.status).sort(), [200, 422]); await full(); assert.equal(driverCash(d.carrierId).outstanding, held - 490);
});
test('the database itself refuses invalid data', async () => {
  await full();
  const o = Repo.all('orders').find((x: any) => Repo.by('deliveries', 'orderId', x.id).some((d: any) => d.status === 'Assigned'));
  const d = Repo.by('deliveries', 'orderId', o.id).find((x: any) => x.status === 'Assigned');
  await assert.rejects(pool.query(`INSERT INTO deliveries (id, order_id, mode, carrier_id, carrier_key, status, custody, assigned_at, updated_at, items, attempts, history) SELECT 'DL-X', order_id, mode, carrier_id, carrier_key, 'Assigned', custody, now(), now(), items, attempts, history FROM deliveries WHERE id=$1`, [d.id]), /deliveries_one_active_per_order/);
  await assert.rejects(pool.query('UPDATE movements SET qty = 0 WHERE id = (SELECT min(id) FROM movements)'), /append-only/);
  await assert.rejects(pool.query('DELETE FROM events WHERE id = (SELECT min(id) FROM events)'), /append-only/);
  const p = Repo.all('payments')[0];
  await assert.rejects(pool.query(`INSERT INTO payments (id, order_id, kind, method, amount, holder_key, ref, at) VALUES ('PAY-X',$1,'collection','Cash',1,'business',$2,now())`, [p.orderId, p.ref]), /unique/);
});
test('records stay consistent after all of the above', async () => {
  await full(); assert.deepEqual(integrity().filter((x: any) => !x.ok), []);
});
test('incremental sync returns exactly what changed', async () => {
  const v0 = (await call('ops', 'GET', '/api/version')).json().v;
  const o = await newOrder();
  const ch = (await call('ops', 'GET', `/api/changes?since=${v0}`)).json();
  assert.equal(ch.v, v0 + 1); assert.ok(ch.changes.some((c: any) => c.t === 'orders' && c.row.id === o.id)); assert.ok(ch.changes.some((c: any) => c.t === 'lines'));
  assert.deepEqual((await call('ops', 'GET', `/api/changes?since=${ch.v}`)).json().changes, []);
  assert.equal((await call('drv', 'GET', `/api/changes?since=${v0}`)).json().resync, true, 'drivers refetch their own scope');
  assert.equal((await call('drv', 'GET', '/api/snapshot?table=orders&after=0')).status, 403, 'drivers cannot page the whole workspace');
  const page = (await call('ops', 'GET', '/api/snapshot?table=orders&after=0')).json(); assert.ok(page.rows.length > 100); assert.equal(page.next, null);
  assert.equal((await call('ops', 'GET', '/api/snapshot?table=users&after=0')).status, 400, 'logins are never exposed');
});
test('team management', async () => {
  assert.equal((await call('owner', 'POST', '/api/users', { email: 'x@t.test', name: 'X', role: 'operations', password: 'short' })).status, 422);
  assert.equal((await call('owner', 'POST', '/api/users', { email: 'd@t.test', name: 'D', role: 'driver', password: PW })).status, 422);
  const r = await call('owner', 'POST', '/api/users', { email: 'new@t.test', name: 'New', role: 'finance', password: PW }); assert.equal(r.status, 201); assert.equal(r.json().user.password_hash, undefined);
  assert.equal((await call('owner', 'POST', '/api/users', { email: 'new@t.test', name: 'New', role: 'finance', password: PW })).status, 409);
  const l = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: 'new@t.test', password: PW } }); cookies.nw = String(l.headers['set-cookie']).split(';')[0];
  assert.equal((await call('nw', 'GET', '/api/me')).status, 200);
  assert.equal((await call('owner', 'PATCH', `/api/users/${r.json().user.id}`, { active: false })).status, 200);
  assert.equal((await call('nw', 'GET', '/api/me')).status, 401, 'deactivating ends sessions');
  const ownerId = (await call('owner', 'GET', '/api/me')).json().user.id;
  assert.equal((await call('owner', 'PATCH', `/api/users/${ownerId}`, { active: false })).status, 422, 'last owner stays');
});
test('backup, restore and reset', async () => {
  const backup = await call('owner', 'GET', '/api/admin/backup'), n = await dbCount('SELECT count(*)::int n FROM orders'); assert.equal(backup.status, 200);
  assert.equal(JSON.parse(backup.body).tables.orders.length, n);
  assert.ok(!backup.body.includes('scrypt$'), 'no password hashes in backups');
  await newOrder(); assert.equal(await dbCount('SELECT count(*)::int n FROM orders'), n + 1);
  assert.equal((await call('owner', 'POST', '/api/admin/restore', { not: 'a backup' })).status, 422);
  assert.equal(await dbCount('SELECT count(*)::int n FROM orders'), n + 1, 'bad restore changes nothing');
  assert.equal((await call('owner', 'POST', '/api/admin/restore', backup.json())).status, 200);
  assert.equal(await dbCount('SELECT count(*)::int n FROM orders'), n);
  const vr = (await call('ops', 'GET', '/api/version')).json().v; assert.equal((await call('ops', 'GET', `/api/changes?since=${vr - 1}`)).json().resync, true, 'browsers reload after a restore');
  assert.equal((await call('owner', 'POST', '/api/admin/load-test', { orders: 1000 })).status, 200);
  assert.ok(await dbCount('SELECT count(*)::int n FROM orders') > n + 900);
  await full(); assert.deepEqual(integrity().filter((x: any) => !x.ok), [], 'load test data is consistent');
  assert.equal((await call('owner', 'POST', '/api/admin/reset', {})).status, 200);
  assert.ok(await dbCount('SELECT count(*)::int n FROM orders') < 200);
  assert.equal((await call('owner', 'GET', '/api/me')).status, 200, 'logins survive a reset');
});
test('login attempts are rate limited', async () => {
  let last = 0; for (let i = 0; i < 12; i++) last = (await call(null, 'POST', '/api/auth/login', { email: 'z@t.test', password: 'wrong-password' })).status;
  assert.equal(last, 429);
});
