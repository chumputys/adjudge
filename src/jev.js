import { experimental_evaluate as evaluate } from 'ai';
import { createGateway } from '@ai-sdk/gateway';
import { getSettings } from './settings.js';

let cached = { key: '', provider: null };

async function model() {
  const { apiKey, model: modelId } = await getSettings();
  if (!apiKey) throw new Error('NO_API_KEY');
  if (apiKey !== cached.key) {
    cached = { key: apiKey, provider: createGateway({ apiKey }) };
  }
  return cached.provider.evaluationModel(modelId);
}

/* ---------- request discipline ----------
 * Jev answers many questions in one request, so the extension should make few
 * large calls rather than many small ones. Everything funnels through one
 * serial queue with a minimum gap, and a rate-limit response trips a breaker
 * instead of retrying into the same wall.
 */

let chain = Promise.resolve();
let lastCall = 0;
let breakerUntil = 0;
let breakerNotified = false;

const MIN_GAP_MS = 500;
const BREAKER_MS = 60_000;

export function rateLimited() {
  return Date.now() < breakerUntil;
}

function isRateLimit(e) {
  const s = String(e?.name || '') + String(e?.message || '');
  return /ratelimit|rate.limit|429|quota/i.test(s);
}

function queued(fn) {
  const run = chain.then(async () => {
    if (rateLimited()) {
      const err = new Error('Jev paused: rate limited');
      err.rateLimited = true;
      throw err;
    }
    const wait = MIN_GAP_MS - (Date.now() - lastCall);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    try {
      const out = await fn();
      breakerNotified = false;
      return out;
    } catch (e) {
      if (isRateLimit(e)) {
        breakerUntil = Date.now() + BREAKER_MS;
        if (!breakerNotified) {
          breakerNotified = true;
          console.warn(`[jev] rate limited — pausing calls for ${BREAKER_MS / 1000}s`);
        }
        e.rateLimited = true;
      }
      throw e;
    } finally {
      lastCall = Date.now();
    }
  });
  chain = run.catch(() => {});
  return run;
}

const REQUEST_CRITERIA = {
  ad: 'ad serving, ad exchange, header bidding, or creative delivery',
  tracker: 'analytics, fingerprinting, session replay, or cross-site user tracking',
  functional: 'content, API, script, style, font, or media the page needs to work',
};

const BREAKAGE_CRITERIA = [
  'none: purely advertising or telemetry',
  'minor: cosmetic gaps only',
  'moderate: some features degrade',
  'severe: the page will not function',
];

const HANDLER_CRITERIA = {
  hijack:
    'advertising code that turns a click anywhere on the page into a popup, popunder, or a redirect to an unrelated site',
  interstitial: 'cookie, consent, paywall, or age-gate handling',
  analytics: 'click tracking or telemetry that does not navigate anywhere',
  functional:
    "the site's own behaviour — menus, player controls, forms, or navigation the visitor asked for",
};

const CONTROL_CRITERIA = {
  control:
    "a genuine control belonging to the site — player button, quality or source selector, menu item, tab, form control, or navigation the visitor means to use",
  bait:
    'an element placed to harvest clicks for advertising — a fake play or download button, a fake close button, or a control wired to open ads',
  content: 'ordinary content or layout, not an interactive control at all',
};

const BLOCK_CRITERIA = {
  ad: 'a paid advertisement, ad slot, ad iframe, or a fake system or download notice placed by an ad network',
  sponsored: 'sponsored, promoted, or native advertising dressed up as editorial',
  promo: 'the site promoting itself: newsletter signup, paywall nag, app install, cookie or consent banner',
  content: 'content the visitor came for, or navigation and controls they need',
};

/** Classify third-party hosts. One request, two questions per host. */
export async function classifyHosts(hosts) {
  if (!hosts.length) return new Map();
  const m = await model();

  const questions = {};
  hosts.forEach((h, i) => {
    questions['kind_' + i] = {
      type: 'choice',
      instructions: `What is host #${i} (${h.host}) doing on the page?`,
      criteria: REQUEST_CRITERIA,
    };
    questions['breakage_' + i] = {
      type: 'score',
      instructions: `If every request to host #${i} (${h.host}) were blocked, how badly would the page break?`,
      criteria: BREAKAGE_CRITERIA,
    };
  });

  const { answers } = await queued(() =>
    evaluate({
      model: m,
      state: {
        task: 'Decide which third-party hosts contacted by a web page are advertising or tracking infrastructure.',
        hosts: hosts.map((h, i) => ({
          index: i,
          host: h.host,
          sampleUrl: h.sampleUrl,
          resourceTypes: h.resourceTypes,
          pageHost: h.pageHost,
        })),
      },
      questions,
    })
  );

  const out = new Map();
  hosts.forEach((h, i) => {
    const kind = answers['kind_' + i];
    if (!kind) return;
    out.set(h.host, {
      kind: kind.choice,
      confidence: kind.probabilities?.[kind.choice] ?? 0,
      breakage: answers['breakage_' + i]?.score ?? 0,
    });
  });
  return out;
}

/**
 * Everything about one page in a single request: which page-wide handlers are
 * click hijackers, which layers are click-catchers, which clickable elements
 * are real controls versus bait, and which blocks are ads.
 */
export async function classifyPage(pageContext, parts, threshold = 0.75) {
  const handlers = parts.handlers || [];
  const overlays = parts.overlays || [];
  const controls = parts.controls || [];
  const blocks = parts.blocks || [];

  if (!handlers.length && !overlays.length && !controls.length && !blocks.length) {
    return { gate: [], defuse: [], genuine: [], bait: [], hide: [] };
  }

  const m = await model();
  const questions = {};

  handlers.forEach((h, i) => {
    questions['h_' + i] = {
      type: 'choice',
      instructions: `What is click handler #${i} for? It is bound to ${h.target} for "${h.type}" events.`,
      criteria: HANDLER_CRITERIA,
    };
  });
  overlays.forEach((o, i) => {
    questions['o_' + i] = {
      type: 'boolean',
      instructions: `Is layer #${i} an invisible click-catcher laid over the page to steal clicks?`,
      criteria: {
        true: 'a transparent or empty layer whose only purpose is to intercept clicks',
        false: 'a real dialog, modal backdrop, video control surface, or visible site element',
      },
    };
  });
  controls.forEach((c, i) => {
    questions['c_' + i] = {
      type: 'choice',
      instructions: `What is clickable element #${i}?`,
      criteria: CONTROL_CRITERIA,
    };
  });
  blocks.forEach((b, i) => {
    questions['b_' + i] = {
      type: 'choice',
      instructions: `What is block #${i}?`,
      criteria: BLOCK_CRITERIA,
    };
  });

  const { answers } = await queued(() =>
    evaluate({
      model: m,
      state: {
        task:
          'Find the advertising on a web page: ad blocks and fake system notices, invisible click-catchers, ' +
          'handlers that turn any click into a popup or redirect, and elements placed to harvest clicks.',
        page: pageContext,
        handlers: handlers.map((h, i) => ({ index: i, boundTo: h.target, event: h.type, source: h.source })),
        layers: overlays.map((o, i) => ({
          index: i, tag: o.tag, classes: o.classes, viewportCoverage: o.coverage,
          zIndex: o.zIndex, opacity: o.opacity, background: o.background,
          text: o.text, href: o.href, children: o.childCount,
        })),
        clickables: controls.map((c, i) => ({
          index: i, tag: c.tag, id: c.elId, classes: c.classes, role: c.role,
          label: c.label, text: c.text, size: `${c.width}x${c.height}`,
          href: c.href, insidePlayer: c.inPlayer, hasClickHandler: c.hasHandler, depth: c.depth,
        })),
        blocks: blocks.map((b, i) => ({
          index: i, tag: b.tag, id: b.id, classes: b.classes, role: b.role,
          label: b.label, size: `${b.width}x${b.height}`, position: b.position,
          zIndex: b.zIndex, placement: b.placement, labelsItselfAsAd: b.selfLabelled,
          collectedBecause: b.why, text: b.text, linkHosts: b.linkHosts,
          frameHost: b.frameHost, images: b.imgCount,
        })),
      },
      questions,
    })
  );

  const pick = (a) => a?.probabilities?.[a.choice] ?? 0;
  const gate = [];
  const defuse = [];
  const genuine = [];
  const bait = [];
  const hide = [];

  handlers.forEach((h, i) => {
    const a = answers['h_' + i];
    if (a?.choice === 'hijack' && pick(a) >= threshold) gate.push(h.id);
  });
  overlays.forEach((o, i) => {
    const a = answers['o_' + i];
    if (a && a.probability >= threshold) defuse.push(o.id);
  });
  controls.forEach((c, i) => {
    const a = answers['c_' + i];
    if (!a || pick(a) < threshold) return;
    if (a.choice === 'bait') bait.push(c.id);
    else if (a.choice === 'control') genuine.push(c.id);
  });
  blocks.forEach((b, i) => {
    const a = answers['b_' + i];
    if (!a || pick(a) < threshold) return;
    if (a.choice === 'ad' || a.choice === 'sponsored' || (parts.hidePromos && a.choice === 'promo')) {
      hide.push({ ref: b.ref, selector: b.selector, kind: a.choice });
    }
  });

  return { gate, defuse, genuine, bait, hide };
}

/** One cheap round trip to verify the API key and model id. */
export async function testConnection() {
  const m = await model();
  const { answers, usage } = await queued(() =>
    evaluate({
      model: m,
      state: 'https://ads.doubleclick.net/pagead/ads?slot=300x250 loaded on a news article.',
      questions: { isAd: { type: 'boolean', instructions: 'Is this an advertising request?' } },
    })
  );
  return { ok: true, probability: answers.isAd?.probability, usage };
}
