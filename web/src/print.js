/* ==========================================================================
   PRINTED DOCUMENTS: shipping labels (airway bills) and invoices sized for
   thermal label printers, 10 × 10 cm or 10 × 15 cm, one order per page.
   Printed through a hidden frame, so the screen is left as it is.
   ========================================================================== */
import { esc, round2, sum } from '@commerce-os/domain';
import { S, activeDelivery, calc, carrierName, customerOf, linesOf, money, orderOf } from '@commerce-os/domain';
import { isAr, trText } from './i18n.js';
import { fd, latestDelivery } from './ui-kit.js';

export const PRINT_SIZES = { '100x150': { w: 100, h: 150, label: '10 × 15 cm' }, '100x100': { w: 100, h: 100, label: '10 × 10 cm' } };
const T = s => trText(s);                       // interface words follow the app language
const M = n => T(money(n));

/* Code 128, character set B: covers order numbers, tracking numbers and references. Each value
   is six alternating bar and space widths; the stop symbol has seven. */
const C128 = '212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 114131 311141 411131 211412 211214 211232 2331112'.split(' ');
export function code128(text) {
  const vals = [104]; for (const ch of String(text)) { const c = ch.charCodeAt(0); if (c < 32 || c > 126) continue; vals.push(c - 32); }
  let check = vals[0]; for (let i = 1; i < vals.length; i++) check += vals[i] * i;
  vals.push(check % 103, 106);
  return vals.map(v => C128[v]).join('');
}
/* The barcode as SVG, with the quiet zones the scanners need on each side. */
export function barcodeSvg(text, heightMm = 12) {
  const widths = code128(text), quiet = 10; let x = quiet, bars = '';
  for (let i = 0; i < widths.length; i++) { const w = Number(widths[i]); if (i % 2 === 0) bars += `M${x} 0h${w}v1h-${w}z`; x += w; }
  const total = x + quiet;
  return `<svg class="bc" viewBox="0 0 ${total} 1" preserveAspectRatio="none" style="height:${heightMm}mm" role="img" aria-label="${esc(text)}"><path d="${bars}" fill="#000"/></svg>`;
}

const toCollect = o => round2(Math.max(0, calc(o).value - calc(o).paid));
function itemsList(o, max) {
  const ls = linesOf(o), shown = ls.slice(0, max), more = ls.length - shown.length;
  return `<ul class="items">${shown.map(l => `<li><b>${l.qty} ×</b> ${esc(l.name)} <span>${esc(l.variant)} · ${esc(l.sku)}</span></li>`).join('')}${more > 0 ? `<li class="more">+${more} ${T('more')}</li>` : ''}</ul>`;
}
function label(o, size) {
  const c = customerOf(o), d = activeDelivery(o) || latestDelivery(o), due = toCollect(o), small = size.h < 120, s = S();
  const units = sum(linesOf(o), l => l.qty);
  return `<section class="pg">
    <header><div><b>${esc(s.company)}</b>${s.companyPhone ? `<span>${esc(s.companyPhone)}</span>` : ''}</div><div class="r"><span>${esc(T(fd(o.at)))}</span>${d && d.mode !== 'store' ? `<span>${esc(T(carrierName(d)))}</span>` : ''}</div></header>
    <div class="ordno"><span>${T('Order')}</span><b>#${esc(o.id)}</b></div>
    ${barcodeSvg(String(o.id), small ? 10 : 13)}
    <div class="to"><small>${T('Ship to')}</small><b class="name">${esc(c?.name || '')}</b><div class="phone">${esc(c?.phone || '')}</div><div class="addr">${esc(o.address || '')}</div><div class="area">${esc(T(o.area || ''))}</div>${o.instructions ? `<div class="instr">${esc(o.instructions)}</div>` : ''}</div>
    <div class="cod ${due > 0 ? '' : 'paid'}"><small>${due > 0 ? T('Collect from customer') : T('Paid. Collect nothing.')}</small>${due > 0 ? `<b>${esc(M(due))}</b>` : ''}</div>
    ${itemsList(o, small ? 3 : 7)}
    <footer><span>${units} ${T(units === 1 ? 'unit' : 'units')}</span>${d?.tracking ? `<span>${T('Tracking no.')} <b>${esc(d.tracking)}</b></span>` : ''}${d ? `<span>${esc(d.id)}</span>` : ''}</footer>
    ${s.returnAddress && !small ? `<div class="ret"><small>${T('If undelivered, return to')}</small> ${esc(s.returnAddress)}</div>` : ''}
  </section>`;
}
function invoice(o, size) {
  const c = customerOf(o), ca = calc(o), ls = linesOf(o), s = S(), small = size.h < 120;
  const gross = sum(ls, l => l.qty * l.price), lineDisc = sum(ls, l => l.discount), due = round2(Math.max(0, ca.value - ca.paid));
  const r = (k, v, cls = '') => `<div class="tr ${cls}"><span>${T(k)}</span><b>${esc(M(v))}</b></div>`;
  return `<section class="pg inv">
    <header><div><b>${esc(s.company)}</b>${s.companyPhone ? `<span>${esc(s.companyPhone)}</span>` : ''}</div><div class="r"><b>${T('Invoice')}</b><span>#${esc(o.id)} · ${esc(T(fd(o.at)))}</span></div></header>
    <div class="cust"><b>${esc(c?.name || '')}</b>${c?.phone ? ` · ${esc(c.phone)}` : ''}</div>
    <table><thead><tr><th>${T('Item')}</th><th class="n">${T('Qty')}</th><th class="n">${T('Price')}</th><th class="n">${T('Total')}</th></tr></thead><tbody>
      ${ls.slice(0, small ? 5 : 12).map(l => `<tr><td>${esc(l.name)}<small>${esc(l.variant)}${l.discount ? ` · ${T('Discount')} ${esc(M(l.discount))}` : ''}</small></td><td class="n">${l.qty}</td><td class="n">${esc(M(l.price))}</td><td class="n">${esc(M(l.qty * l.price - l.discount))}</td></tr>`).join('')}
      ${ls.length > (small ? 5 : 12) ? `<tr><td colspan="4">+${ls.length - (small ? 5 : 12)} ${T('more')}</td></tr>` : ''}
    </tbody></table>
    <div class="totals">${r('Subtotal', gross)}${lineDisc ? r('Item discounts', -lineDisc) : ''}${o.discount ? r('Order discount', -o.discount) : ''}${o.deliveryFee ? r('Delivery fee', o.deliveryFee) : ''}${r('Total', ca.value, 'grand')}${ca.paid ? r('Paid', ca.paid) : ''}${r(due > 0 ? 'Balance due' : 'Balance', due, 'due')}</div>
    ${barcodeSvg(String(o.id), small ? 8 : 10)}
    <footer class="thanks">${T('Thank you for your order')}</footer>
  </section>`;
}
const CSS = (w, h) => `@page{size:${w}mm ${h}mm;margin:0}*{box-sizing:border-box;margin:0;padding:0}
html,body{width:${w}mm;font:9.5pt/1.3 -apple-system,"Segoe UI",Tahoma,Arial,sans-serif;color:#000;background:#fff;-webkit-print-color-adjust:exact;print-color-adjust:exact}
.pg{width:${w}mm;height:${h}mm;padding:3.5mm;display:flex;flex-direction:column;gap:1.8mm;overflow:hidden;page-break-after:always;break-after:page}
.pg:last-child{page-break-after:auto;break-after:auto}
header{display:flex;justify-content:space-between;gap:2mm;border-bottom:.4mm solid #000;padding-bottom:1.5mm}header div{display:flex;flex-direction:column}header b{font-size:11pt}header span{font-size:8pt}header .r{text-align:end}
.ordno{display:flex;align-items:baseline;gap:2mm}.ordno span{font-size:8pt}.ordno b{font-size:20pt;letter-spacing:.3mm}
.bc{width:100%;display:block}
.to{border:.4mm solid #000;border-radius:1.5mm;padding:1.8mm 2.2mm}.to small,.cod small,.ret small{display:block;font-size:7pt;text-transform:uppercase;letter-spacing:.3mm}.to .name{font-size:12pt;display:block}.to .phone{font-size:11pt;font-weight:700}.to .addr{font-size:9.5pt}.to .area{font-weight:700}.to .instr{font-size:8pt;margin-top:.8mm;font-style:italic}
.cod{background:#000;color:#fff;border-radius:1.5mm;padding:1.6mm 2.2mm;display:flex;justify-content:space-between;align-items:center}.cod b{font-size:15pt}.cod.paid{background:#fff;color:#000;border:.4mm dashed #000}
.items{list-style:none;font-size:8.5pt;flex:1;overflow:hidden}.items li{padding:.4mm 0;border-bottom:.2mm dotted #999}.items li span{font-size:7.5pt;color:#333}.items .more{font-style:italic}
footer{display:flex;justify-content:space-between;gap:2mm;font-size:7.5pt;border-top:.3mm solid #000;padding-top:1mm;flex-wrap:wrap}
.ret{font-size:7.5pt}
/* Names, addresses and products keep their own reading order inside an Arabic page. */
.to>*,.items li,.cust,.inv td,.ret,footer span{unicode-bidi:plaintext}
.inv .cust{font-size:9pt}.inv table{width:100%;border-collapse:collapse;font-size:8pt}.inv th{text-align:start;border-bottom:.3mm solid #000;padding:.6mm 0;font-size:7.5pt}.inv td{padding:.7mm 0;border-bottom:.2mm dotted #999;vertical-align:top}.inv td small{display:block;font-size:7pt;color:#333}.inv .n{text-align:end;white-space:nowrap;padding-inline-start:1.5mm}
.totals{margin-top:auto}.tr{display:flex;justify-content:space-between;font-size:8.5pt;padding:.3mm 0}.tr.grand{border-top:.4mm solid #000;margin-top:.6mm;padding-top:.8mm;font-size:11pt}.tr.due{font-weight:700}
.thanks{justify-content:center;font-size:8pt;border:0}
@media screen{body{background:#eee}.pg{background:#fff;margin:4mm auto;box-shadow:0 1mm 4mm #0003}}`;

/* kind: 'label' | 'invoice' | 'both'. Returns the full HTML document, one page per document. */
export function printHtml(orderIds, kind = 'label', sizeKey = '100x150') {
  const size = PRINT_SIZES[sizeKey] || PRINT_SIZES['100x150'];
  const pages = [];
  for (const id of orderIds) {
    const o = orderOf(Number(id)); if (!o) continue;
    if (kind !== 'invoice') pages.push(label(o, size));
    if (kind !== 'label') pages.push(invoice(o, size));
  }
  return `<!doctype html><html lang="${isAr() ? 'ar' : 'en'}" dir="${isAr() ? 'rtl' : 'ltr'}"><head><meta charset="utf-8"><title>${esc(S().company)}</title><style>${CSS(size.w, size.h)}</style></head><body>${pages.join('')}</body></html>`;
}
/* Prints through a hidden frame. The browser's print dialog shows the pages and the printer. */
export function printDocs(orderIds, kind, sizeKey) {
  const html = printHtml(orderIds, kind, sizeKey), f = document.createElement('iframe');
  f.setAttribute('aria-hidden', 'true'); f.tabIndex = -1;
  f.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(f);
  const doc = f.contentDocument; doc.open(); doc.write(html); doc.close();
  setTimeout(() => { try { f.contentWindow.focus(); f.contentWindow.print(); } finally { setTimeout(() => f.remove(), 60000); } }, 300);
}
