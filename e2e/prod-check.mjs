/* Starts in production mode on an empty database: first owner, no demo tools, every screen opens with no data. */
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';
const root = path.resolve(import.meta.dirname, '..'), DB = process.env.PROD_CHECK_DATABASE_URL || 'postgres://localhost:5432/commerce_os_prod_check', PORT = 3102, ADMIN = 'first@example.com', PW = 'prod-check-password';
execSync(`psql "${DB}" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public"`, { stdio: 'ignore' });
const env = { ...process.env, DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: 'production', COOKIE_SECURE: '1', ADMIN_EMAIL: ADMIN, ADMIN_PASSWORD: PW };
const srv = spawn('node', ['src/index.ts'], { cwd: path.join(root, 'server'), env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { srv.stdout.on('data', d => String(d).includes('API on') && res()); srv.on('exit', c => rej(new Error('server exited ' + c))); });
const second = spawn('node', ['src/index.ts'], { cwd: path.join(root, 'server'), env: { ...env, PORT: '3103' }, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { second.stdout.on('data', d => String(d).includes('API on') && res()); second.on('exit', c => rej(new Error('second server exited ' + c))); });
const b = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {}); const p = await b.newPage(); const errs = [];
p.on('pageerror', e => errs.push(e.message));
let fail = 0; const ok = (n, c, x = '') => { console.log(c ? 'ok  ' : 'FAIL', n, x); if (!c) fail++; };
const base = `http://localhost:${PORT}`;
const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ADMIN, password: PW }) });
ok('owner created from environment', login.status === 200); const set = login.headers.get('set-cookie'); ok('cookie is HTTPS-only', /Secure/i.test(set));
const cookie = set.split(';')[0], api = (u, o = {}) => fetch(base + u, { ...o, headers: { cookie, 'Content-Type': 'application/json', ...(o.headers || {}) } });
ok('demo reset is off', (await api('/api/admin/reset', { method: 'POST', body: '{}' })).status === 404);
ok('load test is off', (await api('/api/admin/load-test', { method: 'POST', body: '{"orders":1000}' })).status === 404);
ok('no demo records', (await (await api('/api/snapshot?table=orders&after=0')).json()).rows.length === 0);
const cmd = (port, name, ...args) => fetch(`http://localhost:${port}/api/commands/${name}`, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ args }) });
await cmd(PORT, 'saveSku', { isNew: true, id: 'TST-1', name: 'Test shirt', price: 500, min: 1, labor: 10, overhead: 5, bom: [] }).then(r => r.status);
await cmd(PORT, 'saveCourier', { name: 'Test Courier', shipRate: 50, returnRate: 30, codFee: 10 });

const res = await fetch(base + '/'); ok('web app served with security headers', res.status === 200 && !!res.headers.get('content-security-policy'));
await p.context().addCookies([{ name: 'cos_session', value: cookie.split('=')[1], domain: 'localhost', path: '/', secure: false }]);
await p.goto(base + '/'); await p.waitForSelector('#main .heading');
for (const n of ['overview', 'orders', 'order360', 'crm', 'inventory', 'shipping', 'finance', 'campaigns', 'settings', 'roadmap']) { await p.evaluate(h => { location.hash = h; }, '#/' + n); await p.waitForTimeout(120); ok('empty screen opens: ' + n, (await p.locator('#main').innerText()).length > 5); for (const t of await p.locator('.tabs button').all()) { await t.click(); await p.waitForTimeout(40); } }
ok('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
/* Two server instances on one database: concurrent changes are applied exactly once. */
const sku = await cmd(PORT, 'saveSku', { isNew: true, id: 'TST-2', name: 'Shirt', price: 500, min: 1, labor: 10, overhead: 5, bom: [] });
const mats = await (await api('/api/snapshot?table=materials&after=0')).json();
ok('empty workspace has no materials yet', mats.rows.length === 0);
const cust = await (await cmd(PORT, 'saveCustomer', { name: 'Test Customer', phone: '01011112222', area: 'Maadi', address: '1 Road 9' })).json();
const blocked = await cmd(PORT, 'saveSku', { isNew: true, id: 'TST-3', name: 'No BOM', price: 500, labor: 1, overhead: 1, bom: [] });
ok('a SKU without materials is refused', blocked.status === 422 && sku.status === 422);
ok('customer created', !!cust.result?.id, JSON.stringify(cust).slice(0, 200));
await cmd(PORT, 'saveCampaign', { name: 'Test', platform: 'Meta', start: '2026-11-01', end: '2026-11-30' });
const races = await Promise.all(Array.from({ length: 8 }, (_, i) => cmd(i % 2 ? 3103 : PORT, 'saveCustomer', { name: 'Same Phone ' + i, phone: '01033334444', area: 'Maadi', address: 'x' })));
ok('8 simultaneous requests on 2 servers: exactly one customer created', races.filter(r => r.status === 200).length === 1, races.map(r => r.status).join(','));
const versions = await Promise.all([api('/api/version').then(r => r.json()), fetch('http://localhost:3103/api/version', { headers: { cookie } }).then(r => r.json())]);
ok('both servers see the same version', versions[0].v === versions[1].v);
second.kill('SIGTERM');
await b.close(); srv.kill('SIGTERM'); process.exit(fail ? 1 : 0);
