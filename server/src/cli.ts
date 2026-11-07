/* Command-line tasks: migrate, seed, backup and restore. Point DATABASE_URL at any database, including production. */
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { migrateDb, ensureColumns, withTx, readWorkspace, replaceAll, pool } from './db.ts';
import { hashPassword, ensureAdmin } from './auth.ts';
import { ensureWorkspace, restore } from './store.ts';
import { backupChunks } from './reads.ts';
import { buildSeedWorkspace } from '@commerce-os/domain/seed';

const [cmd, file] = process.argv.slice(2);
if (!process.env.DATABASE_URL) { console.error('Set DATABASE_URL (see .env.example).'); process.exit(1); }
const ran = await migrateDb(); console.log(ran.length ? `Migrated: ${ran.join(', ')}` : 'Database schema is up to date.');
await ensureColumns(); await ensureWorkspace();
if (await ensureAdmin()) console.log(`Created owner account ${process.env.ADMIN_EMAIL}`);
if (cmd === 'seed') {
  if (process.env.NODE_ENV === 'production' && process.env.ALLOW_DEMO_SEED !== '1') { console.error('Refusing to load demo data with NODE_ENV=production. Set ALLOW_DEMO_SEED=1 if this database is a demo.'); process.exit(1); }
  await withTx(async c => { const w = await readWorkspace(c, true); await replaceAll(c, buildSeedWorkspace(), Number(w?.version || 0) + 1); });
  const pw = process.env.SEED_PASSWORD || randomBytes(9).toString('base64url'), hash = await hashPassword(pw);
  const people: [string, string, string, string | null][] = [['owner@nilestudio.example', 'Nadia (Owner)', 'owner', null], ['ops@nilestudio.example', 'Sherine (Operations)', 'operations', null], ['warehouse@nilestudio.example', 'Tamer (Warehouse)', 'warehouse', null], ['finance@nilestudio.example', 'Mona (Finance)', 'finance', null], ['driver@nilestudio.example', 'Mahmoud Fawzy', 'driver', 'DRV-1']];
  for (const [email, name, role, driver] of people) await pool.query(`INSERT INTO users (email, name, password_hash, role, driver_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO UPDATE SET password_hash=$3, name=$2, role=$4, driver_id=$5, active=true`, [email, name, hash, role, driver]);
  console.log(`Demo data loaded. Demo logins (password ${process.env.SEED_PASSWORD ? 'from SEED_PASSWORD' : pw}):`); for (const [email, , role] of people) console.log(`  ${role.padEnd(11)} ${email}`);
}
if (cmd === 'backup') { const parts: string[] = []; for await (const p of backupChunks()) parts.push(p); await writeFile(file || 'commerce-os-backup.json', parts.join('')); console.log(`Backup written to ${file || 'commerce-os-backup.json'}`); }
if (cmd === 'restore') { if (!file) { console.error('Usage: npm run db:restore -- backup.json'); process.exit(1); } await restore(JSON.parse(await readFile(file, 'utf8'))); console.log('Backup restored.'); }
await pool.end();
