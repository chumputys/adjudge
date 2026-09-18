export const DEFAULTS = {
  apiKey: '',
  model: 'typesafe-ai/jev',
  enabled: true,
  blockNetwork: true,
  hideElements: true,
  hideSitePromos: false,
  blockPopunders: true,
  popupAllowlist: [],
  adThreshold: 0.75,
  maxBreakage: 1.5,
  allowlist: [],
};

export async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return { ...DEFAULTS, ...stored };
}

export async function setSettings(patch) {
  await chrome.storage.local.set(patch);
}

export async function isAllowlisted(host) {
  const { allowlist } = await getSettings();
  return allowlist.some((h) => host === h || host.endsWith('.' + h));
}

export async function isPopupAllowed(host) {
  const { popupAllowlist } = await getSettings();
  return popupAllowlist.some((h) => host === h || host.endsWith('.' + h));
}
