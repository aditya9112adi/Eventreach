import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { User } from '../models/User';
import { Admin } from '../models/Admin';
import { sendApprovalEmail } from '../utils/email';
import { AuditService } from '../services/AuditService';
import { RequestWithId } from '../middleware/requestMiddleware';

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
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
    
    if (existingAdmin || existingUser) {
      return res.status(400).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const status = 'Pending';
    
    let createdUser;

    if (role === 'Admin') {
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
    } else {
      createdUser = await User.create({
        name,
        email,
        passwordHash,
        status,
      });
    }

    await AuditService.log({
      action: role === 'Admin' ? 'ADMIN_CREATED' : 'USER_CREATED',
      collectionName: role === 'Admin' ? 'admins' : 'users',
      documentId: createdUser._id.toString(),
      request: AuditService.getRequestInfo(req),
      after: createdUser,
      description: `New ${role} registration pending approval`
    });

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
      return res.status(403).json({ error: 'Your account is pending approval by the Super Admin.' });
    }

    if (user.status === 'Rejected') {
      return res.status(403).json({ error: 'Your account registration was rejected.' });
    }

    if (resolvedRole !== 'SuperAdmin' && user.accessGrantedOn) {
      if (user.isAccessCancelled) {
        return res.status(403).json({ error: 'Your access has been revoked.' });
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
      user: {
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
        createdAt: user.createdAt,
      },
      token,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({ error: 'Something went wrong' });
  }
};
