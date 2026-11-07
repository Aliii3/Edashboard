/* Builds the real Vercel bundle, serves it the way Vercel routes requests, and drives it in a browser. */
import { spawn, execSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { runUi } from './ui.mjs';
const root = path.resolve(import.meta.dirname, '..'), SHOT = path.join(root, 'e2e/shots'); mkdirSync(SHOT, { recursive: true });
const DB = process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/commerce_os_test', PW = 'e2e-password-123', PORT = 3201;
const env = { ...process.env, DATABASE_URL: DB, PORT: String(PORT), NODE_ENV: 'production', DEMO_TOOLS: '1', SEED_PASSWORD: PW, ALLOW_DEMO_SEED: '1', VITE_E2E: '1' };
execSync(`psql "${DB}" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public"`, { stdio: 'ignore' });
execSync('node src/cli.ts seed', { cwd: path.join(root, 'server'), env, stdio: 'ignore' });
execSync('node scripts/build-vercel.mjs', { cwd: root, env: { ...env, E2E_BUILD: '1' }, stdio: 'ignore' });
const srv = spawn('node', ['scripts/serve-vercel.mjs'], { cwd: root, env, stdio: ['ignore', 'pipe', 'inherit'] });
await new Promise((res, rej) => { srv.stdout.on('data', d => String(d).includes('Vercel output on') && res()); srv.on('exit', c => rej(new Error('server exited ' + c))); });
let failed = 1;
try { failed = await runUi({ chromium, URL: `http://localhost:${PORT}/`, SHOT, PW, chrome: process.env.CHROME_PATH }); }
finally { srv.kill('SIGTERM'); execSync('node scripts/build-vercel.mjs', { cwd: root, stdio: 'ignore' }); }
process.exit(failed ? 1 : 0);
