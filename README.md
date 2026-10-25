# Plainview Ad Blocker

A small, transparent ad blocker for **Google Chrome** and **Brave** (macOS), built on **Manifest V3**.
One codebase, no build step, no dependencies, no backend, no accounts, and no data collection.

- **Network blocking** with `declarativeNetRequest`: a short, reviewable list of ad and tracker domains.
- **Cosmetic filtering** with a content script: hides well-known ad containers, including ones inserted later.
- **Popup dashboard**: global ON/OFF, current hostname, per-site allowlist, blocked and hidden counters, reset.

## Project layout

```
extension/            <- the folder you load into the browser
  manifest.json
  rules/ads.json      static blocking rules (declarativeNetRequest)
  src/shared.js       host handling, cosmetic selector list (used everywhere)
  src/background.js   service worker: toggles rules, allowlist, statistics
  src/content.js      cosmetic filtering
  popup/              popup.html / popup.css / popup.js
  icons/
test/
  test-page.html      sample banner, dynamic ads, normal content, network check
  server.js           local server that records which requests actually arrive
  validate.js         manifest / rules / selector / source validation
  shared.test.js      unit tests
  background.test.js  service-worker tests against a mocked chrome.* API
  e2e.js              real-Chromium end-to-end test (optional, needs Playwright)
tools/make_icons.py   regenerates the icons (standard library only)
```

## Install (unpacked)

You need Chrome or Brave 110 or newer. Brave follows Chromium, so the same folder works in both.

### Google Chrome

1. Open `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension` folder (the one containing `manifest.json`).
4. Click the puzzle-piece icon in the toolbar and pin **Plainview Ad Blocker**.

### Brave

1. Open `brave://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and choose the `extension` folder.
4. Pin it from the puzzle-piece icon in the toolbar.

After editing any file, click the reload icon on the extension's card. Content scripts only apply to pages loaded after that, so reload open tabs too.

## Using it

- **Big switch (top right)**: protection on or off for every site. Off disables both the network rules and the cosmetic filter. Cosmetic hiding is removed immediately; already-loaded page content is not re-fetched, so reload the page to see ads that were blocked earlier.
- **Allow ads on this site**: allowlists the current site (and its subdomains). The `www.` prefix is ignored. It is only available on regular `http(s)` pages while protection is on.
- **Statistics**: lifetime totals plus "on this page" numbers. **Reset statistics** zeroes them.
- Changes made in the popup show a **Reload** button, because network rules only affect new requests.
- The toolbar badge shows the browser's own count of blocked requests for the current tab.

## Test it

### 1. Automated checks (no browser needed)

Requires Node 18+.

```sh
npm test
```

This runs:

- `test/validate.js`: manifest is MV3 with the minimal permission set; every referenced file exists; every rule has a valid action, resource types and lower-case domains; no rule blocks `main_frame`; none blocks a protected CDN or major site wholesale; selectors are specific; JS parses; no network calls, `eval`, remote code or MV2 APIs in the source.
- `test/shared.test.js` and `test/background.test.js`: unit tests, including the service worker running against a mocked `chrome.*` API (toggle, allowlist rules, counters, message validation).

These are not browser tests. They do not exercise real blocking.

### 2. Real-browser automated test (optional)

If you have Playwright and a Chromium build installed:

```sh
npm i -D playwright && npx playwright install chromium   # once
node test/e2e.js
```

It loads the unpacked extension in Chromium and checks real network blocking, cosmetic hiding, the popup, the allowlist, live toggling, statistics, and behaviour on a page with a strict CSP. It prints `SKIPPED` and exits with code 2 if Playwright or Chromium is missing. It runs Chromium, not Chrome or Brave on macOS, so also do the manual test below.

### 3. Manual test in Chrome or Brave

```sh
node test/server.js
```

Open **http://127.0.0.1:8765/** (use the IP address, not `localhost`). The page runs two independent tests.

**Cosmetic filtering (section 1).** Static ad banner and `ins.adsbygoogle` should be hidden. A dynamic ad appears after about a second and should be hidden; "Insert 25 ad elements" should hide all 25. The three normal-content boxes, including look-alike class names, must stay visible. The table shows `as expected` per element, and the summary should say `wrongly hidden: 0`.

**Network blocking (section 2).** The page requests `/__adblock_test__/ad-pixel.gif` (matched by a rule in the ruleset) and `/control/pixel.gif` (never blocked), then asks the server what arrived.

- Protection on: `Network blocking is working: 0 ad-path requests reached the server`. The terminal running `server.js` prints a `control` line but **no `AD` line**.
- Protection off, or site allowed: `Not blocked: 2 ad-path request(s)...` and the terminal prints two `AD` lines.

This is independent of cosmetic hiding: it counts requests at the server, so it cannot be fooled by CSS.

Try these in order: protection on, protection off (banner reappears immediately, then reload to see the requests get through), allow the site, and Reset statistics.

### 4. Verify blocking with DevTools

**Network tab.** Open DevTools (`Cmd+Option+I`), go to **Network**, tick **Disable cache**, reload the test page.

- Requests to `/__adblock_test__/ad-pixel.gif` show status `(failed)` with `net::ERR_BLOCKED_BY_CLIENT`. That error means a client-side blocker, here the extension, stopped the request before it left the browser.
- The "Real ad domains" list on the page (googlesyndication, doubleclick, google-analytics, taboola) should show the same error. A failure there alone is not proof (it could be offline), so confirm the error in DevTools.
- `/control/pixel.gif` returns `200`.
- Turn protection off in the popup, reload: the ad requests return `200`.

**Elements tab.** Select the `.ad-banner` element. Under **Computed**, `display` is `none` while protection is on and `block` when it is off.

**Service worker console.** On `chrome://extensions` (or `brave://extensions`), click **service worker** on the extension card, then run:

```js
await chrome.declarativeNetRequest.getEnabledRulesets()          // ["ads"] when protection is on
await chrome.declarativeNetRequest.getDynamicRules()             // allowlist rules
await chrome.storage.local.get(null)                             // enabled, allowlist, stats
await chrome.declarativeNetRequest.testMatchOutcome({            // unpacked installs only
  url: 'https://securepubads.g.doubleclick.net/tag/js/gpt.js',
  type: 'script',
  initiator: 'https://example.com'
})                                                               // matchedRules has an entry if blocked
```

### Brave notes

Brave Shields has its own ad blocking. For the real-domain checks, Shields may block those requests before this extension does, so the result cannot tell the two apart. The `127.0.0.1` network test is not affected, because no Shields list matches it. To test the extension alone, set Shields to **Down** for the test site (click the lion icon).

## How it works

- `rules/ads.json` has three static block rules: ad networks, trackers, and a test rule for `/__adblock_test__/`. They list `resourceTypes` explicitly and never include `main_frame`, so no website is blocked as a whole.
- The global switch enables or disables the static ruleset with `updateEnabledRulesets`. The content script listens to `chrome.storage` and removes or re-adds its stylesheet live.
- The allowlist is mirrored into dynamic `allowAllRequests` rules (priority 2, above the block rules) for the site's main frame, so everything loaded by that page is allowed.
- The content script injects one stylesheet (`display: none !important`) built from a conservative selector list. It counts matches on an initial scan plus newly added nodes, batched every 150 ms, so it never rescans the whole page on each mutation.
- All state is in `chrome.storage.local`. Per-tab "this page" counters live in `chrome.storage.session`.

## Permissions

| Permission | Why |
| --- | --- |
| `declarativeNetRequest` | Block requests and enable/disable rules. |
| `declarativeNetRequestFeedback` | Count blocked requests (`onRuleMatchedDebug`, unpacked installs only). |
| `storage` | Persist settings and statistics locally. |
| `activeTab` | Read the current tab's hostname when you open the popup. |

No host permissions. The content script is registered for all `http(s)` pages, so the browser's install prompt will mention reading site data. It only matches page elements against the selector list and sends one number to the extension's own service worker. There is no `fetch`, no analytics and no remote code, and `validate.js` checks that.

## Limitations

- **Blocked-request counting needs an unpacked install.** Chromium only provides `onRuleMatchedDebug` to unpacked extensions. In a packed or store build the popup shows "—" for blocked requests instead of inventing a number. The toolbar badge, counted by the browser, still works.
- **"This page" blocked counts reset when the tab starts loading a page.** Single-page-app route changes don't reset them.
- **Hidden-element counts are approximate.** They count elements that matched when scanned or inserted. An element that only starts matching later because a script changes its class is hidden but not counted.
- **The domain list is small and static.** There is no filter-list syntax, no automatic updates, and no scriptlets or YouTube-style in-stream ad handling. That is a deliberate scope choice and a Manifest V3 constraint (rule limits, no remote rules).
- **Cosmetic filtering covers the top frame only** (`all_frames` is off). Ads inside cross-origin iframes are mostly stopped by the network rules, and the iframe element itself is hidden in the parent page when it matches a selector.
- **A brief flash of ads is possible** on first paint, because the content script reads its settings asynchronously at `document_start`.
- **Blocking some trackers or ad widgets can break a page.** Allowlist the site if so.
- **Verification status:** the checks above were run in Node and in Chromium 141 on Linux. They have not been run in Google Chrome or Brave on macOS.

## Development

```sh
npm test            # validation + unit tests
node test/e2e.js    # optional real-browser test
npm run icons       # regenerate icons
```

To add a domain, edit `extension/rules/ads.json` and run `npm test`. To add a cosmetic selector, edit `COSMETIC_SELECTORS` in `extension/src/shared.js`; keep it specific (the validator rejects bare tags and `[class*="ad"]`-style matches).
