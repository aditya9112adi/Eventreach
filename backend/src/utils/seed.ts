import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { Admin } from '../models/Admin';
import { User } from '../models/User';

dotenv.config();

const seed = async () => {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not defined');
    
    await mongoose.connect(uri);
    console.log('MongoDB connected for seeding');

    // Clear users and admins
    await User.deleteMany({});
    await Admin.deleteMany({});
    
    // Create admin
    const passwordHash = await bcrypt.hash('***REMOVED***', 10);
    await Admin.create({
      name: 'Aditya Kshirsagar',
      email: 'redacted@users.noreply.invalid',
      passwordHash,
      role: 'SuperAdmin',
      status: 'Active',
    });
    
    console.log('Seed completed successfully. Super Admin created: redacted@users.noreply.invalid');
    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
};

seed();
