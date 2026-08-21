import { Request, Response } from 'express';
import { User } from '../models/User';
import { Admin } from '../models/Admin';

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

export const approveUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { type } = req.query; // 'Admin' | 'User'
    const { accessStartDate, accessDurationValue, accessDurationUnit, accessExpiryDate } = req.body;
    
    if (!accessStartDate || !accessDurationValue || !accessDurationUnit || !accessExpiryDate) {
      return res.status(400).json({ error: 'Missing access duration details' });
    }

    const updatePayload = {
      status: 'Active',
      accessGrantedOn: new Date(),
      accessStartDate: new Date(accessStartDate),
      accessDurationValue: Number(accessDurationValue),
      accessDurationUnit: String(accessDurationUnit),
      accessExpiryDate: new Date(accessExpiryDate),
      isAccessCancelled: false
    };
    
    let user;
    if (type === 'Admin') {
      user = await Admin.findByIdAndUpdate(id, updatePayload, { new: true }).select('-passwordHash');
    } else {
      user = await User.findByIdAndUpdate(id, updatePayload, { new: true }).select('-passwordHash');
    }
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Error approving user:', error);
    res.status(500).json({ error: 'Failed to approve user' });
  }
};

export const rejectUser = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { type } = req.query;

    let user;
    if (type === 'Admin') {
      user = await Admin.findByIdAndUpdate(id, { status: 'Rejected' }, { new: true }).select('-passwordHash');
    } else {
      user = await User.findByIdAndUpdate(id, { status: 'Rejected' }, { new: true }).select('-passwordHash');
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Error rejecting user:', error);
    res.status(500).json({ error: 'Failed to reject user' });
  }
};

export const getAccessRecords = async (req: Request, res: Response) => {
  try {
    // Get all users who have ever been granted access (accessGrantedOn exists)
    const activeUsers = await User.find({ accessGrantedOn: { $exists: true } }).select('-passwordHash').lean();
    const activeAdmins = await Admin.find({ accessGrantedOn: { $exists: true }, role: { $ne: 'SuperAdmin' } }).select('-passwordHash').lean();

    const formattedUsers = activeUsers.map(u => ({ ...u, role: 'User', type: 'User' }));
    const formattedAdmins = activeAdmins.map(a => ({ ...a, type: 'Admin' }));

    res.json([...formattedAdmins, ...formattedUsers].sort((a: any, b: any) => new Date(b.accessGrantedOn || b.createdAt).getTime() - new Date(a.accessGrantedOn || a.createdAt).getTime()));
  } catch (error) {
    console.error('Error fetching access records:', error);
    res.status(500).json({ error: 'Failed to fetch access records' });
  }
};

export const revokeAccess = async (req: Request, res: Response) => {
  try {
    const { id } = req.params;
    const { type } = req.query; // 'Admin' | 'User'

    let user;
    if (type === 'Admin') {
      user = await Admin.findByIdAndUpdate(id, { isAccessCancelled: true }, { new: true }).select('-passwordHash');
    } else {
      user = await User.findByIdAndUpdate(id, { isAccessCancelled: true }, { new: true }).select('-passwordHash');
    }

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json(user);
  } catch (error) {
    console.error('Error revoking access:', error);
    res.status(500).json({ error: 'Failed to revoke access' });
  }
};

