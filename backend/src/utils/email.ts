import nodemailer from 'nodemailer';
import { getFrontendBaseUrl } from '../config/appUrls';

export { getFrontendBaseUrl };

/**
 * Shared email helpers.
 *
 * Two delivery providers are supported:
 *
 *  - RESEND_API_KEY -> Resend's HTTPS API. The only provider usable in
 *    production: Render (and most hosts) block outbound SMTP entirely
 *    (ports 25/465/587), so an SMTP attempt there cannot succeed under any
 *    configuration — it only ever produces a confusing ENETUNREACH or
 *    connection timeout in place of a clear "not configured" message.
 *  - EMAIL_USER / EMAIL_PASS -> Gmail SMTP. A local-development-only
 *    convenience; never selected when NODE_ENV=production, regardless of
 *    whether these are set, so a stale credential left over from an earlier
 *    setup can never cause a silent, doomed SMTP attempt in production.
 *
 * Resend wins whenever it is configured, in every environment. All
 * credentials come from the environment and are never logged — not even
 * their presence is inferred from a boolean flag printed anywhere. If
 * nothing usable is configured the helpers warn and return without
 * throwing, so a missing mail setup can never break the request that
 * triggered the notification.
 */

type Provider = 'resend' | 'smtp' | 'none';

const isProduction = (): boolean => process.env.NODE_ENV === 'production';

/**
 * Reads an env var and treats a blank or whitespace-only value as unset. A
 * stray space or trailing newline pasted into a platform's env-var UI must
 * not silently count as "configured" — that is indistinguishable from a
 * healthy key until a send is attempted and fails.
 */
const cleanEnv = (name: string): string | undefined => {
  const trimmed = process.env[name]?.trim();
  return trimmed ? trimmed : undefined;
};

const resendApiKey = (): string | undefined => cleanEnv('RESEND_API_KEY');

const smtpCredentials = (): { user: string; pass: string } | null => {
  const user = cleanEnv('EMAIL_USER');
  const pass = cleanEnv('EMAIL_PASS');
  if (!user || !pass || pass === 'your_app_password_here') return null;
  return { user, pass };
};

/**
 * Decide which provider to use. Resend is checked first and wins outright
 * whenever it is configured — this function returns before SMTP is even
 * considered. SMTP is additionally unavailable in production outright: see
 * the file-level comment for why that can never be the right choice there.
 */
export const activeProvider = (): Provider => {
  if (resendApiKey()) return 'resend';
  if (isProduction()) return 'none';
  return smtpCredentials() ? 'smtp' : 'none';
};

/**
 * Sender address, chosen for whichever provider is actually sending.
 * EMAIL_USER only makes sense as a From address for an actual SMTP send (it
 * is a real, deliverable Gmail send-as address in that context) — using it
 * as the From address for a Resend send would get rejected as an unverified
 * domain if it were ever left over from an earlier SMTP setup. EMAIL_FROM
 * always wins when set, for either provider.
 */
const fromAddress = (provider: Provider): string => {
  const explicit = cleanEnv('EMAIL_FROM');
  if (explicit) return explicit;
  if (provider === 'smtp') {
    const user = cleanEnv('EMAIL_USER');
    if (user) return `EventReach <${user}>`;
  }
  return 'EventReach <onboarding@resend.dev>';
};

const escapeHtml = (unsafe: string) =>
  unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const getTransporter = () => {
  const credentials = smtpCredentials();
  if (!credentials) return null;

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: credentials.user, pass: credentials.pass },
    // Render has no outbound IPv6 route; without this the SMTP connection fails
    // with ENETUNREACH against Gmail's AAAA record.
    family: 4,
    // Bound every stage so a blocked network path fails fast instead of hanging
    // the request that triggered the send.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  } as nodemailer.TransportOptions);
};

/**
 * Report which provider will be used, and whether its credentials are known
 * to work — without sending anything, and without needing any permission
 * beyond the one the application actually uses.
 *
 * `verified` distinguishes "we proved these credentials work" from "they are
 * present and will be used": only SMTP can be proven at boot.
 *
 * Resend is deliberately NOT probed. The application only ever needs Sending
 * access, and Resend has no endpoint that validates such a key without
 * actually sending a message — every management route (GET /domains,
 * /api-keys, …) is forbidden to a restricted key and answers
 * `401 restricted_api_key`. Probing one reported a perfectly good
 * sending-only key as FAILED at boot, which is precisely the bug this
 * replaces. Requiring Full access purely to satisfy a health check would
 * also mean granting the service far more authority than it needs, so the
 * key's presence is the check here, and a genuinely bad key surfaces on the
 * first real send — which send() already logs.
 *
 * Never logs or returns the credentials themselves.
 */
export const verifyEmailTransport = async (): Promise<{
  configured: boolean;
  ok: boolean;
  verified: boolean;
  provider: Provider;
  error?: string;
}> => {
  const provider = activeProvider();

  if (provider === 'none') {
    return {
      configured: false,
      ok: false,
      verified: false,
      provider,
      error: isProduction()
        ? 'RESEND_API_KEY is not set. SMTP is never used in production, even if EMAIL_USER/EMAIL_PASS are set — set RESEND_API_KEY.'
        : 'No provider configured (set RESEND_API_KEY, or EMAIL_USER/EMAIL_PASS for local development)',
    };
  }

  if (provider === 'resend') {
    // No network call at all: see above. A Sending-access key is enough.
    return { configured: true, ok: true, verified: false, provider };
  }

  const transporter = getTransporter()!;
  let timer: NodeJS.Timeout | undefined;
  try {
    // Hard cap: transporter timeouts cover the socket, but never let an admin
    // request block on a wedged network path. The timer is cleared in the
    // finally below — left dangling it keeps the event loop alive for a full
    // 15s after the check has already resolved.
    await Promise.race([
      transporter.verify(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('SMTP verification timed out after 15s')), 15_000);
      }),
    ]);
    return { configured: true, ok: true, verified: true, provider };
  } catch (error: any) {
    return {
      configured: true,
      ok: false,
      verified: false,
      provider,
      error: String(error?.message || error).slice(0, 200),
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
};

const shell = (inner: string) => `
  <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
    ${inner}
  </div>
`;

const button = (href: string, label: string) => `
  <a href="${href}" style="display: inline-block; padding: 10px 20px; background-color: #22c55e; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; margin-top: 10px;">
    ${label}
  </a>
`;

/**
 * Deliver over Resend's HTTPS API. Throws on a non-2xx so send() can log it.
 *
 * POST /emails is the only Resend route this application ever calls — it is
 * exactly what the `resend` SDK's `resend.emails.send()` issues, so no SDK
 * dependency is needed for it. It is also the only route a Sending-access
 * key is permitted to use, which is deliberate: the service holds the
 * narrowest credential that does the job, and nothing here needs more.
 */
const sendViaResend = async (to: string, subject: string, html: string) => {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: fromAddress('resend'), to: [to], subject, html }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    // The response body can echo the request back (some APIs do this for
    // 4xx validation errors); it is truncated and this never includes the
    // Authorization header, but callers must still treat this as untrusted
    // text, not something to log verbatim at a higher verbosity than here.
    throw new Error(`Resend responded ${response.status}: ${detail.slice(0, 200)}`);
  }
};

const send = async (mailOptions: nodemailer.SendMailOptions, context: string) => {
  const provider = activeProvider();

  if (provider === 'none') {
    console.warn(
      isProduction()
        ? `RESEND_API_KEY is not set — skipping ${context}. SMTP is never used in production.`
        : `No email provider configured (set RESEND_API_KEY, or EMAIL_USER/EMAIL_PASS for local development). Skipping ${context}.`
    );
    return;
  }

  try {
    if (provider === 'resend') {
      await sendViaResend(
        String(mailOptions.to),
        String(mailOptions.subject ?? ''),
        String(mailOptions.html ?? '')
      );
    } else {
      await getTransporter()!.sendMail({ ...mailOptions, from: fromAddress('smtp') });
    }
    // Only the fixed, human-authored context label is logged (e.g. "password
    // reset link") — never the recipient, the message body, or anything
    // derived from either, so a reset link or token can never end up here.
    console.log(`Email sent via ${provider}: ${context}`);
  } catch (error: any) {
    // Never surface mail transport errors to the caller — that would leak
    // whether an account exists. The underlying error message (e.g. a
    // network failure) is logged for operators, but it originates from the
    // transport layer, never from the credentials or the message content.
    console.error(`Failed to send email via ${provider} (${context}):`, error?.message || error);
  }
};

/**
 * Notify the Super Admin that a new Admin registration is awaiting approval.
 */
export const sendApprovalEmail = async (newAdminName: string, newAdminEmail: string) => {
  const { SUPERADMIN_EMAIL } = process.env;

  const superAdminEmail = SUPERADMIN_EMAIL?.trim();
  if (!superAdminEmail) {
    console.warn('SUPERADMIN_EMAIL is not configured. Skipping Super Admin approval notification.');
    return;
  }

  const safeName = escapeHtml(newAdminName);
  const safeEmail = escapeHtml(newAdminEmail);
  const approvalLink = `${getFrontendBaseUrl()}/admin/approvals`;

  await send(
    {
      to: superAdminEmail,
      subject: 'New Admin Registration Pending Approval - EventReach',
      html: shell(`
        <h2>New Admin Registration</h2>
        <p>A new user has registered for an <strong>Admin</strong> account and is awaiting your approval.</p>
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Name:</strong> ${safeName}</p>
          <p><strong>Email:</strong> ${safeEmail}</p>
        </div>
        <p>Please log in to the dashboard to approve or reject this request.</p>
        ${button(approvalLink, 'Review Request')}
      `),
    },
    'super admin approval notification'
  );
};

/**
 * Deliver a self-service password-reset link. Owning this inbox is what
 * proves the recipient's identity — the link is single-use and expires
 * shortly (see RESET_TOKEN_TTL_MS in utils/passwordResetToken.ts); its raw
 * form is never logged or stored anywhere, only its hash.
 */
export const sendPasswordResetEmail = async (name: string, email: string, resetLink: string) => {
  const safeName = escapeHtml(name || 'there');

  await send(
    {
      to: email,
      subject: 'Reset your EventReach password',
      html: shell(`
        <h2>Reset your password</h2>
        <p>Hi ${safeName},</p>
        <p>We received a request to reset the password for your EventReach account. This link is valid for 15 minutes and can only be used once.</p>
        ${button(resetLink, 'Reset Password')}
        <p style="font-size: 13px; color: #666; margin-top: 20px;">
          If you did not request this, you can safely ignore this email — your password will not be changed.
        </p>
      `),
    },
    'password reset link'
  );
};

/**
 * Tell an applicant whether their registration was approved or rejected.
 */
export const sendRegistrationDecisionEmail = async (
  name: string,
  email: string,
  decision: 'approved' | 'rejected',
  reason?: string
) => {
  const safeName = escapeHtml(name || 'there');
  const loginUrl = `${getFrontendBaseUrl()}/login`;

  const html =
    decision === 'approved'
      ? shell(`
          <h2>Your EventReach registration is approved</h2>
          <p>Hi ${safeName},</p>
          <p>Your registration has been approved by the Super Admin. You can now sign in and start using EventReach.</p>
          ${button(loginUrl, 'Sign In')}
        `)
      : shell(`
          <h2>Your EventReach registration was not approved</h2>
          <p>Hi ${safeName},</p>
          <p>Your registration request was reviewed and could not be approved at this time.</p>
          ${
            reason
              ? `<div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
                   <p style="margin:0;"><strong>Reason:</strong> ${escapeHtml(reason)}</p>
                 </div>`
              : ''
          }
          <p style="font-size: 13px; color: #666;">If you believe this is a mistake, please contact your Super Admin.</p>
        `);

  await send(
    {
      to: email,
      subject:
        decision === 'approved'
          ? 'Your EventReach registration has been approved'
          : 'Update on your EventReach registration',
      html,
    },
    `registration ${decision} notification`
  );
};
