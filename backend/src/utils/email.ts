import nodemailer from 'nodemailer';

/**
 * Shared email helpers.
 *
 * All credentials come from the environment (EMAIL_USER / EMAIL_PASS) and are
 * never logged. If mail is not configured the helpers log a warning and return
 * without throwing, so a missing mail setup can never break the request that
 * triggered the notification.
 */

const escapeHtml = (unsafe: string) =>
  unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');

/** First entry of FRONTEND_URL (it may be a comma-separated CORS list). */
export const getFrontendBaseUrl = (): string =>
  process.env.FRONTEND_URL
    ? process.env.FRONTEND_URL.split(',')[0].trim().replace(/\/$/, '')
    : 'http://localhost:5173';

const getTransporter = () => {
  const { EMAIL_USER, EMAIL_PASS } = process.env;

  if (!EMAIL_USER || !EMAIL_PASS || EMAIL_PASS === 'your_app_password_here') {
    return null;
  }

  return nodemailer.createTransport({
    service: 'gmail',
    auth: { user: EMAIL_USER, pass: EMAIL_PASS },
  });
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

const send = async (mailOptions: nodemailer.SendMailOptions, context: string) => {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`EMAIL_USER or EMAIL_PASS is not configured properly. Skipping ${context}.`);
    return;
  }
  try {
    await transporter.sendMail(mailOptions);
    console.log(`Email sent: ${context}`);
  } catch (error) {
    // Never surface mail transport errors to the caller.
    console.error(`Failed to send email (${context}):`, error);
  }
};

/**
 * Notify the Super Admin that a new Admin registration is awaiting approval.
 */
export const sendApprovalEmail = async (newAdminName: string, newAdminEmail: string) => {
  const { EMAIL_USER, SUPERADMIN_EMAIL } = process.env;

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
      from: `"EventReach System" <${EMAIL_USER}>`,
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
 * Password reset link. The raw token appears only in this email — it is never
 * persisted or logged.
 */
export const sendPasswordResetEmail = async (
  name: string,
  email: string,
  resetUrl: string,
  expiresInMinutes: number
) => {
  const { EMAIL_USER } = process.env;
  const safeName = escapeHtml(name || 'there');

  await send(
    {
      from: `"EventReach" <${EMAIL_USER}>`,
      to: email,
      subject: 'Reset your EventReach password',
      html: shell(`
        <h2>Reset your password</h2>
        <p>Hi ${safeName},</p>
        <p>We received a request to reset the password for your EventReach account.</p>
        ${button(resetUrl, 'Reset Password')}
        <p style="margin-top: 20px; font-size: 13px; color: #666;">
          This link expires in <strong>${expiresInMinutes} minutes</strong> and can only be used once.
        </p>
        <p style="font-size: 13px; color: #666;">
          If the button does not work, copy and paste this link into your browser:<br />
          <span style="word-break: break-all;">${resetUrl}</span>
        </p>
        <div style="background-color: #fff4f4; border-left: 4px solid #ef4444; padding: 12px; margin-top: 20px;">
          <p style="margin: 0; font-size: 13px; color: #991b1b;">
            <strong>Didn't request this?</strong> You can safely ignore this email — your password will not change.
            If you keep receiving these, please contact your Super Admin.
          </p>
        </div>
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
  const { EMAIL_USER } = process.env;
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
      from: `"EventReach" <${EMAIL_USER}>`,
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
