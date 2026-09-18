const KEY = 'stats';
const DAYS = 14;

const EMPTY = () => ({
  totals: { blocked: 0, hidden: 0, classified: 0, bytes: 0 },
  daily: {},
  topHosts: {},
});

// Rough per-type transfer sizes, used only for the "estimated data saved" tile.
const BYTES = {
  script: 92_000,
  sub_frame: 130_000,
  image: 44_000,
  stylesheet: 24_000,
  media: 240_000,
  xmlhttprequest: 9_000,
  ping: 1_000,
  other: 18_000,
};

let buffer = null;
let flushTimer = null;

export function dayKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function lastDays(n = DAYS) {
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    out.push(dayKey(d));
  }
  return out;
}

export function estimateBytes(type) {
  return BYTES[type] ?? BYTES.other;
}

async function load() {
  const { [KEY]: s } = await chrome.storage.local.get(KEY);
  if (!s) return EMPTY();
  return { ...EMPTY(), ...s, totals: { ...EMPTY().totals, ...s.totals } };
}

export async function record(patch) {
  if (!buffer) buffer = await load();
  const day = dayKey();
  buffer.daily[day] ||= { blocked: 0, hidden: 0, classified: 0 };

  for (const k of ['blocked', 'hidden', 'classified']) {
    if (patch[k]) {
      buffer.totals[k] += patch[k];
      buffer.daily[day][k] += patch[k];
    }
  }
  if (patch.bytes) buffer.totals.bytes += patch.bytes;
  if (patch.host) buffer.topHosts[patch.host] = (buffer.topHosts[patch.host] || 0) + 1;

  if (!flushTimer) flushTimer = setTimeout(flush, 2000);
}

export async function flush() {
  flushTimer = null;
  if (!buffer) return;
  const keep = new Set(lastDays());
  for (const k of Object.keys(buffer.daily)) if (!keep.has(k)) delete buffer.daily[k];
  buffer.topHosts = Object.fromEntries(
    Object.entries(buffer.topHosts).sort((a, b) => b[1] - a[1]).slice(0, 40)
  );
  await chrome.storage.local.set({ [KEY]: buffer });
}

export async function getStats() {
  if (!buffer) buffer = await load();
  return buffer;
}

export async function resetStats() {
  buffer = EMPTY();
  await chrome.storage.local.set({ [KEY]: buffer });
}
