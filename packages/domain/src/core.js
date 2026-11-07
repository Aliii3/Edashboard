
/* ==========================================================================
   LAYER 1 · CORE: utilities, repository, transactions, persistence adapter.
   Nothing in this layer knows about e-commerce or the DOM. To move to a real
   backend, replace StorageAdapter and route Domain commands through an API.
   ========================================================================== */
const SCHEMA_VERSION = 5;
const round2 = n => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const sum = (a, fn) => { let s = 0; for (const x of a) s += fn(x); return round2(s); };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
class Rule extends Error {}                         // business-rule failure, shown to the operator
const fail = msg => { throw new Rule(msg); };

/* Demo clock: seed data runs through the same commands with a simulated time. */
/* Who is acting. The server sets this from the authenticated session for each command. */
const Actor = { current: null };
const Clock = { fixed: null, now() { return this.fixed || new Date().toISOString(); } };
const addHours = (iso, h) => new Date(new Date(iso).getTime() + h * 3600e3).toISOString();

/* Table definitions. `idx` fields get a secondary index, so lookups stay O(1)
   as records grow. `agg` keeps a running total per key, so stock balances never
   rescan the journal. Adding an entity means adding one line here. */
const SCHEMA = {
  skus: { idx: [] }, materials: { idx: [] }, boms: { idx: [] },
  customers: { idx: ['phone'] }, contacts: { idx: ['customerId'] },
  couriers: { idx: [] }, drivers: { idx: [] },
  campaigns: { idx: [] }, spend: { idx: ['campaignId'] },
  orders: { idx: ['customerId', 'campaignId', 'status', 'externalRef'] },
  lines: { idx: ['orderId', 'sku'], agg: [['sku', 'reserved']] },
  deliveries: { idx: ['orderId', 'carrierKey'] },
  payments: { idx: ['orderId', 'deliveryId', 'holderKey', 'ref'] },
  handovers: { idx: ['driverId', 'ref'] }, handoverAllocs: { idx: ['handoverId', 'deliveryId', 'orderId'] },
  settlements: { idx: ['courierId', 'ref'] }, settlementAllocs: { idx: ['settlementId', 'deliveryId', 'orderId'] },
  driverExpenses: { idx: ['driverId', 'deliveryId'] },
  discrepancies: { idx: ['orderId', 'carrierKey'] },
  cases: { idx: ['orderId'] },
  movements: { idx: ['item', 'key'], agg: [['item', 'qty']] },
  production: { idx: ['sku'] },
  expenses: { idx: [] },
  events: { idx: ['orderId', 'driverId', 'customerId', 'deliveryId'] },
};

/* Repository: normalized tables, primary and secondary indexes, undo-log transactions. */
const Repo = {
  data: null, pk: {}, ix: {}, ag: {}, undo: null, capture: null, version: 0, listeners: [],
  empty() { const d = { schema: SCHEMA_VERSION, workspaceId: 'ws-demo', seq: {}, settings: {}, roadmap: {}, tables: {} }; for (const t in SCHEMA) d.tables[t] = []; return d; },
  load(data) {
    this.data = data; this.pk = {}; this.ix = {}; this.ag = {};
    for (const t in SCHEMA) {
      if (!data.tables[t]) data.tables[t] = [];
      this.pk[t] = new Map(); this.ix[t] = {};
      for (const f of SCHEMA[t].idx) this.ix[t][f] = new Map();
      this.ag[t] = {}; for (const [by, val] of SCHEMA[t].agg || []) this.ag[t][by + ':' + val] = new Map();
      for (const r of data.tables[t]) { this.pk[t].set(r.id, r); this._index(t, r); }
    }
    this.touch();
  },
  _index(t, r) { for (const f of SCHEMA[t].idx) { const v = r[f]; if (v === undefined || v === null) continue; const m = this.ix[t][f]; let s = m.get(v); if (!s) m.set(v, s = new Set()); s.add(r); } this._agg(t, r, 1); },
  _agg(t, r, sign) { for (const [by, val] of SCHEMA[t].agg || []) { const m = this.ag[t][by + ':' + val], k = r[by]; m.set(k, (m.get(k) || 0) + sign * (r[val] || 0)); } },
  total(t, by, val, key) { return round2(this.ag[t][by + ':' + val].get(key) || 0); },
  _unindex(t, r) { for (const f of SCHEMA[t].idx) { const v = r[f]; if (v === undefined || v === null) continue; const s = this.ix[t][f].get(v); if (s) { s.delete(r); if (!s.size) this.ix[t][f].delete(v); } } this._agg(t, r, -1); },
  touch() { this.version++; },
  nextId(prefix, start = 1) { const n = (this.data.seq[prefix] ?? start - 1) + 1; const before = this.data.seq[prefix]; this.data.seq[prefix] = n; if (this.undo) this.undo.push(() => { this.data.seq[prefix] = before; }); return n; },
  all(t) { return this.data.tables[t]; },
  get(t, id) { return this.pk[t].get(id); },
  by(t, f, v) { const s = this.ix[t][f].get(v); return s ? [...s] : []; },
  count(t, f, v) { return this.ix[t][f].get(v)?.size || 0; },
  insert(t, row) {
    if (row.id === undefined) throw new Error('Row needs an id: ' + t);
    if (this.pk[t].has(row.id)) fail(`Duplicate ${t} id ${row.id}`);
    this.data.tables[t].push(row); this.pk[t].set(row.id, row); this._index(t, row); this.touch();
    if (this.undo) this.undo.push(() => { this.data.tables[t].splice(this.data.tables[t].lastIndexOf(row), 1); this.pk[t].delete(row.id); this._unindex(t, row); });
    this._track(t, row, 'upsert');
    return row;
  },
  _track(t, row, op) { if (this.capture) { const k = t + ':' + row.id; const e = this.capture.get(k); if (e) { e.op = op; e.row = row; } else this.capture.set(k, { t, row, op }); } },
  /* Only re-indexes fields that changed, so rows keep their insertion order in each index. */
  _apply(t, row, patch) {
    this._agg(t, row, -1);
    for (const f of SCHEMA[t].idx) if (f in patch && patch[f] !== row[f]) {
      const old = row[f]; if (old !== undefined && old !== null) { const s = this.ix[t][f].get(old); if (s) { s.delete(row); if (!s.size) this.ix[t][f].delete(old); } }
      const v = patch[f]; if (v !== undefined && v !== null) { const m = this.ix[t][f]; let s = m.get(v); if (!s) m.set(v, s = new Set()); s.add(row); }
    }
    Object.assign(row, patch); this._agg(t, row, 1);
  },
  update(t, row, patch) {
    const before = {}; for (const k in patch) before[k] = row[k];
    this._apply(t, row, patch); this.touch();
    if (this.undo) this.undo.push(() => this._apply(t, row, before));
    this._track(t, row, 'upsert');
    return row;
  },
  remove(t, row) {
    const arr = this.data.tables[t], i = arr.indexOf(row); if (i < 0) return;
    arr.splice(i, 1); this.pk[t].delete(row.id); this._unindex(t, row); this.touch(); this._track(t, row, 'delete');
    if (this.undo) this.undo.push(() => { arr.splice(i, 0, row); this.pk[t].set(row.id, row); this._index(t, row); });
  },
  /* Server transaction: stays open until the database commit succeeds. */
  begin() { this.undo = []; this.capture = new Map(); },
  commit() { const changes = [...this.capture.values()]; this.undo = null; this.capture = null; this.touch(); return changes; },
  rollback() { const u = this.undo || []; this.undo = null; this.capture = null; for (let i = u.length - 1; i >= 0; i--) u[i](); this.touch(); },
  /* Client: applies rows sent by the server. */
  applyRemote(t, row, op) {
    const cur = this.pk[t].get(row.id);
    if (op === 'delete') { if (cur) this.remove(t, cur); return; }
    if (cur) this._apply(t, cur, row); else this.insert(t, row);
    this.touch();
  },
  /* All-or-nothing. Any Rule thrown inside rolls back every change made so far. */
  tx(fn) {
    if (this.undo) return fn();                     // joined into the outer transaction
    this.undo = [];
    try { const out = fn(); this.undo = null; this.touch(); this.listeners.forEach(l => l()); return out; }
    catch (e) { const u = this.undo; this.undo = null; for (let i = u.length - 1; i >= 0; i--) u[i](); this.touch(); throw e; }
  },
};

/* Schema migrations: each step upgrades a saved workspace by one version. */
const MIGRATIONS = {
  /* 5: example: { 6: d => { d.tables.warehouses = [...]; } } */
};
function migrate(d) {
  if (!d || !d.tables || !d.schema) return null;
  if (d.schema > SCHEMA_VERSION) return null;
  while (d.schema < SCHEMA_VERSION) { const m = MIGRATIONS[d.schema + 1]; if (!m) return null; m(d); d.schema++; }
  return d;
}


export { Actor, Clock, MIGRATIONS, Repo, Rule, SCHEMA, SCHEMA_VERSION, addHours, esc, fail, migrate, round2, sum };
