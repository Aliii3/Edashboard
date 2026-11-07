/* Local server: the same API as on Vercel, plus the built web app. */
import { existsSync } from 'node:fs';
import { migrateDb } from './db.ts';
import { ensureAdmin } from './auth.ts';
import { ensureWorkspace } from './store.ts';
import { buildApp } from './app.ts';

if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL (see .env.example).'); process.exit(1); }
if (process.env.NODE_ENV === 'production' && process.env.COOKIE_SECURE !== '1') { console.error('Set COOKIE_SECURE=1 and serve over HTTPS in production.'); process.exit(1); }
await migrateDb(); await ensureWorkspace();
if (await ensureAdmin()) console.log(`Created owner account ${process.env.ADMIN_EMAIL}`);
const app = await buildApp({ serveStatic: existsSync(new URL('../../web/dist/index.html', import.meta.url)) });
const port = Number(process.env.PORT) || 3001;
await app.listen({ port, host: process.env.HOST || '127.0.0.1' });
console.log(`Commerce OS API on http://localhost:${port}`);
const stop = async () => { await app.close(); process.exit(0); };
process.on('SIGTERM', stop); process.on('SIGINT', stop);
