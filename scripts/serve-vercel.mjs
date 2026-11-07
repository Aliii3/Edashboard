/* Serves .vercel/output locally the way Vercel routes it, to test the deployment bundle before deploying. */
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const root = path.resolve(import.meta.dirname, '../.vercel/output'), port = Number(process.env.PORT) || 3200;
const { default: handler } = await import(pathToFileURL(path.join(root, 'functions/api.func/index.mjs')).href);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost'), m = u.pathname.match(/^\/api\/(.*)$/);
  if (m) { u.searchParams.set('__path', m[1]); req.url = `/api?${u.searchParams}`; return handler(req, res); }
  let file = path.join(root, 'static', path.normalize(u.pathname).replace(/^(\.\.[/\\])+/, ''));
  try { if (!(await stat(file)).isFile()) throw 0; } catch { file = path.join(root, 'static/index.html'); }
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' }); res.end(await readFile(file));
}).listen(port, () => console.log(`Vercel output on http://localhost:${port}`));
