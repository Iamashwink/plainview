(() => {
  'use strict';

  if (globalThis.__plainviewLoaded) return;
  globalThis.__plainviewLoaded = true;

  const { COSMETIC_SELECTORS, isHostAllowed } = globalThis.Plainview;

  const SCAN_DELAY_MS = 150;
  const MAX_PENDING_NODES = 400;

  function isValidSelector(selector) {
    try {
      document.createDocumentFragment().querySelector(selector);
      return true;
    } catch (_) {
      return false;
    }
  }

  const selectors = COSMETIC_SELECTORS.filter(isValidSelector);
  const selectorText = selectors.join(',');
  if (!selectorText) return;

  let settings = { enabled: true, allowlist: [] };
  let active = false;
  let sheet = null;
  let styleEl = null;
  let observer = null;
  let timer = null;
  let pending = new Set();
  let counted = new WeakSet();
  let hiddenOnPage = 0;

  const shouldBeActive = () =>
    settings.enabled !== false && !isHostAllowed(location.hostname, settings.allowlist);

  function injectStyle() {
    const css = `${selectorText}{display:none!important}`;
    try {
      sheet = new CSSStyleSheet();
      sheet.replaceSync(css);
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
      if (!document.adoptedStyleSheets.includes(sheet)) throw new Error('not adopted');
    } catch (_) {
      sheet = null;
      styleEl = document.createElement('style');
      styleEl.textContent = css;
      (document.head || document.documentElement).appendChild(styleEl);
    }
  }

  function removeStyle() {
    if (sheet) {
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
      sheet = null;
    }
    if (styleEl) {
      styleEl.remove();
      styleEl = null;
    }
  }

  function countInSubtree(element) {
    let n = 0;
    if (element.matches(selectorText) && !counted.has(element)) {
      counted.add(element);
      n += 1;
    }
    for (const match of element.querySelectorAll(selectorText)) {
      if (!counted.has(match)) {
        counted.add(match);
        n += 1;
      }
    }
    return n;
  }

  function scanDocument() {
    let n = 0;
    for (const match of document.querySelectorAll(selectorText)) {
      if (!counted.has(match)) {
        counted.add(match);
        n += 1;
      }
    }
    return n;
  }

  function report(n) {
    if (n <= 0) return;
    hiddenOnPage += n;
    try {
      if (chrome.runtime && chrome.runtime.id) {
        chrome.runtime.sendMessage({ type: 'hidden', delta: n }).catch(() => {});
      }
    } catch (_) {
    }
  }

  function flushPending() {
    timer = null;
    if (!active) return;
    let added = 0;
    if (pending.size > MAX_PENDING_NODES) {
      pending.clear();
      added = scanDocument();
    } else {
      const nodes = [...pending];
      pending.clear();
      for (const node of nodes) {
        if (node.isConnected) added += countInSubtree(node);
      }
    }
    report(added);
  }

  function schedule() {
    if (timer === null) timer = setTimeout(flushPending, SCAN_DELAY_MS);
  }

  function activate() {
    if (active) return;
    active = true;
    injectStyle();

    observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) pending.add(node);
        }
      }
      if (pending.size) schedule();
    });
    observer.observe(document, { childList: true, subtree: true });

    const initialScan = () => {
      if (active) report(scanDocument());
    };
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initialScan, { once: true });
    } else {
      initialScan();
    }
  }

  function deactivate() {
    if (!active) return;
    active = false;
    if (observer) observer.disconnect();
    observer = null;
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pending.clear();
    removeStyle();
    counted = new WeakSet();
    hiddenOnPage = 0;
  }

  function sync() {
    if (shouldBeActive()) activate();
    else deactivate();
  }

  chrome.storage.local
    .get({ enabled: true, allowlist: [] })
    .then((stored) => {
      settings = { enabled: stored.enabled !== false, allowlist: stored.allowlist || [] };
    })
    .catch(() => {})
    .then(sync);

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.enabled) settings.enabled = changes.enabled.newValue !== false;
    if (changes.allowlist) settings.allowlist = changes.allowlist.newValue || [];
    if (changes.enabled || changes.allowlist) sync();
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message && message.type === 'getPageStats') {
      sendResponse({ hidden: hiddenOnPage, active });
    }
    return false;
  });
})();
