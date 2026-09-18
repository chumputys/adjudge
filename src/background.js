import { classifyHosts, classifyPage, rateLimited } from './jev.js';
import { getHostVerdicts, putHostVerdicts, isFresh, getTemplate, putTemplate, getHostSets } from './cache.js';
import { getSettings, isAllowlisted, isPopupAllowed } from './settings.js';
import { record, flush, getStats, resetStats, estimateBytes } from './stats.js';

const DYNAMIC_RULE_BASE = 10000;
const BATCH_SIZE = 12;
const BATCH_DELAY_MS = 4000;
const POPUNDER_WINDOW_MS = 4000;

const pending = new Map();
let flushTimer = null;
let inFlight = false;

// Hot path for popunders: closing a tab has to happen before Chrome paints it,
// so these are kept in memory and never awaited on.
const knownAd = new Set();
let settingsCache = null;

async function hydrate() {
  settingsCache = await getSettings();
  const verdicts = await getHostVerdicts();
  for (const [host, entry] of Object.entries(verdicts)) {
    if (isFresh(entry) && (entry.kind === 'ad' || entry.kind === 'tracker')) knownAd.add(host);
  }
  try {
    for (const rule of await chrome.declarativeNetRequest.getDynamicRules()) {
      const host = rule.condition?.requestDomains?.[0];
      if (host) knownAd.add(host);
    }
  } catch {}
}

console.info(`[jev] service worker start — build ${__BUILD__}`);
hydrate().catch(() => {});
chrome.runtime.onStartup?.addListener?.(() => hydrate().catch(() => {}));
chrome.runtime.onInstalled.addListener(() => hydrate().catch(() => {}));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && !changes.stats) hydrate().catch(() => {});
});

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
  if (rateLimited()) {
    flushTimer = setTimeout(runBatch, 15_000);
    return;
  }
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
    knownAd.add(host);
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
// Tabs already closed, so the two listeners below never double-handle one.
const closedTabs = new Set();

function closeTab(tabId, host, reason) {
  if (closedTabs.has(tabId)) return;
  closedTabs.add(tabId);
  if (closedTabs.size > 200) closedTabs.clear();
  chrome.tabs.remove(tabId).catch(() => {});
  record({ blocked: 1, host }).catch(() => {});
  console.info('[jev] closed popunder', host, reason);
}

// Fires before the tab commits its navigation — the only point early enough to
// close it without a visible flash. Synchronous, so it only fires when the
// in-memory state is warm; otherwise onCreatedNavigationTarget below handles it.
chrome.tabs.onCreated.addListener((tab) => {
  if (tab.openerTabId == null) return;
  if (!settingsCache?.enabled || !settingsCache.blockPopunders) return;

  const host = hostOf(tab.pendingUrl || tab.url || '');
  if (host && knownAd.has(host)) closeTab(tab.id, host, 'cached, pre-paint');
});

// Fallback for a host with no verdict yet: classify, then close. This is the
// path that can still flash, and prefetching is what keeps it rare.
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

  if (closedTabs.has(details.tabId)) return; // already handled pre-paint

  const verdicts = await getHostVerdicts();
  const known = verdicts[target];

  const close = (reason) => closeTab(details.tabId, target, reason);

  if (isFresh(known)) {
    if (known.kind === 'ad' || known.kind === 'tracker') close('cached');
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
    if (advert) knownAd.add(target);
    if (advert && v.confidence >= settings.adThreshold && Date.now() < deadline) {
      close('classified');
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
      debugMode: settings.debugMode,
      hosts: await getHostSets(),
    };
  }

  if (msg.type === 'prefetchHosts') {
    if (!settings.enabled || !settings.apiKey) return { ok: false };
    const pageHost = sender.tab?.url ? hostOf(sender.tab.url) : null;
    if (!pageHost || (await isAllowlisted(pageHost))) return { ok: false };

    const verdicts = await getHostVerdicts();
    for (const host of msg.hosts || []) {
      if (!host || isFresh(verdicts[host]) || pending.has(host)) continue;
      if (baseDomain(host) === baseDomain(pageHost)) continue;
      pending.set(host, {
        host,
        sampleUrl: `https://${host}/`,
        resourceTypes: new Set(['main_frame']),
        pageHost,
      });
    }
    if (pending.size && !flushTimer) flushTimer = setTimeout(runBatch, BATCH_DELAY_MS);
    return { ok: true, queued: pending.size };
  }

  // The shield collected page-wide gesture handlers and stacked layers. Jev
  // decides which are click-hijack machinery; the shield enforces the answer.
  if (msg.type === 'judgePage') {
    const empty = { gate: [], defuse: [], genuine: [], bait: [], hide: [] };
    if (!settings.apiKey || !settings.enabled) return empty;
    const pageHost = sender.tab?.url ? hostOf(sender.tab.url) : null;
    if (pageHost && (await isAllowlisted(pageHost))) return empty;
    if (rateLimited()) return { ...empty, rateLimited: true };

    const result = await classifyPage(
      msg.page,
      {
        handlers: msg.handlers || [],
        overlays: msg.overlays || [],
        controls: msg.controls || [],
        blocks: msg.blocks || [],
        hidePromos: settings.hideSitePromos,
      },
      settings.adThreshold
    );

    const suppressed = result.gate.length + result.defuse.length + result.bait.length;
    if (suppressed) await record({ blocked: suppressed });
    if (result.hide.length) await record({ hidden: result.hide.length });

    if (msg.key && result.hide.length) {
      await putTemplate(msg.key, result.hide.map((h) => h.selector));
    }

    console.info('[jev] page judged', {
      gatedHandlers: result.gate.length,
      defusedLayers: result.defuse.length,
      genuineControls: result.genuine.length,
      baitControls: result.bait.length,
      adBlocks: result.hide.length,
      url: msg.page?.url,
    });

    return result;
  }

  // A popup or programmatic navigation was held mid-click. Ask Jev what the
  // destination is; if it is real, carry it out rather than losing it.
  if (msg.type === 'adjudicate') {
    const host = hostOf(msg.url);
    const pageHost = sender.tab?.url ? hostOf(sender.tab.url) : null;
    if (!host || !pageHost || !settings.apiKey) return { allow: false };

    const verdicts = await getHostVerdicts();
    let v = isFresh(verdicts[host]) ? verdicts[host] : null;

    if (!v) {
      const results = await classifyHosts([
        {
          host,
          sampleUrl: msg.url,
          resourceTypes: [msg.what === 'popup' ? 'popup' : 'navigation'],
          pageHost,
        },
      ]);
      await putHostVerdicts([...results.entries()]);
      v = results.get(host);
      if (!v) return { allow: false };
      if (v.kind === 'ad' || v.kind === 'tracker') await applyRules(results);
    }

    const advert = (v.kind === 'ad' || v.kind === 'tracker') && v.confidence >= settings.adThreshold;
    if (advert) knownAd.add(host);

    console.info(
      `[jev] ${msg.what} to ${host} → ${v.kind} ${(v.confidence * 100).toFixed(0)}%`,
      advert ? 'blocked' : 'allowed'
    );

    if (advert) {
      await record({ blocked: 1, host });
    } else if (msg.what === 'popup') {
      chrome.tabs
        .create({ url: msg.url, openerTabId: sender.tab?.id, active: true })
        .catch(() => {});
    }

    if (sender.tab?.id != null) {
      chrome.tabs
        .sendMessage(sender.tab.id, {
          type: 'adjudicated',
          host,
          advert,
          what: msg.what,
          method: msg.method,
          url: msg.url,
        })
        .catch(() => {});
    }
    return { allow: !advert, kind: v.kind, confidence: v.confidence };
  }

  // The shield held a popup to an unknown cross-site host. Ask Jev what it is,
  // then tell the page — so a real destination works on the next click, and an
  // ad host is refused instantly from here on.
  if (msg.type === 'verifyPopupHost') {
    const host = hostOf(msg.url);
    const pageHost = sender.tab?.url ? hostOf(sender.tab.url) : null;
    if (!host || !pageHost || !settings.apiKey) return { ok: false };

    const verdicts = await getHostVerdicts();
    let v = isFresh(verdicts[host]) ? verdicts[host] : null;

    if (!v) {
      const results = await classifyHosts([
        { host, sampleUrl: msg.url, resourceTypes: ['popup'], pageHost },
      ]);
      await putHostVerdicts([...results.entries()]);
      v = results.get(host);
      if (!v) return { ok: false };
      if (v.kind === 'ad' || v.kind === 'tracker') await applyRules(results);
    }

    const advert = v.kind === 'ad' || v.kind === 'tracker';
    if (advert) knownAd.add(host);

    if (sender.tab?.id != null) {
      chrome.tabs
        .sendMessage(sender.tab.id, {
          type: 'hostVerdict',
          host,
          advert: advert && v.confidence >= settings.adThreshold,
        })
        .catch(() => {});
    }
    return { ok: true, kind: v.kind, confidence: v.confidence };
  }

  if (msg.type === 'shieldTrace') {
    console.log(
      `[jev:trace] ${msg.event}`,
      msg.detail,
      sender.tab?.url ? `\n  on ${sender.tab.url}` : ''
    );
    return { ok: true };
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

  return { error: 'UNKNOWN_MESSAGE' };
}
