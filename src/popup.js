import { getSettings, setSettings } from './settings.js';
import { lastDays } from './stats.js';

const W = 286;
const H = 56;
const PAD_T = 6;
const PAD_B = 10;
const SVG_NS = 'http://www.w3.org/2000/svg';

const compact = (n) =>
  n >= 1_000_000 ? (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  : n >= 1_000 ? (n / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  : String(n);

const bytes = (n) =>
  n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB'
  : n >= 1e6 ? (n / 1e6).toFixed(0) + ' MB'
  : n >= 1e3 ? (n / 1e3).toFixed(0) + ' KB'
  : n + ' B';

const el = (id) => document.getElementById(id);

function svg(tag, attrs) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}

/* ---------- data ---------- */

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let host = null;
try {
  host = tab?.url ? new URL(tab.url).hostname.replace(/^www\./, '') : null;
} catch {}

const res = await chrome.runtime.sendMessage({ type: 'getStats' }).catch(() => null);
const stats = res?.stats ?? { totals: { blocked: 0, hidden: 0, bytes: 0 }, daily: {}, topHosts: {} };
const settings = res?.settings ?? (await getSettings());

let learned = 0;
try {
  learned = (await chrome.declarativeNetRequest.getDynamicRules()).length;
} catch {}

/* ---------- header + hero ---------- */

const live = settings.enabled && !!settings.apiKey;
el('dot').classList.toggle('off', !live);
el('stateText').textContent = !settings.apiKey ? 'no API key' : settings.enabled ? 'active' : 'paused';

const days = lastDays(14);
const values = days.map((d) => stats.daily[d]?.blocked ?? 0);
const todayCount = values[values.length - 1];

el('heroValue').textContent = compact(stats.totals.blocked);
el('heroDelta').textContent = todayCount ? `+${compact(todayCount)} today` : 'none yet today';
el('heroDelta').style.color = todayCount ? '' : 'var(--text-secondary)';

el('tHosts').textContent = compact(learned);
el('tHidden').textContent = compact(stats.totals.hidden);
el('tBytes').textContent = bytes(stats.totals.bytes);

const startLabel = new Date();
startLabel.setDate(startLabel.getDate() - 13);
el('axisStart').textContent = startLabel.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/* ---------- sparkline ---------- */

const chart = el('spark');
const max = Math.max(1, ...values);
const xAt = (i) => 1 + (i / (values.length - 1)) * (W - 2);
const yAt = (v) => PAD_T + (1 - v / max) * (H - PAD_T - PAD_B);

const line = values.map((v, i) => `${i ? 'L' : 'M'}${xAt(i).toFixed(1)},${yAt(v).toFixed(1)}`).join(' ');
const base = H - PAD_B;

chart.append(
  svg('path', {
    d: `${line} L${xAt(values.length - 1).toFixed(1)},${base} L${xAt(0).toFixed(1)},${base} Z`,
    fill: 'var(--series-wash)',
  }),
  svg('line', { x1: 0, y1: base, x2: W, y2: base, stroke: 'var(--grid)', 'stroke-width': 1 }),
  svg('path', {
    d: line,
    fill: 'none',
    stroke: 'var(--series-1)',
    'stroke-width': 2,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
  })
);

const crosshair = svg('line', {
  y1: PAD_T - 4, y2: base, stroke: 'var(--grid)', 'stroke-width': 1, opacity: 0,
});
const marker = svg('circle', {
  cx: xAt(values.length - 1), cy: yAt(todayCount), r: 4,
  fill: 'var(--series-1)', stroke: 'var(--surface-1)', 'stroke-width': 2,
});
chart.append(crosshair, marker);

const tip = el('tip');
const step = (W - 2) / (values.length - 1);

values.forEach((v, i) => {
  const hit = svg('rect', {
    x: Math.max(0, xAt(i) - step / 2), y: 0, width: step, height: H, fill: 'transparent',
  });
  hit.addEventListener('mouseenter', () => {
    crosshair.setAttribute('x1', xAt(i));
    crosshair.setAttribute('x2', xAt(i));
    crosshair.setAttribute('opacity', 1);
    marker.setAttribute('cx', xAt(i));
    marker.setAttribute('cy', yAt(v));
    const d = new Date(days[i] + 'T00:00:00');
    tip.textContent = `${v} · ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    tip.style.left = `${(xAt(i) / W) * 100}%`;
    tip.style.top = `${yAt(v) - 6}px`;
    tip.style.opacity = 1;
  });
  chart.append(hit);
});

chart.addEventListener('mouseleave', () => {
  tip.style.opacity = 0;
  crosshair.setAttribute('opacity', 0);
  marker.setAttribute('cx', xAt(values.length - 1));
  marker.setAttribute('cy', yAt(todayCount));
});

/* ---------- most blocked ---------- */

const top = Object.entries(stats.topHosts).sort((a, b) => b[1] - a[1]).slice(0, 5);
if (top.length) {
  const peak = top[0][1];
  const wrap = el('hosts');
  wrap.textContent = '';
  for (const [name, n] of top) {
    const row = document.createElement('div');
    row.className = 'host-row';
    const label = document.createElement('div');
    label.className = 'host-name';
    label.textContent = name;
    label.title = name;
    const count = document.createElement('div');
    count.className = 'host-n';
    count.textContent = compact(n);
    const track = document.createElement('div');
    track.className = 'bar-track';
    const bar = document.createElement('div');
    bar.className = 'bar';
    bar.style.width = `${Math.max(4, (n / peak) * 100)}%`;
    track.append(bar);
    row.append(label, count, track);
    wrap.append(row);
  }
} else {
  el('hostsCard').style.display = 'none';
}

/* ---------- per-site controls ---------- */

const siteOn = el('siteOn');
const popupOn = el('popupOn');

if (!host) {
  siteOn.disabled = popupOn.disabled = true;
  el('siteLabel').textContent = 'Block on this site';
} else {
  el('siteLabel').textContent = `Block on ${host}`;
  siteOn.checked = !settings.allowlist.includes(host);
  popupOn.checked = settings.blockPopunders && !settings.popupAllowlist.includes(host);
}

function toggleIn(list, on) {
  const set = new Set(list);
  if (on) set.delete(host);
  else set.add(host);
  return [...set];
}

siteOn.addEventListener('change', async () => {
  await setSettings({ allowlist: toggleIn(settings.allowlist, siteOn.checked) });
  chrome.tabs.sendMessage(tab.id, { type: siteOn.checked ? 'rescan' : 'restore' }).catch(() => {});
});

popupOn.addEventListener('change', async () => {
  await setSettings({ popupAllowlist: toggleIn(settings.popupAllowlist, popupOn.checked) });
  chrome.tabs.reload(tab.id);
  window.close();
});

el('rescan').addEventListener('click', () => {
  chrome.tabs.sendMessage(tab.id, { type: 'rescan' }).catch(() => {});
  window.close();
});

el('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
