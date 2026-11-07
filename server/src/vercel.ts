/* Vercel function entry. Every /api request is routed here, with the original
   path in __path. Bundled to .vercel/output by scripts/build-vercel.mjs. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { attachDatabasePool } from '@vercel/functions';
import { pool } from './db.ts';
import { buildApp } from './app.ts';

attachDatabasePool(pool);
let ready: Promise<Awaited<ReturnType<typeof buildApp>>> | null = null;
export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= buildApp().then(async app => { await app.ready(); return app; }).catch(e => { ready = null; throw e; });
  const app = await ready;
  const u = new URL(req.url || '/', 'http://localhost'), p = u.searchParams.get('__path');
  if (p !== null) { u.searchParams.delete('__path'); req.url = `/api/${p}${u.search}`; }
  app.server.emit('request', req, res);
}
