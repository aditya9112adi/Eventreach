import { Request, Response } from 'express';
import { User } from '../models/User';
import { Admin } from '../models/Admin';
import { AuditService } from '../services/AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';
import { getIO } from '../services/socketService';

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

      user = await User.findByIdAndUpdate(
        id,
        {
          status: 'Active',
          accessGrantedOn: new Date(),
          isAccessCancelled: false,
        },
        { new: true }
      ).select('-passwordHash');
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
    // Fetch users who have been granted access OR have been rejected
    const accessUsers = await User.find({
      $or: [
        { accessGrantedOn: { $exists: true } },
        { status: 'Rejected' }
      ]
    }).select('-passwordHash').lean();
    const accessAdmins = await Admin.find({
      role: { $ne: 'SuperAdmin' },
      $or: [
        { accessGrantedOn: { $exists: true } },
        { status: 'Rejected' }
      ]
    }).select('-passwordHash').lean();

    const formattedUsers = accessUsers.map(u => ({ ...u, role: 'User', type: 'User' }));
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

