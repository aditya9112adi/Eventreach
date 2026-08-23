import mongoose from 'mongoose';
import { Event } from './src/models/Event';
import dotenv from 'dotenv';

dotenv.config();

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGODB_URI as string);
    console.log('Connected to MongoDB.');
    const result = await Event.updateMany({ status: 'Draft' }, { $set: { status: 'Upcoming' } });
    console.log(`Updated ${result.modifiedCount} events from Draft to Upcoming.`);
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

migrate();
