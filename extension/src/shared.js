/*
 * Shared, dependency-free helpers.
 *
 * Loaded as a classic script in three places (service worker via importScripts,
 * content script via the manifest, popup via <script>) and via require() in the
 * Node tests. It publishes its API on globalThis.Plainview, or on module.exports
 * when running under Node.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = api;
  } else {
    root.Plainview = api;
  }
})(globalThis, function () {
  'use strict';

  /** Id of the static ruleset declared in manifest.json. */
  const RULESET_ID = 'ads';

  /** Priority of dynamic allowlist rules; static block rules use priority 1. */
  const ALLOW_RULE_PRIORITY = 2;

  const MAX_ALLOWLIST_ENTRIES = 500;

  const DEFAULT_SETTINGS = Object.freeze({ enabled: true, allowlist: [] });

  /**
   * Conservative cosmetic selectors. Each entry is ONE selector. They target
   * well-known ad-slot markup and ad-network iframes and deliberately avoid
   * broad substring matches such as [class*="ad"] that would hide real content.
   */
  const COSMETIC_SELECTORS = Object.freeze([
    // Google AdSense / Ad Manager
    'ins.adsbygoogle',
    '.adsbygoogle',
    'iframe[id^="google_ads_iframe"]',
    'div[id^="google_ads_iframe"]',
    'div[id^="div-gpt-ad"]',
    '[data-google-query-id]',
    '[data-ad-slot]',
    '[data-ad-client]',
    // Ad-network iframes
    'iframe[src*="doubleclick.net/"]',
    'iframe[src*="googlesyndication.com/"]',
    'iframe[src*="amazon-adsystem.com/"]',
    'iframe[src*="adnxs.com/"]',
    // Ad click-through links that wrap ad creatives
    'a[href^="https://www.googleadservices.com/pagead/aclk"]',
    'a[href^="https://ad.doubleclick.net/"]',
    // Common explicit ad container class/id names
    '.ad-banner',
    '.ad-container',
    '.ad-slot',
    '.ad-unit',
    '.ad-wrapper',
    '.advert',
    '.advertisement',
    '.advertising-container',
    '.sponsored-ad',
    '#ad-banner',
    '#ad-container',
    '#advertisement',
    '[id^="ad-slot-"]',
    '[aria-label="Advertisement"]',
    '[aria-label="advertisement"]',
    '[data-testid="ad-slot"]',
    // Recommended-content ad widgets
    '[id^="taboola-"]',
    '.taboola-widget',
    '[id^="outbrain_widget"]',
    '.OUTBRAIN',
    '.ob-widget'
  ]);

  const HOSTNAME_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

  /**
   * Normalises a hostname for allowlist use: lower-case, no trailing dot,
   * no leading "www.". Returns '' for anything that is not a plain hostname.
   */
  function normalizeHost(input) {
    if (typeof input !== 'string') return '';
    let host = input.trim().toLowerCase();
    if (host.endsWith('.')) host = host.slice(0, -1);
    if (host.startsWith('www.')) host = host.slice(4);
    if (!host || host.length > 253 || !HOSTNAME_RE.test(host)) return '';
    return host;
  }

  /** Returns the normalised hostname of an http(s) URL, or null otherwise. */
  function hostFromUrl(url) {
    if (typeof url !== 'string') return null;
    let parsed;
    try {
      parsed = new URL(url);
    } catch (_) {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    return normalizeHost(parsed.hostname) || null;
  }

  /**
   * True if host equals an allowlist entry or is a subdomain of one. This is
   * the same matching rule declarativeNetRequest uses for requestDomains.
   */
  function isHostAllowed(host, allowlist) {
    const h = normalizeHost(host);
    if (!h || !Array.isArray(allowlist)) return false;
    return allowlist.some((entry) => h === entry || h.endsWith('.' + entry));
  }

  function emptyStats() {
    return { blocked: 0, hidden: 0, since: Date.now() };
  }

  function normalizeStats(raw) {
    const base = emptyStats();
    if (!raw || typeof raw !== 'object') return base;
    const num = (v) => (Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0);
    return {
      blocked: num(raw.blocked),
      hidden: num(raw.hidden),
      since: Number.isFinite(raw.since) ? raw.since : base.since
    };
  }

  return Object.freeze({
    RULESET_ID,
    ALLOW_RULE_PRIORITY,
    MAX_ALLOWLIST_ENTRIES,
    DEFAULT_SETTINGS,
    COSMETIC_SELECTORS,
    normalizeHost,
    hostFromUrl,
    isHostAllowed,
    emptyStats,
    normalizeStats
  });
});
