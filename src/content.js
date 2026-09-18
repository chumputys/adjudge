import { buildSelector, templateKey } from './selectors.js';

const HIDDEN_ATTR = 'data-jev-hidden';
const SEEN = new WeakSet();
const MAX_CANDIDATES = 12;
const AD_WORDS = /\b(sponsored|promoted|advertisement|advert|paid partnership|ad choices)\b/i;

let config = null;

function hide(el) {
  if (el.hasAttribute(HIDDEN_ATTR)) return;
  el.setAttribute(HIDDEN_ATTR, el.style.getPropertyValue('display') || '');
  el.style.setProperty('display', 'none', 'important');
}

function restoreAll() {
  for (const el of document.querySelectorAll(`[${HIDDEN_ATTR}]`)) {
    const prev = el.getAttribute(HIDDEN_ATTR);
    el.style.removeProperty('display');
    if (prev) el.style.setProperty('display', prev);
    el.removeAttribute(HIDDEN_ATTR);
  }
}

function applySelectors(selectors) {
  let n = 0;
  for (const sel of selectors) {
    let nodes = [];
    try {
      nodes = document.querySelectorAll(sel);
    } catch {
      continue;
    }
    for (const el of nodes) {
      if (el === document.body || el.contains(document.querySelector('main'))) continue;
      hide(el);
      SEEN.add(el);
      n++;
    }
  }
  return n;
}

function visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 40 && r.height > 20 && r.width * r.height < 1_200_000;
}

function hostOf(url) {
  try {
    return new URL(url, location.href).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function describe(el, ref) {
  const selector = buildSelector(el);
  if (!selector) return null;
  const r = el.getBoundingClientRect();
  const linkHosts = [...new Set([...el.querySelectorAll('a[href]')]
    .map((a) => hostOf(a.href))
    .filter((h) => h && h !== location.hostname.replace(/^www\./, '')))].slice(0, 4);
  const frame = el.matches('iframe') ? el : el.querySelector('iframe[src]');
  return {
    ref,
    selector,
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: [...el.classList].slice(0, 6).join(' ') || null,
    role: el.getAttribute('role'),
    label: el.getAttribute('aria-label'),
    width: Math.round(r.width),
    height: Math.round(r.height),
    text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 200),
    linkHosts,
    frameHost: frame ? hostOf(frame.getAttribute('src')) : null,
    imgCount: el.querySelectorAll('img').length,
  };
}

function collect() {
  const pool = new Set();
  const selfHost = location.hostname.replace(/^www\./, '');

  for (const f of document.querySelectorAll('iframe[src]')) {
    const h = hostOf(f.getAttribute('src'));
    if (h && h !== selfHost) pool.add(f.closest('div,section,aside,li,article') || f);
  }

  const hinted = '[class*="sponsor" i],[class*="promo" i],[class*="banner" i],[class*="advert" i],[id*="ad-" i],[data-ad],[data-ad-slot],[aria-label*="advert" i]';
  for (const el of document.querySelectorAll(hinted)) pool.add(el);

  for (const el of document.querySelectorAll('article,li,section,aside,div')) {
    const t = el.innerText;
    if (!t || t.length > 1200) continue;
    if (AD_WORDS.test(t.slice(0, 300))) pool.add(el);
  }

  const out = [];
  let ref = 0;
  for (const el of pool) {
    if (!el || SEEN.has(el) || el.hasAttribute(HIDDEN_ATTR)) continue;
    if (el === document.body || el.tagName === 'HTML') continue;
    if (!visible(el)) continue;
    if ([...pool].some((other) => other !== el && other.contains(el))) continue;
    const d = describe(el, ref++);
    if (d) {
      out.push(d);
      SEEN.add(el);
    }
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

async function scan() {
  if (!config?.enabled || config.allowlisted) return;
  const candidates = collect();
  if (!candidates.length) return;

  const res = await chrome.runtime.sendMessage({
    type: 'classify',
    key: templateKey(),
    page: {
      url: location.origin + location.pathname,
      title: document.title.slice(0, 120),
      description: document.querySelector('meta[name="description"]')?.content?.slice(0, 200) || null,
    },
    candidates,
  });

  if (res?.selectors?.length) applySelectors(res.selectors);
}

let scanTimer = null;
function scheduleScan(delay = 800) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => scan().catch(() => {}), delay);
}

function bridgeShield() {
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.__jevShield) return;
    chrome.runtime.sendMessage({ type: 'shieldBlocked', kind: e.data.kind, url: e.data.url }).catch(() => {});
  });
}

async function init() {
  config = await chrome.runtime.sendMessage({ type: 'getConfig' });

  if (config?.allowPopups || config?.allowlisted) {
    window.postMessage({ __jevShieldDisable: true }, '*');
  } else {
    bridgeShield();
  }

  if (!config?.enabled || config.allowlisted) return;

  const key = templateKey();
  const cached = await chrome.runtime.sendMessage({ type: 'getTemplate', key });
  if (cached?.template?.selectors?.length) applySelectors(cached.template.selectors);

  scheduleScan(400);

  new MutationObserver(() => scheduleScan(1200)).observe(document.body, {
    childList: true,
    subtree: true,
  });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'restore') restoreAll();
  if (msg?.type === 'rescan') scan().catch(() => {});
});

init().catch(() => {});
