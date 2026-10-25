importScripts('shared.js');

const {
  RULESET_ID,
  ALLOW_RULE_PRIORITY,
  MAX_ALLOWLIST_ENTRIES,
  normalizeHost,
  emptyStats,
  normalizeStats
} = self.Plainview;

const dnr = chrome.declarativeNetRequest;
const STATS_FLUSH_DELAY_MS = 250;

let chain = Promise.resolve();
function serialize(task) {
  const run = chain.then(() => task());
  chain = run.catch(() => {});
  return run;
}

async function getSettings() {
  const stored = await chrome.storage.local.get({ enabled: true, allowlist: [] });
  return {
    enabled: stored.enabled !== false,
    allowlist: Array.isArray(stored.allowlist) ? stored.allowlist : []
  };
}

async function applyState() {
  const { enabled, allowlist } = await getSettings();

  await dnr.updateEnabledRulesets(
    enabled ? { enableRulesetIds: [RULESET_ID] } : { disableRulesetIds: [RULESET_ID] }
  );

  const existing = await dnr.getDynamicRules();
  const addRules = allowlist.map((host, index) => ({
    id: index + 1,
    priority: ALLOW_RULE_PRIORITY,
    action: { type: 'allowAllRequests' },
    condition: { requestDomains: [host], resourceTypes: ['main_frame'] }
  }));
  await dnr.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules
  });
}

async function setEnabled(value) {
  await chrome.storage.local.set({ enabled: Boolean(value) });
  await applyState();
}

async function setSiteAllowed(rawHost, allowed) {
  const host = normalizeHost(rawHost);
  if (!host) throw new Error('Invalid hostname');
  const { allowlist } = await getSettings();
  const next = new Set(allowlist);
  if (allowed) {
    if (!next.has(host) && next.size >= MAX_ALLOWLIST_ENTRIES) {
      throw new Error('Allowlist is full');
    }
    next.add(host);
  } else {
    next.delete(host);
  }
  await chrome.storage.local.set({ allowlist: [...next].sort() });
  await applyState();
}

async function ensureDefaults() {
  const stored = await chrome.storage.local.get(['enabled', 'allowlist', 'stats']);
  const patch = {};
  if (typeof stored.enabled !== 'boolean') patch.enabled = true;
  if (!Array.isArray(stored.allowlist)) patch.allowlist = [];
  if (!stored.stats) patch.stats = emptyStats();
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);
}

let pending = { blocked: 0, hidden: 0, tabs: new Map() };
let flushTimer = null;

function scheduleFlush() {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    serialize(flushStats).catch(() => {});
  }, STATS_FLUSH_DELAY_MS);
}

function addBlocked(tabId) {
  pending.blocked += 1;
  if (Number.isInteger(tabId) && tabId >= 0) {
    pending.tabs.set(tabId, (pending.tabs.get(tabId) || 0) + 1);
  }
  scheduleFlush();
}

function addHidden(count) {
  pending.hidden += count;
  scheduleFlush();
}

async function flushStats() {
  const batch = pending;
  pending = { blocked: 0, hidden: 0, tabs: new Map() };
  if (!batch.blocked && !batch.hidden && !batch.tabs.size) return;

  if (batch.blocked || batch.hidden) {
    const { stats } = await chrome.storage.local.get('stats');
    const next = normalizeStats(stats);
    next.blocked += batch.blocked;
    next.hidden += batch.hidden;
    await chrome.storage.local.set({ stats: next });
  }
  if (batch.tabs.size) {
    const { tabBlocked } = await chrome.storage.session.get({ tabBlocked: {} });
    for (const [tabId, n] of batch.tabs) {
      tabBlocked[tabId] = (tabBlocked[tabId] || 0) + n;
    }
    await chrome.storage.session.set({ tabBlocked });
  }
}

async function resetStats() {
  pending = { blocked: 0, hidden: 0, tabs: new Map() };
  await chrome.storage.local.set({ stats: emptyStats() });
  await chrome.storage.session.set({ tabBlocked: {} });
}

async function resetTabBlocked(tabId) {
  pending.tabs.delete(tabId);
  const { tabBlocked } = await chrome.storage.session.get({ tabBlocked: {} });
  if (tabBlocked[tabId]) {
    delete tabBlocked[tabId];
    await chrome.storage.session.set({ tabBlocked });
  }
}

const statsSupported = Boolean(dnr.onRuleMatchedDebug);
if (statsSupported) {
  dnr.onRuleMatchedDebug.addListener((info) => {
    if (info.rule.rulesetId !== RULESET_ID) return;
    addBlocked(info.request.tabId);
  });
}

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    serialize(() => resetTabBlocked(tabId)).catch(() => {});
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(() => resetTabBlocked(tabId)).catch(() => {});
});

async function getState(tabId, rawHost) {
  await serialize(flushStats);
  const settings = await getSettings();
  const { stats } = await chrome.storage.local.get('stats');
  const totals = normalizeStats(stats);
  const { tabBlocked } = await chrome.storage.session.get({ tabBlocked: {} });
  const host = normalizeHost(rawHost);
  const active = await dnr.getEnabledRulesets();

  return {
    enabled: settings.enabled,
    siteAllowed: Boolean(host) && settings.allowlist.some((e) => host === e || host.endsWith('.' + e)),
    allowlistCount: settings.allowlist.length,
    networkRulesActive: active.includes(RULESET_ID),
    statsSupported,
    blocked: totals.blocked,
    hidden: totals.hidden,
    since: totals.since,
    pageBlocked: Number.isInteger(tabId) ? tabBlocked[tabId] || 0 : 0
  };
}

async function handleMessage(message) {
  switch (message && message.type) {
    case 'getState':
      return getState(message.tabId, message.host);
    case 'setEnabled':
      await serialize(() => setEnabled(message.value));
      return { ok: true };
    case 'setSiteAllowed':
      await serialize(() => setSiteAllowed(message.host, message.allowed));
      return { ok: true };
    case 'resetStats':
      await serialize(resetStats);
      return { ok: true };
    default:
      return undefined;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return false;

  if (message && message.type === 'hidden') {
    const n = message.delta;
    if (Number.isInteger(n) && n > 0 && n <= 10000) addHidden(n);
    return false;
  }

  const known = ['getState', 'setEnabled', 'setSiteAllowed', 'resetStats'];
  if (!message || !known.includes(message.type)) return false;

  handleMessage(message).then(
    (result) => sendResponse(result),
    (err) => sendResponse({ error: String((err && err.message) || err) })
  );
  return true;
});

function setBadgeOptions() {
  dnr.setExtensionActionOptions({ displayActionCountAsBadgeText: true }).catch(() => {});
}
setBadgeOptions();

chrome.runtime.onInstalled.addListener(() => {
  serialize(async () => {
    await ensureDefaults();
    await applyState();
  }).catch((err) => console.error('Plainview: install setup failed', err));
});

chrome.runtime.onStartup.addListener(() => {
  serialize(applyState).catch((err) => console.error('Plainview: startup sync failed', err));
});
