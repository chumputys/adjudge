/**
 * Runs in the page's MAIN world at document_start, in every frame.
 *
 * This file does no judging. It collects two kinds of candidate — gesture
 * handlers bound page-wide, and layers stacked over the page — hands them to
 * Jev through the background, and enforces whatever comes back. Every handler
 * is wrapped but nothing is suppressed until the model says so, so a page that
 * has not been judged yet behaves exactly as it would without the extension.
 *
 * The one decision made locally is window.open, which is synchronous and
 * cannot await a model call. It is answered from host verdicts Jev produced
 * earlier and the page's own click context.
 */
(() => {
  const GESTURE_MS = 1000;
  const GESTURE_EVENTS = new Set([
    'click', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup',
    'touchstart', 'touchend', 'contextmenu',
  ]);
  const MAX_HANDLERS = 10;
  const MAX_OVERLAYS = 8;
  const SOURCE_CHARS = 600;

  let disabled = false;
  let tracing = false;

  const adHosts = new Set();
  const allowHosts = new Set();

  let lastTrustedClick = 0;
  let clickHosts = new Set();
  let clickDescriptor = null;

  const pageHost = location.hostname.replace(/^www\./, '');

  function post(payload) {
    try {
      window.postMessage({ __jevShield: true, ...payload }, '*');
    } catch {}
  }

  const report = (kind, url) => post({ kind, url: String(url || '').slice(0, 300) });
  const trace = (event, detail) => tracing && post({ kind: 'trace', event, detail });

  /* ---------- inbound: verdicts from Jev ---------- */

  const gated = new Set();
  const genuineControls = new Set();
  const baitControls = new Set();
  let genuineClickUntil = 0;

  window.addEventListener('message', (e) => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || typeof d !== 'object') return;
    if (d.__jevShieldDisable) disabled = true;
    if (d.__jevShieldTrace) tracing = true;
    if (Array.isArray(d.__jevAdHosts)) for (const h of d.__jevAdHosts) adHosts.add(h);
    if (Array.isArray(d.__jevAllowHosts)) for (const h of d.__jevAllowHosts) allowHosts.add(h);
    if (Array.isArray(d.__jevGenuine)) {
      for (const id of d.__jevGenuine) genuineControls.add(id);
      trace('controls.genuine', { ids: d.__jevGenuine });
    }
    if (Array.isArray(d.__jevBait)) {
      for (const id of d.__jevBait) baitControls.add(id);
      trace('controls.bait', { ids: d.__jevBait });
    }
    if (Array.isArray(d.__jevGate)) {
      for (const id of d.__jevGate) gated.add(id);
      trace('gated', { ids: d.__jevGate });
    }
    if (Array.isArray(d.__jevDefuse)) {
      for (const id of d.__jevDefuse) defuse(id);
    }
    if (d.__jevNavigate) {
      const { method, url } = d.__jevNavigate;
      const native = nativeNav[method] || nativeNav.assign;
      if (native) {
        trace('nav.replayed', { method, url });
        replaying = true;
        try {
          native.call(location, url);
        } finally {
          replaying = false;
        }
      }
    }
  });

  /* ---------- click context ---------- */

  function hostOf(url) {
    try {
      return new URL(url, location.href).hostname.replace(/^www\./, '');
    } catch {
      return null;
    }
  }

  function sameSite(host) {
    if (!host) return false;
    const tail = (h) => h.split('.').slice(-2).join('.');
    return host === pageHost || tail(host) === tail(pageHost);
  }

  function collectClickHosts(el) {
    const hosts = new Set();
    let node = el;
    for (let i = 0; node && node.nodeType === 1 && i < 8; i++) {
      for (const attr of ['href', 'src', 'data-href', 'data-url', 'data-link', 'action']) {
        const v = node.getAttribute?.(attr);
        const h = v && hostOf(v);
        if (h) hosts.add(h);
      }
      node = node.parentElement;
    }
    return hosts;
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;

      const holder = e.target?.closest?.('[data-jev-ctl]');
      const ctl = holder ? Number(holder.getAttribute('data-jev-ctl')) : 0;

      if (!disabled && ctl && baitControls.has(ctl)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        trace('control.bait.blocked', { id: ctl, tag: holder.tagName });
        report('bait', holder.getAttribute('href') || '');
        return;
      }

      // Jev called this a real control, so nothing opening a window or
      // navigating off-site during this click is something you asked for.
      if (ctl && genuineControls.has(ctl)) {
        genuineClickUntil = Date.now() + GESTURE_MS;
        trace('control.genuine', { id: ctl, tag: holder.tagName });
      }

      lastTrustedClick = Date.now();
      clickHosts = collectClickHosts(e.target);
      const t = e.target;
      clickDescriptor = t?.tagName ? t.tagName.toLowerCase() + (t.id ? '#' + t.id : '') : null;
      trace('click', { target: clickDescriptor, hosts: [...clickHosts] });
    },
    true
  );

  const fresh = () => Date.now() - lastTrustedClick < GESTURE_MS;

  /* ---------- candidate collection ---------- */

  let seq = 0;
  const queuedHandlers = [];
  const queuedOverlays = [];
  const overlayNodes = new Map();
  const judgedSources = new Set();
  let submitTimer = null;

  function submitSoon() {
    clearTimeout(submitTimer);
    submitTimer = setTimeout(() => {
      if (!queuedHandlers.length && !queuedOverlays.length && !queuedControls.length) return;
      const handlers = queuedHandlers.splice(0, MAX_HANDLERS);
      const overlays = queuedOverlays.splice(0, MAX_OVERLAYS);
      const controls = queuedControls.splice(0, MAX_CONTROLS);
      post({
        kind: 'judge',
        page: {
          url: location.origin + location.pathname,
          title: document.title.slice(0, 120),
          frame: window.top === window ? 'top' : 'iframe',
        },
        handlers,
        overlays,
        controls,
      });
      trace('submitted', {
        handlers: handlers.length, overlays: overlays.length, controls: controls.length,
      });
    }, 350);
  }

  function targetName(target) {
    if (target === window) return 'window';
    if (target === document) return 'document';
    if (target === document.documentElement) return 'html';
    if (target === document.body) return 'body';
    const tag = target?.tagName?.toLowerCase?.();
    return tag ? `<${tag}>` : 'element';
  }

  function isPageWide(target) {
    return (
      target === window ||
      target === document ||
      target === document.documentElement ||
      target === document.body
    );
  }

  function sourceOf(listener) {
    try {
      const fn = typeof listener === 'function' ? listener : listener?.handleEvent;
      if (typeof fn !== 'function') return '';
      const src = Function.prototype.toString.call(fn);
      return src.includes('[native code]') ? '' : src;
    } catch {
      return '';
    }
  }

  /* ---------- handler wrapping ---------- */

  const wrapped = new WeakMap();
  const nativeAdd = EventTarget.prototype.addEventListener;
  const nativeRemove = EventTarget.prototype.removeEventListener;

  EventTarget.prototype.addEventListener = function (type, listener, options) {
    if (disabled || !listener || !GESTURE_EVENTS.has(type) || !isPageWide(this)) {
      return nativeAdd.call(this, type, listener, options);
    }

    const source = sourceOf(listener);
    if (!source) return nativeAdd.call(this, type, listener, options);

    let entry = wrapped.get(listener);
    if (!entry) {
      const id = ++seq;
      const call =
        typeof listener === 'function' ? listener : listener.handleEvent.bind(listener);

      const fn = function (event) {
        if (!disabled && gated.has(id)) {
          trace('handler.suppressed', { id, type });
          return;
        }
        return call.call(this, event);
      };

      entry = { id, fn };
      wrapped.set(listener, entry);

      const key = source.slice(0, 160);
      if (!judgedSources.has(key)) {
        judgedSources.add(key);
        queuedHandlers.push({
          id,
          target: targetName(this),
          type,
          source: source.slice(0, SOURCE_CHARS),
        });
        submitSoon();
      }
    }

    return nativeAdd.call(this, type, entry.fn, options);
  };

  EventTarget.prototype.removeEventListener = function (type, listener, options) {
    const entry = listener && wrapped.get(listener);
    if (entry) nativeRemove.call(this, type, entry.fn, options);
    return nativeRemove.call(this, type, listener, options);
  };

  /* ---------- inline handlers ---------- */

  function collectInline(scope) {
    for (const attr of ['onclick', 'onmousedown', 'onmouseup', 'onpointerdown']) {
      for (const node of scope.querySelectorAll(`[${attr}]:not([data-jev-inline])`)) {
        const code = node.getAttribute(attr) || '';
        if (!code) continue;
        const id = ++seq;
        node.setAttribute('data-jev-inline', String(id));
        overlayNodes.set(id, { node, attr, code });
        queuedHandlers.push({
          id,
          target: `inline ${attr} on <${node.tagName.toLowerCase()}>`,
          type: attr.slice(2),
          source: code.slice(0, SOURCE_CHARS),
        });
      }
    }
  }

  /* ---------- overlay candidates ---------- */

  function overlayDescriptor(el) {
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      return null;
    }
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return null;
    const r = el.getBoundingClientRect();
    const coverage = (r.width * r.height) / (innerWidth * innerHeight || 1);
    if (coverage < 0.2) return null;

    return {
      tag: el.tagName.toLowerCase(),
      classes: [...el.classList].slice(0, 5).join(' ') || null,
      coverage: Number(coverage.toFixed(2)),
      zIndex: cs.zIndex,
      opacity: cs.opacity,
      background: cs.backgroundColor,
      text: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80),
      href: el.tagName === 'A' ? el.getAttribute('href') : null,
      childCount: el.children.length,
    };
  }

  const CONTROL_SELECTOR =
    'a, button, [role="button"], [role="menuitem"], [role="tab"], [onclick], ' +
    'li, label, summary, [class*="btn" i], [class*="button" i], [class*="quality" i], ' +
    '[class*="server" i], [class*="control" i], [class*="option" i], [data-quality], [data-server]';

  const MAX_CONTROLS = 16;

  function controlDescriptor(el) {
    const r = el.getBoundingClientRect();
    if (r.width < 12 || r.height < 12) return null;
    if (r.width > innerWidth * 0.9 && r.height > innerHeight * 0.9) return null;

    let depth = 0;
    for (let n = el; n && n !== document.body; n = n.parentElement) depth++;

    return {
      tag: el.tagName.toLowerCase(),
      elId: el.id || null,
      classes: [...el.classList].slice(0, 5).join(' ') || null,
      role: el.getAttribute('role'),
      label: el.getAttribute('aria-label') || el.getAttribute('title'),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60),
      width: Math.round(r.width),
      height: Math.round(r.height),
      href: el.tagName === 'A' ? (el.getAttribute('href') || '').slice(0, 160) : null,
      inPlayer: !!el.closest('video, [class*="player" i], [id*="player" i]'),
      hasHandler: !!(el.onclick || el.getAttribute('onclick')),
      depth,
    };
  }

  const queuedControls = [];

  function collectControls() {
    let added = 0;
    for (const el of document.querySelectorAll(CONTROL_SELECTOR)) {
      if (added >= MAX_CONTROLS) break;
      if (el.hasAttribute('data-jev-ctl')) continue;
      const d = controlDescriptor(el);
      if (!d) continue;
      const id = ++seq;
      el.setAttribute('data-jev-ctl', String(id));
      queuedControls.push({ id, ...d });
      added++;
    }
  }

  function collectOverlays() {
    const candidates = document.querySelectorAll(
      'a, div, section, aside, span:not([data-jev-seen])'
    );
    let added = 0;
    for (const el of candidates) {
      if (added >= MAX_OVERLAYS) break;
      if (el.hasAttribute('data-jev-seen')) continue;
      const d = overlayDescriptor(el);
      if (!d) continue;
      el.setAttribute('data-jev-seen', '');
      const id = ++seq;
      overlayNodes.set(id, { node: el });
      queuedOverlays.push({ id, ...d });
      added++;
    }
  }

  function defuse(id) {
    const rec = overlayNodes.get(id);
    if (!rec) return;
    if (rec.attr) {
      rec.node.removeAttribute(rec.attr);
      trace('inline.removed', { id, attr: rec.attr });
      return;
    }
    const el = rec.node;
    if (el.tagName === 'A') {
      el.setAttribute('data-jev-href', el.href);
      el.removeAttribute('href');
      el.removeAttribute('target');
    }
    el.style.setProperty('pointer-events', 'none', 'important');
    el.setAttribute('data-jev-defused', '');
    report('overlay', el.getAttribute('data-jev-href') || '');
    trace('overlay.defused', { id, tag: el.tagName });
  }

  /* ---------- window.open ---------- */

  // Nothing cross-site is decided on a hunch. Cached Jev verdicts answer
  // instantly; anything unknown is held and sent to the model, and the
  // background reopens it as a real tab if the answer is that it is real.
  function verdict(url) {
    if (disabled) return { allow: true, why: 'disabled' };
    const host = hostOf(url);

    if (!host || host === 'blank') {
      return fresh()
        ? { allow: true, why: 'blank after click' }
        : { allow: false, why: 'blank, no click' };
    }
    if (sameSite(host)) return { allow: true, why: 'same site' };
    if (Date.now() < genuineClickUntil) {
      return { allow: false, why: 'Jev: hijack of a genuine control' };
    }
    if (adHosts.has(host)) return { allow: false, why: 'Jev: ad host' };
    if (allowHosts.has(host)) return { allow: true, why: 'Jev: functional host' };
    return { allow: false, why: 'asking Jev', adjudicate: true };
  }

  function stubWindow() {
    const noop = () => {};
    const stub = {
      closed: false, opener: null, focus: noop, blur: noop,
      close() { stub.closed = true; },
      postMessage: noop,
      document: { write: noop, writeln: noop, close: noop, body: null },
      location: { href: 'about:blank', replace: noop, assign: noop, reload: noop },
    };
    return stub;
  }

  function patchWindow(w, label) {
    if (!w) return;
    try {
      if (w.__jevPatched) return;
      w.__jevPatched = true;
      const nativeOpen = w.open;
      Object.defineProperty(w, 'open', {
        configurable: true, writable: true,
        value: function (url) {
          const v = verdict(url);
          trace(v.allow ? 'open.allowed' : 'open.blocked', {
            url: String(url || ''), why: v.why, via: label,
          });
          if (v.allow) return nativeOpen.apply(w, arguments);
          if (v.adjudicate) {
            post({
              kind: 'adjudicate',
              what: 'popup',
              url: String(url || '').slice(0, 300),
              clicked: clickDescriptor,
              viaClick: fresh(),
              pointedAt: [...clickHosts].slice(0, 6),
            });
          } else {
            report('popup', url);
          }
          return stubWindow();
        },
      });
    } catch (e) {
      trace('patch.failed', { via: label, error: String(e?.message || e) });
    }
  }

  if (window.top === window) console.info(`[jev] shield active — build ${__BUILD__}`);

  patchWindow(window, 'top');

  function patchFrames() {
    for (const frame of document.querySelectorAll('iframe, frame')) {
      try {
        patchWindow(frame.contentWindow, frame.src || 'about:blank');
      } catch {}
    }
  }

  const nativeNav = {};
  let replaying = false;

  for (const method of ['assign', 'replace']) {
    const native = Location.prototype[method];
    if (typeof native !== 'function') continue;
    nativeNav[method] = native;
    try {
      Location.prototype[method] = function (url) {
        if (disabled || replaying) return native.call(this, url);
        const host = hostOf(url);
        if (!host || sameSite(host) || allowHosts.has(host)) return native.call(this, url);
        if (adHosts.has(host)) {
          report('redirect', url);
          trace('nav.blocked', { method, url: String(url || ''), why: 'Jev: ad host' });
          return;
        }
        trace('nav.held', { method, url: String(url || '') });
        post({
          kind: 'adjudicate',
          what: 'navigation',
          method,
          url: String(url || '').slice(0, 300),
          clicked: clickDescriptor,
          viaClick: fresh(),
          pointedAt: [...clickHosts].slice(0, 6),
        });
        return;
      };
    } catch {}
  }

  const nativeAnchorClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!disabled && this.target === '_blank' && !fresh()) {
      report('popup', this.href);
      trace('anchor.blocked', { href: this.href });
      return;
    }
    return nativeAnchorClick.apply(this, arguments);
  };

  /* ---------- sweep ---------- */

  let sweepTimer = null;
  function sweep() {
    if (disabled) return;
    patchFrames();
    collectInline(document);
    collectOverlays();
    collectControls();
    submitSoon();
  }
  const scheduleSweep = () => {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(sweep, 900);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleSweep, { once: true });
  } else {
    scheduleSweep();
  }

  new MutationObserver(scheduleSweep).observe(document.documentElement, {
    childList: true, subtree: true,
  });

  // pagehide, not beforeunload: a Permissions-Policy of `unload=()` makes Chrome
  // reject unload-family listeners outright, and this is only a trace hook.
  try {
    window.addEventListener(
      'pagehide',
      () => {
        trace('navigating', {
          msSinceClick: Date.now() - lastTrustedClick,
          lastTarget: clickDescriptor,
        });
      },
      { capture: true }
    );
  } catch {}
})();
