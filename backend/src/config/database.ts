import mongoose from 'mongoose';

export const connectDB = async () => {
  try {
    const uri = process.env.MONGODB_URI;
    if (!uri) {
      throw new Error('MONGODB_URI is not defined in environment variables');
    }

    /**
     * Connection options.
     *
     * The driver previously ran on defaults, which meant an unbounded-in-practice
     * pool of 100 sockets against a shared Atlas cluster, and a 30 second wait
     * before a request against an unreachable primary finally failed. The caps
     * below keep the connection count proportional to a single web instance and
     * surface an outage quickly rather than leaving requests hanging.
     */
    await mongoose.connect(uri, {
      maxPoolSize: 10,
      minPoolSize: 1,
      serverSelectionTimeoutMS: 10000,
      socketTimeoutMS: 45000,
    });

    console.log('MongoDB Connected Successfully');
  } catch (error) {
    console.error('MongoDB Connection Error:', error);
    process.exit(1);
  }
};
