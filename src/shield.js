/**
 * Runs in the page's MAIN world at document_start.
 *
 * Stops the "click a real control, get an ad tab" pattern: popunders opened
 * without a genuine user gesture, transparent full-page overlay links, and
 * anchors wrapped around a player. Reports what it stopped to the isolated
 * world via postMessage.
 */
(() => {
  const GESTURE_MS = 1000;
  let lastTrustedClick = 0;
  let lastTrustedIntent = false;
  let disabled = false;

  function report(kind, url) {
    try {
      window.postMessage({ __jevShield: true, kind, url: String(url || '').slice(0, 300) }, '*');
    } catch {}
  }

  window.addEventListener('message', (e) => {
    if (e.source === window && e.data?.__jevShieldDisable) disabled = true;
  });

  /* ---------- gesture tracking ---------- */

  document.addEventListener(
    'click',
    (e) => {
      if (!e.isTrusted) return;
      lastTrustedClick = Date.now();
      const a = e.target?.closest?.('a[href]');
      lastTrustedIntent = !!(a && a.target === '_blank' && !isOverlay(a));
    },
    true
  );

  const fresh = () => Date.now() - lastTrustedClick < GESTURE_MS;

  /* ---------- window.open ---------- */

  // A stub window keeps popunder scripts from falling back to location.href
  // when open() returns null.
  function stubWindow() {
    const noop = () => {};
    const stub = {
      closed: false,
      opener: null,
      focus: noop,
      blur: noop,
      close() { stub.closed = true; },
      postMessage: noop,
      document: { write: noop, writeln: noop, close: noop, body: null },
      location: { href: 'about:blank', replace: noop, assign: noop, reload: noop },
    };
    return stub;
  }

  const nativeOpen = window.open;
  Object.defineProperty(window, 'open', {
    configurable: true,
    writable: true,
    value: function (url, name, features) {
      if (disabled) return nativeOpen.apply(window, arguments);
      if (!fresh() || !lastTrustedIntent) {
        report('popup', url);
        return stubWindow();
      }
      return nativeOpen.apply(window, arguments);
    },
  });

  /* ---------- programmatic anchor clicks ---------- */

  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    if (!disabled && this.target === '_blank' && !fresh()) {
      report('popup', this.href);
      return;
    }
    return nativeClick.apply(this, arguments);
  };

  /* ---------- overlay + wrapper links ---------- */

  function isOverlay(el) {
    if (!el || el.nodeType !== 1) return false;
    let cs;
    try {
      cs = getComputedStyle(el);
    } catch {
      return false;
    }
    if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
    const r = el.getBoundingClientRect();
    const coverage = (r.width * r.height) / (innerWidth * innerHeight || 1);
    if (coverage < 0.45) return false;
    const z = Number(cs.zIndex);
    const layered = Number.isFinite(z) ? z > 50 : true;
    const empty = !(el.innerText || '').trim() && !el.querySelector('img,video,svg');
    return layered && empty;
  }

  function wrapsPlayer(a) {
    return !!a.querySelector('video, iframe, canvas');
  }

  function defuse(a, kind) {
    a.removeAttribute('href');
    a.removeAttribute('target');
    a.style.setProperty('pointer-events', 'none', 'important');
    a.setAttribute('data-jev-defused', kind);
    report(kind, a.getAttribute('data-jev-href') || '');
  }

  function sweep() {
    if (disabled) return;
    for (const a of document.querySelectorAll('a[href]:not([data-jev-defused])')) {
      if (isOverlay(a)) {
        a.setAttribute('data-jev-href', a.href);
        defuse(a, 'overlay');
      } else if (a.target === '_blank' && wrapsPlayer(a)) {
        a.setAttribute('data-jev-href', a.href);
        defuse(a, 'wrapper');
      }
    }
  }

  let sweepTimer = null;
  const scheduleSweep = () => {
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(sweep, 300);
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleSweep, { once: true });
  } else {
    scheduleSweep();
  }

  new MutationObserver(scheduleSweep).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
})();
