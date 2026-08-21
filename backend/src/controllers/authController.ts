import { Request, Response } from 'express';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { User } from '../models/User';
import { Admin } from '../models/Admin';
import { sendApprovalEmail } from '../utils/email';

const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
});

const registerSchema = z.object({
  name: z.string().min(2, 'Name must be at least 2 characters'),
  email: z.string().email('Invalid email address'),
  password: z.string().min(6, 'Password must be at least 6 characters'),
  role: z.enum(['Admin', 'User']),
});

export const register = async (req: Request, res: Response) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { name, email, password, role } = parsed.data;

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
      });
      
      // Fire and forget email notification
      sendApprovalEmail(name, email);
      
    } else {
      createdUser = await User.create({
        name,
        email,
        passwordHash,
        status,
      });
    }

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

export const login = async (req: Request, res: Response) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0].message });
    }

    const { email, password } = parsed.data;

    let user: any = await Admin.findOne({ email });
    let resolvedRole = user ? user.role : null;
    
    if (!user) {
      user = await User.findOne({ email });
      resolvedRole = user ? 'User' : null;
    }

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const isValidPassword = await bcrypt.compare(password, user.passwordHash);
    if (!isValidPassword) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (user.status === 'Pending') {
      return res.status(403).json({ error: 'Your account is pending approval by the Super Admin.' });
    }

    if (user.status === 'Rejected') {
      return res.status(403).json({ error: 'Your account registration was rejected.' });
    }

    // Time-bound access enforcement
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
        accessDurationDays: user.accessDurationDays,
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
