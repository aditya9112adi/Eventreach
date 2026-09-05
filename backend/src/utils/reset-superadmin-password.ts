import mongoose from 'mongoose';
import bcrypt from 'bcrypt';
import dotenv from 'dotenv';
import { Admin } from '../models/Admin';

dotenv.config();

/**
 * One-time maintenance script: rotate the EXISTING Super Admin's password.
 *
 * Run locally from the `backend/` directory, e.g.:
 *   RESET_SUPERADMIN_PASSWORD='<new-strong-password>' npm run reset-superadmin-password
 *
 * Optionally set SUPERADMIN_EMAIL to disambiguate if more than one Super Admin exists.
 *
 * Guarantees:
 *  - New password is read only from RESET_SUPERADMIN_PASSWORD; never hard-coded, never logged.
 *  - New password must be at least 12 characters.
 *  - MONGODB_URI is read from the existing environment (backend/.env).
 *  - Only the located Super Admin's `passwordHash` is updated ($set on a single field).
 *  - No document is created or deleted; no other field or collection is touched.
 *  - If the Super Admin cannot be uniquely located, it exits WITHOUT any write.
 *  - MongoDB is disconnected cleanly in all paths.
 *  - Not imported anywhere; guarded so it never runs on application startup.
 */

const MIN_PASSWORD_LENGTH = 12;
const BCRYPT_ROUNDS = 10; // matches authController.ts and seed.ts

const run = async () => {
  const newPassword = process.env.RESET_SUPERADMIN_PASSWORD;
  const mongoUri = process.env.MONGODB_URI;
  const email = process.env.SUPERADMIN_EMAIL?.trim().toLowerCase();

  if (!mongoUri) {
    console.error('MONGODB_URI is not set. Aborting without changes.');
    process.exit(1);
  }
  if (!newPassword) {
    console.error('RESET_SUPERADMIN_PASSWORD is not set. Aborting without changes.');
    process.exit(1);
  }
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    console.error(
      `RESET_SUPERADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters. Aborting without changes.`
    );
    process.exit(1);
  }

  let connected = false;
  try {
    await mongoose.connect(mongoUri);
    connected = true;
    console.log('MongoDB connected.');

    const superAdmins: any[] = await Admin.find({ role: 'SuperAdmin' })
      .select('_id email')
      .lean();

    if (superAdmins.length === 0) {
      console.error('No Super Admin account found. Aborting without changes.');
      process.exitCode = 1;
      return;
    }

    let target: any;
    if (email) {
      target = superAdmins.find((a) => a.email === email);
      if (!target) {
        console.error(`No Super Admin found with email "${email}". Aborting without changes.`);
        process.exitCode = 1;
        return;
      }
    } else if (superAdmins.length > 1) {
      console.error(
        `Found ${superAdmins.length} Super Admin accounts. Set SUPERADMIN_EMAIL to select one. Aborting without changes.`
      );
      process.exitCode = 1;
      return;
    } else {
      target = superAdmins[0];
    }

    const passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS);

    // Filter re-asserts role:'SuperAdmin' so a non-SuperAdmin can never be updated.
    const result = await Admin.updateOne(
      { _id: target._id, role: 'SuperAdmin' },
      { $set: { passwordHash } }
    );

    if (result.matchedCount !== 1) {
      console.error(
        `Expected to match exactly 1 Super Admin, matched ${result.matchedCount}. No changes made.`
      );
      process.exitCode = 1;
      return;
    }

    console.log(
      `Super Admin password rotated successfully for: ${target.email} ` +
        `(modifiedCount=${result.modifiedCount}).`
    );
    process.exitCode = 0;
  } catch (error) {
    console.error('Password rotation failed:', error);
    process.exitCode = 1;
  } finally {
    if (connected) {
      await mongoose.disconnect();
      console.log('MongoDB disconnected.');
    }
  }
};

if (require.main === module) {
  run();
}
