'use strict';

/*
 * Runs the real src/background.js inside a vm sandbox with a mocked chrome.*
 * API. This verifies the worker's logic (toggle, allowlist rules, stats,
 * message handling). It is NOT a browser test: see test/e2e.js for that.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = path.join(__dirname, '..', 'extension', 'src');

function pick(store, keys) {
  if (keys === undefined || keys === null) return { ...store };
  if (typeof keys === 'string') return keys in store ? { [keys]: structuredClone(store[keys]) } : {};
  if (Array.isArray(keys)) {
    return Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
  }
  const out = {};
  for (const [k, def] of Object.entries(keys)) out[k] = k in store ? structuredClone(store[k]) : structuredClone(def);
  return out;
}

function makeArea(onChange) {
  const store = {};
  return {
    store,
    async get(keys) { return pick(store, keys); },
    async set(items) {
      const changes = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: store[k], newValue: structuredClone(v) };
        store[k] = structuredClone(v);
      }
      if (onChange) onChange(changes);
    }
  };
}

function createWorker({ withDebugEvent = true } = {}) {
  const listeners = { message: null, installed: null, startup: null, matched: null, tabUpdated: null, tabRemoved: null };
  const dnrState = { enabled: new Set(['ads']), dynamic: [], calls: [] };

  const dnr = {
    async updateEnabledRulesets({ enableRulesetIds = [], disableRulesetIds = [] }) {
      dnrState.calls.push({ enableRulesetIds, disableRulesetIds });
      enableRulesetIds.forEach((id) => dnrState.enabled.add(id));
      disableRulesetIds.forEach((id) => dnrState.enabled.delete(id));
    },
    async getEnabledRulesets() { return [...dnrState.enabled]; },
    async getDynamicRules() { return structuredClone(dnrState.dynamic); },
    async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
      const remaining = dnrState.dynamic.filter((r) => !removeRuleIds.includes(r.id));
      const ids = new Set(remaining.map((r) => r.id));
      for (const rule of addRules) {
        if (ids.has(rule.id)) throw new Error(`Duplicate rule id ${rule.id}`);
        ids.add(rule.id);
      }
      dnrState.dynamic = [...remaining, ...structuredClone(addRules)];
    },
    async setExtensionActionOptions() {}
  };
  if (withDebugEvent) dnr.onRuleMatchedDebug = { addListener: (fn) => { listeners.matched = fn; } };

  const local = makeArea();
  const session = makeArea();
  const chromeMock = {
    runtime: {
      id: 'test-extension-id',
      onMessage: { addListener: (fn) => { listeners.message = fn; } },
      onInstalled: { addListener: (fn) => { listeners.installed = fn; } },
      onStartup: { addListener: (fn) => { listeners.startup = fn; } }
    },
    storage: { local, session },
    tabs: {
      onUpdated: { addListener: (fn) => { listeners.tabUpdated = fn; } },
      onRemoved: { addListener: (fn) => { listeners.tabRemoved = fn; } }
    },
    declarativeNetRequest: dnr
  };

  const sandbox = {
    chrome: chromeMock,
    console,
    setTimeout,
    clearTimeout,
    structuredClone,
    URL
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.importScripts = (name) => {
    vm.runInContext(fs.readFileSync(path.join(SRC, name), 'utf8'), context, { filename: name });
  };
  const context = vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(SRC, 'background.js'), 'utf8'), context, { filename: 'background.js' });

  // Simulates chrome.runtime.sendMessage as seen by the worker.
  function send(message, sender = { id: chromeMock.runtime.id }) {
    return new Promise((resolve) => {
      const keepOpen = listeners.message(message, sender, resolve);
      if (keepOpen !== true) resolve(undefined);
    });
  }

  async function install() {
    listeners.installed({ reason: 'install' });
    await send({ type: 'getState' }); // queued behind the install work
  }

  return { chrome: chromeMock, dnrState, listeners, send, install, local, session };
}

const matchEvent = (tabId, rulesetId = 'ads') => ({
  rule: { ruleId: 1, rulesetId },
  request: { tabId, frameId: 0, type: 'script', url: 'https://ad.doubleclick.net/x.js', method: 'GET', requestId: String(Math.random()) }
});

test('install sets defaults and enables the ruleset', async () => {
  const w = createWorker();
  await w.install();
  assert.equal(w.local.store.enabled, true);
  assert.deepEqual(w.local.store.allowlist, []);
  assert.ok(w.local.store.stats);
  assert.deepEqual([...w.dnrState.enabled], ['ads']);
  assert.deepEqual(w.dnrState.dynamic, []);
});

test('global toggle disables and re-enables the network ruleset and persists', async () => {
  const w = createWorker();
  await w.install();

  assert.equal((await w.send({ type: 'setEnabled', value: false })).ok, true);
  assert.equal(w.local.store.enabled, false);
  assert.equal(w.dnrState.enabled.has('ads'), false);
  assert.equal((await w.send({ type: 'getState' })).networkRulesActive, false);

  assert.equal((await w.send({ type: 'setEnabled', value: true })).ok, true);
  assert.equal(w.local.store.enabled, true);
  assert.equal(w.dnrState.enabled.has('ads'), true);
  assert.equal((await w.send({ type: 'getState' })).networkRulesActive, true);
});

test('startup re-applies persisted "off" state to the browser rules', async () => {
  const w = createWorker();
  await w.install();
  await w.local.set({ enabled: false });
  w.dnrState.enabled.add('ads'); // browser reverted to the manifest default
  w.listeners.startup();
  await w.send({ type: 'getState' });
  assert.equal(w.dnrState.enabled.has('ads'), false);
});

test('allowlist creates allowAllRequests dynamic rules above block priority', async () => {
  const w = createWorker();
  await w.install();

  await w.send({ type: 'setSiteAllowed', host: 'WWW.Example.com', allowed: true });
  await w.send({ type: 'setSiteAllowed', host: 'news.other.org', allowed: true });
  assert.deepEqual(w.local.store.allowlist, ['example.com', 'news.other.org']);
  assert.equal(w.dnrState.dynamic.length, 2);
  for (const rule of w.dnrState.dynamic) {
    assert.equal(rule.action.type, 'allowAllRequests');
    assert.deepEqual(rule.condition.resourceTypes, ['main_frame']);
    assert.ok(rule.priority > 1, 'must outrank static block rules (priority 1)');
  }
  assert.deepEqual(w.dnrState.dynamic.map((r) => r.condition.requestDomains[0]).sort(), ['example.com', 'news.other.org']);

  const state = await w.send({ type: 'getState', host: 'sub.example.com' });
  assert.equal(state.siteAllowed, true);
  assert.equal((await w.send({ type: 'getState', host: 'notexample.com' })).siteAllowed, false);

  await w.send({ type: 'setSiteAllowed', host: 'example.com', allowed: false });
  assert.deepEqual(w.local.store.allowlist, ['news.other.org']);
  assert.equal(w.dnrState.dynamic.length, 1);
  assert.equal(w.dnrState.dynamic[0].condition.requestDomains[0], 'news.other.org');
});

test('adding the same site twice does not duplicate rules', async () => {
  const w = createWorker();
  await w.install();
  await w.send({ type: 'setSiteAllowed', host: 'example.com', allowed: true });
  await w.send({ type: 'setSiteAllowed', host: 'www.example.com', allowed: true });
  assert.equal(w.dnrState.dynamic.length, 1);
  assert.deepEqual(w.local.store.allowlist, ['example.com']);
});

test('invalid hostnames are rejected without changing state', async () => {
  const w = createWorker();
  await w.install();
  const reply = await w.send({ type: 'setSiteAllowed', host: 'bad host/with path', allowed: true });
  assert.ok(reply.error);
  assert.deepEqual(w.local.store.allowlist, []);
  assert.equal(w.dnrState.dynamic.length, 0);
});

test('blocked-request counting: totals, per-tab, ignores non-ads rulesets', async () => {
  const w = createWorker();
  await w.install();

  w.listeners.matched(matchEvent(5));
  w.listeners.matched(matchEvent(5));
  w.listeners.matched(matchEvent(9));
  w.listeners.matched(matchEvent(5, '_dynamic')); // allowlist rule match: not a block
  w.listeners.matched(matchEvent(-1)); // not tied to a tab: total only

  const state = await w.send({ type: 'getState', tabId: 5, host: 'example.com' });
  assert.equal(state.statsSupported, true);
  assert.equal(state.blocked, 4);
  assert.equal(state.pageBlocked, 2);
  assert.equal((await w.send({ type: 'getState', tabId: 9 })).pageBlocked, 1);

  // Persisted in storage.local so it survives a worker restart.
  assert.equal(w.local.store.stats.blocked, 4);
});

test('a new page load resets only that tab\'s page counter', async () => {
  const w = createWorker();
  await w.install();
  w.listeners.matched(matchEvent(5));
  w.listeners.matched(matchEvent(9));
  await w.send({ type: 'getState', tabId: 5 });

  w.listeners.tabUpdated(5, { status: 'loading' });
  const s5 = await w.send({ type: 'getState', tabId: 5 });
  assert.equal(s5.pageBlocked, 0);
  assert.equal(s5.blocked, 2, 'lifetime total is untouched');
  assert.equal((await w.send({ type: 'getState', tabId: 9 })).pageBlocked, 1);

  w.listeners.tabRemoved(9);
  assert.equal((await w.send({ type: 'getState', tabId: 9 })).pageBlocked, 0);
});

test('hidden-element reports are validated and counted', async () => {
  const w = createWorker();
  await w.install();
  const fromContent = { id: w.chrome.runtime.id, tab: { id: 5 } };

  await w.send({ type: 'hidden', delta: 3 }, fromContent);
  await w.send({ type: 'hidden', delta: 2 }, fromContent);
  await w.send({ type: 'hidden', delta: -4 }, fromContent);
  await w.send({ type: 'hidden', delta: 1.5 }, fromContent);
  await w.send({ type: 'hidden', delta: '7' }, fromContent);
  await w.send({ type: 'hidden', delta: 1e9 }, fromContent);
  await w.send({ type: 'hidden', delta: 100 }, { id: 'some-other-extension' });

  assert.equal((await w.send({ type: 'getState' })).hidden, 5);
});

test('messages from other extensions are ignored', async () => {
  const w = createWorker();
  await w.install();
  const reply = await w.send({ type: 'setEnabled', value: false }, { id: 'evil-extension' });
  assert.equal(reply, undefined);
  assert.equal(w.local.store.enabled, true);
  assert.equal(w.dnrState.enabled.has('ads'), true);
});

test('reset statistics zeroes totals and per-tab counts', async () => {
  const w = createWorker();
  await w.install();
  w.listeners.matched(matchEvent(5));
  await w.send({ type: 'hidden', delta: 4 }, { id: w.chrome.runtime.id });
  assert.equal((await w.send({ type: 'getState', tabId: 5 })).blocked, 1);

  assert.equal((await w.send({ type: 'resetStats' })).ok, true);
  const state = await w.send({ type: 'getState', tabId: 5 });
  assert.equal(state.blocked, 0);
  assert.equal(state.hidden, 0);
  assert.equal(state.pageBlocked, 0);
});

test('without onRuleMatchedDebug (packed install) counting is reported unsupported, never faked', async () => {
  const w = createWorker({ withDebugEvent: false });
  await w.install();
  assert.equal(w.listeners.matched, null);
  const state = await w.send({ type: 'getState', tabId: 1 });
  assert.equal(state.statsSupported, false);
  assert.equal(state.blocked, 0);
});

test('unknown message types are ignored', async () => {
  const w = createWorker();
  await w.install();
  assert.equal(await w.send({ type: 'nope' }), undefined);
  assert.equal(await w.send(null), undefined);
});
