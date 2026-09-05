import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { clientKey } from '../backend/src/middleware/rateLimitMiddleware.ts';

/**
 * Render fronts services with Cloudflare, so `req.ip` resolves to a rotating
 * Cloudflare edge address that is shared between unrelated visitors. That made
 * the 10-per-15-minute auth limiter consumable by strangers and scattered a
 * single client across many buckets.
 *
 * `CF-Connecting-IP` is written by Cloudflare and overwrites anything the caller
 * sends, so it is preferred as the rate-limit identity.
 */
const fakeReq = (headers: Record<string, string>, ip?: string) =>
  ({ headers, ip }) as any;

describe('rate limit clientKey', () => {
  test('prefers the Cloudflare-supplied CF-Connecting-IP over req.ip', () => {
    const key = clientKey(fakeReq({ 'cf-connecting-ip': '203.0.113.7' }, '198.51.100.1'));
    assert.equal(key, '203.0.113.7');
  });

  test('falls back to req.ip when CF-Connecting-IP is absent', () => {
    const key = clientKey(fakeReq({}, '198.51.100.1'));
    assert.equal(key, '198.51.100.1');
  });

  test('two different real clients behind the same edge get different keys', () => {
    const a = clientKey(fakeReq({ 'cf-connecting-ip': '203.0.113.7' }, '198.51.100.1'));
    const b = clientKey(fakeReq({ 'cf-connecting-ip': '203.0.113.8' }, '198.51.100.1'));
    assert.notEqual(a, b);
  });

  test('the same real client keeps one key even when the edge address rotates', () => {
    const a = clientKey(fakeReq({ 'cf-connecting-ip': '203.0.113.7' }, '198.51.100.1'));
    const b = clientKey(fakeReq({ 'cf-connecting-ip': '203.0.113.7' }, '198.51.100.99'));
    assert.equal(a, b);
  });

  test('does not blow up when neither header nor ip is present', () => {
    assert.equal(typeof clientKey(fakeReq({})), 'string');
  });

  test('normalises IPv6 addresses to a stable subnet key', () => {
    const a = clientKey(fakeReq({ 'cf-connecting-ip': '2001:db8:1234:5678::1' }));
    const b = clientKey(fakeReq({ 'cf-connecting-ip': '2001:db8:1234:5678::2' }));
    // ipKeyGenerator groups an IPv6 client by /64 so a single client cannot
    // trivially rotate through its own address space.
    assert.equal(a, b);
  });
});
