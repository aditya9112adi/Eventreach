import mongoose from 'mongoose';
import dotenv from 'dotenv';

dotenv.config();

async function migrate() {
  try {
    await mongoose.connect(process.env.MONGODB_URI as string);
    console.log('Connected to MongoDB.');

    const collection = mongoose.connection.collection('events');
    const events = await collection.find({}).toArray();
    let updatedCount = 0;

    for (const ev of events) {
      const updates: any = {};
      const unsets: any = {};

      if (ev.name) { updates.eventName = ev.name; unsets.name = ""; }
      if (ev.type) { updates.eventType = ev.type; unsets.type = ""; }
      
      // Date is already Date object from previous migration but field name needs change
      if (ev.date) { updates.eventDate = ev.date; unsets.date = ""; }

      if (ev.time) { 
        if (typeof ev.time === 'string') {
          const [h, m] = ev.time.split(':').map(Number);
          updates.eventTime = h * 60 + m;
        } else {
          updates.eventTime = ev.time;
        }
        unsets.time = ""; 
      }

      if (ev.venue) { updates.eventVenue = ev.venue; unsets.venue = ""; }
      if (ev.description !== undefined) { updates.eventDescription = ev.description; unsets.description = ""; }
      if (ev.status) { updates.eventStatus = ev.status; unsets.status = ""; }

      if (Object.keys(updates).length > 0) {
        await collection.updateOne({ _id: ev._id }, { $set: updates, $unset: unsets });
        updatedCount++;
      }
    }

    console.log(`✅ Migration complete: ${updatedCount} records updated with new field names and time format.`);
    process.exit(0);
  } catch (err) {
    console.error('Migration failed:', err);
    process.exit(1);
  }
}

migrate();
