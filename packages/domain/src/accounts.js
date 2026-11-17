import { Repo, round2 } from './core.js';
import { EXPENSE_CATS, calc, carrierCharge, dateKey } from './domain.js';
/* ==========================================================================
   CHART OF ACCOUNTS: a double-entry journal built from the records the app
   already keeps (orders, payments, handovers, settlements, spend, expenses).
   Nothing is typed in here, so it always agrees with Profit & loss.
   ========================================================================== */
const OPEX_CODES = Object.fromEntries(EXPENSE_CATS.map((c, i) => [c, String(6510 + i * 10)]));
/* [code, name, parent code]. Only leaf accounts receive entries. */
const ACCOUNTS = [
  ['1000', 'Assets', null],
  ['1100', 'Business cash and bank', '1000'],
  ['1200', 'Cash with couriers', '1000'],
  ['1300', 'Customer receivables', '1000'],
  ['1400', 'Inventory', '1000'],
  ['2000', 'Liabilities', null],
  ['2100', 'Owed to couriers for shipping', '2000'],
  ['4000', 'Revenue', null],
  ['4100', 'Product sales', '4000'],
  ['4200', 'Shipping fees charged to customers', '4000'],
  ['5000', 'Cost of sales', null],
  ['5100', 'Cost of goods sold', '5000'],
  ['6000', 'Expenses', null],
  ['6100', 'Delivery costs', '6000'],
  ['6200', 'Return shipping costs', '6000'],
  ['6300', 'Payment and COD fees', '6000'],
  ['6400', 'Marketing', '6000'],
  ['6500', 'Operating expenses', '6000'],
  ...EXPENSE_CATS.map(c => [OPEX_CODES[c], c, '6500']),
  ['6600', 'Courier expenses', '6000'],
].map(([code, name, parent]) => ({ code, name, parent, type: { 1: 'Asset', 2: 'Liability', 4: 'Revenue', 5: 'Expense', 6: 'Expense' }[code[0]] }));
const ACCOUNT = new Map(ACCOUNTS.map(a => [a.code, a]));
const isLeaf = code => !ACCOUNTS.some(a => a.parent === code);

/* Journal lines: { code, amt (debit +, credit -), at, d, why, orderId, ref }. Every posting is balanced. */
const _journal = { v: -1, rows: [] };
function journal() {
  if (_journal.v === Repo.version) return _journal.rows; _journal.v = Repo.version;
  const rows = [];
  const post = (at, dr, cr, amt, why, x = {}) => { amt = round2(amt); if (!amt || !at) return; const d = dateKey(at); rows.push({ code: dr, amt, at, d, why, ...x }, { code: cr, amt: -amt, at, d, why, ...x }); };
  for (const o of Repo.all('orders')) {
    for (const e of calc(o).entries) {
      const x = { orderId: o.id };
      if (e.acct === 'revenue') post(e.at, '1300', e.tag === 'fee' ? '4200' : '4100', e.amt, e.why, x);
      else if (e.acct === 'cogs') post(e.at, '5100', '1400', e.amt, e.why, x);
      else if (e.acct === 'delivery') post(e.at, e.tag === 'return' ? '6200' : '6100', '2100', e.amt, e.why, x);
      else if (e.acct === 'fees') post(e.at, '6300', e.why.startsWith('COD fee') ? '2100' : '1100', e.amt, e.why, x);
    }
  }
  for (const p of Repo.all('payments')) if (p.method !== 'Exchange credit') post(p.at, p.holderKey === 'business' ? '1100' : '1200', '1300', p.amount, `${p.kind === 'refund' ? 'Refund' : 'Collection'} ${p.ref}`, { orderId: p.orderId, ref: p.ref });
  for (const a of Repo.all('handoverAllocs')) { const h = Repo.get('handovers', a.handoverId); post(h.at, '1100', '1200', a.amount, `Driver handover ${h.ref}`, { orderId: a.orderId, ref: h.ref }); }
  const netted = new Set();
  for (const a of Repo.all('settlementAllocs')) {
    const s = Repo.get('settlements', a.settlementId), d = Repo.get('deliveries', a.deliveryId);
    post(s.at, '1100', '1200', a.net, `Courier settlement ${s.ref}`, { orderId: a.orderId, ref: s.ref });
    /* The courier keeps its charges out of the customer cash it holds. */
    if (d && !netted.has(d.id)) { netted.add(d.id); post(s.at, '2100', '1200', carrierCharge(d), `Courier kept its charges on ${d.id}`, { orderId: a.orderId, ref: s.ref }); }
  }
  for (const x of Repo.all('driverExpenses')) if (x.status === 'Approved') {
    const at = x.decidedAt || x.at;
    if (x.category === 'Delivery fee payout') post(at, '2100', x.paidFromCash ? '1200' : '1100', x.amount, `Driver kept their commission ${x.id}`, { ref: x.id });
    else post(at, '6600', x.paidFromCash ? '1200' : '2100', x.amount, `${x.category} ${x.id}`, { ref: x.id });
  }
  for (const s of Repo.all('spend')) post(s.at, '6400', '1100', s.amount, s.note || 'Campaign spend', { ref: s.campaignId });
  for (const e of Repo.all('expenses')) post(e.at, OPEX_CODES[e.category] || OPEX_CODES.Other, '1100', e.amount, e.name, { ref: e.id });
  return _journal.rows = rows;
}
const inRange = (e, r = {}) => (!r.from || e.d >= r.from) && (!r.to || e.d <= r.to);
const under = (code, root) => { for (let c = code; c; c = ACCOUNT.get(c)?.parent) if (c === root) return true; return false; };

/* Debit-positive balance of each account (parents include their children) for entries in the range. */
function accountBalances(r = {}) {
  const leaf = new Map();
  for (const e of journal()) if (inRange(e, r)) leaf.set(e.code, (leaf.get(e.code) || 0) + e.amt);
  const out = new Map(ACCOUNTS.map(a => [a.code, 0]));
  for (const [code, v] of leaf) for (let c = code; c; c = ACCOUNT.get(c)?.parent) out.set(c, out.get(c) + v);
  for (const [k, v] of out) out.set(k, round2(v));
  return out;
}
/* Trial balance as of a date: every leaf account with its debit or credit balance. */
function trialBalance(to) {
  const b = accountBalances({ to }), rows = ACCOUNTS.filter(a => isLeaf(a.code)).map(a => ({ ...a, debit: Math.max(0, b.get(a.code)), credit: Math.max(0, -b.get(a.code)) }));
  return { rows, debit: round2(rows.reduce((s, x) => s + x.debit, 0)), credit: round2(rows.reduce((s, x) => s + x.credit, 0)) };
}
/* Income statement for a period: revenue is shown positive, costs positive. */
function incomeStatement(r = {}) {
  const b = accountBalances(r), revenue = round2(-b.get('4000')), cos = b.get('5000'), expenses = b.get('6000');
  return { balances: b, revenue, cos, gross: round2(revenue - cos), expenses, profit: round2(revenue - cos - expenses) };
}
/* One account's entries in a period, with the balance before it and a running balance. */
function accountLedger(code, r = {}) {
  let opening = 0; const rows = [];
  for (const e of journal()) if (under(e.code, code)) { if (r.from && e.d < r.from) opening += e.amt; else if (inRange(e, r)) rows.push(e); }
  rows.sort((a, b) => a.at.localeCompare(b.at));
  let run = opening; const out = rows.map(e => ({ ...e, balance: round2(run += e.amt) }));
  return { opening: round2(opening), rows: out, closing: round2(run) };
}

export { ACCOUNTS, ACCOUNT, OPEX_CODES, accountBalances, accountLedger, incomeStatement, isLeaf, journal, trialBalance };
