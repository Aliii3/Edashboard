/* Client side of the API. Screens call Commands.x() as before; the server runs
   the command. The workspace loads in pages, then stays current by fetching only
   what changed since the last sync. */
import { Repo, Rule, canRun, seesCosts, ROLE_SCREENS, SCHEMA } from '@commerce-os/domain';
export const Session = { user: null, demoTools: false, online: true, version: 0, onAuthLost: null, onChange: null, onProgress: null,
  can(cmd) { return !!this.user && canRun(this.user.role, cmd); },
  canSee(screen) { return !!this.user && ROLE_SCREENS[this.user.role].includes(screen); },
  get isDriver() { return this.user?.role === 'driver'; },
  /* Product costs, profit, campaign spend and company expenses: owner and finance only. The server enforces it. */
  get seesCosts() { return !!this.user && seesCosts(this.user.role); },
};
export async function request(path, { method = 'GET', body } = {}) {
  let res;
  try { res = await fetch(path, { method, headers: body !== undefined ? { 'Content-Type': 'application/json' } : {}, body: body !== undefined ? JSON.stringify(body) : undefined, credentials: 'same-origin' }); }
  catch { Session.online = false; throw new Rule('Can\'t reach the server. Check your connection. Nothing was saved.'); }
  Session.online = true;
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/auth/login' && path !== '/api/me') { Session.onAuthLost?.(); throw new Rule('Your session ended. Please sign in again.'); }
  if (res.status === 413) throw new Rule('That file is too large to upload here. Use npm run db:restore from a computer instead.');
  if (!res.ok) throw new Rule(data.error || `The server returned an error (${res.status}). Open /api/health to check the setup.`);
  return data;
}
let loading = null;
/* Full load: version first, then every table page by page, then catch up on anything that changed meanwhile. */
export function loadSnapshot() {
  return loading ??= (async () => {
    try {
      if (Session.isDriver) { const d = await request('/api/snapshot/mine'); const v = d.version; delete d.version; Repo.load(d); Session.version = v; Session.onChange?.(); return; }
      const meta = await request('/api/version'), tables = {}, names = Object.keys(SCHEMA);
      for (const t of names) tables[t] = [];
      /* Usually one request: the server packs every table into it, and says where to continue if not. */
      let next = { t: '', after: 0 };
      while (next) {
        const page = await request(`/api/snapshot/batch?t=${encodeURIComponent(next.t)}&after=${next.after}`);
        for (const t in page.tables) for (const r of page.tables[t]) tables[t].push(r);
        next = page.next;
        Session.onProgress?.(next ? Math.max(0, names.indexOf(next.t)) : names.length, names.length);
      }
      Repo.load({ schema: meta.schema, workspaceId: 'ws-1', seq: {}, settings: meta.settings, roadmap: meta.roadmap, tables });
      Session.version = meta.v;
      await pull(true);
      Session.onChange?.();
    } finally { loading = null; }
  })();
}
function apply(d) {
  for (const { t, op, row } of d.changes) Repo.applyRemote(t, row, op);
  if (d.meta) { Repo.data.settings = d.meta.settings; Repo.data.roadmap = d.meta.roadmap; }
  Repo.touch(); Session.version = d.v;
}
/* Fetches changes since the last known version. */
export async function pull(quiet = false) {
  const d = await request(`/api/changes?since=${Session.version}`);
  if (d.resync) return loadSnapshot();
  if (d.v <= Session.version && !d.changes.length) return;
  apply(d); if (!quiet) Session.onChange?.();
}
export const Commands = new Proxy({}, { get: (_, name) => async (...args) => {
  const r = await request(`/api/commands/${name}`, { method: 'POST', body: { args } });
  if (r.resync) await loadSnapshot();
  else if (r.delta.v === Session.version + 1) { apply(r.delta); Session.onChange?.(); }
  else await pull();
  return r.result;
} });
/* Polling replaces a held-open connection, which serverless hosts don't keep. */
let timer = null;
export function startSync(every = 4000) {
  stopSync();
  const tick = async () => { if (document.visibilityState === 'visible' && !loading) { try { await pull(); } catch { /* shown via Session.online */ } } timer = setTimeout(tick, every); };
  timer = setTimeout(tick, every);
  document.addEventListener('visibilitychange', onVisible);
}
const onVisible = () => { if (document.visibilityState === 'visible' && Session.user && !loading) pull().catch(() => {}); };
export function stopSync() { clearTimeout(timer); timer = null; document.removeEventListener('visibilitychange', onVisible); }
