import { Request, Response } from 'express';
import { User } from '../models/User';
import { Admin } from '../models/Admin';
import { Event } from '../models/Event';
import { AuditService } from '../services/AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';
import { getIO } from '../services/socketService';
import { isEventAuthorized } from '../services/eventAuthService';

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
          accessGrantedOn: new Date(),
          accessStartDate: admin.pendingAccessStartDate,
          accessExpiryDate: admin.pendingAccessEndDate,
          isAccessCancelled: false,
        },
        { new: true }
      ).select('-passwordHash');
    } else {
      const regularUser = await User.findById(id);
      beforeUser = regularUser?.toObject ? regularUser.toObject() : regularUser;

      const updateData: any = {
        status: 'Active',
        accessGrantedOn: new Date(),
        isAccessCancelled: false,
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

    if (!reason || !String(reason).trim()) {
      return res.status(400).json({ error: 'A rejection reason is required.' });
    }

    let user;
    let beforeUser;

    if (type === 'Admin') {
      beforeUser = await Admin.findById(id);
      user = await Admin.findByIdAndUpdate(id, { status: 'Rejected', rejectionReason: String(reason).trim() }, { new: true }).select('-passwordHash');
    } else {
      beforeUser = await User.findById(id);
      user = await User.findByIdAndUpdate(id, { status: 'Rejected' }, { new: true }).select('-passwordHash');
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

    res.json(user);
  } catch (error) {
    console.error('Error rejecting user:', error);
    res.status(500).json({ error: 'Failed to reject user' });
  }
};

export const getAccessRecords = async (req: Request, res: Response) => {
  try {
    // Fetch users who have been granted access OR have been rejected, populating assignedEventId
    const accessUsers = await User.find({
      $or: [
        { accessGrantedOn: { $exists: true } },
        { status: 'Rejected' }
      ]
    })
      .populate('assignedEventId', 'eventName')
      .select('-passwordHash')
      .lean();

    const accessAdmins = await Admin.find({
      role: { $ne: 'SuperAdmin' },
      $or: [
        { accessGrantedOn: { $exists: true } },
        { status: 'Rejected' }
      ]
    })
      .select('-passwordHash')
      .lean();

    const formattedUsers = accessUsers.map((u: any) => ({
      ...u,
      role: 'User',
      type: 'User',
      assignedEventId: u.assignedEventId ? (u.assignedEventId._id || u.assignedEventId).toString() : null,
      assignedEventName: u.assignedEventId ? u.assignedEventId.eventName : null,
    }));
    const formattedAdmins = accessAdmins.map(a => ({ ...a, type: 'Admin' }));

    res.json([...formattedAdmins, ...formattedUsers].sort((a: any, b: any) => new Date(b.accessGrantedOn || b.createdAt).getTime() - new Date(a.accessGrantedOn || a.createdAt).getTime()));
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

    // If Admin, verify the event is in the Admin's scope
    if (currentUser?.role === 'Admin') {
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
