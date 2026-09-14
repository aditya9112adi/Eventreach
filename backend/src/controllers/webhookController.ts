import { Request, Response } from 'express';
import crypto from 'crypto';
import { MessageLog } from '../models/MessageLog';
import { getIO } from '../services/socketService';

/**
 * WhatsApp Cloud API webhook.
 *
 * This is the only way EventReach ever learns what actually happened to a
 * message. The send call tells us Meta accepted it; delivery, read receipts
 * and asynchronous failures arrive here, minutes or hours later, keyed by the
 * `wamid` stored on the MessageLog at send time.
 *
 * Logging discipline: message bodies, tokens and the app secret are never
 * logged. Phone numbers are not logged either — only counts and wamids, which
 * are opaque handles.
 */

/** Status milestones, ranked so a late or out-of-order callback cannot regress a row. */
const RANK: Record<string, number> = { Pending: 0, Sent: 1, Delivered: 2, Failed: 3 };

/**
 * Meta does not guarantee callback ordering, and retries on any non-200, so a
 * callback can arrive late, out of order, or twice.
 *
 * A 'sent' arriving after 'delivered' must not walk the row backwards. A
 * 'failed' may still overtake 'Sent' — that is the real and important case,
 * where Meta accepted a message and only later reported it undeliverable
 * (error 131047 and friends). But it must NOT overturn a confirmed delivery:
 * once WhatsApp has said the message reached the device, it cannot
 * subsequently have failed, so a late or replayed 'failed' there is spurious
 * and would misreport a message the recipient demonstrably received — or had
 * already opened, since a read message is stored as Delivered plus readAt.
 */
const shouldApply = (current: string, next: string): boolean => {
  if (next === 'Failed') return current !== 'Delivered';
  if (current === 'Failed') return false;
  return (RANK[next] ?? 0) > (RANK[current] ?? 0);
};

/**
 * GET /api/webhooks/whatsapp
 *
 * Meta's subscription handshake: it calls this once when the webhook is
 * configured and expects the raw challenge echoed back as plain text, but
 * only if our verify token matches the one configured in the Meta dashboard.
 */
export const verifyWhatsAppWebhook = (req: Request, res: Response) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  const expected = process.env.WHATSAPP_VERIFY_TOKEN?.trim();
  if (!expected) {
    console.error('WhatsApp webhook: WHATSAPP_VERIFY_TOKEN is not set; refusing verification.');
    return res.sendStatus(500);
  }

  if (mode === 'subscribe' && typeof token === 'string' && timingSafeEqualStr(token, expected)) {
    console.log('WhatsApp webhook: verification succeeded.');
    // Must be the bare challenge, not JSON.
    return res.status(200).send(String(challenge ?? ''));
  }

  console.warn('WhatsApp webhook: verification rejected (token mismatch or bad mode).');
  return res.sendStatus(403);
};

/** Constant-time compare that does not leak length via early return. */
const timingSafeEqualStr = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

/** Outcome of authenticating an incoming callback. */
type SignatureCheck = 'ok' | 'invalid' | 'not-configured';

/**
 * Confirms the payload really came from Meta, using the app secret.
 *
 * Requires the raw body, which is why this route is mounted with
 * express.raw() ahead of the global express.json() (see server.ts).
 *
 * Fails CLOSED in production: with no WHATSAPP_APP_SECRET there is no way to
 * tell Meta's callbacks from anyone else's, and this endpoint writes to
 * MessageLog, so an unauthenticated version of it is an open write surface.
 * Outside production it stays usable without the secret, so local testing
 * against a tunnelled webhook does not require one.
 *
 * Never logs or returns the secret, the signature, or the expected digest.
 */
const checkSignature = (req: Request): SignatureCheck => {
  const secret = process.env.WHATSAPP_APP_SECRET?.trim();
  if (!secret) {
    if (isProduction()) return 'not-configured';
    console.warn('WhatsApp webhook: WHATSAPP_APP_SECRET is not set — signature NOT verified (non-production only).');
    return 'ok';
  }

  const header = req.get('x-hub-signature-256');
  if (!header || !header.startsWith('sha256=')) return 'invalid';

  const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from(JSON.stringify(req.body ?? {}));
  const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(raw).digest('hex');
  return timingSafeEqualStr(header, expected) ? 'ok' : 'invalid';
};

/**
 * POST /api/webhooks/whatsapp
 *
 * Applies delivery/read/failure updates. Always answers 200 once the payload
 * is accepted — Meta retries anything else, and a retry storm caused by our
 * own database hiccup would be worse than a missed status.
 */
export const receiveWhatsAppWebhook = async (req: Request, res: Response) => {
  const signature = checkSignature(req);

  if (signature === 'not-configured') {
    // Configuration fault, not a caller fault — 503 says "this endpoint is
    // not ready", which is accurate and prompts Meta to retry later, once
    // the secret has been set.
    console.error(
      'WhatsApp webhook: WHATSAPP_APP_SECRET is not set — refusing callbacks in production. ' +
      'Set it (Meta App settings > Basic > App secret) to enable delivery status updates.'
    );
    return res.sendStatus(503);
  }

  if (signature === 'invalid') {
    console.warn('WhatsApp webhook: rejected a payload with an invalid signature.');
    return res.sendStatus(403);
  }

  let payload: any;
  try {
    payload = Buffer.isBuffer(req.body) ? JSON.parse(req.body.toString('utf8')) : req.body;
  } catch {
    console.warn('WhatsApp webhook: payload was not valid JSON.');
    return res.sendStatus(400);
  }

  // Acknowledge immediately; process after. Meta's timeout is short and it
  // retries aggressively, and nothing it does depends on our result.
  res.sendStatus(200);

  try {
    await applyStatusUpdates(payload);
  } catch (error: any) {
    console.error('WhatsApp webhook: failed to apply status updates:', error?.message || error);
  }
};

/** Walks the (deeply nested) Meta envelope and applies every status it carries. */
const applyStatusUpdates = async (payload: any): Promise<number> => {
  const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];
  let applied = 0;

  for (const entry of entries) {
    const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const statuses: any[] = Array.isArray(change?.value?.statuses) ? change.value.statuses : [];
      for (const status of statuses) {
        if (await applyOneStatus(status)) applied++;
      }
    }
  }

  if (applied > 0) console.log(`WhatsApp webhook: applied ${applied} status update(s).`);
  return applied;
};

const applyOneStatus = async (status: any): Promise<boolean> => {
  const wamid: string | undefined = status?.id;
  const metaStatus: string | undefined = status?.status;
  if (!wamid || !metaStatus) return false;

  const log = await MessageLog.findOne({ wamid });
  if (!log) {
    // Normal for messages this instance did not send (e.g. a reply, or a
    // send from another environment sharing the same number).
    return false;
  }

  // Meta sends seconds since epoch, as a string.
  const at = status.timestamp ? new Date(Number(status.timestamp) * 1000) : new Date();
  const when = Number.isNaN(at.getTime()) ? new Date() : at;

  const update: Record<string, any> = {};
  let nextStatus: string | null = null;

  switch (metaStatus) {
    case 'sent':
      nextStatus = 'Sent';
      if (!log.sentAt) update.sentAt = when;
      break;
    case 'delivered':
      nextStatus = 'Delivered';
      if (!log.deliveredAt) update.deliveredAt = when;
      break;
    case 'read':
      // Read implies delivered. Recorded as a timestamp rather than its own
      // status value: see the note in models/MessageLog.ts.
      nextStatus = 'Delivered';
      if (!log.readAt) update.readAt = when;
      if (!log.deliveredAt) update.deliveredAt = when;
      break;
    case 'failed': {
      // Ignored outright once delivery is confirmed — not merely blocked from
      // changing the status. Writing failedAt/errorCode onto a row that still
      // reports as Delivered would leave the report self-contradictory: a
      // failure timestamp and reason sitting beside a delivered message the
      // recipient may already have read.
      if (log.deliveredAt || log.status === 'Delivered') return false;
      nextStatus = 'Failed';
      if (!log.failedAt) update.failedAt = when;
      // First write wins, matching the timestamp guards above: a retried
      // 'failed' carries the same error, and rewriting it would make an
      // identical duplicate callback look like a fresh change.
      const err = Array.isArray(status.errors) ? status.errors[0] : undefined;
      if (err) {
        if (typeof err.code === 'number' && log.errorCode === undefined) update.errorCode = err.code;
        if (!log.errorReason) {
          update.errorReason = err.title || err.message || err.details || 'WhatsApp reported a delivery failure';
        }
      }
      break;
    }
    default:
      return false;
  }

  // Skipping a same-value write is what keeps a repeated callback a true
  // no-op rather than a write that only looks like a change via updatedAt.
  if (nextStatus && nextStatus !== log.status && shouldApply(log.status, nextStatus)) {
    update.status = nextStatus;
  }
  if (Object.keys(update).length === 0) return false;

  await MessageLog.updateOne({ _id: log._id }, { $set: update });

  // Drives the live-updating report, same events the send path already emits.
  try {
    getIO().emit('message-log-updated', {
      logId: String(log._id),
      status: update.status ?? log.status,
      campaignId: String(log.campaignId),
    });
    getIO().emit('dashboard-updated');
  } catch {
    // Socket.IO not initialised (tests) — status is still persisted.
  }

  return true;
};

/** Exported for tests: applies a raw Meta payload without the HTTP layer. */
export const __applyStatusUpdatesForTest = applyStatusUpdates;
