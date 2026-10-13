# WhatsApp templates and POC test sending

How templates are managed through Meta from EventReach, and how an approved
template is tested from the designated proof-of-concept (POC) sender. Nothing
here was verified against live Meta: every automated test uses a fake. The
checklist at the end is what has to be checked by hand against a real account.

## 1. Managing templates at Meta

| Step | Where | What happens at Meta |
| --- | --- | --- |
| Create / edit a draft | Templates, Create | nothing |
| Review | Template page, **Review & submit** (`GET /api/whatsapp/templates/:id/payload`) | nothing - the server builds the exact payload and shows it |
| Submit | tick "I have reviewed this payload", **Submit to WhatsApp** (`POST .../submit` with `confirmPayloadHash`) | `POST /{WABA_ID}/message_templates` |
| See the real status | **Refresh status** on a Pending template (`POST .../refresh`) | `GET /{template-id}` |
| Browse the account | Templates, **WhatsApp account (Meta)** tab, Super Admin only (`GET .../templates/meta`) | `GET /{WABA_ID}/message_templates`, cursor-paged with `after` |

- **Review is enforced by the server**, not the page: a submit without the hash
  of the reviewed payload is refused (`CONFIRMATION_REQUIRED`), and one whose
  template changed since the review is refused (`PAYLOAD_CHANGED`).
- **Buttons**: quick reply, fixed https link, phone number - Meta's documented
  fields and limits (10 in all, 2 links, 1 phone number, 25 characters of text,
  quick replies grouped together). Not supported, and refused by name: links
  with a `{{variable}}`, copy-code buttons, media headers, named placeholders.
- **Not implemented, deliberately**: deleting a template at Meta, editing a
  submitted template at Meta, importing Meta-only templates. A template that
  exists only at Meta is listed, but cannot be sent from EventReach.
- **Statuses are kept apart**: EventReach's local state (Draft, Submitting,
  Pending, Approved, ...) and Meta's own status are shown separately. A template
  is *sendable* only when both say approved (`isTemplateSendable`). An unknown
  Meta status is shown as unknown.
- **Duplicates**: the submission claim is a database-atomic state change, so a
  double click or two instances submit once. If Meta's answer is lost the
  template becomes `Unknown` and must be reconciled (a lookup by name) before it
  can be submitted again. This is at-most-once per claim, not exactly-once: a
  template created at Meta by a request whose answer was lost is only found by
  that reconciliation.
- **Errors** are mapped, never passed through raw: validation (400), permission
  (403), Meta rejection (recorded outcome), Meta credentials refused (502, never
  401 - that would sign the user out), rate limit (429), timeout or server error
  (`Unknown`), malformed answer (502), duplicate name (Meta's own message).

## 2. Testing from the POC sender

`POST /api/whatsapp/poc-test/send` is the **only** route that can send a
message. Everything else is a read, including every page load, refresh and
status check.

**Designation.** A Super Admin ticks *POC test sender* on the WhatsApp Senders
page. It is off for every number, including newly synced ones. It does not make
the number usable for events or campaigns, and event sends never use it unless
it is also assigned there under the existing rules.

**Who may use it.** A Super Admin, or an Admin with the template-management
grant who is on that sender's allowed list. Read from the database on every
request.

**What is checked** (on preview, and again on send):

1. the sender: designated, enabled, still listed by Meta, in the configured
   WhatsApp Business Account, and `CONNECTED` by a status checked with Meta in
   the last 15 minutes;
2. the template: held by EventReach, Approved locally **and** by Meta, in the
   same account as the sender, visible to the caller;
3. the recipient: registered with a recorded consent, active, the caller's own;
4. the values: exactly one per placeholder, each valid for Meta;
5. the preview hash: nothing changed since the preview.

There is **no fallback**: an unusable POC sender sends nothing - not from the
environment sender, not from another POC sender.

**Outcomes.**

| Outcome | Meaning | Retry |
| --- | --- | --- |
| Accepted | Meta returned a message id. Not delivery. | not needed |
| Failed | Meta refused. Nothing was sent. | safe, with a new preview |
| Unknown | timeout, 2xx without a message id, Meta "unexpected error" (1, 2, 131000, 131016), a crash after the claim | **not** safe: reconcile, or acknowledge the duplicate risk |
| Confirmed received / not received | a person recorded what they found | after "not received" |

Delivery (`sent`, `delivered`, `read`, `failed`) arrives on the existing
webhook and is attached to the test send; it only moves forward.

**Records.** `TemplateTestSend` is written before the request to Meta; its audit
entry is written first too, and if that cannot be saved nothing is sent. It
holds ids, the masked recipient, counts and the outcome - never message text,
variable values or a full number (a keyed fingerprint is kept for the duplicate
guard). `PocTestRecipient` holds the full number because sending needs it; the
API returns it masked. Test sends expire after 90 days (a TTL index);
recipients can be removed (kept as a revoked record).

**Multiple instances.** State is in MongoDB, so claims, outcomes and the hourly
cap (20 per user) agree across instances. The same idempotency key claims
once on any instance. Two *different* keys racing for the same message are
caught by a read-then-insert guard - this is **not a distributed lock** and can
lose a true race. The sender status refresh cooldown is in-process (existing
behaviour).

## 3. Configuration

No new environment variables. Already required:

| Variable | Used for |
| --- | --- |
| `WHATSAPP_TOKEN` | all Meta calls (server only; never returned or logged) |
| `WHATSAPP_WABA_ID` | template management; the account the POC sender and template must be in |
| `WHATSAPP_PHONE_ID` | the environment sender - **not** used by test sends |
| `WHATSAPP_API_VERSION` | Graph API version (default v22.0) |
| `WHATSAPP_APP_SECRET`, `WHATSAPP_VERIFY_TOKEN` | the delivery webhook |

The token needs `whatsapp_business_management` (templates) and
`whatsapp_business_messaging` (sending). A missing variable is reported by name,
never by value, and blocks the action before anything is claimed.

## 4. Routes

Templates (all behind `requireAuth`; permission decided in the service):
`GET /api/whatsapp/templates/meta` (Super Admin), `GET /templates/:id/payload`,
`POST /templates/:id/submit` (now requires `confirmPayloadHash`).

POC testing: `GET /poc-test/senders`, `GET /poc-test/senders/:senderId/templates`,
`GET|POST /poc-test/recipients`, `DELETE /poc-test/recipients/:id`,
`POST /poc-test/preview`, `POST /poc-test/send`, `GET /poc-test/sends`,
`GET /poc-test/sends/:id`, `POST /poc-test/sends/:id/reconcile`.
`PATCH /api/whatsapp-senders/:id` accepts `pocTestEnabled` (Super Admin).

## 5. Manual verification against a real account (not done)

1. Submit a throw-away template with each button type; confirm Meta accepts the
   payload exactly as shown in the review.
2. Load the account list and page through it; confirm field names, `after`
   cursors and the final page.
3. Refresh a Pending template through approval and rejection.
4. Designate the POC sender; confirm its phone number is in the configured WABA.
5. Send one test message to a consenting number; confirm the message id, the
   delivery webhook statuses and the audit trail.
6. Check an unusual Meta answer (a deliberately wrong template language) maps to
   *Failed*, and note which real error codes appear for timeouts.
7. Confirm the App Secret / webhook subscription delivers statuses for messages
   sent from the POC number (they arrive for the phone number's WABA).
