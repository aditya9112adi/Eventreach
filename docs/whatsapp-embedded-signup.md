# Connecting a business's own WhatsApp number (Meta Embedded Signup)

Admins and Super Admins can connect their business's **own** WhatsApp number to
EventReach from **My WhatsApp Number** (`/whatsapp/connect`), through Meta's
official Embedded Signup popup. The number joins the existing WhatsApp sender
inventory and can then be assigned to events.

> **Update:** the "My WhatsApp Number" and "WhatsApp Senders" pages were removed from the sidebar and app. The `/api/whatsapp-onboarding` and `/api/whatsapp-senders` endpoints remain, so there is currently **no UI to enable senders or to connect a number**.

**Status: not verified against a live Meta app.** See "What is confirmed" below.
Do not enable this in production until the Meta configuration is done and the
test procedure at the end has passed with a dedicated test number.

## What is confirmed, and what is not

Meta's documentation pages could not be opened from the development machine (TLS
to Meta's domains failed certificate verification, apparently a network filter).
The details below were checked against **excerpts of Meta's official pages**
(developers.facebook.com, returned by a search tool), not the full pages.

Confirmed from those excerpts:
- **Embedded Signup v2 and v3 are deprecated on 15 October 2026**; integrations
  must use **v4**. The flow version and products come from the Facebook Login for
  Business configuration (`config_id`); Meta's v4 sample calls `FB.login` with
  `response_type: 'code'`, `override_default_response_type: true` and
  `extras: { setup: {} }` - which is what EventReach now sends.
- The popup posts `message` events from a `facebook.com` origin with
  `type: 'WA_EMBEDDED_SIGNUP'`; `FINISH` carries `data.phone_number_id` and
  `data.waba_id`; `FINISH_ONLY_WABA` (no number) and
  `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` (business app number, `waba_id` only)
  also exist; `CANCEL` reports `data.current_step`. Closing the popup on the final
  screen also counts as finishing.
- The IDs are returned only if the page's domain is in the app's **Allowed
  domains** and **Valid OAuth redirect URIs**.
- The `code` from `FB.login` lives **30 seconds** and must be exchanged
  server-to-server for a **business integration system user** token (Tech
  Providers use business tokens exclusively).
- Subscribing the app to the customer's WABA: `POST /{waba-id}/subscribed_apps`
  with the business token.
- Registration: `POST /{phone-number-id}/register` with
  `{ "messaging_product": "whatsapp", "pin": "<6 digits>" }`. If the number has
  two-step verification, the PIN must be its current PIN; otherwise the PIN given
  becomes its PIN. Registration must happen **within 14 days** of Embedded Signup.
  Errors seen: 133005 (PIN mismatch), 133006 (number must be verified first),
  133008 (too many PIN guesses; retry later), 133015 (recently deleted number).
- Meta is **deprecating the two-step verification PIN for eligible Cloud API
  numbers**, rolling out gradually.
- Meta's guide uses Graph **v26.0** as the latest version.

Not confirmed - verify before going live:
- The exact code-exchange request. EventReach calls
  `GET /oauth/access_token?client_id=<app id>&client_secret=<secret>&code=<code>`
  (the standard Graph exchange); the excerpts confirmed the step, not the request.
- Whether v4's `FINISH` still carries `business_id` (EventReach reads it if
  present and never requires it).
- How registration behaves for numbers whose PIN has been deprecated.
- `GET /{waba-id}/phone_numbers` and `GET /{phone-number-id}` field names used to
  confirm the asset and read its state (`status`, `platform_type`, ...).

All Graph calls are in `backend/src/services/metaOnboardingApi.ts` and
`backend/src/services/senderTemplateCheck.ts`; all popup/SDK details in
`frontend/src/utils/embeddedSignup.ts` and `frontend/src/services/facebookSdk.ts`.

## The flow

1. **Start.** A server-side onboarding session, bound to the account, open 30
   minutes, at most 10 an hour. Then Meta's popup.
2. **Meta's popup.** Business, WhatsApp Business Account, number, code
   verification - Meta's screens; EventReach sees none of it.
3. **Complete.** The page sends the code and the IDs at once. The server, in this
   order: claims the session (once); exchanges the code (within its 30 seconds);
   confirms the token can see exactly that WABA and number - so a client cannot
   claim another business's number; only then compares it with numbers EventReach
   already holds (so nobody can probe whose number is connected); subscribes the
   app to the WABA; reads the number's state; stores the sender with the token
   encrypted (AES-256-GCM). A cancelled, closed or failed popup creates nothing. A
   WhatsApp Business app number is reported as unsupported.
4. **Register.** A number not yet on Cloud API: the owner enters the six-digit PIN.
   Never stored or logged.
5. **Enable.** A Super Admin enables it (the rule for every new sender).
6. **Assign and send.** Its owner's events, and events of Admins a Super Admin
   allows. Template messages are checked against the number's own account first.

## Templates and connected numbers

A template belongs to one WhatsApp Business Account. EventReach's catalog
templates are approved in the configured account (`WHATSAPP_WABA_ID`), not in a
connected business's account. So before a template is sent from a connected
number, EventReach looks it up in **that number's account, with its token**, and
requires it to be there **APPROVED**, in **exactly** the language EventReach
sends, with the **same number of body values** and the **same header type** it
fills. Otherwise the whole request is refused before any upload or message
(`TEMPLATE_NOT_IN_SENDER_ACCOUNT`, `TEMPLATE_NOT_APPROVED_IN_SENDER_ACCOUNT`,
`TEMPLATE_MISMATCH_IN_SENDER_ACCOUNT`, or `TEMPLATE_CHECK_FAILED` when Meta could
not be asked). EventReach never creates or submits templates in a business's
account, and never switches to another sender to get round this. The business
creates the template in its own WhatsApp Manager with the same name, language and
shape.

Campaign (free-text) messages are not templates; Meta's usual rules for
free-form messages apply to every sender.

## Rules (decided on the server, from the database)

| | |
|---|---|
| Who can connect | Admins and Super Admins with an active account. Users cannot. |
| Who manages a number | Its owner; a Super Admin can also check status and disconnect. Only the owner registers (the PIN is the business's). |
| Who can use it for events | Events owned by its owner (Admin **or** Super Admin), and events of Admins a Super Admin allows - once enabled and connected at Meta. |
| Inventory senders | Unchanged: allowed Admins only; a Super Admin's event cannot use one (decision A). |
| Same number twice | One record per phone number id. The owner reconnects in place. Another account is refused while it is connected; after a disconnect, an account whose token Meta confirms for that number may take it over (starting unapproved). A number in the central inventory cannot be claimed. |
| Unavailable sender | Refuses to send ("Nothing was sent"); never falls back to the default sender. |
| Unassigned events | Default sender (`WHATSAPP_PHONE_ID`, `WHATSAPP_TOKEN`), unchanged. |
| Credentials | Each connected number sends with its own token, read and decrypted at send time; never on a queued job, in a response, a log or an audit entry. If the default sender is unconfigured (mock mode), a connected number is still sent for real - never faked. |

## Lifecycle - four different things

| Operation | What EventReach does |
|---|---|
| **Disconnect** (EventReach) | Implemented. Marks it disconnected, disables it, **erases its stored token**. Event assignments are kept on purpose - those events refuse to send until it is reconnected or reassigned (the response says how many). |
| **Remove** the sender record | Not offered; records are kept for the audit trail. |
| **Unsubscribe** the app from the WABA at Meta | Not done. Do it in Meta tools if needed. |
| **Deregister** the number from Cloud API | Not done; it would take the number off Cloud API for the business. |
| Token revoked at Meta | Found on "Check status" (or a failed send): the number becomes "Action required - reconnect" and is unusable until reconnected. |
| Key rotation | Changing `WHATSAPP_CREDENTIAL_KEY` makes stored tokens unreadable (detected by key fingerprint); those numbers must be reconnected. |

## Configuration

### Environment (backend only - placeholders in `backend/.env.example`)

| Variable | Secret? | Purpose |
|---|---|---|
| `META_APP_ID` | no (sent to the browser) | Meta app id for the SDK and code exchange |
| `META_EMBEDDED_SIGNUP_CONFIG_ID` | no (sent to the browser) | the **v4** Embedded Signup configuration (Facebook Login for Business) |
| `META_APP_SECRET` | **yes** | code exchange. Must be the same app as the webhooks: equal to `WHATSAPP_APP_SECRET`, or left empty to use it. A different value is reported as a configuration error. |
| `WHATSAPP_CREDENTIAL_KEY` | **yes** | 32 random bytes, base64; encrypts stored tokens |
| `WHATSAPP_APP_SECRET` | **yes** | existing; webhook signatures (connected WABAs' webhooks are signed with it too) |
| `WHATSAPP_API_VERSION` | no | existing; Graph version for all calls and the SDK (default v22.0; Meta's guide uses v26.0 as latest) |

No Vercel variable is needed. Missing variables are reported by name, at startup
and on the page.

### In Meta's developer tools (manual)

1. A **Business** app with the **WhatsApp** product - the same app whose webhooks
   EventReach already receives.
2. **Tech Provider** status, with **business verification** completed.
3. **Advanced access** through App Review for `whatsapp_business_management` and
   `whatsapp_business_messaging`.
4. **Facebook Login for Business → a v4 Embedded Signup configuration** for the
   WhatsApp Cloud API product; its id is `META_EMBEDDED_SIGNUP_CONFIG_ID`.
5. **Allowed domains** and **Valid OAuth redirect URIs**: the production frontend
   and any test domain - otherwise the popup returns no IDs.
6. **Webhooks**: the existing callback `/api/webhooks/whatsapp` (subscribed to
   `messages`) - EventReach subscribes each connected WABA during onboarding.
7. Each connected business needs payment set up on its own account, and its own
   templates (see above).

## API (all require sign-in)

`/api/whatsapp-onboarding`: `GET config`, `GET senders`, `POST sessions`,
`POST sessions/:id/complete` `{ code, wabaId, phoneNumberId, businessId? }`,
`POST sessions/:id/cancel` `{ currentStep? }`, `POST sessions/:id/error`
`{ errorId? }`, `POST senders/:id/register` `{ pin }` (owner),
`POST senders/:id/verify` (owner or Super Admin),
`POST senders/:id/disconnect` (owner or Super Admin; returns `assignedEvents`).
Changed: `GET /api/whatsapp-senders` (an Admin's own connected numbers with
`unavailableReasons`), `PUT /api/events/:id/contact` (owner rule), and
`POST /api/whatsapp/event-template` (template check for connected numbers).

## Audit

`WHATSAPP_ONBOARDING_STARTED`, `_CANCELLED`, `_ERROR`, `_FAILED`,
`WHATSAPP_SENDER_ONBOARDED`, `WHATSAPP_SENDER_REGISTERED`,
`WHATSAPP_SENDER_REGISTRATION_FAILED`, `WHATSAPP_SENDER_STATUS_CHANGED`,
`WHATSAPP_SENDER_AUTH_REVOKED`, `WHATSAPP_SENDER_DISCONNECTED`; existing
`WHATSAPP_SENDER_UPDATED` and `EVENT_CONTACT_SETTINGS_UPDATED`. No token, code,
PIN or secret is recorded; phone number ids are masked.

## Test procedure (dedicated test number, non-production backend)

1. Do the Meta setup above with a test business and a spare number.
2. Set the variables on a non-production backend; check the startup log says
   "WhatsApp onboarding: configured".
3. As an Admin: My WhatsApp Number → Connect. Complete Meta's screens.
4. Confirm the popup's events arrive (FINISH with both IDs) and the number shows
   "Waiting for registration". Enter a PIN → "Connected".
5. As a Super Admin, enable it on WhatsApp Senders.
6. In the test business's WhatsApp Manager, create and get approved a template
   with the same name, language and shape as the one you will send.
7. Assign the number to one of the Admin's events; send to your own phone only.
8. Confirm the message comes from the test number and statuses update.
9. Disconnect; confirm the event refuses to send.

## Limitations

- WhatsApp Business app numbers (coexistence) are not supported.
- Incoming messages (replies) are not processed; delivery/read statuses are, for
  every number.
- Template management for connected accounts is not part of this release.
- Disconnect is local (see the lifecycle table).
- In-process status-check cooldowns assume one backend instance, as before.
