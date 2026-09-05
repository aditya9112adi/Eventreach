import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { Admin } from '../models/Admin';

dotenv.config();

/**
 * One-time Super Admin bootstrap.
 *
 * Credentials are supplied exclusively via environment variables and are never
 * stored in source control:
 *   - SUPERADMIN_EMAIL     (required)
 *   - SUPERADMIN_PASSWORD  (required, min 12 chars)
 *   - SUPERADMIN_NAME      (optional, defaults to "Super Admin")
 *
 * The script is idempotent: if a Super Admin (or any account using the given
 * email) already exists, it makes no changes. It never deletes existing data.
 */

const MIN_PASSWORD_LENGTH = 12;
const BCRYPT_ROUNDS = 10;

const seed = async () => {
  const missing = ['MONGODB_URI', 'SUPERADMIN_EMAIL', 'SUPERADMIN_PASSWORD'].filter(
    (key) => !process.env[key]
  );
  if (missing.length > 0) {
    console.error(
      `Cannot seed Super Admin. Missing required environment variable(s): ${missing.join(', ')}`
    );
    console.error('Set them in your environment (or backend/.env) and re-run. See backend/.env.example.');
    process.exit(1);
  }

  const email = process.env.SUPERADMIN_EMAIL!.trim().toLowerCase();
  const password = process.env.SUPERADMIN_PASSWORD!;
  const name = (process.env.SUPERADMIN_NAME || 'Super Admin').trim();

  if (password.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `SUPERADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters. Aborting without changes.`
    );
    process.exit(1);
  }

  try {
    await mongoose.connect(process.env.MONGODB_URI as string);
    console.log('MongoDB connected for seeding');

    // Idempotent guard: never overwrite an existing Super Admin or an account
    // that already uses this email address.
    const existing = await Admin.findOne({
      $or: [{ role: 'SuperAdmin' }, { email }],
    }).lean();

    if (existing) {
      console.log('A Super Admin (or an account with this email) already exists. No changes made.');
      await mongoose.disconnect();
      process.exit(0);
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS);
    await Admin.create({
      name,
      email,
      passwordHash,
      role: 'SuperAdmin',
      status: 'Active',
    });

    console.log(`Super Admin created successfully for: ${email}`);
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('Seed error:', error);
    process.exit(1);
  }
};

seed();
