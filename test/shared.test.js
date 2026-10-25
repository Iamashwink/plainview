'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const P = require(path.join(__dirname, '..', 'extension', 'src', 'shared.js'));

test('normalizeHost lower-cases, trims, strips www and trailing dot', () => {
  assert.equal(P.normalizeHost('  WWW.Example.COM. '), 'example.com');
  assert.equal(P.normalizeHost('news.example.co.uk'), 'news.example.co.uk');
  assert.equal(P.normalizeHost('localhost'), 'localhost');
  assert.equal(P.normalizeHost('127.0.0.1'), '127.0.0.1');
});

test('normalizeHost rejects things that are not plain hostnames', () => {
  for (const bad of ['', ' ', 'exa mple.com', 'example.com/path', 'https://example.com', 'a..b', '-a.com', 'a.com:8080', '[::1]', null, undefined, 42]) {
    assert.equal(P.normalizeHost(bad), '', `should reject ${String(bad)}`);
  }
  assert.equal(P.normalizeHost('a'.repeat(254)), '');
});

test('hostFromUrl accepts only http(s) and normalises the host', () => {
  assert.equal(P.hostFromUrl('https://www.Example.com:8443/a?b#c'), 'example.com');
  assert.equal(P.hostFromUrl('http://127.0.0.1:8765/'), '127.0.0.1');
  for (const url of ['chrome://extensions', 'brave://settings', 'about:blank', 'file:///tmp/a.html', 'chrome-extension://abc/popup.html', 'not a url', '', undefined]) {
    assert.equal(P.hostFromUrl(url), null, `should reject ${url}`);
  }
});

test('isHostAllowed matches exact hosts and subdomains only', () => {
  const list = ['example.com', 'news.site.org'];
  assert.equal(P.isHostAllowed('example.com', list), true);
  assert.equal(P.isHostAllowed('www.example.com', list), true);
  assert.equal(P.isHostAllowed('a.b.example.com', list), true);
  assert.equal(P.isHostAllowed('news.site.org', list), true);
  assert.equal(P.isHostAllowed('site.org', list), false, 'parent of an entry is not allowed');
  assert.equal(P.isHostAllowed('notexample.com', list), false, 'suffix lookalike must not match');
  assert.equal(P.isHostAllowed('example.com.evil.net', list), false);
  assert.equal(P.isHostAllowed('example.com', []), false);
  assert.equal(P.isHostAllowed('example.com', undefined), false);
  assert.equal(P.isHostAllowed('', list), false);
});

test('normalizeStats repairs bad stored data', () => {
  const fresh = P.normalizeStats(undefined);
  assert.equal(fresh.blocked, 0);
  assert.equal(fresh.hidden, 0);
  assert.ok(Number.isFinite(fresh.since));
  const fixed = P.normalizeStats({ blocked: -5, hidden: 'x', since: 'y' });
  assert.equal(fixed.blocked, 0);
  assert.equal(fixed.hidden, 0);
  assert.ok(Number.isFinite(fixed.since));
  assert.deepEqual(P.normalizeStats({ blocked: 7.9, hidden: 3, since: 123 }), { blocked: 7, hidden: 3, since: 123 });
});

test('exports are frozen', () => {
  assert.ok(Object.isFrozen(P));
  assert.ok(Object.isFrozen(P.COSMETIC_SELECTORS));
});
