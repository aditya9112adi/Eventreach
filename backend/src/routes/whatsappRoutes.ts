import { Router } from 'express';
import {
  testTemplateMessage,
  previewEventTemplate,
  sendEventTemplate,
} from '../controllers/whatsappController';
import {
  listTemplatesHandler,
  listAccountTemplatesHandler,
  reviewTemplateHandler,
  getTemplateHandler,
  createTemplateHandler,
  updateTemplateHandler,
  deleteTemplateHandler,
  submitTemplateHandler,
  reconcileTemplateHandler,
  refreshTemplateHandler,
} from '../controllers/whatsappTemplateController';
import {
  listPocSendersHandler,
  listPocTemplatesHandler,
  listPocRecipientsHandler,
  registerPocRecipientHandler,
  revokePocRecipientHandler,
  previewTestSendHandler,
  sendTestSendHandler,
  listTestSendsHandler,
  getTestSendHandler,
  reconcileTestSendHandler,
} from '../controllers/pocTestSendController';
import { requireAuth } from '../middleware/authMiddleware';
import { requireRole } from '../middleware/roleMiddleware';
import { actionLimiter } from '../middleware/rateLimitMiddleware';

const router = Router();

router.use(requireAuth);

// Sends a real WhatsApp message, so it is limited to the Super Admin and to the
// same rate limit as other send actions.
router.post('/test-template', requireRole('SuperAdmin'), actionLimiter, testTemplateMessage);

// Sending an approved template to ONE guest of an event, from the Campaign
// Composer. Not Super Admin only: it messages a guest of a specific event, so
// it carries the same per-event authorization as the rest of that flow
// (isEventAuthorized, applied inside the handler) rather than a role check.
router.get('/event-template-preview', previewEventTemplate);
router.post('/event-template', actionLimiter, sendEventTemplate);

// WhatsApp template management. No role check here on purpose: the template
// service decides - from the database, on every call - whether the account is
// a Super Admin or an Admin holding the explicit grant, and answers 403
// otherwise. Calls that reach Meta share the send-action rate limit.
router.get('/templates', listTemplatesHandler);
// Read from Meta on request. Registered before /templates/:id so "meta" is not read as an id.
router.get('/templates/meta', actionLimiter, listAccountTemplatesHandler);
router.post('/templates', createTemplateHandler);
router.get('/templates/:id', getTemplateHandler);
// The exact payload a submission would send. Sends nothing.
router.get('/templates/:id/payload', reviewTemplateHandler);
router.patch('/templates/:id', updateTemplateHandler);
router.delete('/templates/:id', deleteTemplateHandler);
router.post('/templates/:id/submit', actionLimiter, submitTemplateHandler);
router.post('/templates/:id/reconcile', actionLimiter, reconcileTemplateHandler);
// Asks Meta for a Pending template's status. Read only at Meta; also spaced
// out per template in the service.
router.post('/templates/:id/refresh', actionLimiter, refreshTemplateHandler);

// Testing an approved template from the designated POC sender. Authorization
// (a Super Admin, or a template-managing Admin on the sender's allowed list)
// is decided in the service, from the database. Every GET is a pure read; only
// POST /poc-test/send can send, and only with a reviewed, confirmed preview.
router.get('/poc-test/senders', listPocSendersHandler);
router.get('/poc-test/senders/:senderId/templates', listPocTemplatesHandler);
router.get('/poc-test/recipients', listPocRecipientsHandler);
router.post('/poc-test/recipients', actionLimiter, registerPocRecipientHandler);
router.delete('/poc-test/recipients/:id', actionLimiter, revokePocRecipientHandler);
router.post('/poc-test/preview', actionLimiter, previewTestSendHandler);
router.post('/poc-test/send', actionLimiter, sendTestSendHandler);
router.get('/poc-test/sends', listTestSendsHandler);
router.get('/poc-test/sends/:id', getTestSendHandler);
router.post('/poc-test/sends/:id/reconcile', actionLimiter, reconcileTestSendHandler);

export default router;
