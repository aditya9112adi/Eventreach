import nodemailer from 'nodemailer';
import { getFrontendBaseUrl } from '../config/appUrls';

export { getFrontendBaseUrl };

/**
 * Shared email helpers.
 *
 * Two delivery providers are supported:
 *
 *  - RESEND_API_KEY -> Resend's HTTPS API. Required in production on Render,
 *    which blocks outbound SMTP (ports 25/465/587). Gmail SMTP from Render fails
 *    with ENETUNREACH on IPv6 and a connection timeout on IPv4.
 *  - EMAIL_USER / EMAIL_PASS -> Gmail SMTP. Convenient for local development.
 *
 * Resend wins when both are set. All credentials come from the environment and
 * are never logged. If nothing is configured the helpers warn and return without
 * throwing, so a missing mail setup can never break the request that triggered
 * the notification.
 */

type Provider = 'resend' | 'smtp' | 'none';

const activeProvider = (): Provider => {
  if (process.env.RESEND_API_KEY) return 'resend';
  const { EMAIL_USER, EMAIL_PASS } = process.env;
  if (EMAIL_USER && EMAIL_PASS && EMAIL_PASS !== 'your_app_password_here') return 'smtp';
  return 'none';
};

/** Sender address. Resend requires a verified domain, or its shared test sender. */
const fromAddress = (): string =>
  process.env.EMAIL_FROM?.trim() ||
  (process.env.EMAIL_USER ? `EventReach <${process.env.EMAIL_USER}>` : 'EventReach <onboarding@resend.dev>');

const escapeHtml = (unsafe: string) =>
  unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

const getTransporter = () => {
  const { EMAIL_USER, EMAIL_PASS } = process.env;

  if (!EMAIL_USER || !EMAIL_PASS || EMAIL_PASS === 'your_app_password_here') {
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
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
 * Check the mail credentials without sending anything.
 *
 * A dead App Password used to be invisible: `send()` swallows transport errors
 * so the API still answers "reset link sent". This surfaces the problem in the
 * server log at boot instead of when a user tries to reset their password.
 * Never logs or returns the credentials themselves.
 */
export const verifyEmailTransport = async (): Promise<{
  configured: boolean;
  ok: boolean;
  provider: Provider;
  error?: string;
}> => {
  const provider = activeProvider();

  if (provider === 'none') {
    return {
      configured: false,
      ok: false,
      provider,
      error: 'No provider configured (set RESEND_API_KEY, or EMAIL_USER/EMAIL_PASS)',
    };
  }

  if (provider === 'resend') {
    try {
      // Cheap authenticated read — validates the key without sending anything.
      const r = await fetch('https://api.resend.com/domains', {
        headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}` },
        signal: AbortSignal.timeout(10_000),
      });
      return r.ok
        ? { configured: true, ok: true, provider }
        : { configured: true, ok: false, provider, error: `Resend rejected the API key (HTTP ${r.status})` };
    } catch (error: any) {
      return { configured: true, ok: false, provider, error: String(error?.message || error).slice(0, 200) };
    }
  }

  const transporter = getTransporter()!;
  try {
    // Hard cap: transporter timeouts cover the socket, but never let an admin
    // request block on a wedged network path.
    await Promise.race([
      transporter.verify(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error('SMTP verification timed out after 15s')), 15_000)
      ),
    ]);
    return { configured: true, ok: true, provider };
  } catch (error: any) {
    return { configured: true, ok: false, provider, error: String(error?.message || error).slice(0, 200) };
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

/** Deliver over Resend's HTTPS API. Throws on a non-2xx so send() can log it. */
const sendViaResend = async (to: string, subject: string, html: string) => {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ from: fromAddress(), to: [to], subject, html }),
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Resend responded ${response.status}: ${detail.slice(0, 200)}`);
  }
};

const send = async (mailOptions: nodemailer.SendMailOptions, context: string) => {
  const provider = activeProvider();

  if (provider === 'none') {
    console.warn(`No email provider configured (set RESEND_API_KEY, or EMAIL_USER/EMAIL_PASS). Skipping ${context}.`);
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
      await getTransporter()!.sendMail({ ...mailOptions, from: fromAddress() });
    }
    console.log(`Email sent via ${provider}: ${context}`);
  } catch (error: any) {
    // Never surface mail transport errors to the caller — that would leak
    // whether an account exists.
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
