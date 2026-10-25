#!/usr/bin/env node
/*
 * Local test server for the Plainview test page.
 *
 *   node test/server.js            -> http://localhost:8765
 *   PORT=9000 node test/server.js
 *
 * It exists to prove network blocking independently of cosmetic hiding:
 * the page requests one "ad" URL (matched by the extension's test rule) and one
 * "control" URL. If the extension blocks the ad request, it never reaches this
 * server, so the server-side counter stays at 0 while the control counter rises.
 * Only 127.0.0.1 is bound and only the routes below are served.
 */
'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT) || 8765;
const HOST = '127.0.0.1';
const PAGE = path.join(__dirname, 'test-page.html');

// 1x1 transparent GIF.
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

const hits = { ad: 0, control: 0 };

function log(kind, url) {
  const stamp = new Date().toISOString().slice(11, 19);
  console.log(`[${stamp}] ${kind.padEnd(8)} ${url}`);
}

function send(res, status, type, body) {
  res.writeHead(status, {
    'Content-Type': type,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
  });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const { pathname } = new URL(req.url, `http://${HOST}`);

  if (pathname === '/' || pathname === '/test-page.html') {
    return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(PAGE));
  }
  if (pathname === '/csp-test') {
    // Strict CSP: no inline styles allowed. Cosmetic hiding must still work.
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Content-Security-Policy': "default-src 'none'; style-src 'none'; script-src 'none'"
    });
    return res.end('<!DOCTYPE html><title>CSP</title><div id="ad" class="ad-banner">ad</div><p id="real">real content</p>');
  }
  if (pathname.startsWith('/__adblock_test__/')) {
    hits.ad += 1;
    log('AD', `${req.url}  <-- reached the server, so it was NOT blocked`);
    return send(res, 200, 'image/gif', GIF);
  }
  if (pathname.startsWith('/control/')) {
    hits.control += 1;
    log('control', req.url);
    return send(res, 200, 'image/gif', GIF);
  }
  if (pathname === '/__hits') {
    return send(res, 200, 'application/json', JSON.stringify(hits));
  }
  if (pathname === '/__reset') {
    hits.ad = 0;
    hits.control = 0;
    return send(res, 200, 'application/json', JSON.stringify(hits));
  }
  return send(res, 404, 'text/plain; charset=utf-8', 'Not found');
});

server.listen(PORT, HOST, () => {
  console.log(`Plainview test server: http://localhost:${PORT}`);
  console.log('Lines marked AD mean an ad-path request got through. Silence there = blocked.');
});
