import { buildSelector, templateKey } from './selectors.js';

const HIDDEN_ATTR = 'data-jev-hidden';
const SEEN = new WeakSet();
const MAX_CANDIDATES = 24;
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

const AD_LABEL = /\b(sponsored|promoted|advertisement|advert|\bads?\b|paid partnership|ad choices)\b/i;

function hostOf(url) {
  try {
    return new URL(url, location.href).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function corner(r) {
  const vertical = r.top + r.height / 2 < innerHeight / 2 ? 'top' : 'bottom';
  const horizontal = r.left + r.width / 2 < innerWidth / 2 ? 'left' : 'right';
  const edge =
    r.top < 8 || r.left < 8 || r.right > innerWidth - 8 || r.bottom > innerHeight - 8;
  return edge ? `${vertical}-${horizontal} edge` : `${vertical}-${horizontal}`;
}

function usable(el, r) {
  if (!r) return false;
  if (r.width < 32 || r.height < 16) return false;
  if (r.width * r.height > innerWidth * innerHeight * 0.85) return false;
  return true;
}

// Deliberately wide. Anything that could plausibly be an ad is collected and
// described; deciding which ones actually are is Jev's job, not a selector's.
function collect() {
  const selfHost = location.hostname.replace(/^www\./, '');
  const pool = new Map();

  const consider = (el, reason) => {
    if (!el || el.nodeType !== 1) return;
    if (el === document.body || el.tagName === 'HTML') return;
    if (SEEN.has(el) || el.hasAttribute(HIDDEN_ATTR)) return;
    const existing = pool.get(el);
    if (existing) {
      existing.add(reason);
      return;
    }
    pool.set(el, new Set([reason]));
  };

  // Floating and pinned layers — the fake download bars, corner banners and
  // sticky footers live here, and no class-name hint catches them.
  const shallow = document.querySelectorAll(
    'body > *, body > * > *, body > * > * > *, body > * > * > * > *'
  );
  for (const el of shallow) {
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      continue;
    }
    if (cs.position === 'fixed' || cs.position === 'sticky') consider(el, 'pinned');
    else if (cs.position === 'absolute' && Number(cs.zIndex) > 100) consider(el, 'stacked');
  }

  // Third-party frames, and the block that wraps them.
  for (const f of document.querySelectorAll('iframe[src], embed[src], object[data]')) {
    const h = hostOf(f.getAttribute('src') || f.getAttribute('data'));
    if (!h || h === selfHost) continue;
    consider(f.closest('div,section,aside,li,article') || f, 'third-party frame');
  }

  // Declared ad slots and the usual naming.
  const hinted =
    '[class*="sponsor" i],[class*="promo" i],[class*="banner" i],[class*="advert" i],' +
    '[class*="-ad" i],[class*="ad-" i],[id*="ad" i],[data-ad],[data-ad-slot],' +
    '[aria-label*="advert" i],ins,[class*="popup" i],[class*="notif" i],[class*="toast" i]';
  for (const el of document.querySelectorAll(hinted)) consider(el, 'ad-named');

  // Anything that labels itself.
  for (const el of document.querySelectorAll('div,section,aside,li,article,span,a')) {
    const t = el.innerText;
    if (!t || t.length > 600) continue;
    if (AD_LABEL.test(t.slice(0, 200))) consider(el, 'labelled');
  }

  // Keep the outermost candidate of any nested group, unless it is so much
  // larger that it is clearly page furniture wrapping a real one.
  const entries = [...pool.keys()];
  const kept = entries.filter((el) => {
    const r = el.getBoundingClientRect();
    if (!usable(el, r)) return false;
    const area = r.width * r.height;
    return !entries.some((other) => {
      if (other === el || !other.contains(el)) return false;
      const o = other.getBoundingClientRect();
      return usable(other, o) && o.width * o.height < area * 6;
    });
  });

  const out = [];
  let ref = 0;
  for (const el of kept) {
    if (out.length >= MAX_CANDIDATES) break;
    const d = describe(el, ref, [...pool.get(el)]);
    if (d) {
      out.push(d);
      SEEN.add(el);
      ref++;
    }
  }
  return out;
}

function describe(el, ref, reasons) {
  const selector = buildSelector(el);
  if (!selector) return null;

  const r = el.getBoundingClientRect();
  let cs;
  try {
    cs = getComputedStyle(el);
  } catch {
    cs = {};
  }

  const selfHost = location.hostname.replace(/^www\./, '');
  const linkHosts = [
    ...new Set(
      [...el.querySelectorAll('a[href]')]
        .map((a) => hostOf(a.href))
        .filter((h) => h && h !== selfHost)
    ),
  ].slice(0, 4);

  const frame = el.matches('iframe,embed,object') ? el : el.querySelector('iframe[src]');
  const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 220);

  return {
    ref,
    selector,
    why: reasons,
    tag: el.tagName.toLowerCase(),
    id: el.id || null,
    classes: [...el.classList].slice(0, 6).join(' ') || null,
    role: el.getAttribute('role'),
    label: el.getAttribute('aria-label'),
    width: Math.round(r.width),
    height: Math.round(r.height),
    position: cs.position || null,
    zIndex: cs.zIndex || null,
    placement: corner(r),
    selfLabelled: AD_LABEL.test(text.slice(0, 120)),
    text,
    linkHosts,
    frameHost: frame ? hostOf(frame.getAttribute('src') || frame.getAttribute('data')) : null,
    imgCount: el.querySelectorAll('img').length,
  };
}

// Everything the page has to say goes out in one request — Jev answers many
// questions per call, so batching is the difference between one round trip and
// five, which matters a great deal on a rate-limited tier.
let judgeBuffer = null;
let judgeTimer = null;

// Selectors Jev has already condemned on this page. Re-matching them costs
// nothing, so this runs on every DOM change — a re-injected ad disappears
// immediately without another request.
const knownSelectors = new Set();

let judgements = 0;
let nextAllowed = 0;
let backoff = 3000;

const MAX_JUDGEMENTS = 10;
const MIN_BACKOFF = 3000;
const MAX_BACKOFF = 60_000;

function remember(selectors) {
  for (const sel of selectors) knownSelectors.add(sel);
}

function reapplyKnown() {
  if (!knownSelectors.size) return;
  applySelectors([...knownSelectors]);
}

function queueJudge(part) {
  judgeBuffer ||= { handlers: [], overlays: [], controls: [], blocks: [], page: null };
  judgeBuffer.page = part.page || judgeBuffer.page;
  for (const k of ['handlers', 'overlays', 'controls', 'blocks']) {
    if (part[k]?.length) judgeBuffer[k].push(...part[k]);
  }
  scheduleFlush();
}

function scheduleFlush() {
  clearTimeout(judgeTimer);
  judgeTimer = setTimeout(flushJudge, Math.max(700, nextAllowed - Date.now()));
}

async function flushJudge() {
  if (!judgeBuffer || !config?.enabled || config.allowlisted) return;
  if (judgements >= MAX_JUDGEMENTS) return;
  if (Date.now() < nextAllowed) return scheduleFlush();

  const batch = judgeBuffer;
  judgeBuffer = null;
  judgements++;

  batch.page ||= {
    url: location.origin + location.pathname,
    title: document.title.slice(0, 120),
    description: document.querySelector('meta[name="description"]')?.content?.slice(0, 200) || null,
  };

  const r = await chrome.runtime
    .sendMessage({ type: 'judgePage', key: templateKey(), ...batch })
    .catch(() => null);

  // Back off when a pass finds nothing, and when the model is unavailable;
  // reset the moment a pass actually turns something up.
  const found = (r?.hide?.length || 0) + (r?.gate?.length || 0) + (r?.bait?.length || 0);
  if (r?.rateLimited) backoff = MAX_BACKOFF;
  else backoff = found ? MIN_BACKOFF : Math.min(backoff * 2, MAX_BACKOFF);
  nextAllowed = Date.now() + backoff;

  if (!r) return;

  if (r.gate?.length || r.defuse?.length) {
    window.postMessage({ __jevGate: r.gate || [], __jevDefuse: r.defuse || [] }, '*');
  }
  if (r.genuine?.length || r.bait?.length) {
    window.postMessage({ __jevGenuine: r.genuine || [], __jevBait: r.bait || [] }, '*');
  }
  if (r.hide?.length) {
    const selectors = r.hide.map((h) => h.selector);
    remember(selectors);
    applySelectors(selectors);
  }
}

async function scan() {
  if (!config?.enabled || config.allowlisted) return;
  const blocks = collect();
  if (blocks.length) queueJudge({ blocks });
}

// Hosts this page could pop open. Classifying them now means a later click
// finds a cached verdict instead of waiting on a round trip.
function prefetchPopHosts() {
  const selfHost = location.hostname.replace(/^www\./, '');
  const hosts = new Set();

  for (const a of document.querySelectorAll('a[target="_blank"][href]')) {
    const h = hostOf(a.href);
    if (h && h !== selfHost) hosts.add(h);
  }
  for (const f of document.querySelectorAll('iframe[src]')) {
    const h = hostOf(f.getAttribute('src'));
    if (h && h !== selfHost) hosts.add(h);
  }

  if (!hosts.size) return;
  chrome.runtime
    .sendMessage({ type: 'prefetchHosts', hosts: [...hosts].slice(0, 20) })
    .catch(() => {});
}

let scanTimer = null;
let reapplyTimer = null;

function scheduleScan(delay = 1000) {
  clearTimeout(scanTimer);
  scanTimer = setTimeout(() => scan().catch(() => {}), delay);
}

function scheduleReapply() {
  clearTimeout(reapplyTimer);
  reapplyTimer = setTimeout(reapplyKnown, 150);
}

function bridgeShield() {
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data?.__jevShield) return;
    if (e.data.kind === 'judge') {
      queueJudge({
        page: e.data.page,
        handlers: e.data.handlers,
        overlays: e.data.overlays,
        controls: e.data.controls,
      });
      return;
    }
    if (e.data.kind === 'adjudicate') {
      chrome.runtime
        .sendMessage({
          type: 'adjudicate',
          what: e.data.what,
          method: e.data.method,
          url: e.data.url,
          clicked: e.data.clicked,
          viaClick: e.data.viaClick,
          pointedAt: e.data.pointedAt,
        })
        .catch(() => {});
      return;
    }
    if (e.data.kind === 'verify') {
      chrome.runtime.sendMessage({ type: 'verifyPopupHost', url: e.data.url }).catch(() => {});
      return;
    }
    if (e.data.kind === 'trace') {
      chrome.runtime
        .sendMessage({ type: 'shieldTrace', event: e.data.event, detail: e.data.detail })
        .catch(() => {});
      return;
    }
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

  if (config?.debugMode) window.postMessage({ __jevShieldTrace: true }, '*');

  if (config?.hosts) {
    window.postMessage(
      { __jevAdHosts: config.hosts.ad, __jevAllowHosts: config.hosts.allow },
      '*'
    );
  }

  if (!config?.enabled || config.allowlisted) return;

  const key = templateKey();
  const cached = await chrome.runtime.sendMessage({ type: 'getTemplate', key });
  if (cached?.template?.selectors?.length) {
    remember(cached.template.selectors);
    applySelectors(cached.template.selectors);
  }

  prefetchPopHosts();
  scheduleScan(400);
  setTimeout(() => scan().catch(() => {}), 2000);
  setTimeout(() => scan().catch(() => {}), 5000);

  // Ads on these sites arrive long after load, so the observer is the trigger —
  // but it only ever schedules work, never performs a request directly. Known
  // selectors re-apply almost immediately; a fresh judgement waits its turn.
  new MutationObserver((records) => {
    let addedElements = false;
    for (const rec of records) {
      for (const node of rec.addedNodes) {
        if (node.nodeType === 1) {
          addedElements = true;
          break;
        }
      }
      if (addedElements) break;
    }
    if (!addedElements) return;
    scheduleReapply();
    scheduleScan(1200);
  }).observe(document.body, { childList: true, subtree: true });
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === 'restore') restoreAll();
  if (msg?.type === 'rescan') scan().catch(() => {});
  if (msg?.type === 'adjudicated') {
    window.postMessage(
      msg.advert ? { __jevAdHosts: [msg.host] } : { __jevAllowHosts: [msg.host] },
      '*'
    );
    if (!msg.advert && msg.what === 'navigation') {
      window.postMessage({ __jevNavigate: { method: msg.method || 'assign', url: msg.url } }, '*');
    }
  }
  if (msg?.type === 'hostVerdict') {
    window.postMessage(
      msg.advert ? { __jevAdHosts: [msg.host] } : { __jevAllowHosts: [msg.host] },
      '*'
    );
  }
});

init().catch(() => {});
