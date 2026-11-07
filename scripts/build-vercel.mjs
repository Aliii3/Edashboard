/* Produces .vercel/output in Vercel's Build Output API format: the web app as
   static files and the API as one Node function. */
import { execSync } from 'node:child_process';
import { rm, mkdir, writeFile, cp } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
/* Vercel reads .vercel/output from the project's Root Directory, which is where npm was started.
   Writing it there means the build works whether the Root Directory is the repo root, server/ or web/. */
const root = path.resolve(import.meta.dirname, '..'), out = path.join(process.env.INIT_CWD || root, '.vercel/output'), fn = path.join(out, 'functions/api.func');
console.log(`Writing ${path.relative(root, out) || '.'}`);
/* Applies migrations during the build only when asked, so preview builds never change the production database. */
if (process.env.MIGRATE_ON_BUILD === '1') execSync('node src/cli.ts migrate', { cwd: path.join(root, 'server'), stdio: 'inherit' });
execSync(`npx vite build${process.env.E2E_BUILD === '1' ? ' --mode e2e' : ''}`, { cwd: path.join(root, 'web'), stdio: 'inherit' });
await rm(out, { recursive: true, force: true });
await mkdir(fn, { recursive: true });
await cp(path.join(root, 'web/dist'), path.join(out, 'static'), { recursive: true });
await build({
  entryPoints: [path.join(root, 'server/src/vercel.ts')], outfile: path.join(fn, 'index.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22',
  external: ['pg-native', '@fastify/static'], legalComments: 'none', logLevel: 'warning',
  banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" },
});
await writeFile(path.join(fn, '.vc-config.json'), JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, supportsResponseStreaming: true, maxDuration: 60 }, null, 2));
await writeFile(path.join(out, 'config.json'), JSON.stringify({ version: 3, routes: [
  { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
  { src: '^/api/(.*)$', dest: '/api?__path=$1' },
  { handle: 'filesystem' },
  { src: '^/(.*)$', dest: '/index.html' },
] }, null, 2));
console.log('Built .vercel/output');
