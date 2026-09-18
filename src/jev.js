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

/**
 * Classify a batch of third-party hosts in one round trip.
 * hosts: [{ host, sampleUrl, resourceTypes: [], pageHost }]
 * returns Map<host, { kind, confidence, breakage }>
 */
export async function classifyHosts(hosts) {
  if (!hosts.length) return new Map();
  const m = await model();

  const questions = {};
  for (let i = 0; i < hosts.length; i++) {
    questions['kind_' + i] = {
      type: 'choice',
      instructions: `What is host #${i} (${hosts[i].host}) doing on the page?`,
      criteria: REQUEST_CRITERIA,
    };
    questions['breakage_' + i] = {
      type: 'score',
      instructions: `If every request to host #${i} (${hosts[i].host}) were blocked, how badly would the page break?`,
      criteria: BREAKAGE_CRITERIA,
    };
  }

  const { answers } = await evaluate({
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
  });

  const out = new Map();
  for (let i = 0; i < hosts.length; i++) {
    const kind = answers['kind_' + i];
    const breakage = answers['breakage_' + i];
    if (!kind) continue;
    out.set(hosts[i].host, {
      kind: kind.choice,
      confidence: kind.probabilities?.[kind.choice] ?? 0,
      breakage: breakage?.score ?? 0,
    });
  }
  return out;
}

const ELEMENT_CRITERIA = {
  ad: 'a paid advertisement, ad slot, or ad iframe',
  sponsored: 'sponsored, promoted, or native-advertising content dressed up as editorial',
  promo: 'the site promoting itself: newsletter signup, paywall nag, app install, cookie or consent banner',
  content: 'content the visitor actually came for, or navigation and controls they need',
};

/**
 * Classify a batch of DOM candidates against one page state.
 * candidates: [{ ref, selector, tag, id, classes, role, label, width, height, text, linkHosts, frameHost, imgCount }]
 * returns Map<ref, { kind, confidence }>
 */
export async function classifyElements(pageContext, candidates) {
  if (!candidates.length) return new Map();
  const m = await model();

  const questions = {};
  for (let i = 0; i < candidates.length; i++) {
    questions['el_' + i] = {
      type: 'choice',
      instructions: `Classify block #${i}.`,
      criteria: ELEMENT_CRITERIA,
    };
  }

  const { answers } = await evaluate({
    model: m,
    state: {
      task: 'Classify blocks extracted from a web page so an ad blocker can hide the advertising ones.',
      page: pageContext,
      blocks: candidates.map((c, i) => ({
        index: i,
        tag: c.tag,
        id: c.id,
        classes: c.classes,
        role: c.role,
        label: c.label,
        size: `${c.width}x${c.height}`,
        text: c.text,
        linkHosts: c.linkHosts,
        frameHost: c.frameHost,
        images: c.imgCount,
      })),
    },
    questions,
  });

  const out = new Map();
  for (let i = 0; i < candidates.length; i++) {
    const a = answers['el_' + i];
    if (!a) continue;
    out.set(candidates[i].ref, {
      kind: a.choice,
      confidence: a.probabilities?.[a.choice] ?? 0,
    });
  }
  return out;
}

/** One cheap round trip to verify the API key and model id. */
export async function testConnection() {
  const m = await model();
  const { answers, usage } = await evaluate({
    model: m,
    state: 'https://ads.doubleclick.net/pagead/ads?slot=300x250 loaded on a news article.',
    questions: {
      isAd: { type: 'boolean', instructions: 'Is this an advertising request?' },
    },
  });
  return { ok: true, probability: answers.isAd?.probability, usage };
}
