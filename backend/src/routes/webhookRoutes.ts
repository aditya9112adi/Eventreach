import { Router } from 'express';
import { verifyWhatsAppWebhook, receiveWhatsAppWebhook } from '../controllers/webhookController';

const router = Router();

/**
 * Meta's WhatsApp Cloud API callbacks.
 *
 * Deliberately unauthenticated in the normal sense — Meta cannot present a
 * JWT. The GET is gated by the verify token and the POST by the
 * X-Hub-Signature-256 HMAC, both checked in the controller.
 *
 * Mounted in server.ts ahead of express.json() (the signature needs the raw
 * body) and ahead of the global rate limiter (a large campaign produces a
 * status callback per recipient per milestone, which would otherwise trip it
 * and cause Meta to retry).
 */
router.get('/whatsapp', verifyWhatsAppWebhook);
router.post('/whatsapp', receiveWhatsAppWebhook);

export default router;
