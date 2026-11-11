import { randomBytes, scrypt, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { pool } from './db.ts';
import type { User } from './store.ts';
const scryptAsync = promisify(scrypt) as (p: string, s: Buffer, n: number) => Promise<Buffer>;
export const COOKIE = 'cos_session';
export const SESSION_DAYS = 7;
export async function hashPassword(pw: string) { const salt = randomBytes(16), key = await scryptAsync(pw, salt, 64); return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`; }
export async function checkPassword(pw: string, stored: string) { const [, s, k] = stored.split('$'); const key = await scryptAsync(pw, Buffer.from(s, 'hex'), 64); return timingSafeEqual(key, Buffer.from(k, 'hex')); }
const hashToken = (t: string) => createHash('sha256').update(t).digest('hex');
export async function createSession(userId: number) {
  const token = randomBytes(32).toString('base64url');
  await pool.query(`INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1,$2, now() + interval '${SESSION_DAYS} days')`, [hashToken(token), userId]);
  return token;
}
export async function userFromToken(token?: string): Promise<User | null> {
  if (!token) return null;
  const r = await pool.query(`SELECT u.id, u.email, u.name, u.role, u.driver_id FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash=$1 AND s.expires_at > now() AND u.active`, [hashToken(token)]);
  const u = r.rows[0]; return u ? { id: Number(u.id), email: u.email, name: u.name, role: u.role, driverId: u.driver_id } : null;
}
export const destroySession = (token: string) => pool.query('DELETE FROM sessions WHERE token_hash=$1', [hashToken(token)]);
export const destroyUserSessions = (id: number) => pool.query('DELETE FROM sessions WHERE user_id=$1', [id]);
export const validPassword = (p: unknown): p is string => typeof p === 'string' && p.length >= 10 && p.length <= 200;
let dummy: string | null = null;
export const dummyHash = async () => dummy ??= await hashPassword(randomBytes(16).toString('hex'));
/* Login throttling lives in the database, so it holds across serverless instances. */
export async function tooManyAttempts(email: string, ip: string) {
  const r = await pool.query(`SELECT count(*) FILTER (WHERE email=$1)::int AS e, count(*) FILTER (WHERE ip=$2)::int AS i FROM login_attempts WHERE at > now() - interval '15 minutes' AND (email=$1 OR ip=$2)`, [email, ip]);
  return r.rows[0].e >= 10 || r.rows[0].i >= 30;
}
export async function recordFailure(email: string, ip: string) {
  await pool.query('INSERT INTO login_attempts (email, ip) VALUES ($1,$2)', [email, ip]);
  if (Math.random() < 0.05) await pool.query(`DELETE FROM login_attempts WHERE at < now() - interval '1 day'`);
}
/* Creates the first owner from ADMIN_EMAIL and ADMIN_PASSWORD when no logins exist yet. */
export async function ensureAdmin() {
  const n = (await pool.query('SELECT count(*)::int AS n FROM users')).rows[0].n;
  if (n) return false;
  const { ADMIN_EMAIL: email, ADMIN_PASSWORD: pw } = process.env;
  if (!email || !validPassword(pw)) return false;
  await pool.query(`INSERT INTO users (email, name, password_hash, role) VALUES ($1,'Owner',$2,'owner') ON CONFLICT (email) DO NOTHING`, [email.toLowerCase(), await hashPassword(pw)]);
  return true;
}

/* Test logins for the demo data, one per role. The password comes from SEED_PASSWORD, never from code.
   Used by `npm run db:seed` and by "Reset demo data" when demo tools are on. */
export const DEMO_PEOPLE: [string, string, string, string | null][] = [
  ['owner@nilestudio.example', 'Nadia (Owner)', 'owner', null], ['ops@nilestudio.example', 'Sherine (Operations)', 'operations', null],
  ['warehouse@nilestudio.example', 'Tamer (Warehouse)', 'warehouse', null], ['finance@nilestudio.example', 'Mona (Finance)', 'finance', null],
  ['driver@nilestudio.example', 'Mahmoud Fawzy', 'driver', 'DRV-1'],
];
export async function ensureDemoLogins(pw: string) {
  const hash = await hashPassword(pw);
  for (const [email, name, role, driver] of DEMO_PEOPLE) await pool.query(`INSERT INTO users (email, name, password_hash, role, driver_id) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email) DO UPDATE SET password_hash=$3, name=$2, role=$4, driver_id=$5, active=true`, [email, name, hash, role, driver]);
  return DEMO_PEOPLE.map(([email, , role]) => ({ email, role }));
}
