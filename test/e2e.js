#!/usr/bin/env node
/*
 * End-to-end test in a real Chromium with the unpacked extension loaded.
 *
 *   node test/e2e.js
 *
 * Requires Playwright and a Chromium build (not installed by this project):
 *   npm i -D playwright && npx playwright install chromium
 * If Playwright is global, this script finds it via `npm root -g`.
 *
 * What this proves: the real manifest, ruleset, service worker, content script
 * and popup work together in Chromium. What it does NOT prove: behaviour in
 * Google Chrome or Brave on macOS (Brave Shields and Chrome-specific policies
 * are not exercised). Run the manual steps in the README for those.
 */
'use strict';

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

function loadPlaywright() {
  try {
    return require('playwright');
  } catch (_) {
    try {
      const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
      return createRequire(path.join(globalRoot, 'noop.js'))('playwright');
    } catch (err) {
      return null;
    }
  }
}

const EXT_PATH = path.resolve(__dirname, '..', 'extension');
const PORT = 8791;
const ORIGIN = `http://127.0.0.1:${PORT}`;

let failures = 0;
let passed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail !== undefined ? ` -> ${detail}` : ''}`);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn, { timeout = 8000, interval = 100 } = {}) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  return last;
}

async function main() {
  const playwright = loadPlaywright();
  if (!playwright) {
    console.log('SKIPPED: Playwright is not installed, so no browser test was run.');
    process.exit(2);
  }

  const server = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
    stdio: ['ignore', 'pipe', 'inherit']
  });
  const serverLog = [];
  server.stdout.on('data', (d) => serverLog.push(String(d)));
  await waitFor(() => serverLog.join('').includes('http://localhost'), { timeout: 5000 });

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plainview-e2e-'));
  let context;
  try {
    context = await playwright.chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`]
    });
  } catch (err) {
    console.log(`SKIPPED: could not launch Chromium with the extension (${err.message.split('\n')[0]})`);
    server.kill();
    process.exit(2);
  }

  try {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });
    const extId = new URL(worker.url()).host;
    console.log(`Chromium ${context.browser() ? context.browser().version() : ''} - extension id ${extId}`);

    const swEval = (fn, arg) => worker.evaluate(fn, arg);

    console.log('\nservice worker and rules');
    const manifest = await swEval(() => chrome.runtime.getManifest());
    check('extension loaded with manifest_version 3', manifest.manifest_version === 3);
    const enabledSets = await waitFor(async () => {
      const sets = await swEval(() => chrome.declarativeNetRequest.getEnabledRulesets());
      return sets.length ? sets : null;
    });
    check('static ruleset "ads" is enabled after install', Array.isArray(enabledSets) && enabledSets.includes('ads'), JSON.stringify(enabledSets));
    // onInstalled setup runs asynchronously after the worker starts, so poll.
    const defaults = await waitFor(async () => {
      const d = await swEval(() => chrome.storage.local.get(['enabled', 'allowlist', 'stats']));
      return d.enabled !== undefined && d.stats ? d : null;
    }, { timeout: 4000 });
    check('defaults persisted in storage.local', Boolean(defaults) && defaults.enabled === true && Array.isArray(defaults.allowlist), JSON.stringify(defaults));
    const hasDebug = await swEval(() => Boolean(chrome.declarativeNetRequest.onRuleMatchedDebug));
    check('onRuleMatchedDebug is available (unpacked install)', hasDebug);

    // DNR's own matcher, independent of any page: does the ruleset match these URLs?
    const outcome = (url, type) => swEval(
      ({ url, type }) => chrome.declarativeNetRequest.testMatchOutcome({ url, type, initiator: 'https://example.com' }),
      { url, type }
    );
    for (const [url, type, expectBlocked] of [
      ['https://securepubads.g.doubleclick.net/tag/js/gpt.js', 'script', true],
      ['https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js', 'script', true],
      ['https://www.google-analytics.com/analytics.js', 'script', true],
      ['https://cdn.taboola.com/libtrc/unip/loader.js', 'script', true],
      ['https://example.com/', 'main_frame', false],
      ['https://doubleclick.net/', 'main_frame', false],
      ['https://cdnjs.cloudflare.com/ajax/libs/jquery/3.7.1/jquery.min.js', 'script', false],
      ['https://fonts.googleapis.com/css2?family=Inter', 'stylesheet', false],
      ['https://www.google.com/', 'main_frame', false]
    ]) {
      const res = await outcome(url, type);
      const blocked = res.matchedRules.length > 0;
      check(`rule matcher: ${type} ${url} ${expectBlocked ? 'blocked' : 'allowed'}`, blocked === expectBlocked, JSON.stringify(res));
    }

    console.log('\nprotection ON: test page');
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    const failedRequests = [];
    page.on('requestfailed', (req) => failedRequests.push({ url: req.url(), error: req.failure() && req.failure().errorText }));

    const summary = async () => (await page.locator('#net-summary').textContent()) || '';
    const netDone = async () => {
      const t = await summary();
      return t && t !== 'Running...' ? t : null;
    };
    const display = (id) => page.evaluate((i) => getComputedStyle(document.getElementById(i)).display, id);

    await page.goto(`${ORIGIN}/`);
    const net1 = await waitFor(netDone, { timeout: 10000 });
    check('network test: ad requests blocked, control passed', /Network blocking is working/.test(net1 || ''), net1);
    const hits1 = await (await page.request.get(`${ORIGIN}/__hits`)).json();
    check('server saw 0 ad-path requests and 1 control request', hits1.ad === 0 && hits1.control === 1, JSON.stringify(hits1));
    check('blocked ad requests failed with ERR_BLOCKED_BY_CLIENT', failedRequests.filter((r) => r.url.includes('/__adblock_test__/') && /ERR_BLOCKED_BY_CLIENT/.test(r.error || '')).length >= 2, JSON.stringify(failedRequests.filter((r) => r.url.includes('__adblock'))));

    check('static .ad-banner is hidden', (await display('ad-static-banner')) === 'none');
    check('ins.adsbygoogle is hidden', (await display('ad-static-adsense')) === 'none');
    check('normal article is visible', (await display('normal-article')) !== 'none');
    check('look-alike .address element is visible', (await display('normal-address')) !== 'none');
    check('look-alike .loading.download-ad-free element is visible', (await display('normal-lookalike')) !== 'none');

    await page.waitForSelector('#ad-dynamic-1', { state: 'attached', timeout: 5000 });
    check('auto-inserted dynamic ad is hidden', (await display('ad-dynamic-1')) === 'none');
    await page.click('#btn-burst');
    const burstHidden = await page.evaluate(() => [...document.querySelectorAll('#dynamic-area .ad-slot')].every((el) => getComputedStyle(el).display === 'none'));
    check('burst-inserted dynamic ads are all hidden', burstHidden);
    const summaryText = await page.locator('#cosmetic-summary').textContent();
    check('page reports no false positives', /wrongly hidden: 0/.test(summaryText), summaryText);

    // Statistics must be real numbers.
    await sleep(700); // let the batched counters flush
    const stats = await swEval(() => chrome.storage.local.get('stats'));
    check('blocked count recorded (img + fetch ad requests + real ad scripts)', stats.stats.blocked >= 2, JSON.stringify(stats.stats));
    // 2 static + 1 auto + 25 burst = 28 elements.
    await waitFor(async () => (await swEval(() => chrome.storage.local.get('stats'))).stats.hidden >= 28, { timeout: 4000 });
    const stats2 = (await swEval(() => chrome.storage.local.get('stats'))).stats;
    check('hidden count equals elements actually hidden (28)', stats2.hidden === 28, JSON.stringify(stats2));
    const pageHidden = await page.evaluate(() => document.querySelectorAll('.ad-banner, .adsbygoogle, .ad-slot').length);
    check('hidden count matches DOM ad elements on the page', pageHidden === 28, String(pageHidden));

    const badges = await swEval(async () => {
      const tabs = await chrome.tabs.query({});
      return Promise.all(tabs.map((t) => chrome.action.getBadgeText({ tabId: t.id })));
    });
    check('toolbar badge shows the browser\'s own blocked count for the test tab', badges.some((b) => /^\d+$/.test(b) && Number(b) >= 2), JSON.stringify(badges));

    console.log('\nstrict page CSP');
    const cspPage = await context.newPage();
    await cspPage.goto(`${ORIGIN}/csp-test`);
    const cspHidden = await waitFor(async () => (await cspPage.evaluate(() => getComputedStyle(document.getElementById('ad')).display)) === 'none', { timeout: 3000 });
    check('ad hidden on a page with CSP style-src \'none\'', cspHidden);
    check('normal content visible on the CSP page', (await cspPage.evaluate(() => getComputedStyle(document.getElementById('real')).display)) !== 'none');
    await cspPage.close();

    console.log('\npopup UI');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
    await popup.waitForFunction(() => document.getElementById('status').textContent !== 'Loading…');
    check('popup shows protection on', (await popup.locator('#status').textContent()) === 'Protection is on');
    check('popup global toggle is checked', await popup.locator('#globalToggle').isChecked());
    const popupHidden = await popup.locator('#hiddenTotal').textContent();
    check('popup shows the real hidden total', Number(popupHidden.replace(/,/g, '')) >= 28, popupHidden);
    check('popup disables site toggle on non-http pages', await popup.locator('#siteToggle').isDisabled());

    console.log('\nprotection OFF via popup toggle');
    await popup.locator('#globalToggle').click();
    await popup.waitForFunction(() => document.getElementById('status').textContent === 'Protection is off');
    const afterOff = await swEval(() => chrome.storage.local.get('enabled'));
    check('enabled=false persisted', afterOff.enabled === false);
    check('network ruleset disabled', !(await swEval(() => chrome.declarativeNetRequest.getEnabledRulesets())).includes('ads'));
    const liveRestored = await waitFor(async () => (await display('ad-static-banner')) !== 'none', { timeout: 3000 });
    check('cosmetic hiding removed live, without reload', liveRestored);
    check('dynamic ads visible again without reload', (await display('ad-dynamic-1')) !== 'none');

    await page.reload();
    const net2 = await waitFor(netDone, { timeout: 10000 });
    check('after reload with protection off, ad requests are NOT blocked', /Not blocked: 2 ad-path/.test(net2 || ''), net2);
    check('banner stays visible with protection off', (await display('ad-static-banner')) !== 'none');

    console.log('\nprotection back ON');
    await popup.locator('#globalToggle').click();
    await popup.waitForFunction(() => document.getElementById('status').textContent === 'Protection is on');
    check('network ruleset re-enabled', (await swEval(() => chrome.declarativeNetRequest.getEnabledRulesets())).includes('ads'));
    check('cosmetic hiding restored live', await waitFor(async () => (await display('ad-static-banner')) === 'none', { timeout: 3000 }));
    await page.reload();
    const net3 = await waitFor(netDone, { timeout: 10000 });
    check('after reload with protection on, ad requests are blocked again', /Network blocking is working/.test(net3 || ''), net3);

    console.log('\nper-site allowlist');
    const allow = (host, allowed) => popup.evaluate(({ host, allowed }) => chrome.runtime.sendMessage({ type: 'setSiteAllowed', host, allowed }), { host, allowed });
    check('allowlisting 127.0.0.1 succeeds', (await allow('127.0.0.1', true)).ok === true);
    const dyn = await swEval(() => chrome.declarativeNetRequest.getDynamicRules());
    check('dynamic allowAllRequests rule created', dyn.length === 1 && dyn[0].action.type === 'allowAllRequests' && dyn[0].condition.requestDomains[0] === '127.0.0.1', JSON.stringify(dyn));
    check('cosmetic hiding removed live on allowlisted site', await waitFor(async () => (await display('ad-static-banner')) !== 'none', { timeout: 3000 }));
    await page.reload();
    const net4 = await waitFor(netDone, { timeout: 10000 });
    check('allowlisted site: ad requests are not blocked', /Not blocked: 2 ad-path/.test(net4 || ''), net4);
    check('allowlisted site: ads not hidden', (await display('ad-static-banner')) !== 'none');
    check('removing 127.0.0.1 from the allowlist succeeds', (await allow('127.0.0.1', false)).ok === true);
    check('dynamic rule removed', (await swEval(() => chrome.declarativeNetRequest.getDynamicRules())).length === 0);
    check('cosmetic hiding back live after un-allowlisting', await waitFor(async () => (await display('ad-static-banner')) === 'none', { timeout: 3000 }));
    await page.reload();
    const net5 = await waitFor(netDone, { timeout: 10000 });
    check('after un-allowlisting, ad requests are blocked again', /Network blocking is working/.test(net5 || ''), net5);

    console.log('\nreset statistics');
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById('status').textContent !== 'Loading…');
    await popup.locator('#resetBtn').click();
    await waitFor(async () => (await swEval(() => chrome.storage.local.get('stats'))).stats.blocked === 0, { timeout: 3000 });
    const reset = (await swEval(() => chrome.storage.local.get('stats'))).stats;
    check('statistics reset to zero', reset.blocked === 0 && reset.hidden === 0, JSON.stringify(reset));
    check('popup shows 0 hidden after reset', (await popup.locator('#hiddenTotal').textContent()) === '0');

    console.log('\nsettings persistence');
    await popup.locator('#globalToggle').click();
    await popup.waitForFunction(() => document.getElementById('status').textContent === 'Protection is off');
    await popup.close();
    const reopened = await context.newPage();
    await reopened.goto(`chrome-extension://${extId}/popup/popup.html`);
    await reopened.waitForFunction(() => document.getElementById('status').textContent !== 'Loading…');
    check('a freshly opened popup still shows protection off', (await reopened.locator('#status').textContent()) === 'Protection is off');
    await reopened.locator('#globalToggle').click();
    await reopened.waitForFunction(() => document.getElementById('status').textContent === 'Protection is on');

    check('no uncaught page errors on the test page', pageErrors.length === 0, pageErrors.join(' | '));
  } catch (err) {
    failures += 1;
    console.log(`  FAIL unexpected error -> ${err && err.stack ? err.stack : err}`);
  } finally {
    await context.close().catch(() => {});
    server.kill();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }

  console.log(`\n${passed} checks passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main();
