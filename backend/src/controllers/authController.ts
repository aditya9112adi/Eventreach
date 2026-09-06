import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { User } from '../models/User';
import { Admin } from '../models/Admin';
import { Event } from '../models/Event';
import { sendApprovalEmail } from '../utils/email';
import { PasswordResetToken } from '../models/PasswordResetToken';
import { PasswordResetRequest } from '../models/PasswordResetRequest';
import { validatePassword } from '../utils/passwordPolicy';
import { hashResetToken } from '../utils/resetToken';
import { AuditService } from '../services/AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';
import {
  emitPendingApprovalsChanged,
  emitPasswordResetRequestsChanged,
} from '../services/socketService';

/** Matches the cost factor used everywhere else passwords are hashed. */
const BCRYPT_ROUNDS = 10;

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters').max(100, 'Password is too long'),
});

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters').max(100, 'Password is too long'),
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

// ─── Password reset ───────────────────────────────────────────────────────────

/** Identical response whether or not the address exists, to prevent enumeration. */
const GENERIC_FORGOT_RESPONSE = {
  message:
    'If an account exists with this email address, your reset request has been sent to the Super Admin. ' +
    'They will share a reset link with you.',
};

/** Identical response for every failure mode, so probing reveals nothing. */
const INVALID_RESET_TOKEN = 'This password reset link is invalid or has expired.';

const forgotPasswordSchema = z.object({
  email: z.string().email('Please enter a valid email address'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'Reset token is required'),
  password: z.string().min(1, 'Password is required'),
});

/**
 * POST /api/auth/forgot-password
 *
 * Queues a reset request for the Super Admin rather than emailing a link. No
 * secret is generated here: a human authorises the reset and issues the one-time
 * link (see adminController.issuePasswordResetLink). Letting anyone self-serve a
 * reset from an email address alone would be an account-takeover hole.
 *
 * Works for every role — SuperAdmin, Admin and User are all looked up the same way.
 */
export const forgotPassword = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = forgotPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      // A malformed address is a client-side format problem and reveals nothing
      // about which accounts exist.
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const email = parsed.data.email.trim().toLowerCase();

    const admin = await Admin.findOne({ email });
    const user = admin ? null : await User.findOne({ email });
    const account: any = admin || user;

    if (account) {
      const accountModel = admin ? 'Admin' : 'User';

      // Collapse older pending requests so the queue shows one row per person.
      await PasswordResetRequest.updateMany(
        { accountId: account._id, status: 'Pending' },
        { $set: { status: 'Dismissed', handledAt: new Date() } }
      );

      await PasswordResetRequest.create({
        accountId: account._id,
        accountModel,
        name: account.name,
        email: account.email,
        role: admin ? admin.role : 'User',
        status: 'Pending',
        requestedAt: new Date(),
      });

      await AuditService.log({
        action: 'PASSWORD_RESET_REQUESTED',
        collectionName: accountModel === 'Admin' ? 'admins' : 'users',
        documentId: account._id.toString(),
        request: AuditService.getRequestInfo(req),
        description: `Password reset requested for ${account.email}`,
      });

      void emitPasswordResetRequestsChanged();
    }

    return res.json(GENERIC_FORGOT_RESPONSE);
  } catch (error) {
    console.error('Forgot password error:', error);
    // Generic failure — still does not disclose whether the account exists.
    return res.status(500).json({ error: 'Unable to process the request right now. Please try again later.' });
  }
};

/**
 * POST /api/auth/reset-password
 *
 * The token is claimed atomically so it can only ever be redeemed once, even
 * under concurrent requests. The account's role and status are untouched.
 */
export const resetPassword = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = resetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const policyProblem = validatePassword(parsed.data.password);
    if (policyProblem) {
      return res.status(400).json({ error: policyProblem });
    }

    const tokenHash = hashResetToken(parsed.data.token);
    const now = new Date();

    // Atomically claim an unused, unexpired token. Returns the pre-update
    // document, so a second concurrent attempt finds nothing to claim.
    const claimed = await PasswordResetToken.findOneAndUpdate(
      { tokenHash, usedAt: null, expiresAt: { $gt: now } },
      { $set: { usedAt: now } },
      { new: false }
    );

    if (!claimed) {
      return res.status(400).json({ error: INVALID_RESET_TOKEN });
    }

    const Model: any = claimed.accountModel === 'Admin' ? Admin : User;
    const account = await Model.findById(claimed.accountId);
    if (!account) {
      return res.status(400).json({ error: INVALID_RESET_TOKEN });
    }

    const passwordHash = await bcrypt.hash(parsed.data.password, BCRYPT_ROUNDS);

    // Only password-related fields change — role, status and access windows are
    // deliberately left alone.
    await Model.updateOne(
      { _id: account._id },
      { $set: { passwordHash, passwordChangedAt: now } }
    );

    // Retire every other outstanding link for this account.
    await PasswordResetToken.updateMany(
      { accountId: account._id, usedAt: null },
      { $set: { usedAt: now } }
    );

    await AuditService.log({
      action: 'PASSWORD_RESET_COMPLETED',
      collectionName: claimed.accountModel === 'Admin' ? 'admins' : 'users',
      documentId: account._id.toString(),
      request: AuditService.getRequestInfo(req),
      description: `Password reset completed for ${account.email}`,
    });

    // Never echo the password or its hash.
    return res.json({
      message: 'Your password has been reset. You can now sign in with your new password.',
    });
  } catch (error) {
    console.error('Reset password error:', error);
    return res.status(500).json({ error: 'Unable to reset the password right now. Please try again later.' });
  }
};
