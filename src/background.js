import { classifyHosts, classifyElements } from './jev.js';
import { getHostVerdicts, putHostVerdicts, isFresh, getTemplate, putTemplate } from './cache.js';
import { getSettings, isAllowlisted, isPopupAllowed } from './settings.js';
import { record, flush, getStats, resetStats, estimateBytes } from './stats.js';

const DYNAMIC_RULE_BASE = 10000;
const BATCH_SIZE = 12;
const BATCH_DELAY_MS = 1500;
const POPUNDER_WINDOW_MS = 4000;

const pending = new Map();
let flushTimer = null;
let inFlight = false;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function baseDomain(host) {
  const parts = host.split('.');
  return parts.length <= 2 ? host : parts.slice(-2).join('.');
}

/* ---------- network layer ---------- */

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return;
    queueRequest(details).catch(() => {});
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

// Blocked requests surface here as net::ERR_BLOCKED_BY_CLIENT, in packed
// builds as well as unpacked — unlike onRuleMatchedDebug.
chrome.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (!details.error?.includes('BLOCKED_BY_CLIENT')) return;
    const host = hostOf(details.url);
    record({ blocked: 1, bytes: estimateBytes(details.type), host }).catch(() => {});
  },
  { urls: ['http://*/*', 'https://*/*'] }
);

async function queueRequest(details) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.blockNetwork || !settings.apiKey) return;

  const host = hostOf(details.url);
  const pageHost = details.initiator ? hostOf(details.initiator) : null;
  if (!host || !pageHost) return;
  if (baseDomain(host) === baseDomain(pageHost)) return;
  if (await isAllowlisted(pageHost)) return;

  const verdicts = await getHostVerdicts();
  if (isFresh(verdicts[host])) return;

  const entry = pending.get(host) || {
    host,
    sampleUrl: details.url.slice(0, 300),
    resourceTypes: new Set(),
    pageHost,
  };
  entry.resourceTypes.add(details.type);
  pending.set(host, entry);

  if (!flushTimer) flushTimer = setTimeout(runBatch, BATCH_DELAY_MS);
}

async function runBatch() {
  flushTimer = null;
  if (inFlight || !pending.size) return;
  inFlight = true;

  const batch = [...pending.values()].slice(0, BATCH_SIZE).map((e) => ({
    host: e.host,
    sampleUrl: e.sampleUrl,
    resourceTypes: [...e.resourceTypes],
    pageHost: e.pageHost,
  }));
  for (const b of batch) pending.delete(b.host);

  try {
    const results = await classifyHosts(batch);
    await putHostVerdicts([...results.entries()]);
    await applyRules(results);
    await record({ classified: batch.length });
  } catch (e) {
    console.warn('[jev] host classification failed', e?.message || e);
  } finally {
    inFlight = false;
    if (pending.size) flushTimer = setTimeout(runBatch, BATCH_DELAY_MS);
  }
}

async function applyRules(results) {
  const { adThreshold, maxBreakage } = await getSettings();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const used = new Set(existing.map((r) => r.id));
  const blockedHosts = new Set(
    existing.map((r) => r.condition?.requestDomains?.[0]).filter(Boolean)
  );

  let nextId = DYNAMIC_RULE_BASE;
  const addRules = [];

  for (const [host, v] of results) {
    const isAdvert = v.kind === 'ad' || v.kind === 'tracker';
    if (!isAdvert || v.confidence < adThreshold || v.breakage > maxBreakage) continue;
    if (blockedHosts.has(host)) continue;
    while (used.has(nextId)) nextId++;
    used.add(nextId);
    addRules.push({
      id: nextId,
      priority: 2,
      action: { type: 'block' },
      condition: { requestDomains: [host], domainType: 'thirdParty' },
    });
  }

  if (addRules.length) {
    await chrome.declarativeNetRequest.updateDynamicRules({ addRules });
  }
}

/* ---------- popunder / redirect layer ---------- */

// A tab opened by another tab, cross-site, within a few seconds of the click —
// the shape of a click-hijack. Verify the destination before letting it stay.
chrome.webNavigation.onCreatedNavigationTarget.addListener((details) => {
  guardNewTab(details).catch(() => {});
});

async function guardNewTab(details) {
  const settings = await getSettings();
  if (!settings.enabled || !settings.blockPopunders) return;

  const target = hostOf(details.url);
  if (!target) return;

  let sourceHost = null;
  try {
    const source = await chrome.tabs.get(details.sourceTabId);
    sourceHost = source?.url ? hostOf(source.url) : null;
  } catch {}
  if (!sourceHost) return;
  if (await isPopupAllowed(sourceHost)) return;
  if (baseDomain(target) === baseDomain(sourceHost)) return;

  const verdicts = await getHostVerdicts();
  const known = verdicts[target];

  const close = async (reason) => {
    try {
      await chrome.tabs.remove(details.tabId);
      await record({ blocked: 1, host: target });
      console.info('[jev] closed popunder', target, reason);
    } catch {}
  };

  if (isFresh(known)) {
    if (known.kind === 'ad' || known.kind === 'tracker') await close('cached');
    return;
  }

  if (!settings.apiKey) return;

  const deadline = Date.now() + POPUNDER_WINDOW_MS;
  try {
    const results = await classifyHosts([
      { host: target, sampleUrl: details.url.slice(0, 300), resourceTypes: ['main_frame'], pageHost: sourceHost },
    ]);
    await putHostVerdicts([...results.entries()]);
    const v = results.get(target);
    if (!v) return;
    const advert = v.kind === 'ad' || v.kind === 'tracker';
    if (advert && v.confidence >= settings.adThreshold && Date.now() < deadline) {
      await close('classified');
      await applyRules(results);
    }
  } catch {}
}

/* ---------- messages ---------- */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender)
    .then(sendResponse)
    .catch((e) => sendResponse({ error: String(e?.message || e) }));
  return true;
});

async function handle(msg, sender) {
  const settings = await getSettings();

  if (msg.type === 'getConfig') {
    const pageHost = sender.tab?.url ? hostOf(sender.tab.url) : null;
    return {
      enabled: settings.enabled && settings.hideElements && !!settings.apiKey,
      allowlisted: pageHost ? await isAllowlisted(pageHost) : false,
      allowPopups: pageHost ? !settings.blockPopunders || (await isPopupAllowed(pageHost)) : true,
      hideSitePromos: settings.hideSitePromos,
      threshold: settings.adThreshold,
    };
  }

  if (msg.type === 'shieldBlocked') {
    await record({ blocked: 1, host: hostOf(msg.url) || undefined });
    return { ok: true };
  }

  if (msg.type === 'getStats') {
    await flush();
    return { stats: await getStats(), settings };
  }

  if (msg.type === 'resetStats') {
    await resetStats();
    return { ok: true };
  }

  if (msg.type === 'getTemplate') {
    return { template: await getTemplate(msg.key) };
  }

  if (msg.type === 'classify') {
    if (!settings.apiKey) return { error: 'NO_API_KEY' };
    const results = await classifyElements(msg.page, msg.candidates);
    const hide = [];
    for (const [ref, v] of results) {
      const isAd =
        v.kind === 'ad' || v.kind === 'sponsored' || (settings.hideSitePromos && v.kind === 'promo');
      if (isAd && v.confidence >= settings.adThreshold) hide.push(ref);
    }
    const selectors = msg.candidates.filter((c) => hide.includes(c.ref)).map((c) => c.selector);
    if (msg.key) await putTemplate(msg.key, selectors);
    await record({ hidden: hide.length });
    return { hide, selectors };
  }

  return { error: 'UNKNOWN_MESSAGE' };
}
