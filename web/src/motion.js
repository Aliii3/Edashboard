/* Motion: smooth scrolling that eases to a stop, screens that flow in, cards revealed as they
   scroll into view, and figures that count up. Everything is skipped when the device asks for
   reduced motion, and nothing replays when the same screen re-renders after a sync. */
import Lenis from 'lenis';
import { trText } from './i18n.js';

const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const EASE = t => 1 - Math.pow(1 - t, 3);
let lenis = null, io = null, revealedTo = 0;

/* Macs, iPhones, iPads and touch screens already scroll with smooth native momentum, and native
   scrolling runs off the main thread at the screen's full refresh rate (120 Hz on recent Macs).
   Script-driven smoothing would replace that with frames drawn from JavaScript, which Safari
   caps at 60 fps. So the glide is only added for mouse wheels on other systems. */
const platform = navigator.userAgentData?.platform || navigator.platform || '';
const nativeMomentum = /Mac|iPhone|iPad|iPod/i.test(platform) || matchMedia('(pointer: coarse)').matches;
export function startSmoothScroll() {
  if (lenis || reduced() || nativeMomentum) return;
  /* lerp sets the glide: lower is a longer, softer trail behind the wheel. Nested scroll areas
     (tables, pop-ups, search results) keep their own native scrolling. */
  lenis = new Lenis({ autoRaf: true, lerp: 0.2, wheelMultiplier: 1, allowNestedScroll: true, prevent: n => !!n.closest?.('dialog, .search-results') });
}
export function scrollTop() { if (lenis) lenis.scrollTo(0, { immediate: true, force: true }); else window.scrollTo(0, 0); }

/* What flows in, outermost first. Nested items (tiles, driver cards) follow their card. */
const REVEAL = '.hero, .heading, .filterbar, .kpi-grid, .tabs, .note, .stepper, .card, .panel, .tile, .driver-card, .queue, .mini-q';

export function enterScreen(root) {
  io?.disconnect(); io = null;
  if (reduced()) return;
  root.classList.remove('entering'); void root.offsetWidth; root.classList.add('entering');
  clearTimeout(enterScreen.t); enterScreen.t = setTimeout(() => root.classList.remove('entering'), 1000);
  revealedTo = 0;
  watch([...root.querySelectorAll(REVEAL)]);
  countUp(root);
}
/* The same screen was redrawn (new data arrived). Anything already revealed stays visible; anything
   further down still waits for the scroll. */
export function refreshScreen(root) {
  if (!io || reduced()) return;
  io.disconnect(); io = null;
  const limit = Math.max(revealedTo, scrollY + innerHeight);
  watch([...root.querySelectorAll(REVEAL)].filter(el => el.getBoundingClientRect().top + scrollY > limit));
}
function watch(els) {
  for (const el of els) el.classList.add('rv');
  io = new IntersectionObserver(entries => {
    const shown = entries.filter(e => e.isIntersecting).map(e => e.target);
    shown.sort((a, b) => { const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(); return ra.top - rb.top || ra.left - rb.left; });
    shown.forEach((el, i) => {
      el.style.setProperty('--d', Math.min(i, 5) * 20 + 'ms');
      el.classList.add('in'); io?.unobserve(el); revealedTo = Math.max(revealedTo, el.getBoundingClientRect().bottom + scrollY);
      /* Once settled, drop the reveal classes so hover effects run without the stagger delay. */
      setTimeout(() => { el.classList.remove('rv', 'in'); el.style.removeProperty('--d'); }, 320 + Math.min(i, 5) * 20);
    });
  }, { rootMargin: '0px', threshold: 0 });   // any visible part reveals it, so nothing sits blank at the screen edge
  for (const el of els) io.observe(el);
}

/* Counts headline figures up from zero, keeping their currency, separators and decimals. */
function countUp(root) {
  for (const el of root.querySelectorAll('.hstat-v, .bignum strong, .kpi .value, .tile-n, .g-val strong, .queue strong')) {
    const node = [...el.childNodes].find(n => n.nodeType === 3 && /\d/.test(n.nodeValue)); if (!node) continue;
    const m = node.nodeValue.match(/^(.*?)(-?[\d,]+(?:\.\d+)?)(.*)$/s); if (!m) continue;
    const target = Number(m[2].replace(/,/g, '')), decimals = (m[2].split('.')[1] || '').length;
    if (!Number.isFinite(target) || target === 0) continue;
    const fmt = v => trText(m[1] + v.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }) + m[3]);
    const start = performance.now(), dur = 600;
    const step = now => { if (!node.isConnected) return; const t = Math.min(1, (now - start) / dur); node.nodeValue = fmt(target * EASE(t)); if (t < 1) requestAnimationFrame(step); else node.nodeValue = fmt(target); };
    node.nodeValue = fmt(0); requestAnimationFrame(step);
  }
}
