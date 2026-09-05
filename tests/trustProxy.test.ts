import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import express from 'express';

/**
 * CRIT-3 regression guard.
 *
 * backend/src/server.ts sets `app.set('trust proxy', 1)` so that, behind
 * Render's single reverse proxy, Express resolves the real client IP from the
 * X-Forwarded-For header instead of using the proxy's socket address. That is
 * what keeps express-rate-limit bucketing per real client instead of collapsing
 * every request into one shared global bucket.
 *
 * This test verifies that behaviour in isolation (no DB / no full server boot).
 */
test('trust proxy = 1 resolves the client IP from a single X-Forwarded-For hop', async () => {
  const app = express();
  app.set('trust proxy', 1);
  app.get('/ip', (req, res) => {
    res.json({ ip: req.ip });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  const bodyText: string = await new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/ip',
        headers: { 'X-Forwarded-For': '203.0.113.7' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => resolve(data));
      }
    );
    req.on('error', reject);
    req.end();
  });

  await new Promise<void>((resolve) => server.close(() => resolve()));

  const parsed = JSON.parse(bodyText) as { ip: string };
  assert.equal(parsed.ip, '203.0.113.7');
});
