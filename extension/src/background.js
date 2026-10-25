/*
 * Service worker (classic, non-module) for Plainview Ad Blocker.
 *
 * Responsibilities:
 *  - Keep the static "ads" ruleset enabled/disabled to match the global toggle.
 *  - Mirror the per-site allowlist into dynamic allowAllRequests rules.
 *  - Count blocked requests (only possible in unpacked installs, see README).
 *  - Count hidden elements reported by the content script.
 *
 * Settings and statistics live in chrome.storage.local. The worker keeps no
 * state it cannot rebuild, because MV3 service workers are stopped at will.
 */
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

/* ---------------------------------------------------------------- queue -- */

// All storage/rule mutations run one at a time so concurrent messages cannot
// interleave read-modify-write sequences.
let chain = Promise.resolve();
function serialize(task) {
  const run = chain.then(() => task());
  chain = run.catch(() => {});
  return run;
}

/* ------------------------------------------------------------- settings -- */

async function getSettings() {
  const stored = await chrome.storage.local.get({ enabled: true, allowlist: [] });
  return {
    enabled: stored.enabled !== false,
    allowlist: Array.isArray(stored.allowlist) ? stored.allowlist : []
  };
}

/** Makes the browser's rules match the stored settings. Idempotent. */
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

/* ---------------------------------------------------------------- stats -- */

// Increments are batched in memory and written shortly after, so a page that
// triggers hundreds of blocked requests does not cause hundreds of writes.
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

// onRuleMatchedDebug only exists for unpacked extensions that hold the
// declarativeNetRequestFeedback permission. When it is missing we report that
// request counting is unavailable instead of showing made-up numbers.
const statsSupported = Boolean(dnr.onRuleMatchedDebug);
if (statsSupported) {
  dnr.onRuleMatchedDebug.addListener((info) => {
    // Only count the static block ruleset (not dynamic allowlist matches).
    if (info.rule.rulesetId !== RULESET_ID) return;
    addBlocked(info.request.tabId);
  });
}

// A new main-frame load starts a fresh "this page" counter.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    serialize(() => resetTabBlocked(tabId)).catch(() => {});
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  serialize(() => resetTabBlocked(tabId)).catch(() => {});
});

/* -------------------------------------------------------------- messages -- */

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

  // From the content script: number of elements it just hid on its page.
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
  return true; // keep the channel open for the async response
});

/* ------------------------------------------------------------- lifecycle -- */

// Show the browser's own per-tab blocked-request count on the toolbar icon.
// This works in packed installs too, since the browser does the counting.
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
