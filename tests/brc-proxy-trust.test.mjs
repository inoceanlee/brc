import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseTrustProxy } from '../packages/relay/dist/adapters/http/app.js';

test('trusted proxy policy never trusts every proxy implicitly', () => {
  assert.equal(parseTrustProxy(undefined), false);
  assert.equal(parseTrustProxy(''), false);
  assert.equal(parseTrustProxy('false'), false);
  assert.equal(parseTrustProxy('0'), false);
  assert.equal(parseTrustProxy('true'), 'loopback');
  assert.equal(parseTrustProxy('1'), 'loopback');
  assert.equal(parseTrustProxy('loopback'), 'loopback');
  assert.equal(parseTrustProxy('2'), 2);
  assert.equal(parseTrustProxy('127.0.0.1,10.0.0.0/8'), '127.0.0.1,10.0.0.0/8');
});

test('spoofed forwarding headers cannot change the parsed client identity', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(new URL('../packages/relay/dist/adapters/http/app.js', import.meta.url));
  const express = require('express');
  const server = express();
  server.set('trust proxy', parseTrustProxy('true'));
  server.get('/', (req, res) => res.json({ ip: req.ip }));
  const http = await import('node:http');
  const listener = http.createServer(server);
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      headers: { 'x-forwarded-for': '198.51.100.7, 203.0.113.9' },
    });
    const body = await response.json();
    assert.equal(body.ip, '203.0.113.9', 'the nearest trusted hop wins, not the client-supplied value');
  } finally {
    await new Promise((resolve) => listener.close(resolve));
  }
});
