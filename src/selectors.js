const UNSTABLE = [
  /^[a-z]*[-_]?[a-f0-9]{6,}$/i,
  /\d{4,}/,
  /^(css|sc|jsx|emotion)-/i,
  /__[a-z0-9]{4,}$/i,
];

export function isStableToken(t) {
  if (!t || t.length < 2 || t.length > 32) return false;
  return !UNSTABLE.some((re) => re.test(t));
}

function esc(v) {
  return (window.CSS && CSS.escape) ? CSS.escape(v) : v.replace(/["\\]/g, '\\$&');
}

function ownSelector(el) {
  const tag = el.tagName.toLowerCase();

  for (const attr of ['data-testid', 'data-test-id', 'data-component', 'data-cy', 'data-ad-slot', 'data-ad-unit']) {
    const v = el.getAttribute(attr);
    if (v && isStableToken(v)) return `${tag}[${attr}="${esc(v)}"]`;
  }

  if (el.id && isStableToken(el.id)) return `${tag}#${esc(el.id)}`;

  const classes = [...el.classList].filter(isStableToken).slice(0, 3);
  if (classes.length) return tag + classes.map((c) => '.' + esc(c)).join('');

  const role = el.getAttribute('role');
  if (role && isStableToken(role)) return `${tag}[role="${esc(role)}"]`;

  return tag;
}

/** Build a selector that resolves, preferring stable hooks over position. */
export function buildSelector(el, root = document) {
  const parts = [];
  let node = el;
  for (let depth = 0; node && node.nodeType === 1 && depth < 5; depth++) {
    parts.unshift(ownSelector(node));
    const candidate = parts.join(' > ');
    try {
      const matches = root.querySelectorAll(candidate);
      if (matches.length && [...matches].includes(el)) return candidate;
    } catch {
      return null;
    }
    node = node.parentElement;
    if (node === document.body || node === document.documentElement) break;
  }
  return parts.length ? parts.join(' > ') : null;
}

/** origin + coarse route family, so one verdict reuses across similar pages. */
export function templateKey() {
  const u = new URL(location.href);
  const family = u.pathname
    .split('/')
    .filter(Boolean)
    .slice(0, 2)
    .map((seg) => (/\d/.test(seg) || seg.length > 24 ? '*' : seg))
    .join('/');
  return `${u.origin}|/${family}|v1`;
}
