import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

/**
 * CRIT-3 regression guard.
 *
 * backend/src/server.ts sets `app.set('trust proxy', 2)` because Render fronts
 * services with Cloudflare, so requests traverse
 *   client -> Cloudflare edge -> Render router -> app
 * With only one hop trusted, Express resolved `req.ip` to the Cloudflare edge
 * address, which rotates between POPs and is shared by unrelated visitors — that
 * scattered a single client across many rate-limit buckets and let strangers
 * exhaust each other's login attempts.
 *
 * These tests verify the resolution in isolation (no DB / no full server boot).
 */
const TRUST_PROXY_HOPS = 2;

const ipFor = async (headers: Record<string, string>): Promise<string> => {
  const app = express();
  app.set('trust proxy', TRUST_PROXY_HOPS);
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const bodyText: string = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/ip', headers }, (res) => {
      let data = '';
      res.on('data', (chunk) => {
        data += chunk;
      });
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.end();
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return (JSON.parse(bodyText) as { ip: string }).ip;
};

describe('trust proxy resolution', () => {
  test('resolves the original client through the Cloudflare + Render hop chain', async () => {
    // Cloudflare appends the edge address after the real client.
    const ip = await ipFor({ 'X-Forwarded-For': '203.0.113.7, 198.51.100.5' });
    assert.equal(ip, '203.0.113.7');
  });

  test('still resolves the client when only one forwarded hop is present', async () => {
    const ip = await ipFor({ 'X-Forwarded-For': '203.0.113.7' });
    assert.equal(ip, '203.0.113.7');
  });

  test('does not fall back to the loopback socket address when a hop chain exists', async () => {
    const ip = await ipFor({ 'X-Forwarded-For': '203.0.113.7, 198.51.100.5' });
    assert.notEqual(ip, '127.0.0.1');
    assert.notEqual(ip, '::ffff:127.0.0.1');
  });
});
