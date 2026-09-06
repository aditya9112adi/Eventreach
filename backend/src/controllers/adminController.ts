import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { z } from 'zod';
import { validatePassword } from '@eventreach/shared';
import { User } from '../models/User';
import { Admin } from '../models/Admin';
import { Event } from '../models/Event';
import { AuditService } from '../services/AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';
import { getIO, emitPendingApprovalsChanged } from '../services/socketService';
import { isEventAuthorized } from '../services/eventAuthService';
import { sendRegistrationDecisionEmail, verifyEmailTransport } from '../utils/email';
import { getFrontendBaseUrl, isFrontendUrlConfigured } from '../config/appUrls';


export const getPendingUsers = async (req: Request, res: Response) => {
  try {
    const pendingUsers = await User.find({ status: 'Pending' }).select('-passwordHash').lean();
    const pendingAdmins = await Admin.find({ status: 'Pending' }).select('-passwordHash').lean();

    const formattedUsers = pendingUsers.map(u => ({ ...u, role: 'User', type: 'User' }));
    const formattedAdmins = pendingAdmins.map(a => ({ ...a, type: 'Admin' })); // role is already inside Admin doc

    res.json([...formattedAdmins, ...formattedUsers].sort((a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()));
  } catch (error) {
    console.error('Error fetching pending users:', error);
    res.status(500).json({ error: 'Failed to fetch pending users' });
  }
};

export const approveUser = async (req: RequestWithId, res: Response) => {
  try {
    const { id } = req.params;
    const { type } = req.query; // 'Admin' | 'User'
    const { assignedEventId } = req.body || {};
    const currentUser = (req as any).user;

    // Approval metadata is always server-generated; nothing here is taken from
    // the request body.
    const approvedAt = new Date();
    const approvedBy = currentUser?.id;

    let user;
    let beforeUser;
    
    if (type === 'Admin') {
      const admin = await Admin.findById(id);
      if (!admin) return res.status(404).json({ error: 'Admin not found' });
      beforeUser = admin.toObject ? admin.toObject() : admin;

      if (!admin.pendingAccessStartDate || !admin.pendingAccessEndDate) {
        return res.status(400).json({ error: 'This admin did not submit access dates during registration.' });
      }

      user = await Admin.findByIdAndUpdate(
        id,
        {
          status: 'Active',
          accessGrantedOn: approvedAt,
          accessStartDate: admin.pendingAccessStartDate,
          accessExpiryDate: admin.pendingAccessEndDate,
          isAccessCancelled: false,
          approvedAt,
          approvedBy,
          $unset: { rejectedAt: 1, rejectedBy: 1, rejectionReason: 1 },
        },
        { new: true }
      ).select('-passwordHash');
    } else {
      const regularUser = await User.findById(id);
      beforeUser = regularUser?.toObject ? regularUser.toObject() : regularUser;

      const updateData: any = {
        status: 'Active',
        accessGrantedOn: approvedAt,
        isAccessCancelled: false,
        approvedAt,
        approvedBy,
        $unset: { rejectedAt: 1, rejectedBy: 1, rejectionReason: 1 },
      };

      if (assignedEventId) {
        updateData.assignedEventId = assignedEventId;
        await Event.findByIdAndUpdate(assignedEventId, {
          $addToSet: { assignedUserIds: id },
          assignedUserId: id,
        });
      }

      user = await User.findByIdAndUpdate(
        id,
        updateData,
        { new: true }
      ).select('-passwordHash');

      if (assignedEventId && user) {
        const ev = await Event.findById(assignedEventId).select('eventName').lean();
        try {
          getIO().to(id).emit('EVENT_ASSIGNMENT_CHANGED', {
            assignedEventId,
            eventName: ev ? (ev as any).eventName : null,
          });
        } catch (socketErr) {
          console.error('Socket emit error on approveUser:', socketErr);
        }
      }
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await AuditService.log({
      action: 'ACCOUNT_ENABLED',
      collectionName: type === 'Admin' ? 'admins' : 'users',
      documentId: user._id.toString(),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      before: beforeUser,
      after: user,
      description: `Approved and enabled access for ${type}: ${user.email}`
    });

    // One fewer request is pending — update every Super Admin's badge live.
    void emitPendingApprovalsChanged();

    // Let the applicant know they can now sign in. Fire-and-forget: a mail
    // failure must not fail the approval.
    void sendRegistrationDecisionEmail(user.name, user.email, 'approved');

    res.json(user);
  } catch (error) {
    console.error('Error approving user:', error);
    res.status(500).json({ error: 'Failed to approve user' });
  }
};

export const rejectUser = async (req: RequestWithId, res: Response) => {
  try {
    const { id } = req.params;
    const { type } = req.query;
    const { reason } = req.body;
    const currentUser = (req as any).user;

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'A rejection reason is required.' });
    }

    const rejectionReason = String(reason).trim();
    // Server-generated metadata; never accepted from the client.
    const rejectedAt = new Date();
    const rejectedBy = currentUser?.id;

    let user;
    let beforeUser;

    const rejectionUpdate = {
      status: 'Rejected',
      rejectionReason,
      rejectedAt,
      rejectedBy,
    };

    if (type === 'Admin') {
      beforeUser = await Admin.findById(id);
      user = await Admin.findByIdAndUpdate(id, rejectionUpdate, { new: true }).select('-passwordHash');
    } else {
      // Users previously lost the reason entirely — it is now recorded too.
      beforeUser = await User.findById(id);
      user = await User.findByIdAndUpdate(id, rejectionUpdate, { new: true }).select('-passwordHash');
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await AuditService.log({
      action: 'ACCOUNT_DISABLED',
      collectionName: type === 'Admin' ? 'admins' : 'users',
      documentId: user._id.toString(),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      before: beforeUser,
      after: user,
      description: `Rejected ${type} registration: ${user.email}`
    });

    void emitPendingApprovalsChanged();

    void sendRegistrationDecisionEmail(user.name, user.email, 'rejected', rejectionReason);

    res.json(user);
  } catch (error) {
    console.error('Error rejecting user:', error);
    res.status(500).json({ error: 'Failed to reject user' });
  }
};

export const getAccessRecords = async (req: Request, res: Response) => {
  try {
    const currentUser = (req as any).user;
    const isSuperAdmin = currentUser?.role === 'SuperAdmin';

    // Access records contain personal data (names, emails, access windows) for the
    // whole system. A Super Admin may see everything; an Admin must only ever see
    // the Users they manage, and never other Admin accounts.
    const userQuery: any = {
      $or: [
        { accessGrantedOn: { $exists: true } },
        { status: 'Rejected' }
      ]
    };
    if (!isSuperAdmin) {
      userQuery.adminId = currentUser?.id;
    }

    const accessUsers = await User.find(userQuery)
      .populate('assignedEventId', 'eventName')
      .select('-passwordHash')
      .lean();

    const accessAdmins = isSuperAdmin
      ? await Admin.find({
          role: { $ne: 'SuperAdmin' },
          $or: [
            { accessGrantedOn: { $exists: true } },
            { status: 'Rejected' }
          ]
        })
          .select('-passwordHash')
          .lean()
      : [];

    const formattedUsers = accessUsers.map((u: any) => ({
      ...u,
      role: 'User',
      type: 'User',
      assignedEventId: u.assignedEventId ? (u.assignedEventId._id || u.assignedEventId).toString() : null,
      assignedEventName: u.assignedEventId ? u.assignedEventId.eventName : null,
    }));
    const formattedAdmins = accessAdmins.map(a => ({ ...a, type: 'Admin' }));

    let records = [...formattedAdmins, ...formattedUsers];

    // Approval/rejection metadata is Super Admin information only.
    if (!isSuperAdmin) {
      records = records.map((r: any) => {
        const { approvedAt, approvedBy, rejectedAt, rejectedBy, rejectionReason, ...rest } = r;
        return rest;
      });
    }

    res.json(records.sort((a: any, b: any) => new Date(b.accessGrantedOn || b.createdAt).getTime() - new Date(a.accessGrantedOn || a.createdAt).getTime()));
  } catch (error) {
    console.error('Error fetching access records:', error);
    res.status(500).json({ error: 'Failed to fetch access records' });
  }
};

export const revokeAccess = async (req: RequestWithId, res: Response) => {
  try {
    const { id } = req.params;
    const { type } = req.query;

    let user;
    let beforeUser;

    if (type === 'Admin') {
      beforeUser = await Admin.findById(id);
      user = await Admin.findByIdAndUpdate(id, { isAccessCancelled: true }, { new: true }).select('-passwordHash');
    } else {
      beforeUser = await User.findById(id);
      user = await User.findByIdAndUpdate(id, { isAccessCancelled: true }, { new: true }).select('-passwordHash');
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    await AuditService.log({
      action: 'ACCOUNT_DISABLED',
      collectionName: type === 'Admin' ? 'admins' : 'users',
      documentId: user._id.toString(),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      before: beforeUser,
      after: user,
      description: `Revoked access for ${type}: ${user.email}`
    });

    try {
      console.log(`Attempting to emit ACCESS_REMOVED to room ${id}`);
      getIO().to(id).emit('ACCESS_REMOVED', { message: 'Your access has been removed.' });
      console.log(`Successfully emitted ACCESS_REMOVED to room ${id}`);
    } catch (socketErr) {
      console.error('Failed to emit ACCESS_REMOVED:', socketErr);
    }

    res.json(user);
  } catch (error) {
    console.error('Error revoking access:', error);
    res.status(500).json({ error: 'Failed to revoke access' });
  }
};

export const assignUserEvent = async (req: RequestWithId, res: Response) => {
  try {
    const { id } = req.params;
    const { eventId } = req.body;
    const currentUser = (req as any).user;

    const targetUser = await User.findById(id);
    if (!targetUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // If Admin, verify both the target user and the event are in the Admin's scope.
    if (currentUser?.role === 'Admin') {
      // An Admin may only manage their own Users, or claim a User that no Admin
      // owns yet. Without this check any Admin could reassign — and take over —
      // another Admin's Users.
      if (targetUser.adminId && targetUser.adminId.toString() !== currentUser.id) {
        return res.status(403).json({ error: 'You do not have permission to manage this user.' });
      }
      if (eventId) {
        const authorized = await isEventAuthorized(currentUser, eventId);
        if (!authorized) {
          return res.status(403).json({ error: 'You do not have permission to assign this event.' });
        }
      }
      if (!targetUser.adminId) {
        targetUser.adminId = currentUser.id;
      }
    }

    const previousEventId = targetUser.assignedEventId;

    // Remove user from previous event's list
    if (previousEventId && previousEventId.toString() !== eventId) {
      await Event.findByIdAndUpdate(previousEventId, {
        $pull: { assignedUserIds: targetUser._id },
        ...(String(targetUser._id) === String((targetUser as any).assignedUserId) ? { $unset: { assignedUserId: 1 } } : {})
      });
    }

    let assignedEvent: any = null;
    if (eventId) {
      assignedEvent = await Event.findByIdAndUpdate(
        eventId,
        {
          $addToSet: { assignedUserIds: targetUser._id },
          assignedUserId: targetUser._id,
        },
        { new: true }
      );
      targetUser.assignedEventId = eventId;
    } else {
      targetUser.assignedEventId = undefined as any;
    }

    await targetUser.save();

    await AuditService.log({
      action: 'USER_EVENT_ASSIGNED',
      collectionName: 'users',
      documentId: targetUser._id.toString(),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      description: eventId
        ? `Assigned event "${assignedEvent?.eventName || eventId}" to ${targetUser.email}`
        : `Removed event assignment from ${targetUser.email}`
    });

    // Real-time WebSocket emission to target user's socket room
    try {
      getIO().to(targetUser._id.toString()).emit('EVENT_ASSIGNMENT_CHANGED', {
        assignedEventId: eventId || null,
        eventName: assignedEvent?.eventName || null,
      });
      getIO().emit('dashboard-updated');
    } catch (socketErr) {
      console.error('Failed to emit EVENT_ASSIGNMENT_CHANGED:', socketErr);
    }

    res.json({
      success: true,
      user: targetUser,
      assignedEventId: eventId || null,
      assignedEventName: assignedEvent?.eventName || null,
    });
  } catch (error) {
    console.error('Error assigning user event:', error);
    res.status(500).json({ error: 'Failed to assign event to user' });
  }
};

/**
 * Super Admin diagnostic for deployment configuration.
 *
 * Integrations degrade silently by design — a dead mail password still returns
 * "reset link sent" so account existence is not leaked — which makes a
 * misconfigured deployment hard to spot. This reports whether each dependency is
 * usable.
 *
 * Reports booleans and the (public) frontend URL only. No secret value is ever
 * returned; the mail `error` is the provider's rejection message, not a credential.
 */
export const getSystemHealth = async (req: Request, res: Response) => {
  try {
    const mail = await verifyEmailTransport();

    res.json({
      frontendUrl: {
        value: getFrontendBaseUrl(),
        fromEnvironment: isFrontendUrlConfigured(),
      },
      email: {
        provider: mail.provider,
        credentialsConfigured: mail.configured,
        credentialsAccepted: mail.ok,
        error: mail.ok ? undefined : mail.error,
        superAdminRecipientConfigured: Boolean(process.env.SUPERADMIN_EMAIL),
      },
      whatsapp: {
        mode: process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_ID ? 'production' : 'mock',
        apiVersion: process.env.WHATSAPP_API_VERSION || 'v22.0',
      },
      auth: {
        jwtSecretConfigured: Boolean(process.env.JWT_SECRET),
      },
    });
  } catch (error) {
    console.error('System health error:', error);
    res.status(500).json({ error: 'Failed to read system health' });
  }
};

// Matches authController.ts and seed.ts — every hash in the system uses the
// same cost so a rotated password is no weaker than the original.
const BCRYPT_ROUNDS = 10;

const adminResetPasswordSchema = z
  .object({
    newPassword: z.string().min(1, 'New password is required'),
    confirmPassword: z.string().min(1, 'Please confirm the new password'),
  })
  .refine((data) => data.newPassword === data.confirmPassword, {
    message: 'Passwords do not match',
    path: ['confirmPassword'],
  });

/**
 * PUT /api/admin/users/:id/reset-password?type=Admin|User
 *
 * Administrative password reset, Super Admin only.
 *
 * This is the account-recovery path for a locked-out Admin or User. The product
 * deliberately has no email delivery, and an account carries no other verifiable
 * factor (no phone, no MFA, no security questions), so identity is vouched for
 * out-of-band by a Super Admin rather than by an unauthenticated form. That is
 * why there is no public "email + new password" endpoint: email is the login id
 * and is visible across the admin screens, so such an endpoint would be a
 * one-request takeover of any account.
 *
 * The acting Super Admin is taken from the verified JWT via requireAuth /
 * requireRole; nothing about the caller is read from the request body.
 */
export const adminResetUserPassword = async (req: RequestWithId, res: Response) => {
  try {
    const parsed = adminResetPasswordSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { newPassword } = parsed.data;

    // Same policy as registration and self-service change, from the shared module.
    const policyProblem = validatePassword(newPassword);
    if (policyProblem) {
      return res.status(400).json({ error: policyProblem });
    }

    const { id } = req.params;
    const { type } = req.query as { type?: string };
    if (type !== 'Admin' && type !== 'User') {
      return res.status(400).json({ error: 'A valid account type is required.' });
    }

    const Model: any = type === 'Admin' ? Admin : User;
    const account = await Model.findById(id);
    if (!account) {
      return res.status(404).json({ error: 'Account not found.' });
    }

    // A Super Admin may recover Admin and User accounts, but never another
    // Super Admin: that would be a lateral takeover of a peer administrator.
    // A Super Admin rotates their own password through change-password, or
    // offline via the reset-superadmin-password script.
    if (type === 'Admin' && account.role === 'SuperAdmin') {
      await AuditService.log({
        action: 'PASSWORD_RESET_DENIED',
        collectionName: 'admins',
        documentId: account._id.toString(),
        actor: AuditService.getActorFromReq(req),
        request: AuditService.getRequestInfo(req),
        success: false,
        description: `Refused administrative password reset targeting Super Admin ${account.email}`,
      });
      return res
        .status(403)
        .json({ error: 'A Super Admin account cannot be reset from here.' });
    }

    const changedAt = new Date();
    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Only the password fields move. Role, status, access window, event
    // ownership, approval metadata and profile details are all left alone.
    await Model.updateOne(
      { _id: account._id },
      { $set: { passwordHash, passwordChangedAt: changedAt } }
    );

    await AuditService.log({
      action: 'PASSWORD_RESET_BY_ADMIN',
      collectionName: type === 'Admin' ? 'admins' : 'users',
      documentId: account._id.toString(),
      actor: AuditService.getActorFromReq(req),
      request: AuditService.getRequestInfo(req),
      description: `Super Admin reset the password for ${type}: ${account.email}`,
    });

    // passwordChangedAt is in the past relative to any token already issued to
    // this account, so every existing session for them is revoked.
    return res.json({
      message: 'Password has been reset. The account must sign in with the new password.',
      email: account.email,
    });
  } catch (error) {
    console.error('Admin password reset error:', error);
    return res
      .status(500)
      .json({ error: 'Unable to reset the password right now. Please try again later.' });
  }
};
