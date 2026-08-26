import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGODB_URI as string);
    console.log('Connected to MongoDB.');

    const collection = mongoose.connection.collection('events');
    const events = await collection.find({}).toArray();
    let mobileFixed = 0;
    let dateFixed = 0;

    for (const ev of events) {
      const updates: any = {};

      // 1. Convert organizerMobile: "9112472833" (String) → 9112472833 (Number)
      if (typeof ev.organizerMobile === 'string') {
        const num = parseInt(ev.organizerMobile, 10);
        if (!isNaN(num)) {
          updates.organizerMobile = num;
          mobileFixed++;
        }
      }

      // 2. Convert date: "2026-08-23" (String) → ISODate (Date)
      if (typeof ev.date === 'string') {
        const d = new Date(ev.date + 'T00:00:00.000Z');
        if (!isNaN(d.getTime())) {
          updates.date = d;
          dateFixed++;
        }
      }

      if (Object.keys(updates).length > 0) {
        await collection.updateOne({ _id: ev._id }, { $set: updates });
      }
    }

    console.log(`✅ Migration complete:`);
    console.log(`   - ${mobileFixed} records: organizerMobile converted String → Number`);
    console.log(`   - ${dateFixed} records: date converted String → Date`);
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
