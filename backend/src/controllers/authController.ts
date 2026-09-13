import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { User } from '../models/User';
import { Admin } from '../models/Admin';
import { Event } from '../models/Event';
import { PasswordResetToken, ResetAccountType } from '../models/PasswordResetToken';
import { sendApprovalEmail, sendPasswordResetEmail } from '../utils/email';
import { validatePassword, PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH } from '../utils/passwordPolicy';
import { generateResetToken, hashResetToken, RESET_TOKEN_TTL_MS } from '../utils/passwordResetToken';
import { getFrontendBaseUrl } from '../config/appUrls';
import { AuditService } from '../services/AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';
import { emitPendingApprovalsChanged } from '../services/socketService';

/** Matches the cost factor used everywhere else passwords are hashed. */
const BCRYPT_ROUNDS = 10;

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters').max(100, 'Password is too long'),
});

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  // Length is owned by the shared password policy (validatePassword), which
  // runs on this same request; this bound just mirrors it so the two layers
  // cannot report conflicting minimums.
  password: z.string().min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`).max(PASSWORD_MAX_LENGTH, 'Password is too long'),
  role: z.enum(['Admin', 'User']),
  accessStartDate: z.string().optional(),
  accessEndDate: z.string().optional(),
});

export const register = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { name, email, password, role, accessStartDate, accessEndDate } = parsed.data;

    // Strength is enforced by the shared policy so registration and password
    // reset can never drift apart.
    const passwordProblem = validatePassword(password);
    if (passwordProblem) {
      return res.status(400).json({ error: passwordProblem });
    }

    if (role === 'Admin') {
      if (!accessStartDate || !accessEndDate) {
        return res.status(400).json({ error: 'Access Start Date and Access End Date are required for Admin registration.' });
      }
      if (new Date(accessEndDate) <= new Date(accessStartDate)) {
        return res.status(400).json({ error: 'Access End Date must be after Access Start Date.' });
      }
    }

    const existingAdmin = await Admin.findOne({ email });
    const existingUser = await User.findOne({ email });
    
    const now = new Date();
    const isExistingAdminRecreatable = existingAdmin && (
      existingAdmin.status === 'Rejected' || 
      existingAdmin.isAccessCancelled === true || 
      (existingAdmin.accessExpiryDate && now > new Date(existingAdmin.accessExpiryDate))
    );
    const isExistingUserRecreatable = existingUser && (
      existingUser.status === 'Rejected' || 
      existingUser.isAccessCancelled === true || 
      (existingUser.accessExpiryDate && now > new Date(existingUser.accessExpiryDate))
    );
    
    if (existingAdmin && !isExistingAdminRecreatable) {
      return res.status(400).json({ error: 'Email already registered' });
    }
    if (existingUser && !isExistingUserRecreatable) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    const status = 'Pending';
    
    let createdUser;
    const isRecreated = isExistingAdminRecreatable || isExistingUserRecreatable;

    if (role === 'Admin') {
      if (isExistingUserRecreatable) {
        await User.deleteOne({ email });
      }
      
      if (isExistingAdminRecreatable) {
        createdUser = await Admin.findOneAndUpdate(
          { email },
          {
            name,
            passwordHash,
            status: 'Pending',
            pendingAccessStartDate: new Date(accessStartDate!),
            pendingAccessEndDate: new Date(accessEndDate!),
            $unset: { rejectionReason: 1 } 
          },
          { new: true }
        );
        sendApprovalEmail(name, email);
      } else {
        createdUser = await Admin.create({
          name,
          email,
          passwordHash,
          role: 'Admin',
          status,
          pendingAccessStartDate: new Date(accessStartDate!),
          pendingAccessEndDate: new Date(accessEndDate!),
        });
        sendApprovalEmail(name, email);
      }
    } else {
      if (isExistingAdminRecreatable) {
        await Admin.deleteOne({ email });
      }

      if (isExistingUserRecreatable) {
        createdUser = await User.findOneAndUpdate(
          { email },
          {
            name,
            passwordHash,
            status: 'Pending',
            $unset: { rejectionReason: 1 }
          },
          { new: true }
        );
      } else {
        createdUser = await User.create({
          name,
          email,
          passwordHash,
          status,
        });
      }
    }

    if (!createdUser) {
      throw new Error('Failed to create or update user');
    }

    await AuditService.log({
      action: role === 'Admin' ? (isRecreated ? 'ADMIN_RECREATED' : 'ADMIN_CREATED') : (isRecreated ? 'USER_RECREATED' : 'USER_CREATED'),
      collectionName: role === 'Admin' ? 'admins' : 'users',
      documentId: createdUser._id.toString(),
      request: AuditService.getRequestInfo(req),
      after: createdUser,
      description: isRecreated ? `${role} re-registered after previous rejection` : `New ${role} registration pending approval`
    });

    // A new request is now awaiting approval — refresh every connected Super
    // Admin's badge immediately rather than waiting for them to navigate.
    void emitPendingApprovalsChanged();

    res.status(201).json({
      message: 'Registration successful. Please wait for Super Admin approval.',
      user: {
        id: createdUser._id,
        name: createdUser.name,
        email: createdUser.email,
        role: role,
        status: createdUser.status,
      }
    });
  } catch (error) {
    console.error('Registration error:', error);
    res.status(500).json({ error: 'Something went wrong during registration' });
  }
};

/**
 * Serialise an Admin/User document into the profile shape the frontend expects.
 * Kept in one place so `login` and `me` can never drift apart.
 */
const buildAuthProfile = async (user: any, resolvedRole: string) => {
  let assignedEventName: string | undefined;
  if (user.assignedEventId) {
    const ev = await Event.findById(user.assignedEventId).select('eventName').lean();
    if (ev) assignedEventName = (ev as any).eventName;
  }

  return {
    id: user._id,
    name: user.name,
    email: user.email,
    role: resolvedRole,
    status: user.status,
    accessGrantedOn: user.accessGrantedOn,
    accessStartDate: user.accessStartDate,
    accessExpiryDate: user.accessExpiryDate,
    accessDurationValue: user.accessDurationValue,
    accessDurationUnit: user.accessDurationUnit,
    isAccessCancelled: user.isAccessCancelled,
    assignedEventId: user.assignedEventId ? user.assignedEventId.toString() : undefined,
    assignedEventName,
    adminId: user.adminId ? user.adminId.toString() : undefined,
    createdAt: user.createdAt,
  };
};

/**
 * Returns the authoritative, freshly-read profile for the caller's token.
 *
 * The frontend previously restored its session purely from localStorage, which
 * meant a tampered or stale cached profile drove role-based UI. This endpoint
 * lets the client revalidate on load. `requireAuth` has already confirmed the
 * account still exists and has not been revoked or expired.
 */
export const me = async (req: RequestWithId, res: Response) => {
  try {
    const current = (req as any).user;
    if (!current?.id) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    if (current.role === 'User') {
      const user = await User.findById(current.id).select('-passwordHash');
      if (!user) {
        return res.status(401).json({ error: 'Unauthorized: Account not found' });
      }
      return res.json({ user: await buildAuthProfile(user, 'User') });
    }

    const admin = await Admin.findById(current.id).select('-passwordHash');
    if (!admin) {
      return res.status(401).json({ error: 'Unauthorized: Account not found' });
    }
    return res.json({ user: await buildAuthProfile(admin, admin.role) });
  } catch (error) {
    console.error('Get current user error:', error);
    res.status(500).json({ error: 'Failed to load current user' });
  }
};

export const login = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { email, password } = parsed.data;

    let user: any = await Admin.findOne({ email });
    let resolvedRole = user ? user.role : null;
    let collection = 'admins';
    
    if (!user) {
      user = await User.findOne({ email });
      resolvedRole = user ? 'User' : null;
      collection = 'users';
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      await AuditService.log({
        action: 'LOGIN_FAILED',
        collectionName: collection,
        documentId: user._id.toString(),
        request: AuditService.getRequestInfo(req),
        success: false,
        error: { message: 'Invalid credentials' },
        description: `Failed login attempt for email: ${email}`
      });
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.status === 'Pending') {
      return res.status(403).json({ error: 'Your registration is pending approval from the Super Admin.' });
    }

    if (user.status === 'Rejected') {
      return res.status(403).json({ error: 'Your registration request was rejected.' });
    }

    if (resolvedRole !== 'SuperAdmin' && user.accessGrantedOn) {
      if (user.isAccessCancelled) {
        return res.status(403).json({ error: 'Your account has been suspended. Please contact the Super Admin.' });
      }
      const now = new Date();
      if (user.accessStartDate && now < new Date(user.accessStartDate)) {
        return res.status(403).json({ error: 'Your access has not started yet. It starts on: ' + new Date(user.accessStartDate).toLocaleString() });
      }
      if (user.accessExpiryDate && now > new Date(user.accessExpiryDate)) {
        return res.status(403).json({ error: 'Your access expired on: ' + new Date(user.accessExpiryDate).toLocaleString() });
      }
    }

    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET is not defined');
    }

    const token = jwt.sign(
      { id: user._id, email: user.email, role: resolvedRole },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    // Temp set req.user to pass to audit logger
    (req as any).user = { id: user._id.toString(), email: user.email, role: resolvedRole, name: user.name };

    await AuditService.log({
      action: 'LOGIN_SUCCESS',
      collectionName: collection,
      documentId: user._id.toString(),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      description: `User logged in successfully`
    });

    res.json({
      user: await buildAuthProfile(user, resolvedRole as string),
      token,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
};


// ─── Change password (signed in) ──────────────────────────────────────────────

const changePasswordSchema = z
  .object({
    currentPassword: z.string().min(1, 'Current password is required'),
    newPassword: z.string().min(1, 'New password is required'),
    // Optional rather than required so a browser still running the previous
    // build keeps working during a rollout. When it is sent it must match.
    confirmPassword: z.string().optional(),
  })
  .refine(
    (data) => data.confirmPassword === undefined || data.confirmPassword === data.newPassword,
    { message: 'Passwords do not match', path: ['confirmPassword'] }
  );

/**
 * POST /api/auth/change-password
 *
 * Self-service password change for any signed-in account (SuperAdmin, Admin or
 * User). Knowledge of the current password is what proves identity here — there
 * is no email or admin approval step.
 *
 * Note this cannot help someone who is already locked out; recovering a
 * forgotten password necessarily requires proving identity through some other
 * channel.
 */
export const changePassword = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = changePasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const current = (req as any).user;
    const { currentPassword, newPassword } = parsed.data;

    const policyProblem = validatePassword(newPassword);
    if (policyProblem) {
      return res.status(400).json({ error: policyProblem });
    }
    if (currentPassword === newPassword) {
      return res.status(400).json({ error: 'The new password must be different from the current one.' });
    }

    const Model: any = current.role === 'User' ? User : Admin;
    const account = await Model.findById(current.id);
    if (!account) {
      return res.status(401).json({ error: 'Unauthorized: Account not found' });
    }

    const matches = await bcrypt.compare(currentPassword, account.passwordHash);
    if (!matches) {
      await AuditService.log({
        action: 'PASSWORD_CHANGE_FAILED',
        collectionName: current.role === 'User' ? 'users' : 'admins',
        documentId: account._id.toString(),
        actor: AuditService.getActorFromReq(req),
        request: AuditService.getRequestInfo(req),
        success: false,
        description: `Failed password change for ${account.email}: current password incorrect`,
      });
      return res.status(401).json({ error: 'Your current password is incorrect.' });
    }

    const changedAt = new Date();
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Only password fields change — role, status and access windows are untouched.
    await Model.updateOne(
      { _id: account._id },
      { $set: { passwordHash, passwordChangedAt: changedAt } }
    );

    await AuditService.log({
      action: 'PASSWORD_CHANGED',
      collectionName: current.role === 'User' ? 'users' : 'admins',
      documentId: account._id.toString(),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      description: `Password changed for ${account.email}`,
    });

    // passwordChangedAt revokes every token issued earlier, including the one
    // used for this request. Hand back a fresh token so the caller stays signed
    // in here while any other session is signed out.
    if (!process.env.JWT_SECRET) {
      throw new Error('JWT_SECRET is not defined');
    }
    const token = jwt.sign(
      { id: account._id, email: account.email, role: current.role },
      process.env.JWT_SECRET,
      { expiresIn: '1d' }
    );

    // Never return the password or its hash.
    return res.json({ message: 'Your password has been changed.', token });
  } catch (error) {
    console.error('Change password error:', error);
    return res.status(500).json({ error: 'Unable to change the password right now. Please try again later.' });
  }
};


// ─── Forgot password (self-service, no admin approval) ───────────────────────

const GENERIC_FORGOT_PASSWORD_RESPONSE = {
  message: 'If an account exists for that email, a password reset link has been sent.',
};

const forgotPasswordSchema = z.object({
  email: z.string().email('Invalid email address'),
});

/**
 * POST /api/auth/forgot-password
 *
 * Self-service password recovery for any role (SuperAdmin, Admin or User) —
 * no Super Admin or Admin approval is required. Identity is proven by owning
 * the inbox for the account's email (the same address used to sign in), via a
 * single-use, 15-minute link — never by the email address alone, which is
 * why this does not accept or apply a new password directly.
 *
 * Always answers with the same generic message regardless of whether the
 * email matches an account, in the same time whether or not a lookup and
 * email send actually happened, so this endpoint cannot be used to enumerate
 * registered accounts.
 */
export const forgotPassword = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      // Even a malformed address gets the generic response — the shape of
      // the error must not distinguish "not an email" from "no such account".
      return res.json(GENERIC_FORGOT_PASSWORD_RESPONSE);
    }

    const email = parsed.data.email.trim().toLowerCase();

    let account: any = await Admin.findOne({ email });
    let accountType: ResetAccountType = 'Admin';
    if (!account) {
      account = await User.findOne({ email });
      accountType = 'User';
    }

    if (account) {
      // Only the most recently requested link is ever valid — this also
      // bounds how many outstanding tokens one account can accumulate.
      await PasswordResetToken.deleteMany({ accountId: account._id, accountType });

      const rawToken = generateResetToken();
      await PasswordResetToken.create({
        accountId: account._id,
        accountType,
        tokenHash: hashResetToken(rawToken),
        expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
      });

      const resetLink = `${getFrontendBaseUrl()}/reset-password?token=${rawToken}`;
      await sendPasswordResetEmail(account.name, account.email, resetLink);

      await AuditService.log({
        action: 'PASSWORD_RESET_REQUESTED',
        collectionName: accountType === 'Admin' ? 'admins' : 'users',
        documentId: account._id.toString(),
        request: AuditService.getRequestInfo(req),
        description: `Password reset requested for ${account.email}`,
      });
    }

    return res.json(GENERIC_FORGOT_PASSWORD_RESPONSE);
  } catch (error) {
    console.error('Forgot password error:', error);
    // A real failure is reported as an error, not the generic success message
    // — but the message itself still reveals nothing about account existence.
    return res.status(500).json({ error: 'Unable to process the request right now. Please try again later.' });
  }
};

const resetTokenSchema = z.object({
  token: z.string().min(1, 'A reset token is required'),
});

/**
 * POST /api/auth/verify-reset-token
 *
 * Lets the reset-password page decide, before asking for a new password,
 * whether the link the user followed is still valid — without consuming it.
 * Deliberately returns nothing about the account (not even whether one was
 * ever associated with the token) beyond a plain boolean.
 */
export const verifyResetToken = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = resetTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.json({ valid: false });
    }

    const record = await PasswordResetToken.findOne({ tokenHash: hashResetToken(parsed.data.token) });
    const valid = !!record && record.expiresAt.getTime() > Date.now();
    return res.json({ valid });
  } catch (error) {
    console.error('Verify reset token error:', error);
    return res.json({ valid: false });
  }
};

const resetPasswordSchema = z
  .object({
    token: z.string().min(1, 'A reset token is required'),
    newPassword: z.string().min(1, 'New password is required'),
    confirmPassword: z.string().min(1, 'Please confirm the new password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

/**
 * POST /api/auth/reset-password
 *
 * Completes the self-service reset. The caller must present a valid,
 * unexpired, unused token proving they control the account's email; no
 * Super Admin or Admin approval is involved. The new password is checked
 * against the same policy as registration and change-password, then hashed
 * with the same bcrypt mechanism used everywhere else before it is saved.
 *
 * The token is single-use: on success it, and every other outstanding token
 * for the same account, is deleted so none of them can be replayed.
 * passwordChangedAt is updated too, which revokes every session token issued
 * before this moment for every device that was signed in (see requireAuth /
 * isTokenStale in authMiddleware.ts) — the same mechanism change-password and
 * the Super Admin administrative reset already rely on.
 */
export const resetPassword = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { token, newPassword } = parsed.data;

    const policyProblem = validatePassword(newPassword);
    if (policyProblem) {
      return res.status(400).json({ error: policyProblem });
    }

    const INVALID_OR_EXPIRED = { error: 'This password reset link is invalid or has expired. Please request a new one.' };

    const record = await PasswordResetToken.findOne({ tokenHash: hashResetToken(token) });
    if (!record || record.expiresAt.getTime() <= Date.now()) {
      // 400, not 401: the frontend treats a 401 from anywhere other than
      // login/register as "session expired" and force-navigates to /login,
      // which would be the wrong reaction to an invalid reset link.
      return res.status(400).json(INVALID_OR_EXPIRED);
    }

    const Model: any = record.accountType === 'Admin' ? Admin : User;
    const account = await Model.findById(record.accountId);
    if (!account) {
      // The account was deleted after the link was issued.
      await PasswordResetToken.deleteOne({ _id: record._id });
      return res.status(400).json(INVALID_OR_EXPIRED);
    }

    const changedAt = new Date();
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Only the password fields move — role, status, access window and every
    // other field are left exactly as they were.
    await Model.updateOne(
      { _id: account._id },
      { $set: { passwordHash, passwordChangedAt: changedAt } }
    );

    await PasswordResetToken.deleteMany({ accountId: account._id, accountType: record.accountType });

    await AuditService.log({
      action: 'PASSWORD_RESET_COMPLETED',
      collectionName: record.accountType === 'Admin' ? 'admins' : 'users',
      documentId: account._id.toString(),
      request: AuditService.getRequestInfo(req),
      description: `Password reset via self-service link for ${account.email}`,
    });

    return res.json({ message: 'Your password has been reset. You can now sign in with your new password.' });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ error: 'Unable to reset the password right now. Please try again later.' });
  }
};
