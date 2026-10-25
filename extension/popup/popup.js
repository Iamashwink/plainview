/*
 * Popup controller. The service worker owns all state; the popup only reads it
 * and asks for changes via runtime messages.
 */
(() => {
  'use strict';

  const { hostFromUrl } = globalThis.Plainview;
  const $ = (id) => document.getElementById(id);
  const fmt = (n) => Number(n).toLocaleString();

  let tab = null;
  let siteKey = null; // normalised hostname, or null when not an http(s) page
  let siteDisplay = null; // hostname as shown in the address bar
  let state = null;
  let pageHidden = null; // from the content script; null when unavailable

  async function send(message) {
    const response = await chrome.runtime.sendMessage(message);
    if (!response || response.error) throw new Error((response && response.error) || 'No response');
    return response;
  }

  function showError(err) {
    const el = $('error');
    el.textContent = err ? `Something went wrong: ${err.message || err}` : '';
    el.hidden = !err;
  }

  async function findActiveTab() {
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    tab = active || null;
    siteKey = tab && tab.url ? hostFromUrl(tab.url) : null;
    try {
      siteDisplay = siteKey ? new URL(tab.url).hostname : null;
    } catch (_) {
      siteDisplay = null;
    }
  }

  async function fetchPageHidden() {
    pageHidden = null;
    if (!tab || tab.id === undefined || !siteKey) return;
    try {
      const reply = await chrome.tabs.sendMessage(tab.id, { type: 'getPageStats' });
      if (reply && Number.isInteger(reply.hidden)) pageHidden = reply.hidden;
    } catch (_) {
      // No content script on this tab (e.g. opened before install): stays null.
    }
  }

  async function refresh() {
    await fetchPageHidden();
    state = await send({
      type: 'getState',
      tabId: tab ? tab.id : undefined,
      host: siteKey || ''
    });
    render();
  }

  function render() {
    const on = state.enabled;
    $('globalToggle').disabled = false;
    $('globalToggle').checked = on;
    $('status').textContent = on ? 'Protection is on' : 'Protection is off';

    $('hostname').textContent = siteDisplay || 'Not available on this page';
    const siteToggle = $('siteToggle');
    siteToggle.checked = Boolean(siteKey) && state.siteAllowed;
    siteToggle.disabled = !siteKey || !on;
    const siteNote = $('siteNote');
    if (!siteKey) {
      siteNote.textContent = 'Only regular http(s) pages can be filtered.';
      siteNote.hidden = false;
    } else if (!on) {
      siteNote.textContent = 'Protection is off everywhere, so this site is not filtered.';
      siteNote.hidden = false;
    } else if (state.siteAllowed) {
      siteNote.textContent = `Ads are allowed on ${siteKey} and its subdomains.`;
      siteNote.hidden = false;
    } else {
      siteNote.hidden = true;
    }

    const counting = state.statsSupported;
    $('blockedTotal').textContent = counting ? fmt(state.blocked) : '—';
    $('blockedPage').textContent = counting && siteKey ? `${fmt(state.pageBlocked)} on this page` : '';
    $('hiddenTotal').textContent = fmt(state.hidden);
    $('hiddenPage').textContent = pageHidden === null ? '' : `${fmt(pageHidden)} on this page`;

    const statsNote = $('statsNote');
    if (!counting) {
      statsNote.textContent =
        'Blocked-request counting is only available when the extension is loaded unpacked. ' +
        'The toolbar badge still shows the browser’s own count per tab.';
      statsNote.hidden = false;
    } else if (on && !state.networkRulesActive) {
      statsNote.textContent = 'Network rules are not active yet. Try toggling protection.';
      statsNote.hidden = false;
    } else {
      statsNote.hidden = true;
    }

    $('since').textContent = `Since ${new Date(state.since).toLocaleDateString()}`;
    $('reloadBar').hidden = !(needsReload && siteKey);
  }

  let needsReload = false;

  async function change(action) {
    showError(null);
    try {
      await action();
      needsReload = true;
      await refresh();
    } catch (err) {
      showError(err);
      await refresh().catch(() => {});
    }
  }

  function wire() {
    $('globalToggle').addEventListener('change', (e) =>
      change(() => send({ type: 'setEnabled', value: e.target.checked }))
    );
    $('siteToggle').addEventListener('change', (e) =>
      change(() => send({ type: 'setSiteAllowed', host: siteKey, allowed: e.target.checked }))
    );
    $('resetBtn').addEventListener('click', async () => {
      showError(null);
      try {
        await send({ type: 'resetStats' });
        await refresh();
      } catch (err) {
        showError(err);
      }
    });
    $('reloadBtn').addEventListener('click', async () => {
      if (tab && tab.id !== undefined) await chrome.tabs.reload(tab.id);
      needsReload = false;
      $('reloadBar').hidden = true;
    });
  }

  async function init() {
    wire();
    try {
      await findActiveTab();
      await refresh();
    } catch (err) {
      $('status').textContent = 'Could not load';
      showError(err);
    }
    // Keep numbers live while the popup is open.
    setInterval(() => refresh().catch(() => {}), 1500);
  }

  init();
})();
