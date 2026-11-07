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
  data: null, pk: {}, ix: {}, ag: {}, undo: null, version: 0, listeners: [],
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
    return row;
  },
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
    return row;
  },
  remove(t, row) {
    const arr = this.data.tables[t], i = arr.indexOf(row); if (i < 0) return;
    arr.splice(i, 1); this.pk[t].delete(row.id); this._unindex(t, row); this.touch();
    if (this.undo) this.undo.push(() => { arr.splice(i, 0, row); this.pk[t].set(row.id, row); this._index(t, row); });
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

/* Persistence adapter. IndexedDB holds far more than localStorage, which is the
   fallback, and memory is the last resort. A future REST adapter implements the
   same load/save contract. */
const StorageAdapter = {
  KEY: 'commerce-os-workspace', mode: 'memory', _db: null, _timer: null, lastBytes: 0,
  openIDB() { return new Promise((res, rej) => { const r = indexedDB.open('commerce-os', 1); r.onupgradeneeded = () => r.result.createObjectStore('kv'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
  async init() {
    try { if (typeof indexedDB !== 'undefined') { this._db = await this.openIDB(); this.mode = 'indexeddb'; return; } } catch { /* fall through */ }
    try { localStorage.setItem('__t', '1'); localStorage.removeItem('__t'); this.mode = 'localstorage'; } catch { this.mode = 'memory'; }
  },
  load() {
    if (this.mode === 'indexeddb') return new Promise(res => { try { const q = this._db.transaction('kv').objectStore('kv').get(this.KEY); q.onsuccess = () => res(q.result || null); q.onerror = () => res(null); } catch { res(null); } });
    if (this.mode === 'localstorage') { try { return Promise.resolve(JSON.parse(localStorage.getItem(this.KEY))); } catch { return Promise.resolve(null); } }
    return Promise.resolve(null);
  },
  saveSoon(data) { clearTimeout(this._timer); this._timer = setTimeout(() => this.saveNow(data), 250); },
  saveNow(data) {
    if (this.mode === 'indexeddb') { try { this._db.transaction('kv', 'readwrite').objectStore('kv').put(data, this.KEY); } catch { this.mode = 'memory'; } }
    else if (this.mode === 'localstorage') { try { localStorage.setItem(this.KEY, JSON.stringify(data)); } catch { this.mode = 'memory'; } }
  },
  label() { return { indexeddb: 'Saved in this browser (IndexedDB)', localstorage: 'Saved in this browser (localStorage)', memory: 'Not saved: browser storage unavailable, changes last this session only' }[this.mode]; },
};
