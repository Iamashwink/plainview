#!/usr/bin/env node
/*
 * Static validation. No dependencies, no browser.
 *
 *   node test/validate.js
 *
 * Checks the manifest, the declarativeNetRequest ruleset, the cosmetic selector
 * list, JS syntax, and a few privacy/safety constraints on the source.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const EXT = path.join(__dirname, '..', 'extension');
const read = (rel) => fs.readFileSync(path.join(EXT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const exists = (rel) => fs.existsSync(path.join(EXT, rel));

let failures = 0;
let passed = 0;
function check(name, condition, detail) {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${name}`);
  } else {
    failures += 1;
    console.log(`  FAIL ${name}${detail ? ` -> ${detail}` : ''}`);
  }
}
function section(title) {
  console.log(`\n${title}`);
}

/* ------------------------------------------------------------ manifest -- */
section('manifest.json');
const manifest = readJson('manifest.json');

check('manifest_version is 3', manifest.manifest_version === 3);
check('has name, version, description', Boolean(manifest.name && manifest.version && manifest.description));
check('version is dotted integers', /^\d+(\.\d+){0,3}$/.test(manifest.version));
check('service worker is declared', Boolean(manifest.background && manifest.background.service_worker));
check('no MV2 background.scripts / persistent', !('scripts' in (manifest.background || {})) && !('persistent' in (manifest.background || {})));
check('no browser_action / page_action', !('browser_action' in manifest) && !('page_action' in manifest));
check('no web_accessible_resources exposed', !('web_accessible_resources' in manifest));
check('no host_permissions requested', !manifest.host_permissions || manifest.host_permissions.length === 0);
check('no optional_host_permissions', !manifest.optional_host_permissions);
check('no externally_connectable', !('externally_connectable' in manifest));

const EXPECTED_PERMISSIONS = ['activeTab', 'declarativeNetRequest', 'declarativeNetRequestFeedback', 'storage'];
check(
  'permissions are exactly the minimal set',
  JSON.stringify([...(manifest.permissions || [])].sort()) === JSON.stringify(EXPECTED_PERMISSIONS),
  JSON.stringify(manifest.permissions)
);
const FORBIDDEN = ['webRequest', 'webRequestBlocking', 'tabs', 'history', 'cookies', 'scripting', 'declarativeNetRequestWithHostAccess', '<all_urls>'];
check('no broad or MV2-era permissions', !FORBIDDEN.some((p) => (manifest.permissions || []).includes(p)));

const referenced = new Set();
if (manifest.background) referenced.add(manifest.background.service_worker);
if (manifest.action) {
  referenced.add(manifest.action.default_popup);
  Object.values(manifest.action.default_icon || {}).forEach((p) => referenced.add(p));
}
Object.values(manifest.icons || {}).forEach((p) => referenced.add(p));
for (const cs of manifest.content_scripts || []) {
  (cs.js || []).forEach((p) => referenced.add(p));
  (cs.css || []).forEach((p) => referenced.add(p));
}
const resources = (manifest.declarative_net_request || {}).rule_resources || [];
resources.forEach((r) => referenced.add(r.path));
check('every file referenced by the manifest exists', [...referenced].every((p) => p && exists(p)), [...referenced].filter((p) => !exists(p)).join(', '));

const cs = (manifest.content_scripts || [])[0] || {};
check('content script runs at document_start', cs.run_at === 'document_start');
check('content script limited to http(s)', JSON.stringify(cs.matches) === JSON.stringify(['http://*/*', 'https://*/*']));
check('shared.js loads before content.js', (cs.js || []).join(',') === 'src/shared.js,src/content.js');
check('one rule resource with id "ads"', resources.length === 1 && resources[0].id === 'ads' && resources[0].enabled === true);

/* --------------------------------------------------------------- rules -- */
section('rules/ads.json');
const VALID_ACTIONS = new Set(['block', 'allow', 'allowAllRequests', 'redirect', 'upgradeScheme', 'modifyHeaders']);
const VALID_TYPES = new Set([
  'main_frame', 'sub_frame', 'stylesheet', 'script', 'image', 'font', 'object',
  'xmlhttprequest', 'ping', 'csp_report', 'media', 'websocket', 'webtransport', 'webbundle', 'other'
]);
const CONDITION_KEYS = new Set([
  'urlFilter', 'regexFilter', 'isUrlFilterCaseSensitive', 'initiatorDomains', 'excludedInitiatorDomains',
  'requestDomains', 'excludedRequestDomains', 'domains', 'excludedDomains', 'resourceTypes',
  'excludedResourceTypes', 'requestMethods', 'excludedRequestMethods', 'domainType', 'tabIds', 'excludedTabIds'
]);
// Domains whose whole registrable domain must never be blocked wholesale.
const PROTECTED = [
  'google.com', 'googleapis.com', 'gstatic.com', 'googleusercontent.com', 'youtube.com', 'ytimg.com',
  'cloudflare.com', 'cloudflare.net', 'cloudfront.net', 'akamaihd.net', 'akamaized.net', 'akamai.net',
  'fastly.net', 'jsdelivr.net', 'unpkg.com', 'cdnjs.com', 'bootstrapcdn.com', 'jquery.com',
  'github.com', 'githubusercontent.com', 'amazonaws.com', 'amazon.com', 'microsoft.com', 'azureedge.net',
  'apple.com', 'icloud.com', 'facebook.com', 'fbcdn.net', 'twitter.com', 'x.com', 'wikipedia.org',
  'wikimedia.org', 'paypal.com', 'stripe.com', 'recaptcha.net', 'bing.com', 'linkedin.com', 'pinterest.com', 'tiktok.com'
];
const DOMAIN_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

const rules = readJson('rules/ads.json');
check('ruleset is a non-empty array', Array.isArray(rules) && rules.length > 0);
const ids = rules.map((r) => r.id);
check('rule ids are unique positive integers', new Set(ids).size === ids.length && ids.every((i) => Number.isInteger(i) && i >= 1));
check('all priorities are integers >= 1', rules.every((r) => Number.isInteger(r.priority) && r.priority >= 1));
check('all actions are valid', rules.every((r) => r.action && VALID_ACTIONS.has(r.action.type)));
check('only "block" actions in the static ruleset', rules.every((r) => r.action.type === 'block'));
check('no redirect or header-modifying rules (they would need host permissions)', rules.every((r) => !['redirect', 'modifyHeaders'].includes(r.action.type)));
check('condition keys are all valid', rules.every((r) => Object.keys(r.condition || {}).every((k) => CONDITION_KEYS.has(k))));
check('every rule has a URL or domain matcher', rules.every((r) => r.condition.urlFilter || r.condition.regexFilter || (r.condition.requestDomains || []).length));
check('every rule lists resourceTypes explicitly', rules.every((r) => Array.isArray(r.condition.resourceTypes) && r.condition.resourceTypes.length > 0));
check('resourceTypes are valid', rules.every((r) => r.condition.resourceTypes.every((t) => VALID_TYPES.has(t))));
check('no rule blocks main_frame (never block whole pages)', rules.every((r) => !r.condition.resourceTypes.includes('main_frame')));
check('no excludedResourceTypes shortcut that would include main_frame', rules.every((r) => !r.condition.excludedResourceTypes));
check('no regexFilter rules (cost and risk)', rules.every((r) => !r.condition.regexFilter));

const allDomains = rules.flatMap((r) => r.condition.requestDomains || []);
check('request domains are lower-case hostnames (no scheme, path, wildcard)', allDomains.every((d) => DOMAIN_RE.test(d)), allDomains.filter((d) => !DOMAIN_RE.test(d)).join(', '));
check('no duplicate domains', new Set(allDomains).size === allDomains.length);
const tooBroad = allDomains.filter((d) => PROTECTED.some((p) => d === p || p.endsWith('.' + d)));
check('no protected CDN / major-site domain is blocked wholesale', tooBroad.length === 0, tooBroad.join(', '));
check('urlFilter rules use a specific pattern (>= 8 chars, not just a wildcard)', rules.filter((r) => r.condition.urlFilter).every((r) => r.condition.urlFilter.replace(/[*|^]/g, '').length >= 8));
check('ruleset is small and reviewable (< 200 domains, < 20 rules)', allDomains.length < 200 && rules.length < 20, `${allDomains.length} domains, ${rules.length} rules`);

/* ----------------------------------------------------------- selectors -- */
section('cosmetic selectors (shared.js)');
const shared = require(path.join(EXT, 'src', 'shared.js'));
const sels = shared.COSMETIC_SELECTORS;
check('selector list is non-empty', Array.isArray(sels) && sels.length > 0);
check('entries are non-empty strings without commas (one selector each)', sels.every((s) => typeof s === 'string' && s.trim() && !s.includes(',')));
check('no duplicates', new Set(sels).size === sels.length);
check('no bare tag / universal selectors', sels.every((s) => !/^(\*|[a-z][a-z0-9]*)$/i.test(s)));
check('no broad substring class/id matches like [class*="ad"]', sels.every((s) => !/\[(class|id)\*=/i.test(s)));
check('brackets and quotes are balanced', sels.every((s) => (s.match(/\[/g) || []).length === (s.match(/\]/g) || []).length && (s.match(/"/g) || []).length % 2 === 0));
check('no :has() (performance)', sels.every((s) => !s.includes(':has(')));

/* ------------------------------------------------------------- sources -- */
section('JavaScript sources');
const jsFiles = ['src/shared.js', 'src/background.js', 'src/content.js', 'popup/popup.js'];
for (const rel of jsFiles) {
  let ok = true;
  let detail = '';
  try {
    new vm.Script(read(rel), { filename: rel });
  } catch (err) {
    ok = false;
    detail = err.message;
  }
  check(`${rel} parses`, ok, detail);
}

const code = Object.fromEntries(jsFiles.map((rel) => [rel, read(rel)]));
const all = Object.values(code).join('\n');
check('no chrome.webRequest usage (MV2 blocking API)', !/chrome\.webRequest/.test(all));
check('no eval / new Function / remote code', !/\beval\s*\(|new\s+Function\s*\(|importScripts\(\s*['"]https?:/.test(all));
check('no network calls (fetch / XHR / beacon / WebSocket)', !/\bfetch\s*\(|XMLHttpRequest|sendBeacon|new\s+WebSocket|new\s+EventSource/.test(all));
check('no use of localStorage / cookies', !/localStorage|sessionStorage|document\.cookie/.test(all));
check('no http(s) URLs in the extension code', !/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i.test(all.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/'(?:https?:\/\/[^']*)'|"(?:https?:\/\/[^"]*)"/g, (m) => (/doubleclick|googlesyndication|amazon-adsystem|adnxs|googleadservices/.test(m) ? '' : m))));
check('background does not use deprecated MV2 APIs (browserAction, extension.getBackgroundPage)', !/browserAction|pageAction|getBackgroundPage|chrome\.extension\./.test(all));
check('popup HTML has no inline script or remote assets', (() => {
  const html = read('popup/popup.html');
  return !/<script(?![^>]*\bsrc=)/i.test(html) && !/(src|href)=["']https?:/i.test(html);
})());

console.log(`\n${passed} checks passed, ${failures} failed`);
process.exit(failures ? 1 : 0);
