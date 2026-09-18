import { DEFAULTS, getSettings, setSettings } from './settings.js';
import { testConnection } from './jev.js';

const fields = ['apiKey', 'model', 'adThreshold'];
const toggles = ['enabled', 'blockNetwork', 'hideElements', 'hideSitePromos', 'blockPopunders'];

const settings = await getSettings();
for (const f of fields) document.getElementById(f).value = settings[f];
for (const t of toggles) document.getElementById(t).checked = settings[t];
document.getElementById('allowlist').value = settings.allowlist.join('\n');
document.getElementById('popupAllowlist').value = settings.popupAllowlist.join('\n');

document.getElementById('save').addEventListener('click', async () => {
  const patch = {};
  for (const f of fields) patch[f] = document.getElementById(f).value.trim();
  for (const t of toggles) patch[t] = document.getElementById(t).checked;
  patch.model = patch.model || DEFAULTS.model;
  patch.adThreshold = Math.min(1, Math.max(0, Number(patch.adThreshold) || DEFAULTS.adThreshold));
  const hosts = (id) => document.getElementById(id).value
    .split('\n').map((s) => s.trim().replace(/^www\./, '')).filter(Boolean);
  patch.allowlist = hosts('allowlist');
  patch.popupAllowlist = hosts('popupAllowlist');

  await setSettings(patch);
  const status = document.getElementById('status');
  status.textContent = 'Saved';
  setTimeout(() => (status.textContent = ''), 1500);
});

document.getElementById('test').addEventListener('click', async () => {
  const status = document.getElementById('status');
  status.style.color = '#666';
  status.textContent = 'Testing…';
  await setSettings({ apiKey: document.getElementById('apiKey').value.trim() });
  try {
    const r = await testConnection();
    status.style.color = '#0a7';
    status.textContent = `OK — ${Math.round(r.probability * 100)}% on the sample, ${r.usage?.inputTokens ?? '?'} input tokens`;
  } catch (e) {
    status.style.color = '#b00';
    status.textContent = String(e?.message || e).slice(0, 120);
  }
});
