import nodemailer from 'nodemailer';

export const sendApprovalEmail = async (newAdminName: string, newAdminEmail: string) => {
  const { EMAIL_USER, EMAIL_PASS } = process.env;

  if (!EMAIL_USER || !EMAIL_PASS || EMAIL_PASS === 'your_app_password_here') {
    console.warn('EMAIL_USER or EMAIL_PASS is not configured properly in .env. Skipping email notification.');
    return;
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: EMAIL_USER,
      pass: EMAIL_PASS,
    },
  });

  // The link to the dashboard where the Super Admin can approve the request
  const approvalLink = 'http://localhost:5173/admin/users';

  const mailOptions = {
    from: `"EventReach System" <${EMAIL_USER}>`,
    to: 'redacted@users.noreply.invalid', // Hardcoded Super Admin email per your request
    subject: 'New Admin Registration Pending Approval - EventReach',
    html: `
      <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
        <h2>New Admin Registration</h2>
        <p>A new user has registered for an <strong>Admin</strong> account and is awaiting your approval.</p>
        
        <div style="background-color: #f5f5f5; padding: 15px; border-radius: 5px; margin: 20px 0;">
          <p><strong>Name:</strong> ${newAdminName}</p>
          <p><strong>Email:</strong> ${newAdminEmail}</p>
        </div>

        <p>Please log in to the dashboard to approve or reject this request.</p>
        
        <a href="${approvalLink}" style="display: inline-block; padding: 10px 20px; background-color: #22c55e; color: white; text-decoration: none; border-radius: 5px; font-weight: bold; margin-top: 10px;">
          Review Request
        </a>
      </div>
    `,
  };

  try {
    await transporter.sendMail(mailOptions);
    console.log(`Approval email sent to Super Admin for user: ${newAdminEmail}`);
  } catch (error) {
    console.error('Failed to send approval email:', error);
  }
};
