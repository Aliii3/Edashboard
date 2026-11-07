/* Runs commands statelessly: lock the workspace, load what the command reads,
   apply the shared rules, write the changed rows and log them for sync. Safe to
   run on any number of server instances at once. */
import { Repo, Commands, Actor, SCHEMA_VERSION, DRIVER_SCOPE, Rule, canRun, carrierKey, migrate } from '@commerce-os/domain';
import { buildSeedWorkspace, runLoadTest } from '@commerce-os/domain/seed';
import { withTx, persistChanges, recordChanges, saveMeta, replaceAll, loadAll, readWorkspace, ensureColumns, type Change } from './db.ts';
import { loadScope, scopeFor } from './scope.ts';

export type User = { id: number; email: string; name: string; role: string; driverId: string | null };
export class Forbidden extends Error {}
/* The domain layer keeps one in-memory working set, so requests inside one instance take turns. */
let chain: Promise<unknown> = Promise.resolve();
const serial = <T>(fn: () => Promise<T>): Promise<T> => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
export const SETTINGS_KEYS = new Set(['company', 'currency', 'timezone', 'tolerance', 'overdueHours', 'defaultFulfillment', 'allocationPolicy', 'pageSize', 'driverFee', 'returnFeeDriver', 'sources']);

function authorize(user: User, name: string, args: any[]) {
  if (!canRun(user.role, name)) throw new Forbidden(`Your role (${user.role}) can't do this.`);
  if (name === 'saveSettings' && !Object.keys(args[0] || {}).every(k => SETTINGS_KEYS.has(k))) throw new Rule('Unknown setting.');
}
function authorizeDriver(user: User, name: string, args: any[]) {
  if (user.role !== 'driver') return;
  const scope = DRIVER_SCOPE[name], own = carrierKey('driver', user.driverId!);
  if (scope === 'driverField' && args[0]?.driverId !== user.driverId) throw new Forbidden('You can only submit your own expenses.');
  if (scope === 'delivery') {
    if (Repo.get('deliveries', args[0])?.carrierKey !== own) throw new Forbidden('This delivery is not assigned to you.');
    if (name === 'setDeliveryStatus' && args[1] === 'Cancelled Assignment') throw new Forbidden('Only the office can cancel an assignment.');
  }
}
export function runCommand(user: User, name: string, args: any[]) {
  authorize(user, name, args);
  return serial(async () => {
    await ensureColumns();
    return withTx(async c => {
      const { data, version } = await loadScope(c, scopeFor(name, args));
      Repo.load(data);
      authorizeDriver(user, name, args);
      Actor.current = user.name; Repo.begin();
      let result: any, changes: Change[];
      try { result = Commands[name](...args); changes = [...Repo.capture.values()] as Change[]; }
      catch (e) { Repo.rollback(); throw e; }
      finally { Actor.current = null; }
      Repo.commit();
      const v = version + 1;
      await persistChanges(c, changes);
      await saveMeta(c, { schema: Repo.data.schema, version: v, seq: Repo.data.seq, settings: Repo.data.settings, roadmap: Repo.data.roadmap });
      await recordChanges(c, v, changes);
      return { result, delta: { v, changes: changes.map(x => ({ t: x.t, op: x.op, row: x.row })), meta: { settings: Repo.data.settings, roadmap: Repo.data.roadmap } } };
    });
  });
}
async function replaceWorkspace(build: (current: any) => any) {
  return serial(async () => {
    await ensureColumns();
    return withTx(async c => {
      const w = await readWorkspace(c, true), out = build(c);
      const data = out instanceof Promise ? await out : out;
      await replaceAll(c, data.workspace, Number(w?.version || 0) + 1);
      return data.result;
    });
  });
}
export const resetDemo = () => replaceWorkspace(() => ({ workspace: buildSeedWorkspace() }));
export const loadTest = (n: number) => replaceWorkspace(async (c: any) => { const cur = await loadAll(c); Repo.load(cur!.data); const result = runLoadTest(n); return { workspace: Repo.data, result }; });
export const restore = (raw: any) => replaceWorkspace(() => {
  const d = migrate(raw); if (!d || d.schema !== SCHEMA_VERSION || !d.tables) throw new Rule('That file is not a valid Commerce OS backup for this version.');
  Repo.load(d); return { workspace: Repo.data };
});
/* First start: an empty workspace with default settings. */
export async function ensureWorkspace() {
  await ensureColumns();
  await withTx(async c => { if (!(await readWorkspace(c, true))) { const e = Repo.empty(); const { DEFAULT_SETTINGS } = await import('@commerce-os/domain'); e.settings = JSON.parse(JSON.stringify(DEFAULT_SETTINGS)); await replaceAll(c, e, 1); } });
}
