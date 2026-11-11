/* Interface language. English is the source text everywhere in the code; in Arabic, every piece
   of interface text is swapped for its translation as it reaches the page (screens, pop-ups,
   notifications, search results), and the layout runs right to left. Stored data never changes:
   values, codes and anything typed into a form stay as entered. */
import { AR } from './i18n-ar.js';

const KEY = 'cos_lang';
let lang = (() => { try { return localStorage.getItem(KEY) === 'ar' ? 'ar' : 'en'; } catch { return 'en'; } })();
export const isAr = () => lang === 'ar';
export function setLang(next) { lang = next === 'ar' ? 'ar' : 'en'; try { localStorage.setItem(KEY, lang); } catch { /* private mode: this visit only */ } applyDir(); }
export function applyDir() { const h = document.documentElement; h.lang = lang; h.dir = lang === 'ar' ? 'rtl' : 'ltr'; }

/* Whole-text matches first. Multi-word phrases are also replaced inside longer text, longest
   first, which covers sentences built around a number or a name. Single words only ever match
   a whole piece of text, so a word inside a customer's note is left alone. */
const exact = new Map(Object.entries(AR));
const escapeRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const phrases = Object.keys(AR).filter(k => /\s/.test(k.trim()) || /^[^A-Za-z]/.test(k)).sort((a, b) => b.length - a.length);
const PHRASE_RE = new RegExp(phrases.map(escapeRe).join('|'), 'g');
const MONTHS = { Jan: 'يناير', Feb: 'فبراير', Mar: 'مارس', Apr: 'أبريل', May: 'مايو', Jun: 'يونيو', Jul: 'يوليو', Aug: 'أغسطس', Sep: 'سبتمبر', Oct: 'أكتوبر', Nov: 'نوفمبر', Dec: 'ديسمبر' };
const MONTH_RE = /\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b(?=[ ,]+\d)|(?<=\d )(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\b/g;
const memo = new Map();
/* Sentences built around a number or a date. */
const PATTERNS = [
  [/^Page (\d+) of (\d+) · ([\d,]+) records?$/, (m, a, b, c) => `صفحة ${a} من ${b} · ${c} سجل`],
  [/^Showing (.+)$/, (m, a) => `عرض ${trText(a)}`],
  [/^Phase (\d+)$/, (m, a) => `المرحلة ${a}`],
  [/^(\d+) selected$/, (m, a) => `${a} محدد`],
  [/^([\d,]+) available$/, (m, a) => `${a} متاح`],
  [/^([\d,]+) units?$/, (m, a) => `${a} وحدة`],
  [/^([\d,]+) delivered$/, (m, a) => `${a} تم تسليمها`],
  [/^Received (.+)$/, (m, a) => `تم الاستلام ${a}`],
  [/^Pickup (.+)$/, (m, a) => `الاستلام ${a}`],
  [/^Why (\d+) other actions? (?:are|is) unavailable$/, (m, a) => `لماذا ${a} إجراءات أخرى غير متاحة`],
  [/^A (.+?) order cannot be assigned for delivery\.$/, (m, a) => `لا يمكن إسناد طلب حالته "${trText(a)}" للتوصيل.`],
  [/^A (.+?) order cannot be cancelled\.$/, (m, a) => `لا يمكن إلغاء طلب حالته "${trText(a)}".`],
  [/^Depends on: (.+)$/, (m, a) => `يعتمد على: ${trText(a)}`],
  [/^\+(\d+) more lines?$/, (m, a) => `+${a} سطر إضافي`],
  [/^of ([\d,]+) in the workspace$/, (m, a) => `من ${a} في النظام`],
  [/^([\d,]+) orders? placed$/, (m, a) => `${a} طلب`],
  [/^([\d,]+) (?:items?) waiting$/, (m, a) => `${a} في الانتظار`],
  [/^(\d+) of (\d+) closed deliveries$/, (m, a, b) => `${a} من ${b} توصيلة منتهية`],
  [/^(\d+) more\.$/, (m, a) => `${a} أخرى.`],
  [/^(Collection|Refund) (\S+)$/, (m, a, b) => `${a === 'Refund' ? 'استرداد' : 'تحصيل'} ${b}`],
  [/^(\d+) × (\S+) delivered$/, (m, a, b) => `${a} × ${b} تم تسليمها`],
  [/^(\d+) assignments?(.*)$/, (m, a, b) => `${a} إسناد${trText(b)}`],
  [/^Prepaid (.+)$/, (m, a) => `مدفوع مقدمًا ${a}`],
  [/^(\S+) channel$/, (m, a) => `قناة ${a}`],
  [/^channel (\S+)$/, (m, a) => `القناة ${a}`],
  [/^Zones: (.+)$/, (m, a) => `المناطق: ${trText(a)}`],
  [/^(\d+) out for delivery$/, (m, a) => `${a} خرج للتوصيل`],
];
/* Status and channel words left inside an otherwise translated sentence. */
const WORDS = ['collected', 'ship', 'return', 'System', 'Delivery', 'Collected', 'fees', 'Delivered', 'Ready', 'Processing', 'Confirmed', 'Shipped', 'Cancelled', 'Returned', 'Manual', 'Weekly', 'Daily', 'Monthly', 'Assigned', 'Prepaid', 'Card', 'Cash', 'Phone', 'Website', 'Exchange', 'Planned', 'Completed', 'Motorcycle', 'Van', 'Car', 'Bicycle', 'COD', 'New'].filter(w => AR[w]);
const WORD_RE = new RegExp(`\\b(${WORDS.join('|')})\\b`, 'g');
const hasArabic = s => /[؀-ۿ]/.test(s);

export function trText(s) {
  if (lang !== 'ar' || !s || !/[A-Za-z]/.test(s)) return s;
  const hit = memo.get(s); if (hit !== undefined) return hit;
  const t = s.trim(), at = s.indexOf(t), lead = s.slice(0, at), trail = s.slice(at + t.length);
  let out = exact.get(t);
  if (out === undefined) {
    for (const [re, fn] of PATTERNS) { const m = t.match(re); if (m) { out = fn(...m); break; } }
    /* Pieces joined with a middle dot are translated one by one. */
    if (out === undefined && t.includes(' · ')) out = t.split(' · ').map(x => trText(x)).join(' · ');
    if (out === undefined) out = /\s/.test(t) || /^[^A-Za-z]/.test(t) ? t.replace(PHRASE_RE, m => AR[m]) : t;
  }
  out = out.replace(/\bEGP\b/g, 'ج.م').replace(MONTH_RE, (m, a, b) => MONTHS[a || b]).replace(/(?<=\d) to (?=\d)/g, ' إلى ').replace(/\((\d+) units?\)/g, '($1 وحدة)');
  if (out !== exact.get(t) && hasArabic(out)) out = out.replace(WORD_RE, w => AR[w]);
  const r = lead + out + trail;
  if (memo.size > 20000) memo.clear();
  memo.set(s, r); return r;
}

const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE']);
const ATTRS = ['placeholder', 'title', 'aria-label'];
export function translateTree(root) {
  if (lang !== 'ar' || !root) return;
  if (root.nodeType === 3) { const v = trText(root.nodeValue); if (v !== root.nodeValue) root.nodeValue = v; return; }
  if (root.nodeType !== 1 || SKIP.has(root.nodeName) || root.closest?.('[data-no-i18n]')) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => SKIP.has(n.parentNode?.nodeName) || n.parentElement?.closest('[data-no-i18n]') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { const v = trText(n.nodeValue); if (v !== n.nodeValue) n.nodeValue = v; }
  const els = root.querySelectorAll('[placeholder],[title],[aria-label]');
  for (const el of [root, ...els]) for (const a of ATTRS) { const v = el.getAttribute?.(a); if (v) { const t = trText(v); if (t !== v) el.setAttribute(a, t); } }
}

/* Translate anything added to the page, before it is painted. */
export function startI18n() {
  applyDir();
  if (lang !== 'ar') return;
  translateTree(document.body);
  new MutationObserver(muts => { for (const m of muts) for (const n of m.addedNodes) translateTree(n); }).observe(document.body, { childList: true, subtree: true });
}
