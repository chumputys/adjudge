const HOSTS = 'hostVerdicts';
const TEMPLATES = 'templates';
const TTL_MS = 1000 * 60 * 60 * 24 * 30;

export async function getHostVerdicts() {
  const { [HOSTS]: v = {} } = await chrome.storage.local.get(HOSTS);
  return v;
}

export async function putHostVerdicts(entries) {
  const v = await getHostVerdicts();
  const now = Date.now();
  for (const [host, verdict] of entries) v[host] = { ...verdict, at: now };
  await chrome.storage.local.set({ [HOSTS]: v });
  return v;
}

export function isFresh(entry) {
  return entry && Date.now() - entry.at < TTL_MS;
}

export async function getTemplate(key) {
  const { [TEMPLATES]: t = {} } = await chrome.storage.local.get(TEMPLATES);
  const entry = t[key];
  return isFresh(entry) ? entry : null;
}

export async function putTemplate(key, selectors) {
  const { [TEMPLATES]: t = {} } = await chrome.storage.local.get(TEMPLATES);
  t[key] = { selectors, at: Date.now() };
  await chrome.storage.local.set({ [TEMPLATES]: t });
}
